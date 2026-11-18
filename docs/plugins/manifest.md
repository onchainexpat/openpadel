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
| `secrets` | The keys it needs from the club's vault, each `{ "name": "HA_TOKEN", "label": {…}, "where": {…} }`: a name in capitals, what it is, and where the owner gets it. Up to 20. Optional marks ([below](#keys-the-owner-adds-and-keys-the-plugin-keeps)): `"optional": true`, never asked for; `"needed_when"`, asked for only when a setting has a value; and `"kept_by_plugin": true`, the plugin's own to write. |
| `settings` | Its options, in the order a person sets them (below). Up to 20. |
| `data_out` | What member data it sends where, in plain words. It goes into the club's list of services that see member data and its privacy policy's, as it's installed. Say so when it sends nothing about members. |
| `cost` | `{ "charges": true \| false, "note": {…} }`: whether its service charges, and roughly what. |
| `cards` | Where it shows something in the apps (rendered by the apps themselves, from data): each `{ "slot": "game" \| "court_tile" \| "member_profile" \| "money" \| "connectors", "title": {…} }`. Up to 10. What each card says, the plugin puts at run time ([README, Cards](README.md#cards)). |
| `health` | A path on its own address that answers 2xx when it's working (`/health`), for `openpadel doctor` and the club's list. |
| `hook` | Optional: `{ "from": {…} }`, who posts to `/plugins/<name>/hook` (a camera, Home Assistant). Without it, nothing is passed on. With `"challenge": true`, a GET to that address (a sender checking it first, as Meta does) is passed on too: [below](#a-senders-check-of-the-hook-challenge). |
| `channel` | Optional: `{ "kind": "whatsapp", "address_setting": "club_number" }`: it sends the club's messages on that channel ([README, A message channel](README.md#a-message-channel)). `address_setting` names its `string` setting with the club's own number there, shown to members. Needs a `hook`. One plugin per channel at a club. |
| `callback` | Optional: `{ "for": {…} }`, who sends a browser back to `/plugins/<name>/callback` (an OAuth sign-in's redirect, such as Xero's). Without it, that address is a 404. [Below](#a-browsers-way-back-callback). |
| `run` | How it runs, below. |

## `settings`

Each setting is one of:

| `type` | Its other fields | What the club gives |
|---|---|---|
| `string` | `max_length` (up to 500), `default`, `club_network` | Text. |
| `integer` | `minimum`, `maximum`, `default` | A whole number. |
| `boolean` | `default` | `true` or `false`. |
| `choice` | `choices`: `[{ "value": "daily", "label": {…} }, …]` (2 to 30), `default` | One of the values. |
| `courts` | | Courts, by name or id (kept as ids). |

Every setting also has `key` (lowercase letters, digits and `_`), `label` (both languages) and, except `boolean`,
`required`; all may have `help`. `plugin configure` refuses a setting the manifest doesn't have, a value out of shape,
and a court the club doesn't have, and says which.

### One address on the club's own network (`club_network`)

A local plugin's service is kept off private networks (10.x, 172.16-31.x, 192.168.x, 169.254.x, 100.64-127.x and
IPv6's private and link-local ranges). A plugin that has to reach a device there, such as Home Assistant, marks the
`string` setting that names it with `"club_network": true` (at most one per manifest). When the club gives that setting
an address on its own network (`http://192.168.1.20:8123`, or a name that resolves to exactly one such address), the
preview of `plugin install`, `plugin configure` or `plugin update` says so in words ("It can reach 192.168.1.20 on the
club's own network (Home Assistant address), and nothing else there"), and once the owner says yes (a manager asks),
`openpadel plugin service <name> --apply` writes its unit with `IPAddressAllow=` for that one IP, any port. It's
refused, with the reason, when it's this server itself (the loopback or one of its own addresses), not one device's
address (`0.0.0.0`, multicast), a name this server can't find, or a name that answers at more than one address. A
public address needs nothing, and a remote plugin isn't affected: this is only about the local sandbox.

## Keys the owner adds, and keys the plugin keeps

Each key in `secrets` is the owner's to add unless it says otherwise:

- `"optional": true`: never asked for (no vault request, no doctor warning, no "needs attention"): a key that only
  makes something extra work. The plugin says on its card when it would use it.
- `"needed_when": { "setting": "provider", "is": "xero" }`: asked for only while that setting has that value (its
  default counts when the club hasn't set it), and otherwise treated like an optional key. The setting must be one of the
  manifest's, and the value one it can have (a choice's value, `true`/`false` for a boolean, a number for an integer).
  Changing the setting so a key is newly needed sends the owner the vault request then. Not with `optional`.
- `"kept_by_plugin": true`: the plugin writes it itself, through the door (`plugin_secret_keep_preview`, then
  `plugin_secret_keep_confirm`, [README](README.md#keys-it-keeps)): a key it's handed and that changes as it's used, such
  as an OAuth refresh token. The owner is never asked for it, the install preview lists it under "It keeps itself", and
  the vault shows it as "kept by <plugin>, ends in 4F2A". It can't also be `optional` or `needed_when`.

## A browser's way back (`callback`)

A local plugin takes no traffic from outside the club's server, and a remote one may not want to host its own sign-in
page. With `callback`, the owner's browser can come back from an OAuth sign-in to the club's own address,
`https://<club>/plugins/<name>/callback?code=…&state=…` (the redirect address to register with the outside service). The
club passes on only that address's query, as JSON (`{"query": {...}}`, at most 2,000 characters, 20 names), in a POST to
`<url>/callback`, signed with `hooks.secret` like a hook (`openpadel-signature`, `openpadel-event: plugin.callback`), with
no cookies or other headers. It answers `{"ok": true}` when it worked. The browser is then sent to the club's own
Connectors page (`/connectors?plugin=<name>&connected=1`, or `0`): nothing the plugin answers is shown at the club's
address. Only a GET, only to that path, only while the plugin is on, at most 30 a minute.

## A sender's check of the hook (`challenge`)

Some services check an address before they post to it: Meta sends `GET <address>?hub.mode=subscribe&hub.challenge=…&hub.verify_token=…`
and wants the challenge back. With `"hook": { "from": {…}, "challenge": true }`, a GET to `/plugins/<name>/hook` passes
only its query on, as JSON (`{"query": {...}}`, at most 2,000 characters, 20 names), in a POST to `<url>/verify`, signed
with `hooks.secret` (`openpadel-signature`, `openpadel-event: plugin.hook_check`), with no cookies or other headers. The
plugin checks the token itself and answers `{"answer": "<the challenge>"}`; the club answers the sender with exactly that,
as plain text, when it's 1 to 200 letters, digits, dots, dashes or underscores, and with 403 otherwise. Only while the
plugin is on, at most 30 a minute.

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

[examples/whatsapp/openpadel-plugin.json](examples/whatsapp/openpadel-plugin.json): the club's messages by WhatsApp. It
changes and reads nothing at the club; its `channel` makes it the club's WhatsApp channel, its `hook` takes Meta's
messages and statuses (with `challenge`, Meta's check of the address), and it needs four keys and the club's number. The
plugin itself is [plugins/whatsapp](../../plugins/whatsapp/README.md).

[examples/accounting-export/openpadel-plugin.json](examples/accounting-export/openpadel-plugin.json): each club day's
takings, refunds, tax, card fees and payouts sent to the club's Xero or QuickBooks as one journal. It changes nothing at
the club and reads money; its Xero and QuickBooks app keys are `needed_when` its `provider` setting chooses that one, its refresh
tokens are `kept_by_plugin`, it takes the browser back from Xero's or Intuit's sign-in with `callback`, and it shows a
card on Connectors and on Money. The plugin itself is [plugins/accounting-export](../../plugins/accounting-export/README.md).

[examples/court-camera/openpadel-plugin.json](examples/court-camera/openpadel-plugin.json): a court camera system's
highlights and game stats on each game's page. It changes nothing at the club, reads bookings and courts, takes what the
camera system posts with `hook`, needs the vendor's signing secret, and its API key only `needed_when` its `tell_cameras`
setting is on; the camera system's address is its `club_network` setting, and it shows a `game` card. The plugin itself
is [plugins/court-camera](../../plugins/court-camera/README.md), with a vendor adapter interface for camera systems.
