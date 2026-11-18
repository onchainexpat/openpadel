# openpadel: the club's commands, for agents and people

`openpadel` does from a terminal what the staff and members' apps do: read the day, find a member, book a court, put on a
clinic, sign people up. It's made for agents (Claude Code, Codex and the like), which work better with a command line
than with a chat connector, and it works the same for a person typing.

It signs in to the club as an **assistant connection**, the same kind Claude or ChatGPT gets through the club's
connector (`/mcp`), and every command is one of that connector's own tools. So:

- it can do what the person who signed in can do, and nothing more;
- every change shows its preview first and changes nothing until it's confirmed;
- the weekly spending limit the person chose counts what it books for them;
- what's only ever done in the club's app stays there: accepting a waiver, the family card, how someone signs in,
  their own level, money handed over at the desk, chat moderation, and anything that needs a strong sign-in
  (club settings, roles, the vault);
- support access never reaches it.

Every command, with its flags and who may use it, is in [reference.md](reference.md), made from the catalogue itself.
An agent that works for the club rather than for one person (an n8n workflow, a bot, a desk agent at night) signs in
with a club agent's token instead: see [docs/agents](../agents/README.md), with recipes for each tool and the club's webhooks.
On the club's own server, `openpadel doctor`, `openpadel setup`, `openpadel backup` and the other server commands are the same tool
(`openpadel` with nothing after it lists them; see the [setup guide](../setup/README.md)).

## Install

On any computer with Node 24:

```bash
git clone https://github.com/onchainexpat/openpadel openpadel && cd openpadel && npm ci
alias openpadel="node $PWD/apps/server/src/cli.ts"    # or: npm run openpadel -- <command>
```

