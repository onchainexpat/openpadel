# A plugin to copy

The smallest working openPadel plugin: copy this folder and make it yours. As it stands it shows, on the club's
Connectors page, how many bookings each location has today, read again whenever a booking is made or cancelled.
Everything a plugin needs is here, and nothing else:

| File | What |
|---|---|
| `openpadel-plugin.json` | Its manifest: what it asks the club for ([docs/plugins/manifest.md](../../docs/plugins/manifest.md)). |
| `src/plugin.ts` | The address the club calls (register, events, health), and what it does: `refresh` and `cardFor`. |
| `src/signatures.ts` | Checking the club's signed registration (Ed25519) and its signed events (HMAC). Don't change it. |
| `src/door.ts` | The club's door: one MCP tool call at a time, with the plugin's token. Don't change it. |
| `src/main.ts` | Starting it, local or remote, from its environment. |
| `bin/start` | What a club's server runs for a local plugin. |
| `tools/pack.ts` | Its release: a `.tar.gz`, the same bytes from the same files, and the manifest pinning it. |
| `test/fake_club.ts`, `test/plugin.test.ts` | A fake club, and the tests to keep passing as you change it. |

It needs Node 24 or later and no packages. The guide is [docs/plugins/writing.md](../../docs/plugins/writing.md).

```bash
node --test 'test/*.test.ts'      # the tests
PORT=8080 OPENPADEL_DEV=1 node src/main.ts   # run it (remote mode, a club on your own machine)
node tools/pack.ts --release-url https://.../bookings-today-0.1.0.tar.gz   # its release
```

openPadel's own test suite copies this folder out and runs its tests, and installs it at a real club, so it stays
working as openPadel changes.
