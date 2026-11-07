# Contributing to openPadel

Thank you for helping. openPadel runs real clubs, with real members and real money, so changes are
careful, small and tested.

## Before you start
- **Read [`AGENTS.md`](AGENTS.md).** Its rules for changing the code aren't up for debate: every
  write is an action with a preview and an audit; leaving and refunding are separate; no double
  bookings; English and US Spanish for every string; the club's time zone everywhere; no em dashes in
  anything a club or player reads; plain SQL migrations never edited after a release; dependencies
  pinned to releases at least two weeks old.
- **Say what you'd like to change first,** in an issue, for anything bigger than a fix. It saves
  work on both sides.
- **Security problems** go through [`SECURITY.md`](SECURITY.md), never a public issue.

## Working on it
```bash
npm install
docker run -d --rm --name kumi-dev-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:17.9-alpine
docker exec kumi-dev-pg createdb -U postgres kumi
node apps/server/src/seed.ts            # a demo club; or: npm run openpadel -- setup apply club.example.yaml
KUMI_PUBLIC_URL=http://localhost:5173 node apps/server/src/main.ts
npm run dev -w @kumi/manager            # the staff app, http://localhost:5173
npm run dev -w @kumi/member             # the members' app, http://localhost:5174
```
Sign-in codes appear in the server's output.

## Ask the club's test set

After changing the questions or how sure the model must be (`apps/server/src/answerer.ts`), run
`node apps/server/test/ask_the_club_live.ts` with `KUMI_TYPESAFE_API_KEY` and `KUMI_ANTHROPIC_API_KEY`
in the environment. It sends a labelled set of questions to both models and costs cents. A wrong fact
sent is the result that matters; a missed one is better than a wrong one.

## A good pull request
- **Passes** `npm run typecheck && npm test`. Each test file gets its own fresh database.
- **Has tests** for what it changes, and says in the description how you checked it in a browser
  if it changes a screen.
- **Is small,** with commit messages that say why, not only what.
- **Keeps both languages:** new wording goes in `packages/i18n/src/en.ts` and `es.ts` together,
  using the US Spanish word list in `AGENTS.md`.
- **Writes keys the apps can find:** each app ships only the keys its code names, found by the build
  (`packages/i18n/src/wording.ts`). In app code, call `t()` with the key as a string (`t("ui.book")`), a
  choice of strings (`t(paid ? "ui.paid" : "ui.unpaid")`), or a template whose fixed start names the
  family (`` t(`kind.${k}` as Key) `` ships every `kind.*`). A key built any other way can't be found, and
  `packages/i18n/test/wording.test.ts` fails, naming the line. The server has every key in both languages.
- **Adds a changelog line** under "not released yet" in [`CHANGELOG.md`](CHANGELOG.md) when a club
  would notice the change.

## The licence
openPadel is AGPL-3.0. By contributing, you agree your contribution is under the same licence.
