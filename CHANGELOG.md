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
- The Courts page is the desk's day: courts across and time down (sideways on a phone), what's on now
  and next on each court with what's owed and who's running late, and the alerts that need someone,
  each shown until one of the staff marks it handled, for everyone.
- Staff move a booking to another time or court, or make it longer or shorter, by dragging it (or on
  buttons, or with the arrow keys), always through the preview. A lesson moves only when its coach is
  free then, and a program date moves through the same "this date" change as on its page. Moving keeps
  the price paid unless staff ask for it to be priced again; added time is owed at the desk; time taken
  off gives back by the club's cancellation rule, all of it or nothing, as staff choose. The players
  (and a lesson's coach) are told.

**Open matches**
- A member booking a court and paying their part can open it to other players: a level band, rated
  or friendly, listed on the Play page or only by its link. Players inside the band join and pay
  their place at once; outside it they ask the host, who says yes or no. A seat taken but not paid
  for opens again (10 minutes, or an hour for a player the host said yes to), and a payment left
  half-done is called off at Stripe first, so it can't go through unrecorded. A match that isn't
  full at the club's deadline is cancelled: the court is free again and everyone gets back all they
  paid, and nothing goes on the host's card (it isn't even saved).
- Same-day open matches: after the club's deadline, a member can still open a match, until the
  club's same-day cutoff (2 hours before the start, changed in the booking rules). Each player pays
  their part when they join, places can't be saved for friends, and a match that isn't full at the
  cutoff is cancelled with everyone paid back. The match page says when it has to be full by.
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
- Players on a court booked in full: the booker names the other players (people they know: friends, and
  people they've played with), or shares the booking's players link and the others add themselves. Nobody
  added pays anything, taking someone off moves no money, and a named player can take themselves off.
  With four on it, any of them enters the score, and the booker chooses whether it counts for levels
  (a friendly unless they say so), until the score is in.
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
- After a clinic or any program date, staff (or the coach who ran it) set the levels of everyone who had
  a place in one go, with one reason; each player whose level changes is told why.

**Coaches and private lessons**
- A profile for each coach (photo, a few lines, the levels and languages they teach, a rate for each
  lesson length, court included), the hours they give lessons each week, and time off. Coaches keep
  their own from the staff app; front desk and up keep anyone's. Members see the coaches in the app,
  and on the public page when it's on, never with their contact details.
- Members book a private lesson in the app: a coach, a length and a time when the coach gives lessons
  and a court is free. It's paid whole, or by each of 2 to 4 players like "pay my part". The court is
  booked with it, a coach can't be booked twice at once (nor during a date they run), and lessons
  don't count toward the club's limit on court bookings. The booker cancels under the club's rule; a
  lesson the coach or the club calls off gives everyone all their money back. The coach hears about
  each lesson booked, cancelled and coming up, and has a My schedule page.
- Each program date can name its coach, who then sets the levels after it (other coaches can't).
- Reports show lesson revenue apart from courts, and each coach's lessons (paid, less refunds) and the
  dates they ran, with a CSV for payroll: a coach sees their own; owners, managers and the accountant
  everyone's.
- Choosing a refund other than the club's rule when cancelling a booking is for staff only (a member
  could ask for a full refund on a late cancellation before).
- A coach's calendar link: Google, Apple or Outlook calendar subscribes to it and shows their lessons
  and program dates, with the court and the players' names (a junior by first name only, nobody's
  contact details), refreshed about every hour. A cancelled one stays in as cancelled, so the calendar
  drops it. The address itself is the key: making a new link stops the old one at once.
- Who's coming to each lesson and program date, from My schedule and the program page: each player's
  level, a junior's parents, and whether they've accepted the club's waiver. The coach who runs it (or
  front desk and up) marks who came and who didn't, from the start until 48 hours after. "Didn't come"
  counts in the player's no-show record, the same one hosts see in open matches, and the player is
  told. Setting a clinic's levels leaves out whoever didn't come.
- My students: everyone a coach worked with in the last 90 days, with their level now and the last
  time. Front desk and up open any coach's from the Coaches page.

**Families, juniors and the waiver**
- A parent adds their children under Family in the app: a name and a birth year, nothing more, and no
  login of their own (anyone under 18). Kumi never collects anything from a child directly. The parent
  signs them up for clinics and programs, books their lessons, pays, and gets their messages, each
  marked with the child's name. A junior doesn't book courts or play in open matches, and never shows
  on the public page, among friends or in anyone else's lists; their level is for their parents, their
  coaches and staff.
