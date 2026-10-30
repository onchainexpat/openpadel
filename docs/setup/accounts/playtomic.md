# Playtomic (only for a club that also uses it)

**What it's for:** a club can keep Playtomic for court bookings while Kumi runs its clinics, socials
and Americanos. Kumi copies the club's Playtomic bookings in, read-only, so it never puts an event on
a court Playtomic has sold. Kumi never writes to Playtomic.
**Who does what:** the owner creates the API credentials in Playtomic (only an admin of the club's
Playtomic account can). The agent sets Kumi up and links the courts with the owner.
**Time and cost:** 20 minutes. Playtomic's Third Party API comes with its Champion and Master plans.
**`kumi doctor` checks:** `playtomic`.

## Steps

1. **Owner: create Third Party API credentials** in Playtomic's club manager. You get a client
   id, a secret and the club's tenant id. Type them into the server's settings file:
   ```
   KUMI_PLAYTOMIC_CLIENT_ID=...
   KUMI_PLAYTOMIC_SECRET=...
   KUMI_PLAYTOMIC_TENANT_ID=...
   # optional: KUMI_MIRROR_EVERY_MINUTES=10  KUMI_MIRROR_DAYS_AHEAD=30
   ```
2. **Agent:** `systemctl restart kumi`. The first read starts straight away and is gentle on
   Playtomic: one page of bookings a minute.
3. **Owner and agent: link the courts** on the staff app's Playtomic page, each Playtomic court
   to its Kumi court. Until a court is linked, its bookings are listed there but don't hold time.
4. **`kumi doctor`:** `playtomic` should say when it last read.

## What a copied booking does
- **On a free court:** it holds the court in Kumi.
- **The club's own Playtomic tournament or open play over a Kumi event:** taken as the club
  holding the court for that event.
- **A player's booking, lesson or class over a Kumi event:** a clash, listed for staff and sent to
  managers once.
- **Cancelled in Playtomic:** the court is free again in Kumi.

Court blocks made in Playtomic don't come through its API, so block Kumi's event times in Playtomic
yourself (one recurring block per series) to stop players booking them there.

## Common problems
- **`playtomic` fails with 401:** the credentials are wrong or were revoked; create new ones.
- **Bookings missing:** only linked courts hold time in Kumi; check the Playtomic page for
  unlinked courts.
