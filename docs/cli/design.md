# The command line for agents: design

Agents work better with a command line than with a chat connector: they can read `--help`, pipe JSON, branch on exit
codes and retry. `openpadel` already ran on the club's server (setup, doctor, backups). These are the club's own commands
added to it, run from any computer.

## One door, not two

The command line is a client of the club's assistant door, `/mcp` (apps/server/src/mcp.ts), not a second API.

- Each command calls one of the door's tools with a plain JSON-RPC `tools/call`. The door is stateless, so there's no
  session to set up.
- So the permission check, the plan, the apply, the weekly spending limit, the app-only refusals and the assistant's
  limits (support access never, desk money never) are the door's own code, the same path a Claude or ChatGPT
  connection takes. Nothing about them is copied.
- The commands are made from the same catalogue the door lists (`actions()` filtered by `doorAction`, plus `READS`):
  `program.create` is `openpadel program create`, `free_courts` is `openpadel free-courts`, and the flags come from each
  action's Zod schema. 157 changes and 29 reads today.

## Signing in

The door's OAuth (oauth.ts), unchanged in what it grants:

- **With a browser:** the authorization code flow with PKCE and a loopback redirect (RFC 8252). The command line
  registers itself (dynamic registration, as any assistant does) with the exact `http://127.0.0.1:<port>/callback` it
  listens on, once per sign-in. The consent page, the second step, the support-only refusal and the weekly limit are
  the ones an assistant sees.
- **Without one:** added here, the device authorization grant (RFC 8628). `POST /oauth/device_authorization` gives a
  code, which the person types and allows at `/oauth/device` after the same sign-in and second step. The device
  then gets its tokens from `/oauth/token`. Codes are 8 consonants (no words), last 10 minutes, are kept in memory as
  the consent screens are, are rate-limited, and are used once.
  - **Against a code someone else started and sent** (the review of 012eb4e showed a stranger's link allowed by
    one click from a signed-in owner): there's no `verification_uri_complete`, and a link with `?code=` opens the
    empty form, so the code is always typed (posted, and the session cookie is SameSite=Lax, so no other site can
    post it). The consent shows when and from which address the code was started, and says the device's name is its
    own choice. Anyone who signs in with two steps (owners and managers by default) gives a fresh second step at
    Allow: their authenticator's code, or with only a passkey, a passkey sign-in in the last 10 minutes (the page has
    no script, so it can't ask for the passkey itself).
  - **Filling it up:** a code waits 10 minutes and is never pushed out early. At most 5 wait from one network (an
    IPv4 address, or an IPv6 /64, which one home or server holds whole; the rate limits count a /64 once too). Past
    20,000 in all, only a network holding none may start one, up to 25,000. Filling the first takes 4,000 networks
    holding 5 each, renewed every 10 minutes; the last 5,000 places go one a network, so someone at the club (whose
    network holds no code) is refused only after 9,000 networks are in use at once, and the networks doing it are
    refused before them. That's about 10 MB of codes at the most.
- **Tokens:** an hour's access token and a rotating refresh token, as for any assistant. Two refreshes of one token
  end the chain (oauth.ts), so the command line refreshes under a file lock, one process at a time.

It's an ordinary assistant connection: listed in Profile, Assistants as `openpadel (<host>)`, with its own limit, ended
there or by `openpadel logout` (which runs `assistant.disconnect` for itself).

## What changed in the door

- **Staff reads**, which the door didn't have, so staff work could name a person or a court: people, a person's page,
  locations, courts, coaches, programs, a program, the day at a location, alerts, reports, memberships and questions.
  - They're offered only to someone with a staff role, through the staff screens' own read routes (reads.ts) in a new
    assistant mode, where support access never counts. A coach still reads only their own work, and a role the club
    made only its areas.
  - Emails and phone numbers are shortened on the way out (`m...@example.com`, `...42`), since the reader is an
    outside AI provider's model. Chat assistants get these reads too. That covers the fields named for them and any
    text (a note, an alert, why an address is held back), and previews and results too, except what the asker
    typed in their own input.
  - The people search takes names only here: matching an email or phone is a yes or no on the whole of one, which
    would let the shortening be undone a letter at a time.
