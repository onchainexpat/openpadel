# openPadel, for agents and people

openPadel is free and open source padel software that runs a club (see `README.md`). It was called Kumi until
7 November 2026: setting names are `OPENPADEL_` (the old `KUMI_` ones are still read); paths (`/etc/kumi`, `/var/lib/kumi`),
the `kumi` command and package names keep theirs. This file is read by
coding agents such as Claude Code and Codex. There are two jobs, with their own rules:

- **Setting up openPadel for a club** (an owner, or the owner's agent): clone over https, check out the newest
  release tag, and start at [`docs/setup/README.md`](docs/setup/README.md) in that checkout; follow the rules just below.
- **Working a club day to day** (an owner's, a desk's or a coach's agent): use the command line first,
  [`docs/cli/README.md`](docs/cli/README.md). `openpadel login <the staff app's address> --device --no-wait --json`
  gives a link and a code for the person to allow, then `openpadel help`. Every change previews first: show the
  person the preview's words and confirm only on their say-so. Chat assistants (Claude, ChatGPT) use the club's
  connector at `/mcp` instead: the same tools, the same rules.
- **Changing openPadel's code:** the rules further down.

## Setting up a club: the rules
1. **Run `openpadel doctor --json` first and after every step,** and fix the first `fail`. `off` means an
   optional piece the club hasn't chosen (texts, Playtomic, ask the club); the `warn`s that say
   practice mode stay until go-live. Follow the order of [`docs/setup/README.md`](docs/setup/README.md),
   not the order of the checks: Stripe comes before texts. Each check names the guide that fixes it.
2. **Never ask the owner to paste a secret into the chat** (API keys, passwords, codes). Tell them
   which setting it is and where it goes (`/etc/kumi/kumi.env` on the server), and let them type it
   there themselves. Never print the settings file or a key. `openpadel export` and restoring an export ask
   for the file's passphrase: the owner runs those in their own terminal and types it. Never read a sign-in
   code out of the server's log for the owner: before email is set up, `openpadel sign-in-link <owner's email>`
   prints a one-time link (15 minutes) that you hand them without opening it; they set up a second step
   (passkey or authenticator app, so their phone at hand) before the staff app does anything.
3. **Never ask for a Social Security number, ID, bank account or card details.** Stripe collects
   those on its own pages, from the owner directly.
4. **The owner creates every outside account** (domain, server, Stripe, Resend, Playtomic API keys)
   and does every step that asks for identity, payment or a legal promise. You tell them exactly
   what to click and what to choose.
5. **Preview before changing:** `openpadel setup plan` before `openpadel setup apply`, and show the owner the
   plan. Change the club only through `openpadel` and the apps, never in the database directly.
6. **Nothing reaches real members or real money during setup.** Keep practice mode on, use test
   Stripe keys, and only turn either off when the owner says so in their own words.
7. **Offsite backups before go-live** ([docs/setup/accounts/offsite-backups.md](docs/setup/accounts/offsite-backups.md)):
   the owner creates the storage and its key; you run `openpadel backup`, `openpadel offsite` and
   `openpadel restore-test` until `openpadel doctor` shows `offsite` and `restore_test` as `ok`. Ask the owner to
   keep `OPENPADEL_BACKUP_KEY` and `OPENPADEL_SECRET_KEY` in a password manager, looking at them in their own
   terminal (or the server provider's web console); you never read them. `openpadel keys` shows only their last
   4 characters, for the owner to check their copies.
8. **Updates go through `deploy/ship.sh`** (or `deploy/docker/update.sh`), which snapshot the database and
   put everything back by themselves if the new release doesn't come up. `sudo openpadel rollback --yes` loses
   what happened since the update: only with the owner's say-so, in their own words.
9. **The phone apps install from the club's own address** ([docs/setup/apps.md](docs/setup/apps.md)): tell the
   owner so. Store apps (Google Play, the App Store) need the club's own developer accounts, in its company's name,
   with their fees: the owner enrols and pays for those; you never enrol one for them. openPadel doesn't build store
   apps yet.

## Changing openPadel's code

### Read first
Design notes are added to `docs/` as each part needs them. Until a part has one, the code, its tests
and [`CHANGELOG.md`](CHANGELOG.md) are the record of what it does and why.

### Rules that are not up for debate
1. **Every write is an action** from the catalogue: typed input (Zod Mini), a permission check,
   a plan the person sees before anything changes, apply, an undo kind, an audit row, and an
   idempotency key. No route, job or agent writes to the database any other way.
2. **Leaving and refunding are separate decisions.** Removing someone from a booking, match or
   roster never moves money by itself; the plan shows what the refund rule gives and staff can
   change it, with a reason.
3. **Two things can't hold one court at one time,** enforced by the database's exclusion
   constraint. Every write that takes court time locks its courts first, in court-id order.
4. **English and Spanish for every string** a person sees, from the first commit. No string is
   written straight into a component or a message.
   Spanish is US and Latin American Spanish, with "tú" throughout. The words to use:
   - "cancha" (court), "contador" (accountant), "miembro" (member), "dueño" (owner);
   - "inscribirse" (sign up), "lugar" or "cupo" (a place), "agregar" (add), "vencer" (expire),
     "monto" (amount), "Listo" (done);
   - not Spain's "pista", "apuntarse", "plaza", "añadir", "caducar", "importe" or "Hecho".

   Phrase things about a person so they don't need a gender ("ya se inscribió", not "ya está
   inscrito"). The `thing.*` words carry their article ("la cancha"), since Spanish nouns have
   gender. A count goes in a plural message, never a plain one.
5. **Everything runs on the club's time zone,** never the server clock.
6. **Messages:** consent checked on the server before every send, STOP always works, quiet hours
   respected, and texts kept to the plain GSM-7 alphabet (no emoji in texts).
7. **No em dashes** in anything a member, player or club reads.
8. **Migrations are plain SQL,** numbered, applied once, never edited after they ship.
9. **Dependencies are pinned exactly,** to releases at least two weeks old.
10. **TypeScript that Node can run directly:** no enums, namespaces or parameter properties.

### Commits
Commit with explicit paths (`git commit -m "..." -- path ...`), small and with a message that
says why.
