# kumi: the club's commands, for agents and people

`kumi` does from a terminal what the staff and members' apps do: read the day, find a member, book a court, put on a
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
On the club's own server, `kumi doctor`, `kumi setup`, `kumi backup` and the other server commands are the same tool
(`kumi` with nothing after it lists them; see the [setup guide](../setup/README.md)).

## Install

On any computer with Node 24:

```bash
git clone <Kumi's repository> kumi && cd kumi && npm ci
alias kumi="node $PWD/apps/server/src/cli.ts"    # or: npm run kumi -- <command>
```

Use the release the club runs, or a newer one. `kumi login` says when they differ, since a command new in one may be
missing from the other.

## Signing in

```bash
kumi login https://staff.yourclub.com
```

Use the staff app's address or the members' app's: both work. A browser opens on the club's own sign-in page. There
the person:

1. gets a code by email (or a text, when the club texts);
2. gives their second step, if they sign in with two;
3. chooses how much the connection may spend for them each week: nothing to start, which is right for staff work,
   since money a member pays for isn't counted against the staff member's limit.

They can disconnect it any time in the app, under Profile, Assistants. It's listed there as `kumi (<this computer's
name>)`.

**With no browser** (a server, a remote shell, an agent's sandbox), sign in by a code instead:

```bash
kumi login https://staff.yourclub.com --device
```

It prints a link and a code such as `TKBW-VMFJ`. The person opens the link on their phone, signs in, checks the page
shows the same code, and allows it. The command waits up to 10 minutes and finishes by itself.

**For an agent**, which shouldn't sit on one command for minutes, there's a two-step version:

```bash
kumi login https://staff.yourclub.com --device --no-wait --json
# {"status":"waiting_sign_in","link":"https://staff.yourclub.com/oauth/device?code=TKBW-VMFJ","code":"TKBW-VMFJ",...}   exit 12
#   ...the agent shows the person the link and the code, and they allow it...
kumi login https://staff.yourclub.com --device --json
# {"status":"done","club_name":"Kestrel Padel","person":"Robin Hale",...}   exit 0
```

The agent never sees a password or a code from an email. The person types those on the club's page.

**Where the sign-in is kept:**

- in the system keychain when there is one (`secret-tool` on Linux, the Keychain on a Mac);
- otherwise in `~/.config/kumi/secrets.json`, readable by the user only. `KUMI_CONFIG_DIR` moves the folder, and
  `KUMI_CLI_KEYCHAIN=0` keeps the tokens in the file.

The access token lasts an hour and renews itself, one command at a time, so commands run in parallel don't trip over
each other.

**Several clubs and sign-ins:**

- `kumi clubs` lists the clubs signed in to here.
- `kumi use <address>` picks the one commands go to.
- `--club <address>` (or `KUMI_CLUB`) picks one for a single command.
- `kumi logout` signs out here and ends the connection at the club.
- `kumi whoami` says who you are there, your roles, and what the spending limit leaves this week.

## How commands work

**Reads** print what the apps show, as JSON:

- the members' reads, for anyone, about themselves: `kumi my-places`, `kumi open-programs`, `kumi free-courts`;
- the staff reads, for staff: `kumi day`, `kumi people`, `kumi alerts`, `kumi reports`. A coach sees only their own
  work, as in the staff app. Emails and phone numbers come shortened (`m...@example.com`): enough to tell two people
  apart, never a way to reach members from outside the club's apps.

**Changes** are `kumi <thing> <change>`. Each one first prints its preview, worded exactly as the apps and the
connector word it, and stops with exit code 10. Nothing has changed yet. Then either:

- `kumi confirm <run_id>` does what was previewed;
- or the same command again with `--yes` confirms that same preview. `--yes` on its own previews and does it at
  once.

A preview lasts 15 minutes. A change that needs a staff member's approval waits for it, up to a week (exit code 11).

**Asked twice, done once.** The same command with the same input, within 10 minutes of being done, isn't done
again: it says it was done and gives the run. So an agent that retries after a dropped connection doesn't book twice.

- `--again` does it a second time.
- `--key <yours>` names a change, so a retry with the same key is the same change for a day.
- `kumi confirm` on a run already done just says so.

**Names where ids go.** For staff, `--person "Maria Lopez"`, `--coach`, `--court`, `--courts "Court 1,Court 2"`,
`--location`, `--program` and `--plan` take a name or an id.

- A name that fits more than one lists them with their ids (exit code 5).
- A name that fits nothing says so (exit code 4).
- `--person me` is whoever signed in, for anyone.
- A member gives ids, which their own reads list, such as a court's from `kumi free-courts`.

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

`kumi login` without `--no-wait` prints a `waiting_sign_in` line first, then its `done` line.

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
| 8 | not signed in, or the sign-in ended: `kumi login` |
| 9 | couldn't reach the club, or it's busy: try again shortly |
| 10 | preview only: nothing changed yet |
| 11 | waiting for a staff member's approval |
| 12 | waiting for the person to allow the sign-in |

**Help:**

- `kumi help` lists every command.
- `kumi help <command>` gives its flags and an example.
- `kumi schema <command>` gives its JSON schema and flags as JSON.
- `--lang=es` gives the command line's own words in Spanish. The club's words (previews, errors) come in the language
  the person chose at the club.

Text needs no quoting unless it has spaces.

## The first things an owner's or a desk's agent asks for

These ran against a demo club, Kestrel Padel. The previews are the club's own words, so a club's agent sees exactly
these.

**Who am I there?**

```
$ kumi whoami
Robin Hale at Kestrel Padel (owner). Spending limit $0.00 a week, $0.00 left this week.
```

**What's on today, or another day?**

```bash
kumi day --location Main --json
kumi day --location Main --date 2026-11-20 --json
```

Each court's bookings, blocks and program dates, who's playing and what's owed, as the desk's Courts page shows them.

**What needs someone?**

```bash
kumi alerts --json
```

Places left empty at the last minute, questions waiting, money owed, programs short of their minimum.

**Find a member:**

```
$ kumi people maria
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
kumi free-courts --location Main --date 2026-11-20 --minutes 90 --json
```

**Book a court for a member:**

```
$ kumi booking request --court "Court 1" --starts-at "2026-11-20 18:00" --minutes 90 --pay whole --person "Maria Lopez"
Preview (nothing has changed yet):
  Book Court 1, Fri, Nov 20, 6:00 PM, for 90 minutes: $60.00, paid now.
