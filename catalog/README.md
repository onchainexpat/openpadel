# openPadel's plugin catalog

The reviewed list of plugins a club's agent can install by name (`openpadel plugin search`, `openpadel plugin install
--name ...`). Everything listed here has been checked against [CONTRIBUTING.md](CONTRIBUTING.md) by openPadel, and a
club's install preview treats it as reviewed; anything installed from elsewhere says **NOT REVIEWED** in capitals.

These files live in openPadel's own repository for now, laid out as the public catalog repository will be, so the
plugins built here and the catalog can't drift apart. The [build tool](tools/build.ts) checks every manifest with the
club server's own parser and writes [catalog.json](catalog.json), the index a club's server reads.

## Layout

```
catalog/
  catalog.json                     the index (written by tools/build.ts; never edited by hand)
  CONTRIBUTING.md                  what openPadel checks before listing a plugin
  plugins/<name>/
    openpadel-plugin.json          its manifest, as its author ships it (docs/plugins/manifest.md)
    release.json                   the release it pins: { version, url, sha256, reviewed }
  tools/build.ts                   checks everything and writes catalog.json
```

`release.json` pins one release: the `.tar.gz` at `url` whose SHA-256 is `sha256`, of the manifest's `version`, and
who reviewed it against which version of the checklist. A local manifest (`"run": {"mode": "local"}`) pins the same
address and SHA-256 in its `run`, and a club's server refuses a release whose bytes don't match
(`openpadel plugin service`). A remote manifest runs at its publisher's address; its release is what that address
runs, and what a club can run itself instead.

| Plugin | What |
|---|---|
| [court-lights](plugins/court-lights) | Court lights in Home Assistant, on before each booking and off after ([source](../plugins/court-lights)). |
| [accounting-export](plugins/accounting-export) | Each club day's books as one journal in Xero or QuickBooks ([source](../plugins/accounting-export)). |
| [klaviyo](plugins/klaviyo) | Members who said yes to club news, kept as a Klaviyo list ([source](../plugins/klaviyo)). |
| [whatsapp](plugins/whatsapp) | The club's messages by WhatsApp, through Meta's Cloud API, to members who said yes ([source](../plugins/whatsapp)). |
| [court-camera](plugins/court-camera) | Court cameras' highlights and stats on a game's page ([source](../plugins/court-camera)). |

## Building

```bash
node catalog/tools/build.ts           # check every plugin and write catalog.json
node catalog/tools/build.ts --check   # fail if catalog.json isn't current
node catalog/tools/build.ts pin klaviyo --release-url https://github.com/onchainexpat/openpadel/releases/download/plugin-klaviyo-v0.1.0/klaviyo-0.1.0.tar.gz
```

`pin` packs one of this repository's own plugins with its `tools/pack.ts` (the same bytes every time from the same
files) into `plugins/<name>/dist/`, and writes its `release.json` with that file's SHA-256: publish the file at that
address before the catalog lists it. A plugin from elsewhere is pinned by hand, with the SHA-256 of the file its author
published (`sha256sum`). `apps/server/test/plugin_catalog_repo.test.ts` runs the build in openPadel's test suite: every
manifest checks, catalog.json is current, and the manifests are the ones in docs/plugins/examples and the bundled sample.

## Adding a plugin

1. Its author opens a pull request adding `plugins/<name>/` with its manifest and `release.json`.
2. openPadel reviews it against [CONTRIBUTING.md](CONTRIBUTING.md), and fills in `reviewed`.
3. `node catalog/tools/build.ts`, and the new catalog.json goes in the same pull request.

One of this repository's own plugins is added the same way: copy its manifest from `docs/plugins/examples/<name>/`,
run `pin`, then build.

## Publishing it (the owner's steps)

Nothing here is published yet. To make it the catalog every club reads:

1. **The repository.** Create `openpadel/plugins` on GitHub (public), and copy this folder's contents to its root.
   Turn on branch protection for `main` (a review needed, and a check that runs `node tools/build.ts --check`).
   The build imports the manifest parser from openPadel (`@kumi/core`): in its own repository, add openPadel as a
   pinned dependency (a git tag), or vendor `plugin_manifest.ts` with a test that it matches.
2. **The releases.** For each plugin, a GitHub release `v<version>` in its own repository (`openpadel/plugin-<name>`)
   with the `.tar.gz` that `pin` made, so each `release.json` address answers with exactly those bytes.
3. **The address.** Serve `catalog.json` at `https://plugins.openpadel.dev/catalog.json`: a DNS record for
   `plugins.openpadel.dev` and any static host (GitHub Pages from the repository works), https only.
4. **The hosted plugins.** The catalog's manifests are remote ones that run at `https://<name>.plugins.openpadel.dev/v1`.
   Until openPadel runs those, clubs install them locally (`openpadel plugin service`) with the pinned release.

**What changes in the setting then:** nothing for a club. `KUMI_PLUGIN_CATALOG_URL` stays unset; openPadel's own
address is built in (`OPENPADEL_CATALOG_URL` in packages/core/src/plugins.ts, `https://plugins.openpadel.dev/catalog.json`).
Today an unset setting reads the sample bundled with openPadel (packages/core/src/plugin_catalog.sample.json); once the
address answers, openPadel's next release reads it there when the setting is unset (a one-line change in
`pluginCatalog`), and keeps the sample only for a server with no internet. A club that set `KUMI_PLUGIN_CATALOG_URL` to
another catalog keeps it, and `openpadel doctor` keeps warning that its catalog isn't openPadel's.
