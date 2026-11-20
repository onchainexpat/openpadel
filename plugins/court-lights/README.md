# Court lights for Home Assistant

An openPadel plugin: it turns a court's lights on in the club's Home Assistant a few minutes before each booking and off
a few minutes after the last one ends. It is a separate program. It talks to the club only through the club's door
(`/mcp`, with its own token) and to Home Assistant through its REST API, and needs nothing but Node 24 or later: no
packages, no database.

Its manifest is [docs/plugins/examples/court-lights/openpadel-plugin.json](../../docs/plugins/examples/court-lights/openpadel-plugin.json)
(the same one is in openPadel's bundled catalog). It changes nothing at the club, reads bookings and courts, and sends
Home Assistant only which lights to turn on or off: no names, emails or phone numbers.

## What it does

- **Lights on** `minutes_before` (10 unless set) before anything that has people on a court: a booking, a program's
  date (a clinic, a league night), or a Playtomic booking the club mirrors. Not for a block (maintenance, an event the
  club runs itself) or a court someone is still paying for.
- **Lights off** `minutes_after` (5 unless set) after it ends. Back-to-back bookings (or ones closer together than
  before plus after) keep the lights on between them.
- **It reads the club, it doesn't trust events alone.** On start, every 5 minutes, and a second after any booking or
  court event (made, moved, cancelled, blocked, freed), it reads today's and tomorrow's schedule for each location with
  lit courts (the `day` read, in that location's own time zone). An event that never arrives is caught by the next read.
  Every event's signature is checked first, and the same event twice is handled once.
- **An error never turns lights off during a booking.** If the club's door doesn't answer, it keeps the last schedule,
  and it turns lights off on a schedule read in the last 15 minutes. While the door stays down, lights that are on stay
  on until 2 hours (`CUTOFF_MINUTES`, 120, in src/club.ts) after they were due off (the last booking it knows about
  on that court, plus its minutes after), then go off, so a court isn't lit all night because the club's server is down.
  A command Home Assistant doesn't take is tried again, the wait doubling from 5 seconds to 5 minutes.
- **After a restart** it remembers what it turned on (when it has somewhere to keep it, below). With nothing kept, a
  court with no booking now whose last booking ended in the past 3 hours has its lights turned off once.
- **On each court's tile** on the staff app's Today (the `court_tile` card, through `plugin.card_put`): "On until
  9:30 PM", "Off" and when they next come on, its Home Assistant lights, and a warning when Home Assistant isn't
  answering, refused the key, or the key or address is missing. A club whose openPadel doesn't show plugin cards yet
  is asked again hourly; the lights work the same without them.

## Setting it up at the club

The club's agent installs it, and the owner says yes to the preview (see [docs/plugins/README.md](../../docs/plugins/README.md)):

```bash
openpadel plugin install --name court-lights
openpadel plugin configure --plugin court-lights --settings '{"home_assistant_url": "https://ha.yourclub.com", "courts": "Court 1, Court 2"}'
```

| Setting | What |
|---|---|
| `home_assistant_url` | Where the club's Home Assistant answers (required). |
| `courts` | The courts with lights, by name or id (required). |
| `lights` | Each court's lights in Home Assistant: `Court 1 = light.court_1, Court 2 = light.c2_north light.c2_south`. A court left out uses `light.` and its name (Court 3 is `light.court_3`, Cancha Ñ is `light.cancha_n`). Lights and switches (`switch.court_4`) both work. |
| `minutes_before` | Minutes before a booking, 0 to 30 (10). |
| `minutes_after` | Minutes after a booking, 0 to 30 (5). |

The key, `HA_TOKEN`, is a Home Assistant long-lived access token (in Home Assistant: your profile, Security,
Long-lived access tokens, Create token). The owner adds it in the club's vault, or on the server with
`openpadel plugin secret court-lights HA_TOKEN`. The plugin reads it through the door (`plugin_secret`), keeps it in
memory only, and reads it again when Home Assistant refuses it. A user in Home Assistant with access to the court
lights only is enough.

## Running it

### On the club's own server (local)

`openpadel plugin service` runs a local plugin as its own sandboxed service, from a release pinned by its SHA-256.
Make the release:

```bash
node tools/pack.ts --release-url https://github.com/onchainexpat/openpadel/releases/download/plugin-court-lights-v0.1.0/court-lights-0.1.0.tar.gz
```

It writes `dist/court-lights-0.1.0.tar.gz` (the same bytes every time from the same files) and
`dist/openpadel-plugin.local.json`: the manifest with `"run": {"mode": "local", "release_url": ..., "sha256": ...,
"entry": "bin/start"}`. Publish the `.tar.gz` at that address. Then install with that manifest (the catalog's entry, or
`openpadel plugin install --manifest dist/openpadel-plugin.local.json`, which the preview marks NOT REVIEWED until the
catalog has it) and:

```bash
sudo openpadel plugin service court-lights --apply
sudo systemctl daemon-reload && sudo systemctl enable --now openpadel-plugin-court-lights
```

The service gets `PORT`, `OPENPADEL_URL`, `OPENPADEL_MCP`, `OPENPADEL_TOKEN`, `OPENPADEL_WEBHOOK_SECRET` and
`OPENPADEL_HOOK_SECRET` in its environment and listens on 127.0.0.1. Its sandbox has nowhere to write, so it keeps
its state in memory and reads the club again on start.

**Home Assistant on the club's own network:** the local service is kept off private addresses (10.x, 192.168.x and
the like), except one: the Home Assistant address setting is the manifest's `club_network` setting, so when it names an
address on the club's network (`http://192.168.1.20:8123`, or a name that resolves to one address there), the preview
says "It can reach 192.168.1.20 on the club's own network", and once the owner says yes `openpadel plugin service
court-lights --apply` lets the service through to that one IP and nothing else there. Changing the address later is
a `plugin configure` the owner says yes to, then the service written again. A public https address (Home Assistant
Cloud's `https://....ui.nabu.casa`, or the club's own) needs none of this.

### Anywhere else (remote)

Any host with Node 24 that the club reaches at a public https address (production clubs only send to those):

```bash
PORT=8080 STATE_DIR=/var/lib/court-lights node src/main.ts
```

and the manifest's `"run": {"mode": "remote", "url": "https://lights.yourclub.com/v1"}`. Paths are matched by their
last part, so any prefix works: the club POSTs `<url>/register`, `<url>/events`, and checks `<url>/health`.

On install the club POSTs a registration signed with its Ed25519 key. The plugin checks it against the key the club
publishes at its own address (`/.well-known/openpadel-plugin-key`, https only), and only then keeps the token and
secrets: in `STATE_DIR`, one file per club, readable by its own user only (0600, in a 0700 directory). One remote
plugin can serve several clubs; `OPENPADEL_CLUBS=https://club-a.example,https://club-b.example` limits which. Set it
on a public host: without it, any openPadel club can register, and the plugin then calls that club's addresses and its
Home Assistant, so keep the host away from anything private. A local plugin takes no registrations at all.

| Variable | What |
|---|---|
| `PORT`, `HOST` | Where it listens (8080 on 0.0.0.0; a local plugin 127.0.0.1). |
| `STATE_DIR` | Where it keeps registrations and what it turned on (`state`; systemd's `STATE_DIRECTORY` if given). |
| `OPENPADEL_CLUBS` | Only these clubs may register, when set. |
| `OPENPADEL_DEV=1` | Accept a club on http (a club on your own machine, in development). |

## Health

`GET <url>/health` answers 200 when it's working and 503 when it isn't (Home Assistant not answering or refusing its
key, or the club's door not read in 15 minutes), with what it knows: when the last event came, when it last read the
club, whether Home Assistant answers, how many courts it looks after and how many are on. Waiting for its key or its
address isn't "down": `openpadel doctor` names the missing key itself. It names no club: anyone can ask.

## Logs

One JSON line per thing worth knowing, on stderr (journald for a local plugin): lights on and off, Home Assistant or the
door failing (once, until they answer again), settings that don't read. Never a token, a key or a secret.

## Developing

```bash
node --test 'test/*.test.ts'
```

The tests run it against a fake club (a signing key, a door, signed registrations and events) and a fake Home Assistant.
`apps/server/test/court_lights_plugin.test.ts` runs it against the real openPadel server, and the repo's `npm test`
runs both.