- **A connection's reach** (assistant_reach.ts): each keeps what its person held when they allowed it (their roles
  and grants) and whether that sign-in gave a second step. At each use, if they now hold more (by any path: a role
  given, a removal undone, the server's `owner add`, a role the club made widened) or the club asks a second step
  they didn't give, it works as a member's until they connect it again: only the member role counts in its tool
  list, its reads and the permission check (`memberOnly`). They hear it once, in their inbox, and `whoami` says
  why. "More" is judged by what it reaches, not by role names, so an owner giving themselves coach reaches nothing
  new and keeps their connection. A connection from before this takes what its person holds at its first use.
- **No yes or no on an email:** the members' list import is the app's (its preview says who of a list is already
  here), and a taken email or phone through the door is a plain `error.door_not_here`. Shortening catches the usual
  spellings (415-5550142, 07700 900123, 020 7946 0958, josé@example.test) and never touches a field that names an id.
- **changed_since:** whether anything one of the person's own changes made has been changed again since, by anyone
  (the change log, `entity_change`); the command line asks it before saying "already done".
- **An earlier result** (`apply` by idempotency key) is given again only to whoever made the change.
- **whoami** also gives the person's id (for `--person me`) and the connection's id (for logout).
- **A failure carries its key and status** in the result's `_meta` (`kumi/error`, `kumi/status`), so the command line
  can give exit codes. An assistant still reads the same words.
- **One read of the person's grants per request** instead of one per action (`everDoable`): building the tool list
  went from about 180 ms to about 15 ms, which every assistant call pays.

## What the command line adds, on the computer it runs on

- **Names for ids, for staff:** looked up through the staff reads; ambiguous or unknown names are errors that list
  the choices. Members give ids, except `--person me`.
- **The club's clock:** a time without a zone is the club's (from whoami's time zone).
- **Done once, however often it's asked:** a local record of recent previews (`runs.json`), each with a hash of its
  input, the ids it names, and whose it is (person and connection).
  - The same input, or the same `--key`, confirms the preview already made rather than making another.
  - A change already done isn't done again within 10 minutes (a day for `--key`) unless `--again`. Without a
    `--key`, anything it made changed since by anyone (the club's `changed_since`; on a club too old to say, a
    different command here naming the same ids) makes it a new change instead. A `--key` is the same change for its
    day, kept however many other previews come after (200 of those are kept).
  - A `--key` used again with a different input is refused: a key names one change.
  - A confirm refused (out of date, no longer theirs to do, or no longer offered) forgets its preview, so the same
    command again starts afresh.
  - When someone else signs in to the club on that computer, the previews kept go.
  - On the server, the door's confirm is itself idempotent per run (`mcp:<run_id>`).
- **Only the club's own sign-in:** the sign-in server named in the club's metadata must be the club's own host or its
  staff app beside it (`staff.<host>`), exactly, over https (http only on this computer), with every endpoint on it; requests to it time out at 30 s, under the minute
  after which another command takes the refresh lock over. The browser opens without a shell (on Windows
  `rundll32 url.dll,FileProtocolHandler`, not `cmd /c start`, which cuts a link at `&` and runs what follows).
- **Exit codes and one JSON object a line** (README.md), from the door's error keys and statuses.

## The docs stay in step

- `docs/cli/reference.md` is generated from the catalogue, with each change's preview wording (its `plan.*` key) and
  who may do it with the built-in roles as the migrations grant them (`tools/gen_cli_reference.ts`).
- `apps/server/test/cli_reference.test.ts` fails when it's stale. A changed action, input, read, wording or grant
  needs the file made again.

## Left out, and why

- **Windows' credential store:** the tokens go in the 0600 file there. Its own API needs more than a child process.
- **A package to install:** it runs from an openPadel checkout (`node apps/server/src/cli.ts`), the same release as the
  club or newer. Publishing to npm is a step to take with going public.
- **Spanish flag descriptions:** they come from the schemas' `describe()`, which are English, as the door's tool
  descriptions are. The command line's own words, and the club's previews and errors, are in both languages.
- **Rendered previews in the reference:** a preview needs a real club's data. The reference gives each change's
  preview wording, with its blanks, and README.md shows real ones from a demo club.
- **More staff reads:** the twelve above cover the desk's and the owner's day. Others (the change log, settings,
  CSVs) can join the door's list as they're needed, each through its screen's own read route.