To do it: kumi confirm 01a1b732-3980-78fe-858c-10941bb1d1a0, or the same command again with --yes. The preview lasts until 10:23 AM.
```

**Put on a clinic, give it a date, and open it for sign-up:**

```
$ kumi program create --location Main --kind clinic --name "Tuesday drills" --capacity 8 --price-cents 3000 --yes
Create Tuesday drills (clinic), 8 places at $30.00. Its results don't change levels.
Done.
$ kumi session add --program "Tuesday drills" --starts-at "2026-11-20 18:00" --ends-at "2026-11-20 19:30" --courts "Court 2" --yes
Add Tuesday drills on Fri, Nov 20, 6:00 PM, on Court 2.
Done.
$ kumi program publish --program "Tuesday drills" --yes
Publish Tuesday drills so players can sign up. Members will see it as a clinic at $30.00, with 8 places. It has 1 date: Fri, Nov 20, 6:00 PM, on Court 2.
Done.
```

**Sign people up:**

```
$ kumi enrolment join --program "Tuesday drills" --person "Maria Lopez"
Preview (nothing has changed yet):
  Sign Maria Lopez up for Tuesday drills for $30.00.
To do it: kumi confirm 01a1b732-3a45-790c-ba66-7a0a6bf410ee, or the same command again with --yes. The preview lasts until 10:23 AM.
```

**Close a court for a while:**

```bash
kumi court block --courts "Court 3" --starts-at "2026-11-20 07:00" --ends-at "2026-11-20 09:00" --reason resurfacing
```

**Set a new member's level:**

```bash
kumi level set --person "Maria Lopez" --level 4 --reason "Played 4.0 at her last club"
```

**And what it won't do:**

```
$ kumi waiver accept
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