- Another parent joins the family from an invite link (it works for 7 days); then both manage the same
  juniors and both get their messages, each in their own language. A parent can't leave the juniors
  with nobody. From the year a junior turns 18, a parent (or staff) gives them their own login by
  adding an email; they stay in the family but don't manage its juniors.
- The waiver: the club writes it in Settings, and each change is a new version. An adult accepts it
  before their first booking or sign-up, and a parent accepts it for each junior; a new version asks
  again. Who accepted, for whom, which version and when are kept, and staff see it on the person's
  page. With no waiver set, nobody is asked. Staff booking at the desk aren't stopped by it.
- Kids with a login of their own: from the year a junior turns 13, a parent can turn on a login with
  the kid's email. The kid then books courts, joins open matches, signs up for clinics and programs
  and books lessons themselves, with the family plan's member prices, and each payment goes on the
  family card at once (a card a parent saves on the Family page; the kid never sees a card form).
  The parents get a message for each charge and each refund. They set what the kid may do on their
  own (open matches, courts, programs and lessons, each on or off) and a monthly limit ($100 to
  start); anything switched off or over the limit goes to the parents as a request, and a yes books
  it there and then (planned afresh, so a court taken meanwhile is said, not booked). Nothing is held
  while a request waits. A card that's declined or wants its owner to confirm, or no card saved,
  means a parent is asked to pay it in the app instead. The kid stays a junior: off the public page
  and level lists, the waiver is their parents' to accept, memberships are their parents' to look
  after, and friends stay off until a parent turns them on (then nobody can add them, and they can't
  take a place from someone's link). Turning the login off signs them out everywhere.

**Receipts**
- A numbered receipt for every payment that goes through and every refund sent, to whoever paid: by email
  (whatever they chose about news) and in the members' app (Profile, then Receipts), where each prints. It
  has the club and its address, what was bought and when, the subtotal, the sales tax when the club charges
  it, the total, the card's brand and last four digits (from Stripe), and the date. Several courts paid in
  one checkout share a receipt; a kid's charge on the family card is the receipt of the parent who saved the
  card, naming the kid; a refund's receipt names the receipt it refunds. Paid at the desk (cash, the club's
  card reader, another way) says so. No notification on phones for a receipt. Staff who take or see the
  club's money (owners, managers, front desk, accountants) see someone's receipts on their page and can
  email one again. Receipts start with this version: nothing paid before it gets one. Turn off Stripe's own
  receipt emails (docs/setup/accounts/stripe.md) so members don't get two.

**Memberships**
- Plans by the month or the year, with member prices on courts and a longer booking window.
- Members join in the app and pay by card; Kumi renews from that card each period at the price they
  joined at, with no subscription fee at Stripe. A declined renewal is tried again twice over five
  days while the membership carries on, and the member can pay with another card meanwhile.
- A membership payment left unfinished (the card form, or the bank's check, left open) is called off at
  Stripe after a day, so it can't go through later unrecorded; nothing was started by it, and the member is
  told once that they weren't charged and where to try again.
- When a card payment or a refund doesn't go through, people are told why in plain words (the card was
  declined, it has expired, the payment was already refunded), never a code from Stripe; a reason that
  means nothing to a person isn't given at all.
- A refund that doesn't go through tells the owner and managers what it was for (the program, the court
  or lesson and when, or the membership) and links to the program's page or the person's.
- The owner and managers hear once when a renewal is declined (not at every try): who, the plan, the
  amount, the bank's reason when it gives one, the next try and the last day, with a link to the
  member. It waits on the Courts page's alerts until it's handled, or closes by itself when the
  renewal is paid after all (they hear that too). If the last try fails, they hear the membership
  ended, and that takes its place on the alerts.
- Members cancel in the app (it runs to the end of what's paid) and can change their mind until then.
- The club pauses a membership until a date (an injury, a long trip): no benefits and nothing charged
  meanwhile, and the paid time left moves to after the pause; ending a pause early gives the unused
  time back to the renewal date.
- Founding offers: a plan for the first so many members, starting on a date. Joining before then
  saves the card without charging it; the first charge is on the start date.
- The desk gives and ends memberships (with an end date or without), and can stop or restart a
  renewal. Messages for joining, renewals, declined cards, cancelling and ending.
- Family plans: a plan covers up to so many people from one household on the payer's card, and
  optionally more at a price each. The payer adds the other parent, grown-up children and juniors on
  the Membership page; each of them gets the plan's benefits (member prices, the booking window,
  program discounts) and their own included sessions. One more than the plan covers is charged for the
  current period at once and added to each renewal; someone taken off (or who leaves the family) keeps
  the benefits until the next renewal. Pausing, a late renewal and ending apply to everyone on it.
  If the card is declined for one more person, they aren't added, and adding them again tries the card again.
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
- Apple Pay and Google Pay show on the card form: the server registers the members' address with Stripe
  as it starts (on the club's own account under Connect, once it has one), and `kumi doctor` says
  whether they're on.
- Taking someone off and refunding are separate decisions; passing a place to a sub (who pays their
  own price: a member price, or one of their included sessions); comped places.
- Dates added once a week for as many weeks as wanted, at the same club time across clock changes.
  A program's dates are changed (time, length, courts, coach) or cancelled as this one, this one and
  the ones after it, or every date still to come; the preview lists each date as it was and will be,
  what's in the way (a booking, a block or another program on the court, the coach teaching, in a
  lesson or away) and who's signed up, and they're told. Another program at the same time for the
  same players is a warning, not a block. Undoing a change puts the dates back if the courts are
  still free, and tells the players. Places are for the whole program, so more of them go to the
  waitlist first.
