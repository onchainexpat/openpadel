# Plugins

A plugin is an extra a club installs only if it wants it: court lights, an accounting export, a camera's highlights.
It is a **separate program** that talks to the club only through the club's door (`/mcp` and the command line, the same
one people's assistants use) and gets the club's events by signed webhook. It never runs inside openPadel's server and
never touches its database, so it can't read what its manifest doesn't allow, can't take the server down, and can be
written in any language.

Each plugin is declared by a manifest, [`openpadel-plugin.json`](manifest.md), that says exactly what it asks for. An
example: [examples/court-lights/openpadel-plugin.json](examples/court-lights/openpadel-plugin.json).

## For a club: installing one

The club's agent does the installing (Claude Code, Codex, an assistant connected at `/mcp`), and the owner says yes:

```bash
openpadel plugin search lights          # the catalog
openpadel plugin info --name court-lights   # everything it asks for, in words
openpadel plugin install --name court-lights
```

`plugin install` is a preview first, like every change. It lists in plain words everything the manifest asks for:

> Install the plugin court-lights 0.1.0. From: openPadel's reviewed catalog, published by openPadel examples. What it
> does: Turns a court's lights on in Home Assistant a few minutes before each booking and off after it ends. It will be
> able to: change nothing at the club. It reads: bookings, courts and hours. It's told when: booking.cancelled, ...
> It sends: Each booking's court, start and end go to the club's own Home Assistant. No names, emails or phone numbers.
> Needs: Home Assistant access token (HA_TOKEN). ... Its key to the club: a token that goes straight to
> lights.plugins.openpadel.org, signed by the club, never to you or your agent. It can't move money.

The agent shows the owner those words and confirms only on their yes. The owner's own agent installs outright; a
manager (or a club agent with the manager's role) asks, and the owner says yes in Approvals.

A plugin from outside openPadel's catalog (`--url` with its manifest's address, or `--manifest` with the file itself)
installs too, but the preview says so first, in capitals: **NOT REVIEWED**.

Then:

