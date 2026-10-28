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
| `migrations` | Plain SQL migrations, numbered, each applied once |

## Stack

TypeScript end to end on Node 24 LTS, Hono, Postgres 17 with Kysely over node-postgres, Zod Mini
schemas shared by the API, the MCP tools and the forms, the official MCP SDK, and Preact. The
reasons and measurements are in the design notes (`docs/`, to come).

## Licence

AGPL-3.0. See `LICENSE`.
