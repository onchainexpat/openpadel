# The plugin manifest: `openpadel-plugin.json`

Everything a plugin asks of a club, declared up front. openPadel checks it strictly before it previews an install: a
field it doesn't know, a missing one, or a value out of shape, and it isn't installed. The words in it are shown to the
club in the install preview, in English and Spanish, so they're written for the club's owner, not for developers.
(Like everything a club reads, they may not contain em or en dashes.) The checker is
[packages/core/src/plugin_manifest.ts](../../packages/core/src/plugin_manifest.ts); a test checks that every field
below is the checker's and that the [example](examples/court-lights/openpadel-plugin.json) passes it.

Words in both languages are written `{ "en": "…", "es": "…" }` (US and Latin American Spanish, with "tú").

| Field | What it is |
|---|---|
| `$schema` | Optional: an address for editors. Ignored. |
| `manifest_version` | `1`. |
| `name` | The plugin's name at the club: lowercase letters, digits and dashes, 3 to 40 (`court-lights`). It names its keys in the vault (`court-lights/HA_TOKEN`) and its hook address (`/plugins/court-lights/hook`). |
| `publisher` | Who makes it, as the club will read it. |
| `version` | `1.2.3`, or `1.2.3-beta.1`. A new version is installed with `plugin update`. |
| `homepage` | Its page (http or https). |
| `licence` | Its licence, as an SPDX name (`AGPL-3.0-only`, `MIT`). |
| `description` | What it does, in both languages (up to 500 characters each). |
| `grants` | Its role: the club's actions it may plan, each `{ "action": "court.block", "mode": "allow" \| "ask", "scope": "any" \| "own" }` (scope defaults to `any`). `ask` waits in the club's Approvals for a person. Only actions a club's own role may hold (what a manager does without asking), never one that makes or changes agents, plugins, webhooks, roles, the vault, assistants, support access or the club's settings, and never one only done in the app. Up to 100. |
| `reads` | The parts of the club it reads beyond what its actions cover: `bookings`, `courts`, `programs`, `members`, `memberships`, `money`, `messages`, `levels`, `coaches`, `settings`. |
| `events` | The events it's sent (the club's webhook events, [docs/agents/webhooks.md](../agents/webhooks.md)). Each must be in a part of the club it reads. |
| `secrets` | The keys it needs from the club's vault, each `{ "name": "HA_TOKEN", "label": {…}, "where": {…} }`: a name in capitals, what it is, and where the owner gets it. Up to 20. |
| `settings` | Its options, in the order a person sets them (below). Up to 20. |
| `data_out` | What member data it sends where, in plain words. It goes into the club's list of services that see member data and its privacy policy's, as it's installed. Say so when it sends nothing about members. |
| `cost` | `{ "charges": true \| false, "note": {…} }`: whether its service charges, and roughly what. |
| `cards` | Where it shows something in the apps (rendered by the apps themselves, from data): each `{ "slot": "game" \| "court_tile" \| "member_profile" \| "money" \| "connectors", "title": {…} }`. Up to 10. |
| `health` | A path on its own address that answers 2xx when it's working (`/health`), for `openpadel doctor` and the club's list. |
| `hook` | Optional: `{ "from": {…} }`, who posts to `/plugins/<name>/hook` (a camera, Home Assistant). Without it, nothing is passed on. |
| `run` | How it runs, below. |

## `settings`

Each setting is one of:

| `type` | Its other fields | What the club gives |
|---|---|---|
| `string` | `max_length` (up to 500), `default` | Text. |
| `integer` | `minimum`, `maximum`, `default` | A whole number. |
| `boolean` | `default` | `true` or `false`. |
| `choice` | `choices`: `[{ "value": "daily", "label": {…} }, …]` (2 to 30), `default` | One of the values. |
| `courts` | | Courts, by name or id (kept as ids). |

Every setting also has `key` (lowercase letters, digits and `_`), `label` (both languages) and, except `boolean`,
`required`; all may have `help`. `plugin configure` refuses a setting the manifest doesn't have, a value out of shape,
and a court the club doesn't have, and says which.

## `run`

**Remote**: it runs at its publisher's address.

```json
"run": { "mode": "remote", "url": "https://lights.example.com/v1" }
```

The club POSTs its registration to `<url>/register`, events to `<url>/events` and hooks to `<url>/hook`, and checks
`<url><health>`. In production the address must be https and public, under the same rules as webhooks.

**Local**: it runs on the club's own server, as its own service.

```json
"run": { "mode": "local", "release_url": "https://github.com/…/releases/download/v1.0.0/plugin.tar.gz",
         "sha256": "<64 hex characters>", "entry": "bin/start",
         "image": "ghcr.io/example/plugin@sha256:<64 hex characters>" }
```

`release_url` is a `.tar.gz` pinned by its `sha256`; `entry` is the program to run inside it (a relative path, no
`..`). `image`, optional, is a container image pinned by digest, for Docker installs. The service gets `PORT` (it
listens on 127.0.0.1 there), `OPENPADEL_URL`, `OPENPADEL_MCP`, `OPENPADEL_TOKEN`, `OPENPADEL_WEBHOOK_SECRET`,
`OPENPADEL_HOOK_SECRET` and `OPENPADEL_PLUGIN` in its environment, instead of a registration.

## An example

[examples/court-lights/openpadel-plugin.json](examples/court-lights/openpadel-plugin.json): Home Assistant turning a
court's lights on before each booking. It changes nothing at the club, reads bookings and courts, is told when bookings
are made, moved or cancelled and courts blocked or freed, needs one key, and has five settings. The plugin itself is
[plugins/court-lights](../../plugins/court-lights/README.md).
