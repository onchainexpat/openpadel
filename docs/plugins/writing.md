# Writing a plugin

For coding agents (Claude Code, Codex, any builder) and people. A plugin is a separate program that a club installs to
add something openPadel doesn't do itself: it talks to the club only through the club's door, gets the club's events
by signed webhook, and can be written in any language. This guide starts from the template, a small working plugin in
Node: [plugins/template](../../plugins/template/README.md). Read [README.md](README.md) (what the club sends you) and
[manifest.md](manifest.md) (every field) beside it.

## The rules

1. **Separate, and through the door only.** Never import openPadel, never touch its database, never call its pages.
   Everything goes through the door (`/mcp`, with your token): reads your manifest opens, and changes as a preview
   then a confirm. What your manifest says `ask` waits for a person in the club's Approvals.
2. **Ask for the least.** Each grant, read, event, key and setting in your manifest is one the club's owner reads and
   says yes to. Ask only for what the plugin uses.
3. **Say what leaves the club.** `data_out` names every piece of member data you send anywhere, and to whom. Nothing
   that names a member in your logs; nothing on disk you don't need.
4. **Check every signature** before you act: the registration (Ed25519, the club's key at its own address) and every
   event (HMAC). Handle each event once, by its id.
5. **Don't trust events alone.** An event says "something changed": read the club again, and read it on a timer too,
   so a missed event is caught.
6. **Keys stay keys.** Read them through the door (`plugin_secret`), keep them in memory, never log them, never put them
   in an answer or a card, and never ask anyone to paste one into a chat: the owner adds them in the club's vault.
7. **No money.** A plugin's weekly limit is 0: it can't take payments or give refunds.
8. **Both languages.** Everything a person reads (your manifest's words, your cards) in English and Spanish: US and
   Latin American Spanish with "tú" and openPadel's words ("cancha", "miembro", "agregar"; see AGENTS.md), and no em
   or en dashes anywhere.

## 1. Copy the template

```bash
cp -r plugins/template ../my-plugin && cd ../my-plugin
node --test 'test/*.test.ts'     # passes as it is: start from green
```

Then make it yours:

- **`openpadel-plugin.json`**: its `name` (lowercase, dashes: it names its keys `my-plugin/KEY` and its hook address),
  `publisher`, `homepage`, `licence`, `description`, and the rest below. Rename it in `package.json` too.
- **`src/plugin.ts`**: change `refresh` (what it reads and does) and `cardFor` (what its card says). Leave the
  registration, events, health and door as they are: they're the contract with the club.
- **`test/fake_club.ts`**: add the door tools your plugin calls, answering as the club does. **`test/plugin.test.ts`**:
  keep its tests and add yours.

## 2. The manifest

Start from what the plugin does, and ask for exactly that:

| It needs to | In the manifest |
|---|---|
| read the schedule | `"reads": ["bookings"]` (`day`, `courts`); members' details `members`; the club news list `club_news`; the books `money` |
| hear when something happens | `"events": ["booking.created", ...]`, each in a part it reads ([docs/agents/webhooks.md](../agents/webhooks.md)) |
| change something at the club | `"grants": [{ "action": "court.block", "mode": "ask" }]`: `ask` unless it must act alone |
| a key for an outside service | `"secrets": [{ "name": "API_KEY", "label": {...}, "where": {...} }]`, `where` saying exactly what to click |
| options | `"settings"`: string, integer, boolean, choice or courts, each with help an owner understands |
| show something | `"cards": [{ "slot": "connectors", "title": {...} }]` (game, court_tile, member_profile, money, connectors) |
| hear from an outside service | `"hook": { "from": {...} }`: it posts to `/plugins/<name>/hook`, passed on to `<url>/hook` |
| an OAuth sign-in | `"callback"`, and `"kept_by_plugin": true` on the refresh token ([manifest.md](manifest.md#a-browsers-way-back-callback)) |

`openpadel plugin info --name <name>` (or the install preview) shows the owner your manifest in words: read it as
they will. The club's server checks it strictly: an unknown field, a missing one, or a grant no plugin may hold, and
it won't install.

## 3. Talking to the club

Your token is a club agent's at the door. `tools/list` shows what it sees. Always there:

- `plugin_settings`: your settings, status, and which keys the owner has added (last four only).
- `plugin_secret { name }`: one key your manifest declares, read through the door each time you need it fresh.
- `plugin_card_put_preview` then `plugin_card_put_confirm { run_id }`: your card (rows of `{ label: {en, es}, text: {en, es} }`,
  up to 6, one line each); `plugin_card_clear_*` takes it down. A club whose openPadel doesn't have cards yet says
  the tool isn't there: carry on without it.

Every other change is the same two steps: `<action>_preview` (read its `status`: `awaiting_approval` means a person
decides), then `<action>_confirm` with its `run_id`. Each is in the club's change log as yours, and undoable.

## 4. Testing

Test against a fake club and a fake of the outside service, with no network, as the template and openPadel's own
plugins do ([court-lights](../../plugins/court-lights/test), [klaviyo](../../plugins/klaviyo/test)). At least:

- a registration signed by a stranger, and an old one replayed, refused; the real one kept;
- the main path, end to end, with what reaches the outside service checked field by field;
- a forged event refused; the same event twice handled once;
- a missed event caught by the timer's read;
- the outside service down or slow (a 429): nothing worse than waiting, and the card and health say so;
- the club's door down; its cards missing;
- what it keeps on disk (0600) and logs: no key, no token, nothing naming a member.

## 5. Running it

- **Remote** (any host the club reaches at a public https address): `PORT=8080 STATE_DIR=/var/lib/my-plugin node src/main.ts`,
  and `"run": { "mode": "remote", "url": "https://my-plugin.example.com/v1" }`.
- **Local** (on the club's own server, sandboxed): `node tools/pack.ts --release-url https://.../my-plugin-0.1.0.tar.gz`
  writes the release and a manifest pinning it by SHA-256; publish the file at that address, install with that
  manifest, then `sudo openpadel plugin service my-plugin --apply`.
- **On your own machine, against a club in development** (an openPadel server without `NODE_ENV=production`):
  `OPENPADEL_DEV=1 PORT=8080 node src/main.ts`, then, as the club's owner,
  `openpadel plugin install --manifest ./openpadel-plugin.json` with `"run": { "mode": "remote", "url": "http://127.0.0.1:8080/v1" }`.
  The preview says NOT REVIEWED: it isn't in the catalog yet.

## 6. Getting it listed

openPadel's reviewed catalog is [catalog/](../../catalog/README.md). Open a pull request adding `plugins/<name>/` with
your manifest and the release it pins; openPadel reviews it against [catalog/CONTRIBUTING.md](../../catalog/CONTRIBUTING.md)
(least privilege, honest data out, signatures, tests, licence) before it's listed.
