# Changelog

Each release says what changed for a club, and anything to do when updating. Versions follow
[semantic versioning](https://semver.org); before 1.0, a minor release (0.x.0) can need a step when
updating, and says so under "When updating". Database changes always apply by themselves when the
server starts.

## 0.1.0 (not released yet)

The first version a club can run on its own (court bookings included), or for its events alongside Playtomic.

**Court bookings**
- Opening hours and special days, court blocks, and a Courts page for staff to see the day, book at the
  desk (taking cash), block courts and cancel. No double bookings, even when many try at once.
- Prices by court, day, time and season, sales tax, and booking rules that bookings keep once made.
- Members book in the app and pay the whole court, or only their part: the others join from a link
  and pay theirs, and what's unpaid at the club's deadline goes once on the organiser's saved card
  (saved, never held). Cancelling refunds what the club's rules give. Calendar links.
- Messages for confirmations, shares paid, cancellations, money owed, and a reminder before playing.
- Occupancy and revenue by day, with a CSV export.

**Open matches**
- A member booking a court and paying their part can open it to other players: a level band, rated
  or friendly, listed on the Play page or only by its link. Players inside the band join and pay
  their place at once; outside it they ask the host, who says yes or no. A seat taken but not paid
  for opens again (10 minutes, or an hour for a player the host said yes to), and a payment left
  half-done is called off at Stripe first, so it can't go through unrecorded. Places still empty at
  the club's deadline go on the host's saved card.
- The host saves places for named friends (nobody else can take them; each pays their own). A player
  who can't make it puts their place up, and gets their money back when the match fills without
  them; after the deadline it's a late cancellation. "Running late" tells the others. After the
  game the host marks who didn't come, and hosts see each player's no-shows and late cancellations
  (90 days) when they join or ask.

**Results and levels**
- After a booking or open match, one of the four enters the score (sets, and who played with whom);
  someone from the other side confirms or disputes it, and with no answer in 48 hours it counts as
  entered. A rated match moves levels once confirmed, each with a sentence on why; a friendly never
  does. A dispute goes to the club's new Scores page: keep, correct or set aside, and levels are
  replayed as if it had always been decided that way. Fair teams are suggested once four are in.

**Memberships**
- Plans by the month or the year, with member prices on courts and a longer booking window.
- Members join in the app and pay by card; Kumi renews from that card each period at the price they
  joined at, with no subscription fee at Stripe. A declined renewal is tried again twice over five
  days while the membership carries on, and the member can pay with another card meanwhile.
- Members cancel in the app (it runs to the end of what's paid) and can change their mind until then.
- The club pauses a membership until a date (an injury, a long trip): no benefits and nothing charged
  meanwhile, and the paid time left moves to after the pause; ending a pause early gives the unused
  time back to the renewal date.
- Founding offers: a plan for the first so many members, starting on a date. Joining before then
  saves the card without charging it; the first charge is on the start date.
- The desk gives and ends memberships (with an end date or without), and can stop or restart a
  renewal. Messages for joining, renewals, declined cards, cancelling and ending.

**Events, programs and money**
- Clinics, courses, socials and Americanos with dates on courts that can't be double-booked.
- Sign-up and pay by card (Stripe; Apple Pay and Google Pay as cards), with waitlists. A place that
  opens is offered to the next person, held from when they can be told, and passed on if they don't
  take it.
- Taking someone off and refunding are separate decisions; passing a place to a sub; comped places.
- Americano rounds with fair teams, scores and re-pairing.
- Levels from results: members see theirs, how many rated games it rests on and each change;
  staff can set a level or a coach's floor, always with a reason.

**Clubs that also use Playtomic**
- Playtomic's bookings copied in read-only, so Kumi never uses a court Playtomic has sold.

**People**
- Members join by themselves (with their club-news answer kept as consent), or staff add them or
  import a spreadsheet. Staff roles by location.
- Messages: an in-app inbox and email for offers, confirmations, removals, refunds and staff alerts,
  with quiet hours and consent checked at the send.

**The public page**
- Once switched on: the club's locations, hours, courts, prices, memberships and upcoming public
  events, as plain HTML that search engines and AI assistants read, with schema.org markup and a
  sitemap. "Join the club" goes to the app's sign-up (the interest list before opening).

**Notifications**
- Push notifications on phones and computers, turned on per device in Profile: every message also
  arrives as a notification, encrypted for that device (Web Push, no third-party service of Kumi's
  own), with quiet hours and consent as for email. Staff alerts go to the staff app's devices.

**Running it**
- Setting up from `club.yaml` (`kumi setup plan`, `kumi setup apply`), member import, and
  `kumi doctor`; guides an owner's AI agent can follow (`docs/setup`).
- One-server install script or Docker Compose, HTTPS, nightly backups, tested restore.
- English and US Spanish throughout. Security: rate limits, no cross-site changes, strict headers.

**When updating:** nothing; this is the first release.