- **Keys.** Each key the plugin needs that the vault doesn't have becomes a request: the owner gets a notice, and the
  vault page shows "the plugin asked for" with where to get each one. The owner adds it there, or types it on the
  server with `openpadel plugin secret court-lights HA_TOKEN` (a prompt that doesn't show it). Whoever installed the
  plugin only ever sees "added, ends in 4F2A". The key is kept as `court-lights/HA_TOKEN`, the plugin's own.
- **Settings.** `openpadel plugin configure --plugin court-lights --settings '{"courts": "Court 1, Court 2"}'`, checked
  against the manifest's settings and previewed. The plugin hears at once.
- **Health.** `openpadel doctor` checks each plugin's health address, and says which keys it still waits for.
- `openpadel plugin list` shows what's installed. `plugin update` previews what a new version asks for that the old
  one didn't. `plugin pause` stops its token, events and hooks until `plugin resume`. `plugin remove` revokes its token,
  ends its webhook and role, and keeps its keys in the vault unless you add `--delete-keys`.

Installing, updating, setting up, pausing and removing are the owner's; a manager asks.

### Why installing works through the door when making an agent doesn't

A club agent made by hand (Settings, Agents) is app-only: its token is shown once, to the person who made it, so it is
made by a person signed in with a second step. A plugin's token is never shown to anyone. It goes straight to the
plugin, signed by the club, and its role is exactly what the preview listed and never more than the installer holds.
So the club's agent can do the installing, and the owner's yes to the preview is what lets it in.

### The catalog

`openpadel plugin search` reads a JSON index of manifests: openPadel's reviewed catalog, or another the server names in
`KUMI_PLUGIN_CATALOG_URL` (an https address, or a file on the server). Without one it reads a sample bundled with
openPadel, with the court lights example.
Whatever a catalog lists counts as reviewed, so `openpadel doctor` warns while the server reads one other than
openPadel's own (`https://plugins.openpadel.org/catalog.json`) or the bundled sample.

The list of installed plugins and the catalog are for the owner and managers (and their agents), like Settings, Agents;
the services that see member data (`openpadel processors`) are for all staff.

### Local plugins

A plugin whose manifest says `"mode": "local"` runs on the club's own server, as its own service. After installing it:

```bash
sudo openpadel plugin service court-lights            # a preview: fetches the release and checks its SHA-256
sudo openpadel plugin service court-lights --apply    # unpacks it, writes its environment and its systemd unit
sudo systemctl daemon-reload && sudo systemctl enable --now openpadel-plugin-court-lights
```

The release is refused unless its SHA-256 is the one its manifest pins. The service runs as its own throwaway user
with the system read-only, the club's settings, backups, database socket and Caddy's admin socket out of sight, and the
private networks refused (Postgres still answers on the loopback, but only with a password the plugin never has):
it reaches the club only through its public address, like a remote plugin. Its token is written into its environment
file (root's alone) and nowhere else. On a Docker install, this version prints the compose service it would add and
writes nothing.

## For a plugin's author: what the club sends you

A remote plugin has an address (`run.url` in its manifest, say `https://lights.example.com/v1`). The club POSTs to:

| Path | What |
|---|---|
| `<url>/register` | Once, on install (and again with a new token if your address changes): your token and secrets. |
| `<url>/events` | The events your manifest names, and `plugin.configured` when the club changes your settings. |
| `<url>/hook` | What an outside service posted to the club at `/plugins/<name>/hook`, passed on as it came. |
| `<url><health>` | A GET, for `openpadel doctor` and the club's list: answer 2xx when you're working. |

### The registration

```json
{
  "type": "plugin.registered", "id": "…", "sent_at": "2026-11-17T18:20:00.000Z",
  "club": { "name": "Kestrel Padel", "url": "https://club.example.com", "language": "en", "time_zone": "America/Los_Angeles",
            "key_url": "https://club.example.com/.well-known/openpadel-plugin-key" },
  "plugin": { "name": "court-lights", "version": "0.1.0" },
  "door": { "mcp": "https://club.example.com/mcp", "token": "opa_…" },
  "webhooks": { "secret": "whsec_…", "signature_header": "openpadel-signature" },
  "hooks": { "url": "https://club.example.com/plugins/court-lights/hook", "secret": "opps_…", "signature_header": "openpadel-signature" },
  "settings": { "home_assistant_url": "https://ha.kestrel.example", "courts": ["…"], "minutes_before": 10 }
}
```

It's signed with the club's own Ed25519 key, in `openpadel-signature-ed25519: t=<seconds>,ed25519=<base64url>` over
`"<t>.<body>"`. Fetch the club's public key from `club.key_url` (the club's own https address, so only that club can
have signed it), check the signature, then keep the token and secrets. Answer 2xx: until you do, the club tries again,
waiting longer each time, and its owner sees the error. Once it arrives the club keeps your token only as a hash.

<!-- registration-sample: apps/server/test/plugins_docs.test.ts runs this against the server's own signing -->
```js
import { createPublicKey, verify } from "node:crypto";

/** Whether a registration really came from the club it names: its signature checks with the club's published key. */
export async function verifyRegistration(header, body, fetchKey = (url) => fetch(url).then((r) => r.json()), nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > 300 || !parts.ed25519) return false;
  const club = JSON.parse(body).club;
  if (!club?.key_url?.startsWith(`${club.url}/`)) return false;
  const { keys } = await fetchKey(club.key_url);
  const key = createPublicKey({ key: keys[0], format: "jwk" });
  return verify(null, Buffer.from(`${t}.${body}`), key, Buffer.from(parts.ed25519, "base64url"));
}
```

### Events, settings and hooks

Events come signed like every club webhook, under `webhooks.secret` (the check is in
[docs/agents/webhooks.md](../agents/webhooks.md)). When the club changes your settings you get a `plugin.configured`
event with them all. What arrives at `/plugins/<name>/hook` comes to `<url>/hook` with the sender's own headers (never
the club's cookies) and an `openpadel-signature` under `hooks.secret`, so you know the club passed it on; check the
sender's own signature yourself. At most 1 MB a message and 120 a minute. Your answer goes back to the sender.

### Acting at the club

With the token, you're a club agent at the club's door: connect to `door.mcp` as an MCP client with
`Authorization: Bearer <token>`. You see the tools your manifest's grants give, every change is a preview and a confirm,
and what your manifest says to ask waits in the club's Approvals for a person. Two tools are yours alone:

- `plugin_settings`: your settings, your status, and which of your keys the owner has added (with their last four).
- `plugin_secret` with `{ "name": "HA_TOKEN" }`: one of the keys your manifest declares, from the club's vault. Any
  other name is refused. Each read is kept on record.

You can't move money (your weekly limit is 0), make webhooks, or install or change plugins.
