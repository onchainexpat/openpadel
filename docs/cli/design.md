# The command line for agents: design

Agents work better with a command line than with a chat connector: they can read `--help`, pipe JSON, branch on exit
codes and retry. `kumi` already ran on the club's server (setup, doctor, backups). These are the club's own commands
added to it, run from any computer.

## One door, not two

The command line is a client of the club's assistant door, `/mcp` (apps/server/src/mcp.ts), not a second API.

- Each command calls one of the door's tools with a plain JSON-RPC `tools/call`. The door is stateless, so there's no
  session to set up.
- So the permission check, the plan, the apply, the weekly spending limit, the app-only refusals and the assistant's
  limits (support access never, desk money never) are the door's own code, the same path a Claude or ChatGPT
  connection takes. Nothing about them is copied.
- The commands are made from the same catalogue the door lists (`actions()` filtered by `doorAction`, plus `READS`):
  `program.create` is `kumi program create`, `free_courts` is `kumi free-courts`, and the flags come from each
  action's Zod schema. 157 changes and 29 reads today.

## Signing in

The door's OAuth (oauth.ts), unchanged in what it grants:

- **With a browser:** the authorization code flow with PKCE and a loopback redirect (RFC 8252). The command line
  registers itself (dynamic registration, as any assistant does) with the exact `http://127.0.0.1:<port>/callback` it
  listens on, once per sign-in. The consent page, the second step, the support-only refusal and the weekly limit are
  the ones an assistant sees.
- **Without one:** added here, the device authorization grant (RFC 8628). `POST /oauth/device_authorization` gives a
  code, which the person checks and allows at `/oauth/device` after the same sign-in and second step. The device
  then gets its tokens from `/oauth/token`. Codes are 8 consonants (no words), last 10 minutes, are kept in memory as
  the consent screens are, are rate-limited, and are used once.
- **Tokens:** an hour's access token and a rotating refresh token, as for any assistant. Two refreshes of one token
  end the chain (oauth.ts), so the command line refreshes under a file lock, one process at a time.

It's an ordinary assistant connection: listed in Profile, Assistants as `kumi (<host>)`, with its own limit, ended
there or by `kumi logout` (which runs `assistant.disconnect` for itself).

## What changed in the door

- **Staff reads**, which the door didn't have, so staff work could name a person or a court: people, a person's page,
  locations, courts, coaches, programs, a program, the day at a location, alerts, reports, memberships and questions.
  - They're offered only to someone with a staff role, through the staff screens' own read routes (reads.ts) in a new
    assistant mode, where support access never counts. A coach still reads only their own work, and a role the club
    made only its areas.
  - Emails and phone numbers are shortened on the way out (`m...@example.com`, `...42`), since the reader is an
    outside AI provider's model. Chat assistants get these reads too.
- **whoami** also gives the person's id (for `--person me`) and the connection's id (for logout).
- **A failure carries its key and status** in the result's `_meta` (`kumi/error`, `kumi/status`), so the command line
  can give exit codes. An assistant still reads the same words.
- **One read of the person's grants per request** instead of one per action (`everDoable`): building the tool list
  went from about 180 ms to about 15 ms, which every assistant call pays.

## What the command line adds, on the computer it runs on

- **Names for ids, for staff:** looked up through the staff reads; ambiguous or unknown names are errors that list
  the choices. Members give ids, except `--person me`.
- **The club's clock:** a time without a zone is the club's (from whoami's time zone).
- **Done once, however often it's asked:** a local record of recent previews (`runs.json`).
  - The same input, or the same `--key`, confirms the preview already made rather than making another.
  - A change already done isn't done again within 10 minutes (a day for `--key`) unless `--again`.
  - On the server, the door's confirm is itself idempotent per run (`mcp:<run_id>`).
- **Exit codes and one JSON object a line** (README.md), from the door's error keys and statuses.

## The docs stay in step

- `docs/cli/reference.md` is generated from the catalogue, with each change's preview wording (its `plan.*` key) and
  who may do it with the built-in roles as the migrations grant them (`tools/gen_cli_reference.ts`).
- `apps/server/test/cli_reference.test.ts` fails when it's stale. A changed action, input, read, wording or grant
  needs the file made again.

## Left out, and why

- **Windows' credential store:** the tokens go in the 0600 file there. Its own API needs more than a child process.
- **A package to install:** it runs from a Kumi checkout (`node apps/server/src/cli.ts`), the same release as the
  club or newer. Publishing to npm is a step to take with going public.
- **Spanish flag descriptions:** they come from the schemas' `describe()`, which are English, as the door's tool
  descriptions are. The command line's own words, and the club's previews and errors, are in both languages.
- **Rendered previews in the reference:** a preview needs a real club's data. The reference gives each change's
  preview wording, with its blanks, and README.md shows real ones from a demo club.
- **More staff reads:** the twelve above cover the desk's and the owner's day. Others (the change log, settings,
  CSVs) can join the door's list as they're needed, each through its screen's own read route.
