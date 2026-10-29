# Kumi

Free, open-source software (AGPL-3.0) that runs a padel club: bookings, payments, memberships,
open matches, clinics and fair levels, with the club's own branded app and a manager that works
on a phone. Agents are built in: members and staff can ask Kumi, or connect their own assistant
over MCP. A club can run it itself or have it hosted.

**Status:** pre-alpha, private while the first version is built. Not ready for use.

## Layout

| Path | What |
|---|---|
| `packages/core` | Actions, schemas, database types and the permission check, shared by everything |
| `packages/i18n` | English and Spanish catalogs and formatting helpers |
| `apps/server` | The API, the MCP endpoint and background jobs (Hono on Node 24) |
| `apps/member` | The members' installable web app (Preact) |
| `apps/manager` | The staff app for phone and web (Preact) |
| `packages/ui` | What both apps share: sign-in, the preview sheet, the profile page, styles |
| `migrations` | Plain SQL migrations, numbered, each applied once |

## Stack

TypeScript end to end on Node 24 LTS, Hono, Postgres 17 with Kysely over node-postgres, Zod Mini
schemas shared by the API, the MCP tools and the forms, the official MCP SDK, and Preact. The
reasons and measurements are in the design notes (`docs/`, to come).

## Development

Needs Node 24 and Docker.

```bash
npm install
docker run -d --rm --name kumi-dev-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:17-alpine
docker exec kumi-dev-pg createdb -U postgres kumi
node apps/server/src/seed.ts                                   # a demo club, owner owner@kestrel.test
KUMI_PUBLIC_URL=http://localhost:5173 node apps/server/src/main.ts   # API on 8790; emailed codes go to its log
npm run dev -w @kumi/manager                                    # the staff app on http://localhost:5173
npm run dev -w @kumi/member                                     # the members' app on http://localhost:5174
npm test && npm run typecheck
```

Open the staff app at `localhost` (not `127.0.0.1`), so passkeys and the session cookie see one origin.

## Licence

AGPL-3.0. See `LICENSE`.
