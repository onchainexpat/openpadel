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
  An open match works differently (below): nothing goes on the host's card.
- Several courts the same day in one checkout (whole courts): one card payment for all of them, at
  each court's own price (member prices included), and one message. Each court is still its own
  booking, cancelled on its own, with its part of the payment refunded. If someone takes one of the
  courts while the payment is going through, that court's part comes back and the rest stay booked.
- Messages for confirmations, shares paid, cancellations, money owed, and a reminder before playing.
- Occupancy and revenue by day, with a CSV export.

**Open matches**
- A member booking a court and paying their part can open it to other players: a level band, rated
  or friendly, listed on the Play page or only by its link. Players inside the band join and pay
  their place at once; outside it they ask the host, who says yes or no. A seat taken but not paid
  for opens again (10 minutes, or an hour for a player the host said yes to), and a payment left
  half-done is called off at Stripe first, so it can't go through unrecorded. A match that isn't
  full at the club's deadline is cancelled: the court is free again and everyone gets back all they
  paid, and nothing goes on the host's card (it isn't even saved).
- If the host cancels, the players who joined get everything back whenever it is; the club's late
  cancellation rule is for the host's own payment.
- The host saves places for friends (nobody else can take them; each pays their own, and a saved
  place still unpaid at the deadline counts as empty). A player who can't make it gets their
  money back at once and the place opens, up to the deadline.
- Up to the start, a player who can't make it can find someone to take their place: a friend by
  name, or anyone inside the band through a "take my place" link. The sub pays in the app; only
  then is the place theirs and the player paid back, and it isn't a late cancellation. The offer
  can be taken back while nobody has paid (a payment that goes through after that is refunded).
- After the deadline, backing out without a sub is a late cancellation, and the front desk hears
  about it once. Staff open the empty place in the app (whoever joins and pays takes it over) or give
  it to someone free, from the Courts page.
- What a late leaver gets back is the club's rule, set in Settings with the booking rules and kept
  with each booking: by default all of it when their own sub or a paying player takes the place, and
  nothing when nobody does or it's given free. Staff can choose all or nothing more instead, case by
  case, and every preview says the amount. "Running late" tells the others. After the
  game the host marks who didn't come, and hosts see each player's no-shows and late cancellations
  (90 days) when they join or ask.

**Friends**
- Members add people they've played with (the same booking or game), or anyone who sends them their
  friend link; once each has added the other, they're friends. A Friends page lists friends, who added
  you, whom you added, and people you've played with lately. Only friends can save each other a place
  in a match, and the search for one looks among friends only: no member's name is shown to someone
  they haven't played with or given their link to.

**Results and levels**
- After a booking or open match, one of the four enters the score (sets, and who played with whom);
  someone from the other side confirms or disputes it, and with no answer in 48 hours it counts as
  entered. A rated match moves levels once confirmed, each with a sentence on why; a friendly never
  does. A dispute goes to the club's new Scores page: keep, correct or set aside, and levels are
  replayed as if it had always been decided that way. Fair teams are suggested once four are in.
- A new player who feels their level is wrong can move it once, by up to half a level either way, in
  their first 5 rated games; it's kept as a move, so a replay after a corrected score keeps it too.
- Any player can ask the club to review their level, free, once every 30 days, with a note.
- A new Levels page for staff (front desk and up, and coaches): the reviews asked for, and any level
  that moved more than 0.50 in 30 days (counted from the last time staff looked at it). Each is kept
  or changed with a reason; players who asked are told either way, and a changed level is always told.
- After a clinic or any program date, staff set the levels of everyone who had a place in one go, with
  one reason; each player whose level changes is told why.

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
- Member prices on clinics and other programs: a plan gives a percent or an amount off, and a
  program can set its own member price instead, which wins. A plan can also include so many single
  sessions each membership period (say 4 clinics a month), of the kinds it names; courses never count.
  Signing up uses an included session while there's one left, and leaving in time gives it back.
  Members see their own price on What's On, and everyone else what members pay (on the public page
  too). A place keeps the price it was taken at, so changing a price never changes what someone
  agreed to; staff are told how many have signed up when they change one.

**Events, programs and money**
- Clinics, courses, socials and Americanos with dates on courts that can't be double-booked.
- Sign-up and pay by card (Stripe; Apple Pay and Google Pay as cards), with waitlists. A place that
  opens is offered to the next person, held from when they can be told, and passed on if they don't
  take it.
- Taking someone off and refunding are separate decisions; passing a place to a sub (who pays their
  own price: a member price, or one of their included sessions); comped places.
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
