# Security

## Reporting a problem

Please report security problems privately, through this repository's **Security** tab ("Report a
vulnerability"), not in a public issue. Say what you found, how to reproduce it, and what it could
let someone do. You'll get an answer within a few days, and credit in the release that fixes it if
you'd like it.

## What Kumi does

- **No passwords.** People sign in with a code sent to their email (hashed, valid 10 minutes, 5 tries)
  or a passkey. Staff who have a passkey must use it for sensitive changes, such as roles and the
  club's payment account.
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
- **Payments:** card details go from the member's browser to Stripe and never reach Kumi. A live
  Stripe key is refused outside production.
- **Agents** connect through OAuth with tokens scoped to one person and one club; refresh tokens rotate,
  and reusing an old one revokes the whole family.
- **Dependencies** are pinned exactly, to releases at least two weeks old.

## What a club running Kumi itself should do

- Keep the server updated: the setup installs Ubuntu's automatic security updates; ship Kumi's
  updates with `deploy/ship.sh` when they come out.
- Keep keys only in `/etc/kumi/kumi.env` on the server. Never commit them, paste them into a chat or
  send them by email.
- Copy the nightly backups off the server (`docs/setup/accounts/server.md`).
- Staff, especially owners, should add a passkey (Profile in the staff app).
- Run `kumi doctor` after any change to the server.
