# Court cameras: highlights and game stats

An openPadel plugin: when the club's court cameras have a highlight or a game's stats ready, they show on that game's
page for its players (the member app) and on the booking in the staff app's Schedule. It is a separate program. It
talks to the club only through the club's door (`/mcp`, with its own token), takes what the camera system posts through
the club's own address, and needs nothing but Node 24 or later: no packages, no database.

It is generic on purpose: openPadel has no camera vendor yet. A camera system that can post a signed webhook works with
it as it is ([the generic HTTP adapter](#the-generic-http-adapter)); one with its own API gets a small adapter
([Making an adapter for your cameras](#making-an-adapter-for-your-cameras)).

Its manifest is [docs/plugins/examples/court-camera/openpadel-plugin.json](../../docs/plugins/examples/court-camera/openpadel-plugin.json)
(the same one is in openPadel's bundled catalog). It changes nothing at the club, reads bookings and courts, and sends
the camera system nothing unless the club turns `tell_cameras` on: then each booking's camera, start and end, and an id
for it. Never a name, an email or a phone number.

## What it does

- **A notice comes in.** The camera system POSTs to `https://<club>/plugins/court-camera/hook`. The club passes it on,
  signed with the plugin's own secret; the plugin checks that signature (so it came through the club) and the vendor's
  own, under `CAMERA_WEBHOOK_SECRET` from the club's vault (so the vendor sent it). Either one wrong, and it's refused
  with 401 and nothing changes.
- **It finds the game.** The notice names a camera; the settings say which court it films. The plugin reads that court's
  day through the door (the `day` read, in the location's own time zone) and takes the booking on the court at that
  moment (the middle of the clip), allowing 5 minutes before the booking starts and 15 after it ends, for a camera that
  starts early or the last point. On the change of booking, the one the clip falls inside wins. If the camera was told
  the booking's session (below) and sends it back, that booking wins outright.
- **It shows it.** That booking's `game` card (through `plugin.card_put`): how many clips and how long ("2 clips, 2:10
  in all", "2 videos, 2:10 en total"), up to five of the game's stats, and a link to watch. One card per game, put again
  as clips and stats come in; the same clip id again replaces it (a re-cut), never adds one. The club shows the card to
  the game's organiser and players and to staff; nobody else, and nothing while the plugin is paused or removed.
- **An empty court is no one's.** A clip from a time nobody had that court (or only a block, a clinic or a Playtomic
  copy) is answered `empty` and dropped: no card, nothing kept. A camera the settings don't name is `unknown_camera`.
- **Late clips are fine.** A clip that comes the next morning still finds its game, by the time it was filmed. One about
  a game more than 14 days ago is `too_old`; one more than 10 minutes in the future (a camera whose clock is off) is
  `future`.
- **The club's door down.** A notice that comes while the plugin can't read the club waits (up to 200, for up to 2 days)
  and is matched on the next read that works, every 5 minutes. The vendor is answered 200 with `waiting`.

The answer to the camera system is `{"ok": true, "results": [{"id": "clip_81", "result": "shown"}]}`, one result per
notice: `shown`, `matched` (kept, the card waits for the club), `waiting`, `empty`, `unknown_camera`, `too_old` or
`future`. It answers 401 to a bad signature, 400 to a body it can't read, and 503 with `not_set_up` until the owner has
put `CAMERA_WEBHOOK_SECRET` in the vault (the vendor should try again later).

### Telling the cameras when bookings start and end (optional)

Some camera systems record only when told to. With `tell_cameras` on, the plugin reads today's and tomorrow's bookings
on the courts with cameras (on start, every 5 minutes, and a second after a booking is made, moved or cancelled) and
tells the camera system each one: its session id, its camera, its start and end. A moved booking is told again (and
taken back from the old camera if it changed court); a cancelled one, or a court taken out of the settings, is taken
back. Turning `tell_cameras` off takes back every booking still to come.

The session id is `ses_` and 32 hex characters, made from the booking's id with the plugin's own secret: the same booking
always gets the same one, and the camera system can't look anything up at the club with it.

If the camera system doesn't answer, nothing is lost: what it wasn't told is tried again, the wait doubling from 5
seconds to 5 minutes, and a cancellation is only sent on a schedule read in the last 15 minutes. Health says so (below).

## Setting it up at the club

The club's agent installs it, and the owner says yes to the preview (see [docs/plugins/README.md](../../docs/plugins/README.md)):

```bash
openpadel plugin install --name court-camera
openpadel plugin configure --plugin court-camera --settings '{"courts": "Court 1, Court 2", "cameras": "Court 1 = cam-01, Court 2 = cam-02"}'
```

| Setting | What |
|---|---|
| `courts` | The courts with cameras, by name or id (required). |
| `cameras` | Each court's camera id in the camera system: `Court 1 = cam-01, Court 2 = cam-02`. A court left out uses its name: Court 3 is `court_3`, Cancha Ñ is `cancha_n`. |
| `tell_cameras` | Tell the camera system when bookings start and end (off unless set). |
| `vendor_url` | Where the camera system takes bookings' times (`https://api.cameras.example/v1`), only with `tell_cameras`. It may be an address on the club's own network (`http://192.168.1.30`): it's the manifest's `club_network` setting, so a local plugin may reach that one address and nothing else there, once the owner says yes. |

The keys, which the owner adds in the club's vault (or on the server with `openpadel plugin secret court-camera <NAME>`):

- `CAMERA_WEBHOOK_SECRET`: the secret the camera system signs its notices with. In the camera system, where you add
  openPadel (its webhooks or integrations page), give it `https://<your club's address>/plugins/court-camera/hook` as the
  address and copy its signing secret (or make one up there, long and random, and put the same one in both places).
- `CAMERA_API_KEY`: the camera system's API key, asked for only while `tell_cameras` is on.

The plugin reads them through the door (`plugin_secret`), keeps them in memory only, and reads them again when a
signature doesn't check or the camera system refuses the key, so a key changed in the vault is picked up by itself.

### Recording, consent and what to tell members

The video is the camera system's: it records it, keeps it and serves it, under the club's own agreement with the vendor.
This plugin never touches video. It shows a link to it, to the people in that game.

- **Signs are the club's.** Wherever laws ask for notice of recording (most places do), the club puts up its own signs
  at the courts with cameras and at the door, saying the courts are filmed, by whom, and what for. openPadel doesn't do
  this for the club.
- **If players can be recognised in the video,** it's personal data about them. The club should say so in its privacy
  policy (installing the plugin adds the camera system to the club's list of services that see member data, from the
  manifest's "data out"), and tell members in plain words: which courts are filmed, that clips go to the players of that
  game, how long the camera system keeps them, and how to ask for one to be taken down (to the club, which asks the
  vendor). Something like: "Courts 1 and 2 have cameras. After your game, its highlights show on your game's page in the
  app, for the people who played. [Vendor] keeps them for 30 days. To have one taken down, ask at the desk."
- **Links.** A clip's link is the vendor's. If it works for anyone who has it (no sign-in at the vendor), a player can
  share it on; say so to members, or ask the vendor for links that expire.
- **Juniors.** If juniors play on filmed courts, check what the club's country asks of filming minors before turning
  cameras on for those courts or hours.

## The generic HTTP adapter

What the camera system posts, as JSON, to `https://<club>/plugins/court-camera/hook`:

```json
{ "type": "highlight.ready", "id": "clip_81", "camera_id": "cam-02", "session_id": "ses_…",
  "started_at": "2026-11-17T18:42:10Z", "ended_at": "2026-11-17T18:42:55Z",
  "url": "https://clips.cameras.example/c/clip_81.mp4", "duration_seconds": 45 }
```

```json
{ "type": "game_stats.ready", "id": "stats_9", "camera_id": "cam-02", "session_id": "ses_…",
  "started_at": "2026-11-17T18:00:00Z", "ended_at": "2026-11-17T19:30:00Z", "url": "https://clips.cameras.example/g/9",
  "stats": [{ "key": "rallies", "value": 54 }, { "key": "longest_rally_shots", "value": 23 },
            { "key": "lobs", "value": 7, "label": { "en": "Lobs", "es": "Globos" } }] }
```

- `id` (up to 200 characters), `camera_id` (up to 100) and `started_at` are required; `session_id` is optional (the one
  it was told, if any). The same `id` again replaces what it said before.
- A highlight needs its `url`, https only. `duration_seconds` is its length (or `ended_at` minus `started_at`).
- Stats: up to 12, each `{ "key", "value" }`, where `value` is a number or words in both languages (`{ "en", "es" }`).
  openPadel has words for `rallies`, `longest_rally_shots`, `shots`, `smashes`, `winners`, `distance_m`,
  `top_speed_kmh` and `minutes_played`. Any other key needs its `label` in both languages, or it isn't shown. The card
  shows the first ones that fit (six rows in all). `url`, optional, is the game's page at the vendor: with several clips
  the card links there.
- Several at once: `{ "notices": [ … ] }`, up to 50. Any other `type` (a ping) is answered and ignored.
- Signed: a `camera-signature: t=<unix seconds>,v1=<hex>` header, where `<hex>` is the HMAC-SHA256 of `<t>.<the exact
  body>` under `CAMERA_WEBHOOK_SECRET`, within 5 minutes of the time it's checked. In Node:

  ```js
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  headers["camera-signature"] = `t=${t},v1=${v1}`;
  ```

  At most 1 MB a message and 120 a minute (the club's limits for `/plugins/<name>/hook`).

What the plugin sends the camera system with `tell_cameras` on, under `Authorization: Bearer <CAMERA_API_KEY>`:

```
PUT    <vendor_url>/sessions/<session_id>   {"session_id": "ses_…", "camera_id": "cam-02", "starts_at": "<ISO>", "ends_at": "<ISO>"}
DELETE <vendor_url>/sessions/<session_id>
```

Both must be safe to repeat: a PUT for a session it has replaces it (a moved booking), a DELETE for one it doesn't have
answers 404 (taken as done). Any 2xx is success; 401 or 403 means the key is wrong; anything else, or no answer within 8
seconds, is tried again later.

## Making an adapter for your cameras

If your camera system can't speak the generic shapes, write an adapter: one file, about a page. Everything else (the
club's door, registration, matching, the card, retries, health, packaging) stays as it is.

1. Copy `src/adapters/generic_http.ts` to `src/adapters/<yours>.ts` and give it a `name`.
2. Implement the interface in [src/adapters/types.ts](src/adapters/types.ts):
   - `verify(headers, rawBody, secret, nowSeconds)`: whether your system really sent it, with its own signature scheme,
     under the secret the owner put in the vault as `CAMERA_WEBHOOK_SECRET`. Headers come with lowercase names. Refuse
     old timestamps, and compare with `timingSafeEqual`.
   - `parse(rawBody)`: your payload as `Notice`s (`kind` "highlight" or "stats", your `id`, the `camera`, `start` and
     `end` in milliseconds, an https `url`, `seconds`, `stats`). Return none for a message that isn't one; throw
     `VendorError(400, …)` for one you can't read.
   - `tell(o, op, session)`, optional: `upsert` or `cancel` a booking's session at your API (`o.baseUrl` is the
     `vendor_url` setting, `o.apiKey` the vault's `CAMERA_API_KEY`). Throw `VendorError(status, …)` on failure. Leave it
     out if your cameras record all the time.
3. Add it to `ADAPTERS` in `src/adapters/index.ts`. The plugin uses the one named in `CAMERA_ADAPTER`.
4. Copy the tests in `test/camera.test.ts` that post notices, with your payloads and your signatures, and run them.
5. Make your own manifest from the example: your `name` (it names the vault keys and the hook address, so
   `<yours>/CAMERA_WEBHOOK_SECRET` and `/plugins/<yours>/hook`), `publisher`, `homepage`, and a `data_out` that says
   exactly what you send and keep. If you need other keys or settings, add them to the manifest and read them the same
   way. Then `tools/pack.ts` for a release, and ask openPadel to list it in the catalog.

## Running it

### On the club's own server (local)

`openpadel plugin service` runs a local plugin as its own sandboxed service, from a release pinned by its SHA-256.
Make the release:

```bash
node tools/pack.ts --release-url https://github.com/onchainexpat/openpadel/releases/download/plugin-court-camera-v0.1.0/court-camera-0.1.0.tar.gz
```

It writes `dist/court-camera-0.1.0.tar.gz` (the same bytes every time from the same files) and
`dist/openpadel-plugin.local.json`: the manifest with `"run": {"mode": "local", "release_url": ..., "sha256": ...,
"entry": "bin/start"}`. Publish the `.tar.gz` at that address, install with that manifest (the catalog's entry, or
`openpadel plugin install --manifest dist/openpadel-plugin.local.json`, which the preview marks NOT REVIEWED until the
catalog has it), and:

```bash
sudo openpadel plugin service court-camera --apply
sudo systemctl daemon-reload && sudo systemctl enable --now openpadel-plugin-court-camera
```

The service gets `PORT`, `OPENPADEL_URL`, `OPENPADEL_MCP`, `OPENPADEL_TOKEN`, `OPENPADEL_WEBHOOK_SECRET` and
`OPENPADEL_HOOK_SECRET` in its environment and listens on 127.0.0.1; the camera system's notices reach it through the
club's own address, so the club opens no new ports. Its sandbox has nowhere to write, so after a restart a game's card
starts its clip count again from the next clip (the card already shown stays at the club until then).

### Anywhere else (remote)

Any host with Node 24 that the club reaches at a public https address (production clubs only send to those):

```bash
PORT=8080 STATE_DIR=/var/lib/court-camera node src/main.ts
```

and the manifest's `"run": {"mode": "remote", "url": "https://cameras.yourclub.com/v1"}`. Paths are matched by their
last part, so any prefix works: the club POSTs `<url>/register`, `<url>/events`, `<url>/hook`, and checks
`<url>/health`. A registration is kept only when the club's Ed25519 signature checks against the key at its own
address; registrations, games and what it told the cameras are kept in `STATE_DIR`, one file per club, readable by
its own user only (0600, in a 0700 directory). `OPENPADEL_CLUBS=https://club-a.example,https://club-b.example` limits
which clubs may register: set it on a public host.

| Variable | What |
|---|---|
| `PORT`, `HOST` | Where it listens (8080 on 0.0.0.0; a local plugin 127.0.0.1). |
| `STATE_DIR` | Where it keeps its state (`state`; systemd's `STATE_DIRECTORY` if given). |
| `CAMERA_ADAPTER` | The vendor adapter (`generic-http`). |
| `OPENPADEL_CLUBS` | Only these clubs may register, when set. |
| `OPENPADEL_DEV=1` | Accept a club on http (a club on your own machine, in development). |

## Health

`GET <url>/health` answers 200 when it's working and 503 when it isn't (the club's door not read in 15 minutes, or,
with `tell_cameras` on, the camera system not answering or refusing its key), with what it knows: the last event, the
last notice, the last read, how many cameras it knows, games shown, notices waiting, and whether the camera system
answers. It names no club: anyone can ask.

## Logs

One JSON line per thing worth knowing, on stderr (journald for a local plugin): a notice matched or dropped and why,
the door or the camera system failing (once, until they answer again), settings that don't read. Never a token, a key
or a secret.

## Developing

```bash
node --test 'test/*.test.ts'
```

The tests run it against a fake club (a signing key, a door, signed registrations, events and hooks) and a fake camera
system. `apps/server/test/court_camera_plugin.test.ts` runs it against the real openPadel server, and the repo's
`npm test` runs both.
