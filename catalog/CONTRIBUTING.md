# Listing a plugin: what openPadel checks

A plugin in this catalog is installed by a club's agent with the owner's yes, and the preview calls it reviewed. So
before a plugin is listed, someone at openPadel goes through every point below against the release it pins, and
writes their name and the date in its `release.json` (`reviewed`, against this checklist's version: **1**). Any
point not met, and it isn't listed. A new version is reviewed again, for what changed.

## 1. The manifest asks for the least it needs

- **Grants:** only the actions the plugin really takes, `ask` wherever a person should say yes first, `own` scope
  where it's enough. No grant "in case". A plugin that only shows something has none.
- **Reads:** only the parts of the club it reads. `members` only if it truly needs the member list; `club_news`
  only for a sync of club news (and then the data out says where the emails go).
- **Events:** only the ones it acts on.
- **Keys:** only the ones it uses, each with where the owner gets it, in words an owner can follow. A key that changes
  as it's used (an OAuth refresh token) is `kept_by_plugin`, never asked of the owner. Ask for the narrowest scope the
  outside service offers, and say which in `where`.
- **Settings:** each one needed, with help an owner understands. `club_network` only for a device on the club's own
  network that the plugin must reach (Home Assistant), never a server on the internet.
- **Cards:** only where it has something to say.

## 2. The data out is honest and complete

- `data_out` says, in both languages, every piece of member data that leaves the club, to whom, and why. "No names,
  emails or phone numbers" when none do. It names the outside service. If the data passes through the publisher's
  own servers (a remote plugin), it says so, and whether they keep any of it.
- **No member data beyond need:** compare the code with the words. Every field it reads through the door and every
  field it sends out is one the description needs. Nothing logged that names a member (ids are fine), and nothing kept
  on disk beyond what it needs to work (say what it keeps, in the README).
- `cost` says whether the outside service charges, roughly how.

## 3. It checks every signature

- The registration's Ed25519 signature, against the key at the club's own https address (`club.key_url` under
  `club.url`), with the time checked, before it keeps anything.
- Every event's `openpadel-signature` (HMAC, constant-time compare, the time within 5 minutes), and each event handled
  once (by its `id`).
- A hook's `openpadel-signature` from the club, and the outside sender's own signature on what it sent.
- Tokens and keys never logged, never in an answer, kept 0600 when kept at all, and read from the club's vault through
  the door (`plugin_secret`), never asked for in a chat.

## 4. It's tested

- Tests run against a fake club (signed registration, signed events, a fake door) and a fake of the outside service,
  with no network: the main path, a forged signature refused, the outside service down (and what happens to the club
  meanwhile: nothing worse than waiting), a missed event caught by reading the club again.
- The tests pass on the release it pins (`node --test`), and the release unpacks and starts (`bin/start`) on Node 24.

## 5. It behaves at the club

- It acts only through the door: every change a preview and a confirm, nothing around them. It moves no money.
- It works when the club's openPadel doesn't show cards yet, and says on its card (and its health) what needs the
  owner: a key missing or refused, a setting missing.
- Its health answers 2xx only when it's working, and names no club and no member.
- It's in both English and Spanish wherever a person reads it (its manifest, its cards): US and Latin American
  Spanish with "tú", openPadel's word list (AGENTS.md), and no em dashes.

## 6. The release and the licence

- The release is a `.tar.gz` at an https address, its SHA-256 the one pinned, built from the source the review read
  (the same bytes from the same files: a `tools/pack.ts` like this repository's plugins').
- An OSI-approved licence, as an SPDX name in the manifest, and the source public at `homepage`.
- No dependency that isn't pinned to an exact version, and none it doesn't need.

When the review finds something, the author fixes it and the release is pinned again: a listing is always one exact
release, reviewed.