- Cancelling dates: one date of a course paid once gives back that date's share of what each paid;
  cancelling every date cancels the program and gives everything back (or staff choose all or
  nothing, with a reason). A whole program can be cancelled from its page.
- Before publishing, staff see the card exactly as members will, each date with its courts and coach,
  and anything in the way; publishing waits until nothing is.
- A minimum to run: a program short of it at its decision time (24 hours before its first date, or
  its own) is cancelled and everyone gets their money back and is told. Front desk hears once before
  that (24 hours, set in Settings) how many it still needs, to push it. Members see "needs 2 more to
  run" on the card.
- "Tell me when a place opens" on a full program: the waitlist is offered places first; once a place
  is open to anyone, everyone watching hears once. A watch ends when they sign up.
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
- Your data: a member downloads a copy of everything Kumi holds about them (and the juniors they
  manage) as one JSON file from Profile, or deletes their account. Anything still running (bookings or
  places to come, a membership that would charge again, money owed, a kid's request) is listed with how
  to clear it, and deleting waits until it's cleared. Deleting removes their name, contact details,
  sign-ins, devices, friends and family links, here and in the history (Changes, events, other people's
  messages and level reasons), and keeps payments, refunds and game results under "Former member"
  ("Exmiembro" in Spanish), so the books and other players' levels still add up. Juniors only they
  manage go with them. The owner can do either for a member who asks (a manager asks the owner), and
  the club is told each time.
- Asking the club: the club's own answers ("club facts", in each of its languages) show in the app as
  Common questions, searched by plain words, before a member asks; the ones the club marks public are
  on its public page too, with FAQ markup. What a member still asks (or a parent, about a junior) is a
  thread on the staff app's Questions page, the longest wait first, with the member's membership and
  level beside it. Front desk and up answer it (the member hears in the app, by push and by email), give
  it to someone, close it, or turn an answer into a club fact. A question that waits past the club's
  setting (2 hours to start, counted only in opening hours; 0 turns it off) is told to front desk once.
  Five new questions a day each. Questions are in the member's data file, and deleting the account
  takes their words out of the history too.
- Ask the club (optional): with a decision model's key on the server (TypeSafe's Jev, Claude Haiku, or
  both, Jev first), a new question is answered at once from the club facts, word for word, when one
  answers it completely; otherwise it waits for the staff as before. The model never writes anything,
  and anything about the member's own bookings, money, membership or level, a complaint or an injury
  goes to a person. Only the question's words and the facts go to the model, never names or details.
  The question is saved with the staff first, so a slow or failing model only means it waits for them,
  and a staff answer always wins. Under the fact, "That didn't answer it" or "Ask a person" sends it to
  the staff at once. Staff see which fact Kumi sent and how sure it was; every decision is kept with
  the version of its questions and thresholds. Settings can switch it off. `kumi doctor` and
  `/health/deep` report it. The services that see member data are listed in `docs/processors.md`.
- Messages to members, for front desk and up: write once, in each of the club's languages ({first_name}
  and {club} filled in for each person), to a group, now or at a set time. A group is a set of filters
  (membership and plan, level, the club's own tags, played lately or not, adults or juniors, language,
  in a program, a booking or place on a date, when they joined), saved with a name or built on the spot,
  and means whoever matches when it's used; a live count shows who that is. Club news goes only to people
  who said yes to it, and the preview says how many are left out. A service notice (a court closed, a
  clinic moved) needs no yes, so it only goes to people with a booking or place on a date or in a program;
  one about something within a day goes at once, even in quiet hours. Juniors are reached through their
  parents ("For Mia: ..."); a kid with a login of their own hears it themselves, and their parents get a
  copy of service notices. The app's copy is there at once; email waits out quiet hours for club news and
  is spread over days under the club's daily cap (80 to start, in Settings), so the club's own messages
  keep room. The sender gets a copy (owners and managers too, if the club wants). The Messages page lists
  what went, to which group, and what came of it by channel; a message can be called off before it goes,
  and email still waiting can be stopped. Templates keep words to start from.
