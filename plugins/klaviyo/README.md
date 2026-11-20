# Klaviyo: club news as a Klaviyo list

An openPadel plugin: it keeps a list in the club's own Klaviyo account of the members who said yes to club news by
email, so the club can send its newsletters from Klaviyo. It is a separate program. It talks to the club only through
the club's door (`/mcp`, with its own token) and to Klaviyo through its API, and needs nothing but Node 24 or later:
no packages, no database.

Its manifest is [docs/plugins/examples/klaviyo/openpadel-plugin.json](../../docs/plugins/examples/klaviyo/openpadel-plugin.json)
(the same one is in openPadel's bundled catalog and in [catalog/plugins/klaviyo](../../catalog/plugins/klaviyo)). It
changes nothing at the club and reads one thing: the **club news list** (`club_news`).

## What goes to Klaviyo, and what doesn't

The club news list is filtered on the club's own server, for this plugin as for anyone who reads it: only the members
whose latest answer to club news by email is yes, adults with an account and an email. Nobody who said no, never
answered, was deleted or is a junior is in it. Each member is their **email, first name and language** (`en` or `es`,
as a profile property `language`), and nothing else: no phone, no bookings, no money, no level. The plugin keeps none
of it on disk (below).

- **Saying yes** (in the members' app, at sign-up, or in an import of members who had said yes): on the list within a
  few seconds of the club's `club_news.joined` event.
- **Saying no** (in the app, from the link in a club email, or by texting STOP to the club): off the list at once, on
  `club_news.left`. Their profile stays in the club's Klaviyo, off the list (Klaviyo keeps a profile's history; the
  club decides what to do with it there).
- **A deleted account**: off the list, and the plugin asks Klaviyo to delete the profile and everything Klaviyo holds
  about it (a Data Privacy deletion, which Klaviyo carries out within a few days). That needs the key's Data Privacy
  access; without it they still come off the list, and the card says to give the key that access.
- **Whatever no event said** is caught: the club's list is read again every hour and soon after every event, and once
  a day the whole Klaviyo list is checked against it. Anyone on the Klaviyo list who isn't on the club's comes off (a
  missed event, someone added by hand in Klaviyo), and anyone missing goes back on.
- **A removal Klaviyo doesn't take** (Klaviyo down, a 429 that doesn't clear) is kept and tried again every minute,
  before anything is added. Every event's signature is checked first, and the same event twice is handled once.

