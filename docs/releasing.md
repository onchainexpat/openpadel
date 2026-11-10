# Releasing openPadel

## Before the repository goes public

Do these once, before the first public release:

- [ ] **Turn on private vulnerability reporting:** GitHub, Settings, then Security (Code security),
      then "Private vulnerability reporting": Enable. `SECURITY.md` sends people to the Security tab's
      "Report a vulnerability" button, which only appears once this is on.
- [ ] **The CLA** (decided 9 November 2026, over a DCO): `CLA.md` names Onchain Expat (the onchainexpat account); have a lawyer read it,
      and check `.github/workflows/cla.yml` asks on a test pull request from another account.
- [ ] **The names:** openPadel for the software (decided 7 November 2026), and the trademark search on "Kumi", the
      hosted service's name, done.
- [ ] **Real contact addresses:** `security@openpadel.dev` and `conduct@openpadel.dev` forward to an inbox someone
      reads (send each a test), and the `<your-org>` placeholder in the clone commands (`docs/setup/accounts/server.md`,
      `deploy/docker/README.md`) with the repository's real address.
- [ ] **Tests on every push:** add `push:` to `.github/workflows/test.yml` (public repositories don't use up Actions minutes).

## Cutting a release

1. **Everything passes:** `npm run typecheck && npm test`, and a walkthrough of what changed in a browser.
2. **The changelog:** move "not released yet" to the version and date. Say what changed for a club
   in plain words, and under **When updating** anything a club must do (most releases: nothing).
3. **The version:** set it in the root `package.json` (`/health` and `openpadel doctor` show it).
4. **Test the update itself:** restore a copy of a database from the previous release, start the
   new server on it (database changes apply on start), and check `openpadel doctor` and the data.
5. **Tag and publish:** `git tag -a v0.x.y -m "openPadel 0.x.y"`, push the tag, and make a GitHub release
   with the changelog's section as its notes.

## Rules for database changes
- Migrations are plain SQL, numbered, applied once in order, and never edited after a release.
- Prefer changes an older server can live with (add a column or table, then use it in the next
  release), so going back a release after a bad update works.
- A change that needs a club to act (a new required setting, a manual step) goes under
  "When updating", and `openpadel doctor` should check for it.
