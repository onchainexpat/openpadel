# Playtomic (only for a club that also uses it)

**What it's for:** a club can keep Playtomic for court bookings while openPadel runs its clinics, socials
and Americanos. openPadel copies the club's Playtomic bookings in, read-only, so it never puts an event on
a court Playtomic has sold. openPadel never writes to Playtomic.
**Who does what:** the owner creates the API credentials in Playtomic (only an admin of the club's
Playtomic account can). The agent sets openPadel up and links the courts with the owner.
**Time and cost:** 20 minutes. Playtomic's Third Party API comes with its Champion and Master plans.
**`openpadel doctor` checks:** `playtomic`.

## Steps

1. **Owner: create Third Party API credentials** in Playtomic's club manager. You get a client
   id, a secret and the club's tenant id. Type them into the server's settings file:
   ```
   OPENPADEL_PLAYTOMIC_CLIENT_ID=...
   OPENPADEL_PLAYTOMIC_SECRET=...
   OPENPADEL_PLAYTOMIC_TENANT_ID=...
   # optional: OPENPADEL_MIRROR_EVERY_MINUTES=10  OPENPADEL_MIRROR_DAYS_AHEAD=30
   #           OPENPADEL_MIRROR_FAR_EVERY_HOURS=6  OPENPADEL_MIRROR_PAGE_SECONDS=60
   ```
2. **Agent:** `systemctl restart kumi`. The first read starts straight away and is gentle on
   Playtomic: one page of bookings a minute.
3. **Owner and agent: link the courts** on the staff app's Playtomic page, each Playtomic court
   to its openPadel court. Until a court is linked, its bookings are listed there but don't hold time.
4. **`openpadel doctor`:** `playtomic` should say when it last read.

## What a copied booking does
- **On a free court:** it holds the court in openPadel, whatever kind of booking it is.
- **The club's own Playtomic tournament or open play over an openPadel event:** taken as the club
  holding the court for that event. Those are the only two.
- **Anything else over an openPadel event:** a clash, listed for staff and sent to managers once. That's a
  player's booking (one-off, or a recurring one made for them), an open or league match, a lesson, a
  class or a course, and any kind of booking openPadel doesn't know yet (one Playtomic adds later).
- **Cancelled in Playtomic:** the court is free again in openPadel.

**How far ahead:** the next 30 days at every read (every 10 minutes). Further ahead, out to as far as
members can book or openPadel has anything on a linked court (a program's date, a weekly court, a block),
at most a year: 30 days of it after each read, each 30 days again every 6 hours. After a restart the
further reads start again from the nearest. Every page of bookings waits a minute after the one
before, whichever read it's for.

Court blocks made in Playtomic don't come through its API, so block openPadel's event times in Playtomic
yourself (one recurring block per series) to stop players booking them there.

**The archive:** every booking read is also kept as Playtomic gave it, players included, from the first read and
three months back (Playtomic keeps no more than that). Staff see a person's on their page; it comes with their data
download, and goes with their account. **Moving the club off Playtomic** (taking upcoming bookings over, the daily
comparison, the switch): see [moving-from-playtomic.md](../moving-from-playtomic.md).

## Common problems
- **`playtomic` fails with 401:** the credentials are wrong or were revoked; create new ones.
- **Bookings missing:** only linked courts hold time in openPadel; check the Playtomic page for
  unlinked courts.

## Moving the club off Playtomic: wallets and memberships

Members' Playtomic wallet balances become club credit here, and their memberships carry over, paid through Playtomic's
date: [playtomic-wallets-and-memberships.md](../playtomic-wallets-and-memberships.md).