**Use a list only this plugin fills.** Anyone else on it (a sign-up form on the club's website, say) is taken off at the
daily check, since the club hasn't heard their yes. Send the club's newsletters to this list (or a segment of it), and
keep Klaviyo's own unsubscribe link in each email.

**An unsubscribe in Klaviyo stands.** The plugin never subscribes anyone in Klaviyo (it adds profiles to the list and
never touches their email marketing consent). A profile Klaviyo shows as unsubscribed or suppressed (a bounce, a
complaint) is never put on the list again, comes off it at the daily check, and is passed back to the club
(`club_news_unsubscribed_elsewhere`), so the member's answer to club news turns to no in openPadel too, recorded as
the plugin's change.

## Setting it up at the club

The owner, in Klaviyo (the club's own account; the owner creates it):

1. **The list.** Audience, Lists & Segments, Create New, List. Call it "Club news" (or "Novedades del club"). Open it,
   then Settings: the **List ID** is six letters and digits, such as `Xy12Ab`.
2. **The key.** Settings, Account, API keys, Create Private API Key. Choose **Custom Key** and give it Full Access to
   **Lists** and **Profiles**, and to **Data Privacy** (so a deleted member's profile is deleted there too). Nothing else.
   Klaviyo shows the key once: it starts `pk_`.

Then the club's agent installs it, and the owner says yes to the preview (see [docs/plugins/README.md](../../docs/plugins/README.md)):

```bash
openpadel plugin install --name klaviyo
openpadel plugin configure --plugin klaviyo --settings '{"list_id": "Xy12Ab"}'
```

The owner adds the key, `KLAVIYO_API_KEY`, in the club's vault, or on the server with
`openpadel plugin secret klaviyo KLAVIYO_API_KEY` (a prompt that doesn't show it). Never in a chat. The plugin reads it
through the door (`plugin_secret`), keeps it in memory only, and reads it again when Klaviyo refuses it.

The club's privacy policy names Klaviyo as soon as the plugin is installed (`openpadel processors`, from the
manifest's `data_out`). Klaviyo's pricing is Klaviyo's: it charges by the number of profiles and emails, with a free
plan for small lists.

## On the Connectors page

Its card (`connectors`, through `plugin.card_put`) says how many members are on the list and its name, when the whole
list was last checked, anyone waiting to come off while Klaviyo isn't answering, and a warning when the key is missing
or refused, the list's id is missing or wrong, or deleted members' profiles can't be deleted. A club whose openPadel
doesn't show plugin cards yet is asked again hourly; the list is kept the same without it.

## Running it

### On the club's own server (local)

`openpadel plugin service` runs a local plugin as its own sandboxed service, from a release pinned by its SHA-256:

```bash
node tools/pack.ts --release-url https://github.com/onchainexpat/openpadel/releases/download/plugin-klaviyo-v0.1.0/klaviyo-0.1.0.tar.gz
```

writes `dist/klaviyo-0.1.0.tar.gz` (the same bytes every time from the same files) and `dist/openpadel-plugin.local.json`,
the manifest with `"run": {"mode": "local", "release_url": ..., "sha256": ..., "entry": "bin/start"}`. Publish the
`.tar.gz` at that address, install with that manifest, then:

```bash
sudo openpadel plugin service klaviyo --apply
sudo systemctl daemon-reload && sudo systemctl enable --now openpadel-plugin-klaviyo
```

Its sandbox has nowhere to write, so it checks the whole Klaviyo list against the club's on start instead of
remembering what it put there.

### Anywhere else (remote)

Any host with Node 24 that the club reaches at a public https address:

```bash
PORT=8080 STATE_DIR=/var/lib/openpadel-klaviyo node src/main.ts
```

and the manifest's `"run": {"mode": "remote", "url": "https://klaviyo.yourclub.com/v1"}`. The club POSTs
`<url>/register` (signed with its Ed25519 key, checked against `/.well-known/openpadel-plugin-key` at the club's own
https address before anything is kept) and `<url>/events`, and checks `<url>/health`.

| Variable | What |
|---|---|
| `PORT`, `HOST` | Where it listens (8080 on 0.0.0.0; a local plugin 127.0.0.1). |
| `STATE_DIR` | Where it keeps registrations and what it put on the list (`state`; systemd's `STATE_DIRECTORY` if given). |
| `OPENPADEL_CLUBS` | Only these clubs may register, when set. Set it on a public host. |
| `OPENPADEL_DEV=1` | Accept a club on http (a club on your own machine, in development). |

**What it keeps:** one file per club, readable by its own user only (0600, in a 0700 directory): the club's
registration (its token and webhook secret), the event ids it has handled, and for each member it put on the list
their id at the club, the id Klaviyo gave their profile and a SHA-256 fingerprint of what it sent, to tell when it
changed. No email, name, language or Klaviyo key.

## Health

`GET <url>/health` answers 200 when it's working and 503 when Klaviyo isn't answering, refuses the key or has no such
list, or the club's door hasn't been read in two hours, with what it knows: the last event, the last read, the last
whole check, whether Klaviyo answers, how many members are on the list and how many wait to come off. Waiting for its
key or its list's id isn't "down": `openpadel doctor` names the missing key itself. It names no club and no member.

## Logs

One JSON line per thing worth knowing, on stderr: members put on or taken off (counts, or a member's id at the club),
Klaviyo or the door failing (once, until they answer again). Never a token, a key or an email: the fields are chosen by
hand, and anything shaped like a key or an email is blotted out again before it's written.

## Developing

```bash
node --test 'test/*.test.ts'
```

The tests run it against a fake club and a fake Klaviyo: a member saying yes, saying no, deleted, the daily check
catching a missed event and someone added by hand, Klaviyo down, a 429, a forged event, and what it keeps on disk.
`apps/server/test/klaviyo_plugin.test.ts` runs it against the real openPadel server (the club news list's filter, who
may read it, the events), and the repo's `npm test` runs both.

Klaviyo's API revision is pinned (`REVISION` in src/klaviyo.ts); a newer one is a change to review, not an automatic
update.