- Club news emails carry one-click unsubscribe (RFC 8058, and a link at the foot): it stops club news by
  email with no sign-in, and nothing else. Members turn club news on or off in Profile too. The link is on
  the members' app's address (`KUMI_MEMBER_URL`), never the staff app's.
- Tags: the club's own words for members ("league A"), put on a member's page. The People list searches by
  name, email or phone and narrows to a tag or a saved group. Tags, and the groups, templates and messages
  a staff member made, are in the data file; deleting an account takes the tags off and kills the old
  unsubscribe link.
- Staff start on the page their role uses: owners and managers on Changes, coaches on their schedule,
  front desk on Courts, the accountant on Reports.

**The public page**
- Once switched on: the club's locations, hours, courts, prices, memberships and upcoming public
  events, as plain HTML that search engines and AI assistants read, with schema.org markup and a
  sitemap. "Join the club" goes to the app's sign-up (the interest list before opening). Its own address,
  for search engines, is the members' app's, even when someone opens it from the staff app.

**Notifications**
- Push notifications on phones and computers, turned on per device in Profile: every message also
  arrives as a notification, encrypted for that device (Web Push, no third-party service of Kumi's
  own), with quiet hours and consent as for email. Staff alerts go to the staff app's devices.
- Texts, through the club's own Twilio account (optional): a member confirms their US or Canadian
  number with a texted code and ticks the yes themselves in Profile, and Kumi keeps the words they saw,
  their version, the number and the device. Texts are only for what can't wait: a place offered with a
  deadline, a booking, lesson or class the club cancelled or moved, a court lost while paying, a match
  that didn't fill. Each starts with the club's name, ends with how to stop and keeps to plain letters
  (one segment where it can). STOP to the club's number turns every message to that member off at once;
  START turns texts back on; HELP is answered with the club's name. Codes are guarded against SMS
  pumping (the bot check, no Caribbean or premium numbers, limits per number, person and club). A kid
  with their own login says yes once a parent turns texts on. Twilio's delivery reports are checked
  against its signature; `kumi doctor` and `/health/deep` report texts. US carriers must approve the
  club's texting registration (in its own Twilio console) before real texts reach anyone.
- Wording: a reason or note someone typed that ends its own sentence ("Fine for now.") no longer shows a
  second full stop after it. A message's preview of who it reaches names only people it will reach (club
  news never names someone left out for having said no). Creating an Americano (or another format) says so
  in its preview. The waiver's text box in Settings has a label for screen readers.

**Signing in and roles**
- Signing in, or joining, by a code texted to a US or Canadian mobile number, when the club texts: "Use my
  mobile number instead" on the sign-in page. A new number joins with a name and language, and no email is
  needed; the app then asks (never requires) for one, confirmed by a code, for receipts by email and to sign
  in if the phone is lost. A number belongs to one account. The answer is the same whether or not a number
  has an account; codes live 10 minutes, take five tries, and count with the profile's number codes (three a
  number and 30 for the club an hour, plus the bot check). A sign-in code needs no yes to texts: it's a text
  the person asked for. Staff can sign in this way too, and still owe their second step; a junior only once
  their parents have given them a login. In practice mode the code is in the server's log, as an emailed one is.
- Two-step sign-in for staff: a passkey (both steps by itself), or the emailed code followed by a code from
  an authenticator app. Setting one up shows a QR code and the key to type, then ten recovery codes, shown
  once and kept only as slow hashes, each good once. Owners, managers and anyone with a role the club made
  must use it (the default), or every staff role if the club says so in Settings; members can choose it
  for themselves. Until the second step is given, nothing but finishing the sign-in answers. The owner can
  start someone's second step over (a lost phone): their authenticator, recovery codes and passkeys go and
  they're signed out everywhere; `kumi reset-sign-in <email>` does it on the server for an owner who is
  locked out. Connecting an agent asks for the second step too.
- Bot protection with no third party, on sign-up, sign-in codes and opening a card form: a field people
  never see, and a small proof of work the page solves (a fraction of a second on a phone, harder for an
  address that keeps failing). It's always on in production; staff at the desk and agents don't meet it.