openPadel was called Kumi until November 2026: `kumi` is the same command (`npm run kumi`, and `/usr/local/bin/kumi`
on a club's server), so scripts that use it keep working. Its sign-ins stay in `~/.config/kumi`.

Use the release the club runs, or a newer one. `openpadel login` says when they differ, since a command new in one may be
missing from the other.

## Signing in

```bash
openpadel login https://staff.yourclub.com
```

Use the staff app's address or the members' app's: both work. A browser opens on the club's own sign-in page. There
the person:

1. gets a code by email (or a text, when the club texts);
2. gives their second step, if they have one set up (or the club asks it at every sign-in);
3. chooses how much the connection may spend for them each week: nothing to start, which is right for staff work,
   since money a member pays for isn't counted against the staff member's limit.

They can disconnect it any time in the app, under Profile, Assistants. A connection never reaches further than they
held when they allowed it: given a role later, or an owner or manager who didn't give a second step then, it works
as a member's until they connect it again (they're told once, and `openpadel whoami --json` says `limited`). It's listed there as `openpadel (<this computer's
name>)`.

**With no browser** (a server, a remote shell, an agent's sandbox), sign in by a code instead:

```bash
openpadel login https://staff.yourclub.com --device
```

It prints the club's page and a code such as `TKBW-VMFJ`. The person opens the page on their phone, signs in, types
the code, and allows it. The link never carries the code: a code someone else started and sent can't be allowed by
following a link. The consent says when and from which address the code was started, beside the name the device
gave itself. An owner or a manager gives a fresh second step to allow it: their authenticator's code there, or with only a
passkey, a passkey sign-in in the last 10 minutes (with none set up, it's connected as a member's). The command waits up
to 10 minutes and finishes by itself.

**For an agent**, which shouldn't sit on one command for minutes, there's a two-step version:

```bash
openpadel login https://staff.yourclub.com --device --no-wait --json
# {"status":"waiting_sign_in","link":"https://staff.yourclub.com/oauth/device","code":"TKBW-VMFJ",...}   exit 12
#   ...the agent shows the person the page and the code; they type the code there and allow it...
openpadel login https://staff.yourclub.com --device --json
# {"status":"done","club_name":"Kestrel Padel","person":"Robin Hale",...}   exit 0
```

The agent never sees a password or a code from an email. The person types those on the club's page.

**The owner's first sign-in, before the club's email is set up.** With no email service on the server yet, a sign-in
code only reaches the server's log, which the owner usually can't read (only the agent's SSH key works there), and the
agent must not read a code out of it and pass it on. Either set up email first ([resend.md](../setup/accounts/resend.md),
with the owner's address in `KUMI_MAIL_TEST_TO` while practice mode is on), or, on the server:

```bash
openpadel sign-in-link owner@yourclub.com      # prints a link for that owner; --json for {"url": ..., "expires_at": ...}
```

The agent gives the owner that link (in the chat is fine) and never opens it itself. It's the one thing passed on, and
it's made to be: it works once, for 15 minutes, only for an owner, and only while the server has no email service (with
one, the command and the link both refuse, and the code goes by email). Opening it only shows whom it signs in; its
button signs in, so a chat app previewing the link can't use it up. Making a new one ends the one before. Once the
owner is in, they allow the agent's `--device` code as above.

**On the club's own server.** `openpadel login ... --device` works there too (run it as root, as the server's other
commands are): the server's `openpadel` runs as the openPadel service user, so the sign-in is kept in
`/var/lib/kumi/.config/kumi/secrets.json` (that user's home, readable by it and root only), not in root's home. Anyone
with root on the server can use it, so sign in there as the person whose agent works on the server, and `openpadel logout`
when that work is done.

`openpadel login` signs in only at the club's own addresses: the sign-in server the club names must be the club's own host
or its staff app beside it (`staff.<host>`), over https (http only on this computer), with every endpoint on it.
Working on openPadel itself, where the two apps run on `localhost` ports of their own (5173 and 5174) and not as
`staff.<host>`, sign in with the staff app's address; the members' address names a sign-in server on another port and is
refused. A club's real addresses don't have this.

**Where the sign-in is kept:**

- in the system keychain when there is one (`secret-tool` on Linux, the Keychain on a Mac);
- otherwise in `~/.config/kumi/secrets.json`, readable by the user only. `KUMI_CONFIG_DIR` moves the folder, and
  `KUMI_CLI_KEYCHAIN=0` keeps the tokens in the file.

The access token lasts an hour and renews itself, one command at a time, so commands run in parallel don't trip over
each other.

**Several clubs and sign-ins:**

- `openpadel clubs` lists the clubs signed in to here.
- `openpadel use <address>` picks the one commands go to.
- `--club <address>` (or `KUMI_CLUB`) picks one for a single command.
- `openpadel logout` signs out here and ends the connection at the club.
- `openpadel whoami` says who you are there, your roles, and what the spending limit leaves this week.

## How commands work

**Reads** print what the apps show, as JSON:

- the members' reads, for anyone, about themselves: `openpadel my-places`, `openpadel open-programs`, `openpadel free-courts`;
- the staff reads, for staff: `openpadel day`, `openpadel people`, `openpadel alerts`, `openpadel reports`. A coach sees only their own
  work, as in the staff app. Emails and phone numbers come shortened (`m...@example.com`): enough to tell two people
  apart, never a way to reach members from outside the club's apps. That's everywhere in what comes back: inside
  notes, alerts and previews too, except what you typed yourself. `openpadel people` searches names only, so a shortened
  address can't be pieced back together from its answers; look someone up by email in the staff app.

**Changes** are `openpadel <thing> <change>`. Each one first prints its preview, worded exactly as the apps and the
connector word it, and stops with exit code 10. Nothing has changed yet. Then either:

- `openpadel confirm <run_id>` does what was previewed;
- or the same command again with `--yes` confirms that same preview. `--yes` on its own previews and does it at
  once.

A preview lasts 15 minutes. A change that needs a staff member's approval waits for it, up to a week (exit code 11).

**Asked twice, done once.** The same command with the same input, within 10 minutes of being done, isn't done
again: it says it was done (`already: true`, exit 0) and gives the run. So an agent that retries after a dropped
connection doesn't book twice.

- Anything that change made, changed since by anyone (in the app, another command, someone else), makes it a new
  change: rename a court A, have the desk rename it back, then ask for A again, and it's previewed and made like any
  other (not "already done"). The command asks the club before it says "already done".
- `--again` does it a second time.
- `--key <yours>` names one change, so a retry with the same key is the same change for a day, however many other
  commands run in between. The same key with a different input is refused (exit 7, `cli.key_reused`), and nothing
  is made: use a new key.
- After a conflict (exit 7), or a confirm refused because you may no longer do it (exit 3), the preview is forgotten
  here: the same command again previews afresh, and with `--yes` does it.
- `openpadel confirm` on a run already done just says so.
- The previews kept on a computer are the signed-in person's: when someone else signs in to the club there, the
  earlier person's go.

**Names where ids go.** For staff, `--person "Maria Lopez"`, `--coach`, `--court`, `--courts "Court 1,Court 2"`,
`--location`, `--program` and `--plan` take a name or an id.

- A name that fits more than one lists them with their ids (exit code 5).
- A name that fits nothing says so (exit code 4).
- `--person me` is whoever signed in, for anyone.
- A member gives ids, which their own reads list, such as a court's from `openpadel free-courts`.

**Times** without a zone are on the club's clock: `--starts-at "2026-11-20 18:00"` is 6 PM at the club, wherever the
command runs. A time with its zone (`2026-11-21T02:00:00Z`) is used as it is.

**Amounts** are in cents, as the club's apps keep them: `--price-cents 3000` is $30.00, or €30,00 at a club in euros.

**Bigger input:** `--input file.json`, `--input '{...}'` or `--input -` (from what's piped in) gives the whole input
as JSON, and any flags change it. That's for lists of days, translations, score sets and the like.

**`--json`** prints one JSON object a line:

| `status` | What it means | Exit code |
|---|---|---|
| `ok` | a read, with `data` | 0 |
| `preview` | with `run_id`, `summary`, `undo`, `expires_at`, and `confirm`, the command that does it | 10 |
| `done` | with `run_id`, `summary`, `result`, and `already: true` when it was done before | 0 |
| `waiting_approval` | with `run_id`, `summary` | 11 |
| `waiting_sign_in` | with `link`, `code` | 12 |
| `error` | with `code` (the club's error key, such as `error.court_taken`, or `cli.*`), `exit` and `message` (in the person's words), and `choices` for a name that fits several | as below |

`openpadel login` without `--no-wait` prints a `waiting_sign_in` line first, then its `done` line.

**Exit codes:**

| Code | Means |
|---|---|
| 0 | done (a read answered, a change made, or already made) |
| 1 | something unexpected went wrong |
| 2 | the command or its input is wrong: a flag that isn't there, a value it doesn't take, one missing |
| 3 | refused: your role doesn't do it, a club rule says no, or it's over the weekly spending limit |
| 4 | not found: an id, or a name that fits nothing |
| 5 | a name fits more than one: the error lists them |
| 6 | only in the club's app |
| 7 | conflict: something changed since the preview, the time is taken, or the preview ran out |
| 8 | not signed in, or the sign-in ended: `openpadel login` |
| 9 | couldn't reach the club, or it's busy: try again shortly |
| 10 | preview only: nothing changed yet |
| 11 | waiting for a staff member's approval |
| 12 | waiting for the person to allow the sign-in |

**Help:**

- `openpadel help` lists every command.
- `openpadel help <command>` gives its flags and an example.
- `openpadel schema <command>` gives its JSON schema and flags as JSON.
- `--lang=es` gives the command line's own words in Spanish. The club's words (previews, errors) come in the language
  the person chose at the club.

Text needs no quoting unless it has spaces.

## The first things an owner's or a desk's agent asks for

These ran against a demo club, Kestrel Padel. The previews are the club's own words, so a club's agent sees exactly
these.

**Who am I there?**

```
$ openpadel whoami
Robin Hale at Kestrel Padel (owner). Spending limit $0.00 a week, $0.00 left this week.
```

**What's on today, or another day?**

```bash
openpadel day --location Main --json
openpadel day --location Main --date 2026-11-20 --json
```

Each court's bookings, blocks and program dates, who's playing and what's owed, as the staff app's Schedule shows them.

**What needs someone?**

```bash
openpadel alerts --json
```

Places left empty at the last minute, questions waiting, money owed, programs short of their minimum.

**Find a member:**

```
$ openpadel people maria
[
  {
    "id": "01a1b732-387e-744f-8611-c9e258794d79",
    "display_name": "Maria Lopez",
    "email": "m...@example.com",
    "roles": ["member"],
    ...
  }
]
```

**Which courts are free?**

```bash
openpadel free-courts --location Main --date 2026-11-20 --minutes 90 --json
```

**Book a court for a member:**

```
$ openpadel booking request --court "Court 1" --starts-at "2026-11-20 18:00" --minutes 90 --pay whole --person "Maria Lopez"
Preview (nothing has changed yet):
  Book Court 1, Fri, Nov 20, 6:00 PM, for 90 minutes: $60.00, paid now.
