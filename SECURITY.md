# Security

## Reporting a problem

Please report security problems privately, never in a public issue: through this repository's
**Security** tab ("Report a vulnerability"), which is turned on when the repository goes public, or
until then by email to `security@<your-domain>`. Say what you found, how to reproduce it, and what it
could let someone do. You'll get an answer within a few days, and credit in the release that fixes it if
you'd like it.

## What openPadel does

- **No passwords.** People sign in with a code sent to their email or, when the club texts, their phone
  (hashed, valid 10 minutes, 5 tries), or a passkey. Staff who have a passkey must use it (or two steps) for sensitive changes, such as roles
  and the club's payment account.
- **Two steps for staff.** Owners, managers and the club's own roles (or every staff role, if the club
  chooses) sign in with a passkey, or with the emailed code and then an authenticator app's code (TOTP,
  RFC 6238, each code good once) or a one-time recovery code. Until the second step is given, the
  session can do nothing but finish signing in. Recovery codes are kept as salted scrypt hashes. The
  authenticator's secret is sealed (below) and kept out of the change log.
- **Secrets sealed with the server's own key.** Authenticator secrets, the push signing key and
  everything in the owner's vault are sealed with AES-256-GCM under `KUMI_SECRET_KEY` (32 random bytes made
  at install, never printed), a fresh nonce each time and the key's id in front, so the key can be changed
  (`openpadel rotate-key`). Production won't start without it. Two kinds of link key stay as they are because
  they're looked up by value: a club news email's unsubscribe key and a coach's calendar link (both do one
  thing, can be replaced, and are kept out of the change log).
- **The vault** (the owner's keys and documents) is the owner's alone: managers are told no, no role the
  club makes can hold it, and agents can't use it. A value or file reaches the server first and is sealed
  there; the action names only that upload, so neither an action's input nor the change log carries it. A
  secret is never shown again (only its last four characters); a document comes back only as a download
  (type checked by its first bytes, `nosniff`, never shown in the page), and each download is kept.
- **Backups** are dumped with a manifest of every table's rows from one snapshot. Offsite copies are sealed
  with `KUMI_BACKUP_KEY` (AES-256-GCM) before they leave the server, signed for the club's own storage
  with AWS Signature Version 4, and restored into a scratch database once a month to check they work.
- **Bot protection** with no third party on sign-up, sign-in codes and opening a card form: a hidden
  field, and a signed, short-lived SHA-256 proof of work that gets harder for an address that keeps
  failing. Production won't start with it off.
- **Roles the club makes** can hold only what a manager does without asking, and nobody can make or give
  a role that does more than they can.
- **Limits on guessing and flooding.** Each address gets a limited number of code requests, code
  checks, sign-ups and passkey sign-ins before it has to wait, and codes to join are capped club-wide
  each hour, so a stranger can't use the club to send mail. Sign-in answers the same way whether or
  not an email has an account.
- **Changes only from the club's own pages.** The session cookie is HTTP-only, Secure and
  SameSite=Lax. Changes a browser marks as coming from another site are refused, and so are
  form-style posts except on the agent sign-in pages.
- **Every change is an action** with a permission check, a preview, an audit record and, where it can
  be, an undo. Staff permissions are by role and location.
- **Headers:** the apps allow scripts only from the club and Stripe and can't be framed by another
  site; the API sends its own strict headers.
- **Payments:** card details go from the member's browser to Stripe and never reach openPadel. A live
  Stripe key is refused outside production.
- **Agents** connect through OAuth with tokens scoped to one person and one club; refresh tokens rotate,
  and reusing an old one revokes the whole family.
- **Dependencies** are pinned exactly, to releases at least two weeks old.

## What a club running openPadel itself should do

- Keep the server updated: the setup installs Ubuntu's automatic security updates; ship openPadel's
  updates with `deploy/ship.sh` when they come out.
- Keep keys only in `/etc/kumi/kumi.env` on the server. Never commit them, paste them into a chat or
  send them by email.
- Set up offsite backups (`docs/setup/accounts/offsite-backups.md`), and keep `KUMI_BACKUP_KEY` and
  `KUMI_SECRET_KEY` in a password manager away from the server: without the backup key the offsite copies
  can't be opened.
- Staff, especially owners, should add a passkey (Profile in the staff app), and keep their recovery
  codes somewhere safe. An owner locked out is reset on the server: `openpadel reset-sign-in <email>`.
- Run `openpadel doctor` after any change to the server.
