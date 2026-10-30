# Releasing Kumi

## Before the repository goes public

Do these once, before the first public release:

- [ ] **Turn on private vulnerability reporting:** GitHub, Settings, then Security (Code security),
      then "Private vulnerability reporting": Enable. `SECURITY.md` sends people to the Security tab's
      "Report a vulnerability" button, which only appears once this is on.
- [ ] **Decide how outside contributions are signed:** DCO (a sign-off line on each commit) or a CLA.
- [ ] **The name:** the trademark search on "Kumi" done.
- [ ] Tests running on every pull request (GitHub Actions), a contribution guide and a code of conduct.

## Cutting a release

1. **Everything passes:** `npm run typecheck && npm test`, and a walkthrough of what changed in a browser.
2. **The changelog:** move "not released yet" to the version and date. Say what changed for a club
   in plain words, and under **When updating** anything a club must do (most releases: nothing).
3. **The version:** set it in the root `package.json` (`/health` and `kumi doctor` show it).
4. **Test the update itself:** restore a copy of a database from the previous release, start the
   new server on it (database changes apply on start), and check `kumi doctor` and the data.
5. **Tag and publish:** `git tag -a v0.x.y -m "Kumi 0.x.y"`, push the tag, and make a GitHub release
   with the changelog's section as its notes.

## Rules for database changes
- Migrations are plain SQL, numbered, applied once in order, and never edited after a release.
- Prefer changes an older server can live with (add a column or table, then use it in the next
  release), so going back a release after a bad update works.
- A change that needs a club to act (a new required setting, a manual step) goes under
  "When updating", and `kumi doctor` should check for it.