To do it: openpadel confirm 01a1b732-3980-78fe-858c-10941bb1d1a0, or the same command again with --yes. The preview lasts until 10:23 AM.
```

**Put on a clinic, give it a date, and open it for sign-up:**

```
$ openpadel program create --location Main --kind clinic --name "Tuesday drills" --capacity 8 --price-cents 3000 --yes
Create Tuesday drills (clinic), 8 places at $30.00. Its results don't change levels.
Done.
$ openpadel session add --program "Tuesday drills" --starts-at "2026-11-20 18:00" --ends-at "2026-11-20 19:30" --courts "Court 2" --yes
Add Tuesday drills on Fri, Nov 20, 6:00 PM, on Court 2.
Done.
$ openpadel program publish --program "Tuesday drills" --yes
Publish Tuesday drills so players can sign up. Members will see it as a clinic at $30.00, with 8 places. It has 1 date: Fri, Nov 20, 6:00 PM, on Court 2.
Done.
```

**Sign people up:**

```
$ openpadel enrolment join --program "Tuesday drills" --person "Maria Lopez"
Preview (nothing has changed yet):
  Sign Maria Lopez up for Tuesday drills for $30.00.
To do it: openpadel confirm 01a1b732-3a45-790c-ba66-7a0a6bf410ee, or the same command again with --yes. The preview lasts until 10:23 AM.
```

**Close a court for a while:**

```bash
openpadel court block --courts "Court 3" --starts-at "2026-11-20 07:00" --ends-at "2026-11-20 09:00" --reason resurfacing
```

**Set a new member's level:**

```bash
openpadel level set --person "Maria Lopez" --level 4 --reason "Played 4.0 at her last club"
```

**And what it won't do:**

```
$ openpadel waiver accept
That one (Accept the waiver) is only ever done in the club's app, never from the command line or an assistant.
```

## For agents: working with a club

- **Show the person the preview, in its own words, and confirm only once they agree.** Use `--yes` only for what the
  person asked for in so many words, and never for money or messages to members on your own judgement.
- **Branch on the exit code, and read `--json`.** Act on 10 (show the preview), 5 (ask which one), 7 (read again,
  then preview again) and 8 (ask the person to sign in again). Don't parse the human text.
- **Retry with the same command or the same `--key`**, never with `--again`, after a timeout or a dropped connection.
- **Never ask the person for a password, an emailed code or a card number.** Those are typed on the club's pages, and
  card details on Stripe's.
- **Members' details stay at the club.** What reads return is for the task at hand, not to keep or send elsewhere.