- Roles the club makes: a name and, area by area, what it can do (nothing, the person's own, or
  everyone's, with or without approval). The preview says in plain words what it can and can't do. A
  club's role only holds what a manager does without asking; anything else is the owner's. Nobody can
  make or give a role that does more than they can. The built-in roles stay as they are and can be copied
  as a start. Someone whose only staff role is the club's own sees only the areas it covers, and their
  screens offer only the changes the role allows (no "Add a person" or "Import" on People without them)
  and don't ask for lists the role can't read.
- Fixed: grants like "person.passkey_*" (a family of actions) now apply, so front desk, coaches and
  accountants can add and remove their own passkeys, as was meant.
- Someone given a staff role (or another owner's) is emailed once, in their language: who gave it, the role and
  where, and the staff app's address to sign in at, with a word about the second step when their role needs
  it. Taking a role away tells them once too. Nobody hears about a role they gave themselves.
- The staff app opens on the day on the courts for owners, managers and the desk (a coach on their schedule,
  the accountant on reports); Changes, the audit log, has its own page and link.

**Running it**
- Setting up from `club.yaml` (`kumi setup plan`, `kumi setup apply`), member import, and
  `kumi doctor`; guides an owner's AI agent can follow (`docs/setup`).
- One-server install script or Docker Compose, HTTPS, nightly backups, tested restore.
- The server's own key (`KUMI_SECRET_KEY`, made at install, never printed) seals the secrets Kumi keeps:
  staff authenticators, the push signing key and the vault. Production won't start without it; a server
  from before gets one on its next update and seals what it has as it starts. `kumi rotate-key` moves
  everything to a new key.
- The vault, for the owner only (Settings): the club's keys (a supplier login, the alarm code) and small
  documents (insurance, the lease), sealed. A secret is never shown again, only its last four characters;
  documents are PDFs or pictures up to 2 MB, downloaded by the owner, and each download is kept. Neither
  an action nor the change log ever holds what's inside.
- Updates that can be undone: `deploy/ship.sh` installs the new release beside the running one, takes a
  snapshot of the database, switches and checks it answers as the new release; if it doesn't, the old
  release and the snapshot go back by themselves. `sudo kumi rollback --yes` goes back later (losing what
  happened since). The last 3 releases and snapshots are kept. With Docker, `deploy/docker/update.sh`
  does the same with images tagged by release; given a branch, it takes the branch's newest commit, and
  after an update that didn't come up, `rollback` still goes back to the release before the last one
  that worked.
- Backups with a manifest: each night's dump comes with every table's row count, from the same snapshot.
  Offsite copies go to the club's own S3-compatible storage (Cloudflare R2, Backblaze B2, S3, Spaces),
  sealed with a backup key of their own; 30 daily and 12 monthly are kept. Once a month the newest is
  restored into a scratch database and checked against its manifest. If the backup, its offsite copy or
  the check starts failing, the owner and managers are told once. `kumi restore` restores a local or
  offsite backup, and keeps the server's own record of its backups as it was (so doctor doesn't go back to
  the night the backup was made). Backup files and update snapshots can be read only by the server's own user.
- Backups run at 3:17 at night on the club's clock, and the restore test on the 1st at 4:17, whatever the
  server's clock is (Docker's is UTC). The timer, or Docker's backup service, checks every hour; a server
  that was off at 3:17 catches up at its next check. In Docker, doctor's hints name the backup service and
  Docker's own guide.
- Two addresses: the staff app's (`KUMI_PUBLIC_URL`) and the members' (`KUMI_MEMBER_URL`, which the
  install sets; without it, the staff address without its `staff.`). `kumi doctor` checks both answer.
- `/health/deep` (on the server itself, or for an owner or manager): the database, the outbox, the last
  backup, offsite copy and restore test, and disk space. `/health` now names the release's commit.
- English and US Spanish throughout. Security: rate limits, no cross-site changes, strict headers,
  two-step sign-in for staff, bot protection.
- Light apps: each app downloads only its own wording, in the person's language, and set-up pages load
  when opened. The members' app needs about 124 kB of JavaScript before its first screen (under its
  200 kB budget, which the build now checks); the staff app about 150 kB.

**When updating:** nothing; this is the first release. An update rewrites the backup timers, so backups
move to the club's 3:17 by themselves (with Docker, `deploy/docker/update.sh` starts the backup service
again with the new schedule). (A server set up from a test build before it gets
`KUMI_SECRET_KEY` added to `/etc/kumi/kumi.env` by its first update; with Docker, `deploy/docker/update.sh`
adds it to `.env`. A Docker checkout from before `update.sh` existed runs the release's own copy:
`git fetch && bash <(git show origin/main:deploy/docker/update.sh) main`.)
