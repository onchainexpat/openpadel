# Changelog

Each release says what changed for a club, and anything to do when updating. Versions follow
[semantic versioning](https://semver.org); before 1.0, a minor release (0.x.0) can need a step when
updating, and says so under "When updating". Database changes always apply by themselves when the
server starts.

openPadel was called Kumi until 7 November 2026; the releases from before then keep the name they had.

## Unreleased

### Added
- **Moving a club from Playtomic** ([docs/setup/moving-from-playtomic.md](docs/setup/moving-from-playtomic.md)): the
  four stages (shadow, side by side, openPadel first, Playtomic off), what openPadel does and what staff do at each,
  and the traps at the switch.
  - **The archive.** Every Playtomic booking the mirror reads is kept as Playtomic gave it, players by name and email
    included, from the first read, three months back (Playtomic keeps no more) and as far ahead as Playtomic has them
    (up to a year, read once a day for the archive only), matched to members by email or Playtomic id. Staff see a
    person's on their page, read only (a coach without who they played with, as in openPadel's own list); it comes with the
    member's data download; and their name and email go from it with their account. Deleting an account marks the
    person, by their Playtomic id and a salted one-way hash of each address (never the address; ids are learned as
    they're matched), so no later read of Playtomic, bookings or players, brings them back. Only their own act brings
    them back (signing up again themselves, adding or changing their own address, or first signing in to an account
    the desk made for them), and it starts fresh from that day: what Playtomic holds from before stays out, what's
    theirs after comes in (their upcoming bookings are read again by name). Nothing staff do lifts it: a member import
    leaves their line out, counted and not named; support access or the desk at their address lifts nothing (the
    desk's preview says the address belonged to a deleted account, naming nothing of it).
  - **Taking over upcoming bookings** (staff app, Playtomic; owners and managers). Chosen Playtomic bookings become
    bookings here on their linked court, with their players, and read "Paid in Playtomic" at the desk and in My places.
    What was paid in Playtomic stays paid there: nothing is owed, nothing enters the books, and no receipt is made. A
    refund of it is made in Playtomic, whatever gives it back (the booking cancelled, its weekly court ended, a court
    blocked over it, made shorter, moved or repriced): the preview says how much, by the club's rule or as staff chose,
    or that Playtomic already refunded it; the managers are told why and by which (on Today until handled); and it's kept as given back
    there, so a later change counts only what's left. Recurring ones every week become a weekly court. What can't be
    taken over (a class, a player not a member here yet, partly paid, a clash) stays in Playtomic, held here, and the
    preview says why by name. The mirror knows a taken-over booking by Playtomic's id: it never holds it twice, even
    when Playtomic moves it to another court, and holds it again if it's cancelled here. One taken over unpaid and paid
    in Playtomic since: the desk marks it paid there (booking.paid_in_playtomic), for what Playtomic says it took, never
    the price here (time added here stays owed here, and the preview, the desk's court detail and the person's page
    say how much, beside what was paid in Playtomic). The players are told what the club refunds them in Playtomic,
    when it's cancelled, moved or made shorter.
  - **A daily comparison for the owner**: each linked court and day, Playtomic and openPadel side by side, on the
    Playtomic page; a clash, a booking not held yet, or a taken-over one moved (another time or court), cancelled or
    paid in Playtomic is told to the owners once.
- **Moving in from Playtomic: wallets and memberships** (the staff app's Playtomic page, Moving in; or
  `openpadel move-in` on the server; [the guide](docs/setup/playtomic-wallets-and-memberships.md)). The owner's, with a
  manager first seeing the preview, then asking (an ask the owner's own run covered is settled, others keep waiting;
  an ask that no longer needs a yes is shown again to confirm, never said to be done); never support access or
  an assistant. Both read only what the server read itself, newer than the last run: Playtomic's
  players through its Third Party API (at Playtomic's pace; a read that can't reach the end fails and says so), or the
  club's customer export as uploaded and read on the server. Each player is matched to a member here by Playtomic id
  or email (import the members first), and someone whose account was deleted isn't read again. Nothing changes in
  Playtomic: each preview says what to do there.
  - **Wallets become club credit:** each member's wallets, added up in the club's currency, are owed to them here like
    any club credit (in the books as money owed, from "brought in", never revenue). Each member has one total from
    Playtomic, so a re-run moves only the difference whatever the wallets are called, and the same money never comes in
    twice, nor again to someone who deleted their account and joined again (the total follows their Playtomic id and
    address, kept as one-way hashes). Less than before is taken back only when staff choose it, from what came from
    Playtomic and the member still holds (never a refund or gift card credit), and never once the owner says the
    wallets are being set to zero in Playtomic. The same player on two rows counts once, and rows that
    disagree are listed. The preview lists the export's columns read as wallets, any of which can be left out, and
    anything over $10,000 for one person (a ceiling the owner gives for a currency openPadel can't size, and can only
    lower for one it can), in another
    currency or unreadable. Players who aren't members here are counted, not named, and an upload keeps nobody whose
    account was deleted here; the change history keeps only an upload's hash and row count. The owner and managers hear once, on
    Today, to set the wallets to zero in Playtomic in the same hour; it stays there, with a link to the page, until the
    owner says it's done, and after that no more credit comes over. Paying this credit out at the desk warns that it
    may have been topped up by card.
  - **Memberships carry over,** each on the plan here that staff choose for it, paid through Playtomic's last day, with
    nothing charged now. On a plan members join in the app, it renews here from that day on a card the member adds in
    the app, on Playtomic's day of the month: they're told a week before, and without a card it ends that day, with
    nothing charged and no failed renewal for staff. On a desk plan, the next period is paid at the desk. Someone
    already a member here, a plan that's full, a membership with no end date and a commitment period (kept in the note,
    not held to) are said in the preview, as is stopping the renewals in Playtomic.
### Changed
- **What a staff role kept to one location may do.** It works its own location as before, and now also what belongs
  to no location: staff alerts that aren't about one place (an alert about a booking or a program stays its
  location's, so Eastside's front desk can't mark Westside's handled), members' questions, and levels. The whole
  club's own things stay with managers and the owner: messages to a group of members, the groups, message
  templates, the club's facts, and downloading someone's data or deleting their account. Those are refused in words
  that say who does them ("messages to a group of members are sent by a manager or the owner"), not "your role
  doesn't cover this location", and the staff app hides their buttons (/me lists them as `cannot`). A role with no
  location keeps everything its role allows.
### Fixed
- **A booking moved later was refunded by the time it left (0.1.0 to 0.4.0).** A cancel measured "how long before"
  from the earliest time the booking ever had, so a court moved from tomorrow to next week and cancelled five days
  ahead counted as cancelled late: "Nothing comes back: it's less than 24 hours before", and nothing did. The same
  wrong time decided what goes back in Playtomic for a booking taken over from it, and for a moved week of a weekly
  court when it ended. It's measured from the time the booking has now. Also measured from the old time: a member with time owed at
  the desk on a court moved to next week couldn't book anything once the time it left had gone by ("You still owe
  $20.00 on a court booking"), and the list of bookings refunded after a restore and still to come (0.3.0 on) could
  keep one moved earlier and already over.
- A cancelled booking's page still offered to chat with the players (0.3.0 on) and to name who's playing (0.1.0 on).
  It's read only now: what it was, that it's cancelled ("This booking was cancelled." for a court, as a match says),
  and what came back of what you paid, and where to.
- A booking cancelled in the same moment it was made (at the speed of an assistant or a script) could still send its
  "Booked" email after it. News of it being booked not gone out yet by email, push or text doesn't go now, as for a
  move; the in-app copy stays.
- **A booking moved, then cancelled, was said to be at its old time, and a moved booking showed twice in My places
  (0.1.0 to 0.4.0).** A move (or a new length) retires the booking's court time and takes a new one; once it's
  cancelled none is current, and what read "the current one" took any. So the players' cancellation said the old time
  and court ("Cancelled: Court 3, Sat, Nov 14, 9:00 AM" for one moved to 1:00 PM), and so could the match page, the
  person's page in the staff app, receipts and what a payment was for; a cancelled lesson's place in the coach's
  earnings and calendar always took the oldest; a chat about it (0.3.0 on) spanned both times. And before any cancel,
  My places listed a moved booking once for each time it had had. Each now reads the time the booking has, or, once
  cancelled, the last one it had. News of a move or a new length not yet gone out by email, push or text when the
  booking is cancelled doesn't go (the in-app copy stays), and one not written yet isn't: the cancellation says where
  it was and what comes back.
- **An ask the owner's own change made out of date waited for a yes it could never get.** A manager's ask (club
  details, say) that read something the owner then changed directly is now marked out of date at once. The Changes
  page says why ("Out of date: what it asked for has changed since..."), as it does for one done meanwhile by another
  change, and approving either says the same instead of "it is failed". Asks to say the Playtomic wallets are being
  set to zero, or are at zero, are settled when the owner says it, and approving one later never moves when the
  zeroing started.
- **A member's data download, the club's export and move, and an undo sent their ask on the first tap.** Like every
  other change that needs someone's yes, each is shown first and asked for only when the person says so.
- **A club setting's preview said only which setting changed** ("Change the legal name."). It says what to now: "the
  legal name to Kestrel Padel LLC", "whether members book courts in the app (yes)".
- **The Moving in page lost who uploaded the export** ("by -") and how many deleted members it left out.
- **Front desk kept to one location couldn't add a person** ("your role doesn't cover this location"), though the
  button showed and the role allows it. A person belongs to no location, so a desk role kept to one now adds people,
  tags and untags them, adds a junior, lets a held-back address through again and sends a receipt again (one from
  another location stays that location's). In 0.4.0 too.
- **A change to the club's details couldn't be undone once the move-in from Playtomic had done anything** ("something
  has changed it since"). Its runs, the wallets being zeroed and every read of Playtomic's players wrote to the
  club's row, so each looked like a change to the club's details, and it also put a manager's waiting ask to change
  one out of date. The move-in keeps its state in a row of its own now (migration 110).
- **An undo's preview of the club's details named no values** ("Undo: Change the club's details"). It says what goes
  back: "Undo: the legal name goes back to Kestrel Padel Co."
- **A Playtomic take-back could reach a member's own refund or gift card.** What they had spent here was counted
  against credit that wasn't card money first, so a cash refund given as credit, or a gift card bought in cash, could
  count as spent and leave Playtomic's credit whole to take back. Now what they spend counts against Playtomic's
  credit first, walked in the order it happened, and a take-back never touches anything they were given here. The
  pay-out warning still counts card money last: it asks how much may be a stolen card's.
- **A member's own weekly court was refunded again when their account was deleted again after a restore (in 0.3.0
  to 0.4.0).** Putting a copy back from before a member ended their weekly court (refunded then by the club's rule)
  and deleted their account, openPadel deletes the account again, and ends the weekly court it finds with no money moving:
  but every paid week went back to the card a second time. Now nothing moves; the weeks are listed for the staff to
  check against the payment provider, as before.
- **A message in the app, or an alert on Today, stayed in the language it was sent in (always).** The owner who
  switched to Spanish still read English alerts. The in-app copy now keeps both languages' words, and each reads in the
  reader's language when it's shown. Emails, pushes and texts go out in one language, as before.
- A person's page offered front desk (and anyone below a manager) the form to give or take away a role, including
  owner, and then refused it. Only owners and managers see it now. A refusal to give a role says what the role
  would let them do in words ("Undo a change"), not the action's internal name.
- Allow clicked twice at once on a device sign-in (two taps, or two tabs) could make two connections for one code.
  The code is taken at the first click now, and a check that fails after it (a wrong authenticator code) leaves it
  waiting to be answered again.

## 0.4.0 (2026-11-07)

The club's commands for agents and people (`openpadel`, from any computer), the new name openPadel with members
reading only their club's name, a starting level brought from another app, and assistants that never reach further
than their person allowed. Every club should update.

### Added
- **The phone apps, written down** ([docs/setup/apps.md](docs/setup/apps.md)): the members' and staff apps install
  from the club's own address with its name, icon and colour, for free and with every update at once; store apps for
  Google Play and the App Store need the club's own developer accounts in its company's name (a D-U-N-S number, 99 USD
  a year at Apple, 25 USD once at Google), their forms and reviews. openPadel doesn't build store apps yet. Linked
  from the README, the setup guide (step 5l), AGENTS.md and the setup skill (now `openpadel-setup`).
- **The club's commands from any computer, for agents and people** (`openpadel`, [docs/cli](docs/cli/README.md)).
  - `openpadel login <the club's address>` signs in in the browser, or with `--device` by a code typed and allowed on the
    club's page from a phone, for a server or an agent's machine with no browser of its own. It signs in only at the
    club's own addresses, over https.
  - It's an ordinary assistant connection: in Profile, Assistants, with its weekly spending limit, and ended there or
    by `openpadel logout`.
  - Then every read and change the club's assistant connector offers is a command: `openpadel day`, `openpadel people maria`,
    `openpadel program create`, `openpadel enrolment join`. Each change previews first and changes nothing until
    `openpadel confirm <run_id>` or `--yes`, and the same command asked twice is done once (asked again after a
    different change to the same thing, it's a new change). A `--key` names one change: used again for another, it's
    refused. The previews it keeps are the signed-in person's.
  - Staff can give names where ids go (`--person "Maria Lopez"`), and a time without a zone is on the club's clock.
  - Every command takes `--json`, and the exit codes say what happened.
  - What's only done in the app stays there, as for any assistant.
  - Every command is listed, with who may use it, in [docs/cli/reference.md](docs/cli/reference.md), made from the
    catalogue itself.
- **Staff reads for assistants.** A staff member's assistant (Claude, ChatGPT, or the command line) can now read what
  the staff app's main screens show: the day at a location, people, a person's page, programs, courts, coaches,
  alerts, reports, memberships and members' questions.
  - Each goes through that screen's own checks: a coach reads only their own work, and support access never reaches
    an assistant.
  - Emails and phone numbers come shortened, enough to tell two people apart, in what each read names and inside
    notes, alerts and previews too (except what the asker typed). People are found by name only there, so a
    shortened address can't be pieced back together from the answers.
- **Signing in from a device with no browser.** An assistant or a program on a machine with no browser can ask for a
  code, which the person types and allows at the club's `/oauth/device` page after signing in as usual. A link never
  carries the code, the page says when and from which address it was started, and an owner or a manager gives a
  fresh second step to allow it (their authenticator's code, or a passkey sign-in in the last 10 minutes).
- **A starting level from another app** ([docs/levels-from-other-apps.md](docs/levels-from-other-apps.md)). Nobody signs
  in to another app through the club's app. While a player has played fewer than 5 rated games here:
  - staff record what they saw in the player's app, or looked up (Playtomic, Playbypoint, WPR, MATCHi, the LTA rating,
    PadelLevels, Padelmates or another), on the player's level page;
  - the player brings it themselves in the members' app: at or below the club's line (Settings, 4.50 to start) it
    starts at once as their own word, and above it, or from an app whose levels aren't converted, staff check it on the
    Levels page first;
  - the member import takes a Playtomic customer export's Playtomic id (so a re-run finds the same person), phone
    (kept only for someone who has none), a yes to club news (only a yes, and never over a member's own answer) and
    Playtomic level with its reliability.

  Each is a provisional start, never surer than a level staff set and never a floor, and the player's level page says
  where it came from. The player can take it away while still new, and their level is worked out again without it.
  Assistants and the command line can't bring in or take away a player's own level. Links the player approves on WPR
  or PadelLevels wait for those apps' API access; nothing calls another app.

### Changed
- **Kumi is now openPadel,** free and open source padel software. The command is `openpadel`, and `kumi` still works
  (a server gets `openpadel` beside `kumi` at its next update; Docker images have both). The settings keep their
  `KUMI_` names, and so do the paths, the service, the database and the packages: nothing to change on a server.
  - Members never read a product name: the apps, emails, texts and the public page name the club, or "the app".
  - Staff read the product's name in the staff app, staff emails and the server's commands: "openPadel", or "Kumi"
    where Kumi's hosted service runs the club (`KUMI_HOSTED=1`, docs/settings.md). There the members' profile, the foot
    of the public page and the staff app's Settings say "Runs on Kumi", linking to kumi.club. A club running openPadel
    itself shows neither; its public page no longer ends with "Run on Kumi, free and open-source club software".
  - Something done by the club's own rules rather than by a person (a level set at setup, say) is shown with the
    club's name, where members read it.
- An assistant's list of what it can do is made from one read of the person's roles instead of one per action, so
  every assistant call answers sooner (about 15 ms instead of 180 for an owner).

### Fixed
- Found on a real phone (run 8), on what this release adds:
  - A Playtomic level from the club's own file starts less sure below 50% reliability, as one seen in the app does: a
    40% level was taken as surely as a 70% one.
  - A level brought from another app has its own place on the staff Levels page, "Levels brought from other apps", not
    under "Asked for a review", and the player's page no longer says they asked for a review while it waits.
  - A player with no level yet reads "Give Ann a starting level of 4.80" and "Leave Ann without a level for now", not
    "from no level yet to 4.80"; a level set after a session says "gave you a level of 2.75". In Spanish, rated games are
    "partidos puntuables" throughout.
  - An import with nobody new says "Nobody new to add", not "Add 0 people as members".
  - "Runs on Kumi" is a link of its own size: 24 px, 44 on a touch screen.
  - Staff downloads (reports, coaches' earnings, receipts, the desk) and the calendar feed are named for the club
    ("kestrel-padel-receipts-...csv"), like the members' data download, not "kumi-...".
- **Members read "Kumi" in the browser (found on a real phone).** Both apps' tabs were titled "Kumi" whatever the
  club, even on a club running openPadel itself, and a member's data download was `kumi-data-<date>.json`. The tab, its
  history and the share sheet now name the club (the staff app's, "<club> Staff", as its installed name is), and the
  download is named for the club too (`kestrel-padel-data-<date>.json`). Its `format` stays `kumi-export-1`.
- **An assistant reached what its person was given after they connected it (in 0.1.0 to 0.3.1).** Connected as a
  member, it went on with a staff role given later (or a removal undone, the server's `owner add`, a role the club made
  widened), without their allowing it again or giving the second step the role needs. Now each connection keeps what
  its person held when they allowed it, and whether they gave a second step. When they hold more, or the club now asks
  a second step they didn't give, it works as a member's (its reads and changes, and the permission check behind
  them) until they connect it again, and they hear it once, in their inbox. Holding less is checked as always, and an
  owner giving themselves another role reaches nothing new, so their connection carries on.
  - Connections made before this update take what their person holds at their first use after it, and count no
    second step: where the club asks one (owners and managers, to start), they work as a member's until connected
    again.
- **A connection held to a member's reach still used some staff powers on the person's own things.** Choosing a
  refund other than the rule when cancelling a booking or a weekly court, taking a founding place given up, naming
  anyone on someone's court, a coach's full refund on their lesson and the like read the person's roles directly.
  Every such check now goes through one place that counts the member role alone for a held-back connection, and a
  test walks the whole catalogue: a staff member held back gets exactly a member's answer to every action.
- **Shortened contacts no longer catch other numbers.** A bare run of digits ("invoice 123456789", "order #100200300",
  "member number 12345678901") is left alone; a phone is one written with a + or in groups (415-5550142, 07700 900123,
  020 7946 0958), or a US or Canadian number right after a word that says it's one ("call 4155550142"). Text with no
  @ and few digits is passed over at once, which halves what shortening costs on the biggest staff reads.
- **Through an assistant, an email could be confirmed as someone's (in 0.1.0 to 0.3.1).** Importing a members'
  list said who of it was already here, and adding someone with a taken email said so: each a yes or no on a guess.
  The import is now done in the app (or `openpadel import members` on the server), and a taken email or phone gets a
  plain refusal there. Shortened contacts now also catch "415-5550142", "07700 900123", "020 7946 0958" and
  "josé@example.test" inside text, and never touch a field that holds an id (an alert's long event id still works).
- **The command line said "already done" after a change made since, elsewhere.** Asked again, it now asks the club
  whether anything its earlier change made has been changed since, by anyone (in the app, another command, someone
  else): then it's a new change, previewed and made. A `--key` is kept for its day however many other previews come
  after. A confirm the club refuses, or no longer offers, forgets its preview, as a conflict does. It signs in only at
  the club's own host or its staff app beside it (not a neighbour under co.uk, com.es or kumi.club).
- **Device sign-in codes:** an IPv6 /64 counts as one network (5 codes waiting at most), no code waiting is ever
  pushed out to make room, and when the codes are near full a network holding none can still start one, so the
  club's own staff are refused only after thousands of networks are in use at once.
- **The result of someone else's change could be read again by its run id (in 0.1.0 to 0.3.1).** Run ids are long and
  hard to guess, and the change itself was never made twice; now an earlier result is given only to whoever made it.
- On a phone, a checkbox or choice beside a long label was squeezed narrower than its 24 px (10 of the 46 in the
  staff app's Settings). Each now keeps its size.
- The staff app's courts' day and a person's page say what a promo code took off a booking paid in full, "Paid $48.00
  ($12.00 off with a code)", the way the members' app does, so a $60 court doesn't look $12 short.

### When updating
- The database changes (098 and 099) apply by themselves as the server starts. The update snapshots the database
  first, and `sudo kumi rollback --yes` goes back to 0.3.1 with it. On Docker, `deploy/docker/update.sh v0.4.0`.
- **The command is `openpadel` now.** `kumi` still works, and a server gets `openpadel` beside it at this update. The
  settings keep their `KUMI_` names, and nothing in `/etc/kumi/kumi.env` changes.
- **Assistants and the command line:** where the club asks a second step at sign-in (owners and managers, by default),
  a staff member's connection made before this update works as a member's until they connect it again (Profile,
  Assistants). They're told once. Someone made staff after connecting an assistant as a member, before this update,
  keeps that connection's reach: end it from their page if that isn't wanted.
- **A host running clubs for others** sets `KUMI_HOSTED=1` (kumi-hosted does), so staff read "Kumi" and members see
  "Runs on Kumi". A club running openPadel itself sets nothing.

### Known limits
- No app store apps yet: the members' and staff apps install from the club's own address ([the phone apps](docs/setup/apps.md)).

## 0.3.1 (2026-11-07)

Fixes for 0.3.0. A split court's organiser is no longer charged what a promo code took off another player's share;
clubs on Stripe Connect no longer keep each other's card payments; a Playtomic recurring booking or league match over
a Kumi event is now a clash the staff hear about; a card payment found after a restore and kept counts in the books;
and a big club reads and writes faster as it grows. Every club should update, first those on Stripe Connect or
running beside Playtomic.

### Changed
- A card payment found after a restore that the staff keep as paid elsewhere now counts in the books the way they
  say, so Kumi's revenue matches the payment provider's. Reports, "Paid with nothing here", offers two ways to keep
  it, and the preview says plainly which was chosen:
  - "Count it as income": it's added to the books as other income on the day it was paid. Reports shows it on a
    line of its own, "Card payments recorded after a restore", and the Reports download has a column for it.
  - "It's already in the books": when it was put right with a payment Kumi records (the court booked again at the
    desk and paid there, say), nothing is added, so the same money doesn't count twice.

  Counted as income, it counts once, even kept twice at the same moment. A refund of it at the provider takes its
  part back out once the refund has gone through, each refund once, on the refund's own day: one made in the
  provider's dashboard later is found too, because Kumi asks the provider about kept payments now and then (a few
  at a time, each at most every 6 hours, for a year after it was paid). A refund still on its way takes nothing out
  until it goes through, and one that fails never does. If Kumi later records a payment for it (a charge of its own
  made again), it comes out of other income on the day it was paid. A kept payment that's disputed at the provider
  is told to the owner and managers once, on Today, to answer in the provider's dashboard. One paid in another
  currency than the club's stays out of the books, and the preview says so. "Refund it" asks only for what's left
  of a payment a refund was already seen for, and says so; with nothing left, it's refused. After a restore it's
  like any other card payment: a copy from before it was kept has it to decide again, with nothing counted by
  itself.
- Every spreadsheet download names its columns in English, whatever the reader's language, so the same file reads
  the same in a spreadsheet or an accounting tool from anyone on staff. The coach earnings download followed the
  reader (and its kinds and statuses: "lesson", "session", "scheduled", "cancelled" now); the club receipts download
  has "what (en)" and "what (es)" always in that order, where its first was "what" in the reader's own language.
  Amounts and dates keep the club's formats.

### Fixed
- **Playtomic: a player's recurring booking or league match over a Kumi event went unnoticed.** Kumi took any kind of
  Playtomic booking it didn't list as the club's own block, so nobody heard of the clash, and a Kumi event could even
  be put on top of one. Now only the club's own tournaments and open play count as the club's. Every other kind,
  including one Kumi doesn't know yet, is a clash the staff hear about once. One already copied the old way is judged
  again at the next read, and the clash is said then.
  - Bookings further ahead than 30 days are read too: as far as members can book or Kumi has anything on a linked
    court (a year at most), 30 days at a time after each read, each again every 6 hours (`KUMI_MIRROR_FAR_EVERY_HOURS`).
    Pages stay a minute apart, whichever read they're for (`KUMI_MIRROR_PAGE_SECONDS`).
  - A booking's end comes from Playtomic's end time, not from guessing the unit of its length.
  - The Playtomic page, the courts' day and the clash email name each kind of Playtomic booking in the reader's
    language (the email used Playtomic's own English words, in Spanish too).
- A big club was slow in places, and slower every day. Tried with two years of one: 3,000 members, 12 courts, 90,000
  court bookings, 300 programs, 60,000 chat messages. Indexes (database change 097) and reads that use them; nothing
  changes but the speed.
  - Every change that moves money checked that the books balance by reading all of them: 14 ms an entry at 160,000
    entries, inside the change. A member booking a court and paying by card took 265 ms; now 45.
  - A member's booking or sign-up counted their bookings and what they owe by reading every booking (180 ms).
  - The outbox stepped over every event nothing handles to find the next one to send: 55 ms an event, five and a half
    seconds for a run of 100.
  - Reports read the whole of the books, and each day's courts one day at a time: a year took 750 ms, now 150; a
    month 360, now 75. The desk's day read every change the club ever made once gift cards and passes were sold at
    the desk: 700 ms, now 140.
  - The staff's Chats asked about each chat's game one at a time: 260 ms, now 25.
  - After a restore, each card payment the provider listed was looked up through all the club's payments: a week of
    them took 16 s, now under half a second.
- **Under Stripe Connect, a club kept other clubs' card payments as its own (in 0.3.0, under Connect).** One webhook
  endpoint hears every connected account's events, and a paid one with no record here was kept as a payment found
  after a restore: the staff saw the other club's payer's email and what was bought, and an owner or manager could
  refund it, on the other club's account. An event on any account but the club's is now left alone (with direct
  keys, any event that names an account), and found payments are listed, kept and refunded only on the club's own
  account (or one its payments were made on before it moved). As the server starts, any kept from another club's
  account that nobody acted on are removed, and the rest lose the payer's email and description.
- **Entering a draw night's score could rewrite a decided match (in 0.1.0 to 0.3.0; tournament and league matches in
  0.3.0).** "Enter a score" took any game: the front desk, or support access at manager level, could rewrite a
  tournament's decided result (levels replayed, the winner kept), confirm a score a player had entered without the
  match deciding (stuck until reopened), or change a court result the players had confirmed. It's for a draw night's
  games only now. A tournament or league match changes through its own screen (reopening it stays the owner's and
  managers', in the app), and a court's result through the players' answers and the staff's dispute ruling.
- **Support access read chat moderation in Changes (in 0.3.0).** Who reported whose message, and who was stopped
  posting, showed in Changes to someone who can't read chats. Changes now leaves chat changes out for anyone the
  chats are closed to.
- **Typed text saved before 0.3.0 could carry control and invisible characters (in 0.3.0 and before).** Names
  saved before names were made plain, and a gift card's who-for and message (never made plain), could hold a
  terminal's escape sequences or a bidi override, which `kumi restore` printed to the operator's terminal and the
  receipt and its download carried. Gift card words are made plain as they're typed, the restore prints names made
  plain, and as the server starts, names and gift card words saved before are made plain once.
- **A split court's organiser was charged what a promo code took off another player's share (in 0.3.0).** At the
  deadline, Kumi charged the organiser's saved card for what it took to be unpaid, counting the money paid but not
  what a code took off a share, the organiser's own included. Everyone had paid, yet the card was charged the
  discount; a declined card left it owed, with an alert to collect it at the desk. The desk could also record the
  discount as money owed on any court paid after a code. A code's part of the price now counts as paid on every
  path that weighs a booking's payments against its price (one rule for all of them, `promo_off.ts`): the deadline's
  charge, the desk's limit, the screens and an assistant's weekly spend.
- **Credit from a use of a pass bought by card was paid out in cash with no warning (in 0.3.0).** A use that comes
  back as club credit after its pass was refunded is card money, and paying out club credit now warns of it, as it
  does for gift cards bought by card and card payments refunded as credit.
- **The pay-out warning could be spent away (in 0.3.0).** What a member spent of their credit was taken from its
  card money first, so after spending, card money paid out in cash had no warning. Spending is now taken from what
  wasn't card money first: the warning lasts as long as it can.
- **Buying a gift card or a pass again could undo one just paid (in 0.3.0).** Buying again calls off one bought
  before and never paid; it also called off one whose card had gone through but wasn't recorded yet (the app said
  "Paid, thank you: confirming"), so it was refunded, never issued, and left the list. Kumi now asks the payment
  provider first and leaves one that went through or is still being processed: it's recorded, and the card or the
  pass is the member's.
- **Staff could buy a gift card or a pass in a member's name (in 0.3.0).** The owner, a manager or support access
  could, and that also called off the member's own waiting purchase. Only the member (or their own assistant) buys
  one in the app now; the desk sells them as before, paid there.
- **What a restore left for staff left Today after 14 days (in 0.3.0),** handled or not, like every other alert.
  It now stays until someone marks it handled.
- What the browser check of the staff app found on 6 November and left for after 0.3.0:
  - Changes offered Undo on every change, receipts, alerts, deletions and money sent included, and then refused.
    Undo now shows only on a change that can be undone, still in time. A refusal says its reason once ("This
    can't be undone: the refund has gone out.", not "This can't be undone: Can't be undone: ..."), and a change
    that was never an undo no longer says "an undo is final".
  - Reports, "Paid with nothing here": the table has its column names on a wide screen and each date on one line.
  - Reports, "Refunded after the backup, still booked here": each booking opens on the person's page, at that
    booking, where it can be cancelled; each place opens on its program.
  - On a phone, a row of a list (a booking with its refund form, for one) wraps instead of pushing the page
    sideways, as it did in Spanish.
  - On a touch screen, a section that opens and closes is 44 px tall, and every checkbox and choice is the larger
    size, not only those beside their label.

### When updating
- The database changes (095 to 097) apply by themselves as the server starts. 097 adds indexes; on a big club the
  first start takes a little longer while they're built. `kumi update` snapshots the database first, and
  `sudo kumi rollback --yes` goes back to 0.3.0 with it. On Docker, `deploy/docker/update.sh v0.3.1`.
- Nothing to set. Two new settings for clubs beside Playtomic keep their defaults unless changed:
  `KUMI_MIRROR_FAR_EVERY_HOURS` (6) and `KUMI_MIRROR_PAGE_SECONDS` (60), in `docs/settings.md`.
- **Beside Playtomic:** the first reads after the update can tell the staff about clashes that were already there and
  went unnoticed (a player's recurring booking or league match on a court with a Kumi event). Look at each one.

### Known limits
- As in 0.3.0.

## 0.3.0 (2026-11-06)

Tournaments and leagues with draws and fixtures, and Mexicano and King of the Court nights; the same court every
week; chats for the players in a game; club credit, gift cards, passes and promo codes; a club's own currency,
formats, tax-included prices and country, for clubs outside the US; and restores that no longer bring back what was
taken away since the copy, or lose track of card money from after it. Every club should update.

### Added
- **A club's own currency.** Settings has the club's currency (its three-letter code: USD, EUR, GBP, MXN...),
  USD until it's changed. Every amount Kumi shows, reads, sends to Stripe, puts on a receipt, a report, a
  spreadsheet, an email or a notification is in it, written the club's way ("€40.50", "¥1,500"), and an amount staff
  type is read the same way: only with the club's own sign or code ("$40" in a euro club, "12 mil" or "5k" aren't
  read), and an amount is shown with the club's separators whatever the reader's language, so what's shown can be
  typed back. Zero-decimal currencies (yen, won) are whole units; three-decimal ones (the Kuwaiti dinar and a few
  others) and the Icelandic krona and Ugandan shilling (whole units Stripe takes written with two decimals) aren't
  taken yet. Limits sized in dollars (a gift card's largest amount, a pass's price, a kid's monthly limit) are sized
  for the currency. Outside costs (AI, texts, email) are still counted, capped and shown in US dollars, as the
  services bill them, whatever the club's currency. The currency can't change once the
  club has taken a payment, and `kumi doctor` warns when it isn't the Stripe account's own (Stripe would convert
  every payment, for a fee). See the setup guide's "Running Kumi outside the US".
- **A club's own formats.** Settings has the club's locale (en-US until changed: en-GB, es-ES, fr-FR...). Dates,
  times, numbers and amounts are written the club's way (day or month first, "1.200,50" or "1,200.50"), its clock
  runs to 12 or 24 hours, and its week starts on its first day (Sunday in the US, Monday in most of Europe), in the
  Courts week, opening hours and the public page alike. Each member still reads Kumi in their own language: an
  English speaker at a club in Spain sees "Thu, 12 Nov, 17:00". A US club reads as before, except that its weeks now
  start on Sunday, as US calendars do.
- **Prices that include tax.** Settings has "Prices include tax" (off: the US way, tax on top) and the tax's name on
  receipts (Sales tax, VAT, IVA, GST). With it on, a court or lesson priced at €40 costs €40, and its receipt
  shows the total, then "Of which VAT (21%): €6.94". A refund or a promo code takes its share of the tax, as before.
  Each receipt keeps the rate and the way the booking was taxed when it was sold (a later change of the club's rate
  never rewrites it, and a refund's receipt follows the payment's), and a share's receipt states the tax on its own
  amount (a quarter of a €10.00 court at 21% is €0.43). Reports show revenue before tax, with the tax collected under
  them. What's taxed is unchanged: court bookings and lessons; places, memberships, passes and gift cards aren't.
- **A club's country.** Settings has the club's country (US until changed). A phone number typed without a + is read
  in it first: in a Mexican club "55 1234 5678" is Mexico City, never the US number with the same digits (before this
  fix, such a number was read as a US one, so a sign-in code or a yes to texts could reach a stranger in the US). Only
  US and Canadian numbers are texted, so only those are kept on an account (they're confirmed by a texted code);
  someone who gives another country's number is told so plainly and gets the same messages by email. The club's own
  Stripe account (under Connect) is opened in its country, and the country can't change once that account exists. A location's address has its postal code, region and
  country, and a receipt writes the address that way.
- **Mexicano and King of the Court nights**, beside the Americano. A Mexicano pairs each round by the night's
  standings (1st and 4th against 2nd and 3rd, the best four on the top court), with games to 16, 21, 24 or 32
  points, and a round sat out counts half a game's points. King of the Court plays timed rounds (12 minutes to
  start): winners move up a court, losers down, and partners change every round. Staff make each round once the
  last one has its scores ("Make round N"); a late drop makes the round not yet played again.
- **Weekly courts.** The desk books a member the same court, day and time every week (on the Courts page, "Every
  week" once a member is chosen), for up to 26 weeks. Each week is its own booking with its own code, price and
  the club's cancel rules, paid at the desk; the preview names any week left out because something is already
  on, the court is closed or can't be booked (none is moved). Members book their own when the club turns on
  "Members book the same court every week in the app" (Settings; off by default, at most 12 weeks unless the club
  says otherwise): the first week is paid by card now, which saves the card, each later week is booked once it's
  inside the member's booking window and goes on that card at the club's "pay my part" deadline. A week someone
  else has by then is left out, the member hears, and nothing is charged for it; a declined week is owed at the
  desk and the others stay. My places and the staff's page of the member show each weekly court and its weeks,
  with "Cancel this and the rest" (each week under its own rules; staff can choose what comes back). A member's
  AI assistant sees each week as a booking and can end their weekly court as they can; a weekly court the desk
  ends is told to the member once, not once a week. Read-only, nothing new is booked, and the weeks still to come wait.
  - **A week is never charged twice**, even when a restored copy (or a second server after a move) books it again
    under a new booking: its charge is keyed on the week, which exists from the day the weekly court is made.
  - **A member's AI assistant counts the whole weekly court against its weekly limit** (every week still to be
    charged, as a shared court counts in full), not just the first week. The first week's pay step says the later
    weeks go on the same card, how many, and what they come to.
  - A declined week shows as owed at the desk, not paid. While it's owed, the weeks already booked are owed at
    the desk too at their deadlines (the declined card isn't tried again; the member is told once), and the next
    weeks wait. Each week counts toward the club's limit on upcoming bookings, counting only bookings not begun
    (the week being played makes room for the next). A week owed or at the limit waits and is tried again each run;
    it's left out only once its pay deadline has passed, and the member hears once a run, with every week left out
    and why. A first week never paid (not in time, lost while its card went through, or cancelled before paying)
    ends it. A court archived later leaves its weeks out instead of stopping the job, and weekly courts that keep
    failing are said once to the owner and managers, and once when they work again.
  - Turning weekly (or court) bookings off pauses members' weekly courts instead of ending them: nothing is booked
    while it's off, booked weeks stay, each member is told once, and once more when it's back on (weeks that passed
    meanwhile aren't booked). The settings preview says how many it pauses.
  - Only a week still to be booked blocks deleting its member's account, so a member can end their weekly court
    and delete their account while the club is read-only; ending one gives an assistant's weekly allowance back at
    once. After a restore, a week charged and then refunded before the copy was taken is recorded as given back
    and owed at the desk, not paid. A charge Kumi looks for again is found past the member's newest 100 payments
    (Stripe's search).
  - **Stop every member's weekly court at once** (Settings, next to the weekly setting; owners and managers): no more
    weeks and the booked ones stay, or the booked weeks from today go too, with what comes back by each week's rule,
    everything they paid, or nothing. Previewed like every change; weekly courts the desk made stay; each member
    hears once, however many weekly courts they had.
- **Chats in games.** The players in a game message each other in the app: each court booking with named players
  (an open match is one) and each program date (a clinic, a social night) has a chat for the people in it, and its
  coach. Plain text up to 1,000 characters, links as links; a message changes for 5 minutes after it's posted and
  is taken back any time ("message removed"). Someone who leaves a game reads what was said up to the moment they
  left, without posting; someone the organiser or the staff took off reads nothing. Only people who held a place
  read a date's chat: never a waitlist, and someone who left a course reads only the dates that had begun before
  they left. A place saved for someone isn't theirs in the chat until they take it. A program date's chat names only
  those who've written in it (the roster stays the club's); a court booking's names its players, as the booking
  does. There are no messages between members outside a game they share, and no list of members.
- **Safety first.** Juniors don't see chats in this version, and the app says why (a parent in the same game reads it
  as themselves). A member reports a message, and front desk and up hear once; the staff read every chat under
  Chats, hide a message ("hidden by the club") and stop someone posting for 1 to 90 days, each in Changes. Support
  access never sees chats, and no assistant posts, reports or hides (a member's assistant reads their chats). At most
  20 posts in 10 minutes, even sent at once. Read-only, moved or closing: chats are read, not added to. A reported
  message keeps its words for the staff until they've hidden it or shown it again, even if its author takes it back,
  and can't be changed meanwhile (the words are in the author's own Download data then, marked as kept for a
  report); the staff hear about reports once an hour per chat at most. Reasons typed in a report or a stop aren't
  kept in the change log, nor with a preview nobody confirmed or a report that was refused. Text loses control and
  invisible formatting characters (a bidi override can't turn "gnp.exe" into "exe.png"), characters that draw
  nothing (Hangul fillers, the blank Braille cell) and marks stacked past three on a letter; emoji joiners,
  Persian's non-joiner and flags keep what they need. A name or a message with nothing to see is refused, at
  sign-up, on the profile, when staff add or import people, for a junior and in a chat; a blank name already stored
  shows as "A player". A booking moved earlier ends its chat at its new time.
- A new chat message reaches the players' phones as a notification, at most once in 5 minutes per chat, never at
  night and never for a chat they muted; never by email or text. The nav's Chats shows what's unread. A push copy
  keeps none of the message's words: they're read as it's sent, so a message taken back, hidden, deleted or written by
  an account since deleted sends nothing, and no player's Download data holds another's words.
- Posting closes two days after the game; reading goes on until the chat goes, 90 days after its game, with
  everything in it, and nothing makes it again. A member's own messages are in their Download data,
  and deleting their account takes their words. "Players can message in their games" (Settings, The club) turns
  chats off; it starts on.
- **Tournaments and leagues with draws and fixtures.** Members enter with a friend as their partner (both need a
  place; the partner accepts in the app), or staff pair two people. A tournament is groups of 3 or 4 then a
  knockout of each group's top two, or a straight knockout with byes to the top seeds; a league is a round robin,
  once or twice. Matches are one set to 6, a pro set to 9, or best of three with a match tiebreak. Kumi suggests
  courts and times on the program's own dates and courts (never two matches on a court, never a pair twice at
  once), staff move any match, and players can ask for a move. Scores come from staff (they count at once) or from
  the players with the usual 48-hour confirmation; walkovers and withdrawals are recorded, and the winners move on
  by themselves. Group and league tables (2 points a win, 1 a loss played), each member's next matches on their
  Tournaments page, the tables and results on the public page, and a read tool for members' assistants.
  Fixed before release, from its review: a disputed semi-final could reopen while the final already had a score
  waiting, and confirming that score then broke the final and stopped the job that counts scores (a result now
  stands once the next match, through any byes, has a score or a result, and the job carries on past any score it
  can't count). The public page showed every player's name, juniors included: it now shows "Pair 1", "Pair 2"
  unless the club turns on "Show players' names on the public page" for that program, and never names a junior;
  in members' tables a junior is named only to their partner and their family. Also: a pair that withdraws
  mid-group can't take a knockout place; a group winner meets its runner-up again only in the final; no court
  is booked for a match against a bye; results stay on the public page until the competition is finished; a
  Mexicano re-pair keeps the round's scored games; the lowest in the standings sit out, not the leader; King of
  the Court never keeps a partner; a match tiebreak counts as one game; staff corrections are checked against
  the match format; the other pair sees that a move was asked, not its words.
  Fixed before release, from its second review: a junior was still named in full to their opponents in match
  messages and emails, score previews, result messages and the opponents' level history; every one of them now
  names a junior only to the junior, their partner and their family ("Junior player" to anyone else). A wrong
  result often couldn't be put right by anyone (a staff typo counted at once, a loss confirmed by mistake once
  the winners had entered the final's score): staff can now "Take a result back" on any match, which undoes its
  score and everything it led to, shows all of it in the preview, works levels out again and tells the players
  once; and a score staff enter can be disputed by the players for 24 hours, like any other, unless staff mark
  it final. Also: players are told how a dispute in a tournament or league was resolved (and to enter the score
  again when it's set aside); a drawn tournament or league takes no more sign-ups, and its public page says so;
  invitations still open at the draw are closed and both players told; suggested times place the knockout after
  a walkover given before any times; a group with fewer than two pairs left sends only the pair still in (the
  other place is a bye); times confirmed after a pair withdrew skip its walkover and tell nobody they play it; a
  Mexicano or King of the Court re-pair confirmed after another court was scored is refused (preview again), and
  nobody can be in two games of a round; King of the Court seeded again keeps nobody with last round's partner.
- **Club credit.** A member's balance at the club, kept in the books as what the club owes them. It comes from a
  refund staff give back as club credit (a new choice when cancelling a booking, "Everything they paid, as club
  credit"), from a program's "credit inside the window" rule, or from money paid from credit coming back. Members
  never choose credit over their card. Before a card form opens, the pay sheet offers "Use my $X of club credit"
  (on to start): all of a court or a place from credit, or part of a program place with the card paying the rest.
  Anything paid from credit goes back to credit when it's refunded. Credit never runs out and can't be bought
  outright. The owner or a manager pays credit out at the desk (Person page), never more than is held, and it shows
  on the desk's day as money handed back. A member's profile shows their credit; Reports shows the credit members
  hold; their data download has it, with what came and went; and an account can't be deleted while it holds credit
  (the club pays it out first). Two checkouts at once can't spend the same credit. Read-only spends no credit and
  still pays it out; a club that has moved to another server pays nothing out (the new server does). Not for
  assistants: spending credit and paying it out are app-only, and never support access. Only the member spends their
  own credit, and nobody else is told what they hold. A junior's refund given as credit goes to the parent who looks
  after them (the family card's saver), since a junior can't spend credit. A place paid in part only from credit is
  reminded and let go like an unpaid one, its credit back; credit never shows on the desk's day as money taken
  there; and a booking paid from credit, made shorter or moved, says the money goes back to club credit. The pay-out
  preview says how much of a member's credit came from gift cards, and warns when any were bought by card (paying
  those out in cash can be a way to cash out a stolen card).
- **Gift cards**, when the club turns them on (Settings, with the smallest and largest amount: $10 to $500 to start).
  A member buys one in the app by card, for themselves to give (with who it's for and a message), or the desk sells
  one for a member (cash, the card reader or another way, on the desk's day). They never expire, carry no fees and
  aren't taxed when sold; until one is used it's money the club owes (in the books apart from revenue, and on
  Reports with each card). The code is in the buyer's app under Gift cards, with a page to print: never in an email
  or a message, sealed in the database with the club's key, found by a fingerprint under that key, and never kept
  in the change log or with a preview. Redeeming a code (in the app, for yourself only: never through an assistant
  or support access) puts its value into the redeemer's club credit, once, even if two people try at once; wrong
  codes are limited to 10 an hour, counted against the person redeeming, one at a time; someone trying for another
  person is refused before anything is looked up, and the refusal is logged (without the code). A buyer can always
  delete their account: the preview says to save the code of any card nobody has redeemed, which stays usable
  (who it was for and the message go with the account); Download data lists the cards (never the codes). A refund
  given as credit for a junior's payment goes to whoever paid it (the parent whose card or app paid). After an
  import, cards can be redeemed at once (their fingerprints are made under this server's key straight away). A manager or the owner voids a card nobody has used, and the buyer gets the money
  back the way they paid; staff can remind the buyer it's waiting. Members' assistants see their cards, never the
  codes. Check your state's rules on gift cards (expiry, fees, cash back for small balances, unclaimed property)
  with a lawyer: Kumi's cards never expire, and the owner or a manager can pay credit out at the desk.

- **Passes**: products the club makes in Settings ("Passes the club sells"), for example 10 clinic places, 5 courts
  up to an hour, or a single drop-in. Each covers program places (some kinds of program, or any) or court bookings
  (up to a length the club sets), with a number of uses and a price, and no date to use it by unless the club sets
  one of at least 365 days. A member buys one in the app by card (Profile, Passes), or the desk sells one from a
  member's page for its price. In the pay sheet, before any card, a pass that covers the payment is offered ("Pay
  with ... (3 left)"): one use pays it, as a card would, and the place or court is theirs. Cancelled in time for a
  full refund, the use comes back; cancelled when the club's rules give part or nothing back, it's spent. Until a
  use is taken the money is what the club owes (in the books apart from revenue); each use moves its share of the
  price to revenue, the last use whatever is left. Two checkouts at once can't take a pass's last use twice. The
  owner or a manager refunds a pass's unused uses, pro rata, the way it was paid for; a pass is never through an
  assistant (it reads them, and buying one counts on its weekly limit) or through support access. Read-only sells
  and takes no pass, and still refunds one. After the review, before any club used them:
  - **A program's "club credit inside the window" rule paid out a pass use, or a place a code made free, as club
    credit at the full place price** (a $10 use on a $200 tournament became $200 of credit, which could be paid out
    in cash). That rule now goes payment by payment like every refund: a pass's use goes back to the pass (or is
    spent), a free place gives nothing, and never more than was paid.
  - A courts pass covers court bookings only. Coach lessons have a pass of their own ("Coach lessons", made only
    if the club wants one) and an area of their own for promo codes.
  - A place paid with a pass and passed to a sub who pays: the use comes back once the sub has paid, never before.
  - A pass with uses left stops the account being deleted (the club refunds the unused uses first), and the data
    download has a person's passes, each use, and the codes they used.
  - Cancelling or shortening something paid with a pass, or made free by a code, says so ("the use goes back to the
    pass", "the use is spent", "nothing to give back: it was free") instead of quoting money for the desk.
- **Promo codes** (Settings, "Promo codes"): a percentage or an amount off court bookings, program places or a
  membership's first payment, with uses in all (optional), uses per person (one to start), a smallest spend and a
  last day. Never on a gift card or a pass, never on a renewal, one code per payment. A member types it in the pay
  sheet before any card: the payment is asked again for what's left (the card is never asked for the old amount),
  or, all of it off, it goes through with nothing to pay. The receipt names the discount; a refund is never more
  than was paid. Two checkouts at once can't take a code's last use twice, and a use whose payment is never paid
  doesn't count. Making codes is the owner's and managers', in the app (never support access or an assistant).
  After the review, before any club used them:
  - **A code used before paying part from club credit (or at the desk) dropped off the payment**, so it stopped
    counting and could be used again on the rest. The code now stays with the payment it was applied to, and
    there's one code per place or court player, whichever payment it's on.
  - **A membership's first payment with a code set the price it renewed at.** The code is for the first payment
    only; it renews at the plan's price, and the receipt says "off the first payment".
  - A code's percentage and smallest spend are worked out on the whole price, even after part was paid another way,
    and the discount counts as paid: the desk can't take it again.
  - A code can't make a payment that saves a card free (a membership's first, a split court's organiser), since the
    card is needed for what comes later.
  - Wrong codes count per person, ten an hour, and a code that isn't for this (or that you've used up) gets the same
    answer as one that doesn't exist, so a private code can't be found by guessing. Support access never applies a
    code or spends a member's pass.

### Changed
- **Install the app.** The members' profile has "Install the app" when Chrome offers it, and on an iPhone it says
  where Add to Home Screen is (Share). Neither shows once the app runs from the home screen.
- **The phone's back button closes what's open** (a preview to confirm, the card form, a booking picked on the
  Courts page, the Changes sheet) instead of leaving the page under it.
- **Buttons say what they do.** Every preview's "don't" button is now Back, so it's never a second "Cancel" next to
  a cancellation. On the Courts page a paid booking's button is "Cancel booking…" (the choice of what goes back
  follows), and the form's own button is "Cancel booking". Cancelling a program's date has Back too.
- **Pushes that matter now arrive now.** A place offered from the waitlist, a court booked for you or lost, a match
  about to start or changed, and money that needs you go at high urgency, so a phone asleep shows them at once;
  each is kept for a phone that's off only until it's no longer worth getting (an offer until it expires).
- On a phone, the Reports tables (occupancy and revenue, coaches' earnings, receipts) stack like the desk's day,
  and the profile's "Your receipts" link is as easy to tap as a button.

### Fixed
Those marked "in 0.2.1" are in the release a club runs now; the rest were found in this release's own new parts
before it went out.
- What a browser check of the staff app showed on 6 November:
  - Cancelling a court with nothing back said "it's less than 24 hours before" when that wasn't why: when the staff
    chose nothing, or when everything paid on it had gone back already. It now says which.
  - What a restore leaves for the staff to look at read as a failure ("... failed. Run kumi doctor"), pointed at
    Payments instead of Reports, counted "2 card payment(s)", and could stop in the middle of a word. It now reads
    "After a restore: ...", says what to do and where, opens on Reports, and keeps to whole sentences. When nothing is
    left it just closes. Courts and places freed by deleting an account again are named by their code (never the
    deleted person's name), so they can be found at the payment provider.
- After a restore, when the payment provider's list was cut short (more than 20,000 card payments since the backup),
  the alert saying older ones weren't checked closed by itself within a minute. It's now an alert of its own that
  stays on Today until someone marks it handled, and says where to look for them.
- The Reports download has a "tax collected" column, matching the tax line on the page.
- Importing a club's export (`kumi restore <export>`) wrote what it deleted again for the staff in US dollars,
  whatever the club's currency. It reads the club's currency and formats first, as `kumi restore` does.
- What a second look on the phone showed on 6 November:
  - **A gift card whose card was declined can be paid or removed.** It stayed "Waiting for payment" on the buyer's
    list with nothing to tap until they bought another. It now has Pay (the card form again) and Remove, which calls
    its payment off so it can't be paid after (a card that went through anyway at that moment is given back in
    full). Only the buyer can remove it.
  - The gift card sheet reads "Pay $50.00 for a gift card for Maya", not "Pay $50.00 for Gift cards".
  - The card form starts on the club's country (Settings) instead of Stripe's guess, so a member in a club in Spain
    isn't asked for a US postal code. The same for saving a card.
  - A profile preview with nothing changed says "Nothing would change." instead of "Change  on your profile."
- What a real phone showed on 6 November:
  - **Buying a gift card or a pass by card works again.** Since the sheet stopped offering credit and promo codes for
    them, it opened as a "save a card" sheet: without the page check, and the server refused it ("We couldn't check
    this page"). It's a payment again, checked and confirmed as one. A try that wasn't paid (the form closed, a card
    declined) no longer leaves a card "Waiting for payment" on the list: buying again calls the earlier one off, and
    if its card went through after all, that money goes back in full. Paid with a card that needs the bank's own
    page, the member comes back to the gift cards or passes page, not My places.
  - After paying, nothing offers Pay again while the payment is being confirmed: a court, a place, a match share, a
    junior's payment, a renewal and a gift card read "Paid, thank you: confirming" until it's recorded, even after
    leaving the page, and the page asks again every few seconds. A Pay tapped again for a payment that has gone
    through records it instead of opening a second card form, so it can't be paid twice.
  - **Signing out stops that device's notifications (in 0.2.1).** A result reached a shared phone six minutes after its owner
    signed out. Signing out of either app now turns off notifications on that device, for the server and the
    browser, so the next person to sign in there turns them on for themselves.
  - A match's score preview ends in a sentence of its own ("It counts for levels."), and in Spanish says who won
    ("ustedes ganaron 6-2"). The dispute message says what was disputed: "the score entered for your match: Ann
    and Ben 6-2 against Cal and Dee".
  - Staff entering a match's score can tick "Final": the players can't dispute it, so after a dispute they don't get
    another 24 hours.
  - A match played and still waiting for its score is listed under "Played, score to come", not under "Next matches".
  - /tournaments and /leagues open Competitions, and an address the members' app doesn't have opens the home page
    instead of a blank one.
  - Spanish says cancha, lugar and correo everywhere (it mixed in pista, plaza and email).
  - Changing your language says what it changes: everything Kumi says to you, from then on.
  - The pay-out and desk sale choices of how money moves are read out as that, not as "Refund".
  - A gift card sold at the desk for someone says who in its preview.
  - The desk lists booking lengths shortest first (it read 60, 90, 120, 30...); 90 minutes is still the one chosen.
  - With prices that include tax, the pay sheet says how much of it is tax ("Of which VAT (21%): €4.17"), as the
    booking and the receipt do.
  - The staff Settings page no longer shows a file path from the code where it says how to set up answers.
- **Paying out credit that came from a card refund is warned of too.** Paying a member's club credit out in cash or
  another way already warned when the credit came from gift cards bought by card. It now also warns when the credit
  is a card payment the club gave back as credit ("$40.00 of their credit came from card payments the club refunded
  as credit"): either way, card money leaves as cash. Credit from cash at the desk is not warned of.
- What a real phone showed on 5 November:
  - A court paid after a promo code read "Paid $30.00 of $40.00". What the code took off now counts as paid on court
    bookings, for the member ("Paid $30.00 ($10.00 off with a code)") and on the desk's grid, which no longer offers
    to take the discount as money. Just after paying, the booking shows "Paid, thank you: confirming" instead of
    "Being paid for" and a Pay button again.
  - Buying a gift card or a pass no longer offers club credit or a promo code, which can't pay for them.
  - The gift cards page lists the cards you bought apart from the cards you redeemed.
  - The profile says club credit comes from gift cards you redeem and refunds the club gives as credit.
  - Receipt lines are written when the receipt is read, in the reader's language and the club's formats as they
    are then (a line issued before keeps its text). Gift card and pass receipts say what they were for ("Gift card
    for Sam", "Pass: 5 clinic places") instead of "Payment".
  - The move request's Send button on a tournament says what it sends, and a test now refuses any button with no
    words or label in either app.
- **A form's refused details are said in plain words (in 0.2.1).** Staff saw the checker's own text when something was missing
  (a program's "Add a date" without a court said "✖ Too small: expected array to have >=1 items → at court_ids").
  Every form now says what to do, in English and Spanish ("Pick at least one court.", "Choose a date and time.",
  "Enter an amount.", "Fill in the name."), and "Add a date" asks for a court before its preview.
- **A weekly court's card form says what the card is for.** Paying the first week from the Book page said only
  "Pay $60.00 for Court booking"; it now says, as My places does, how many later weeks go on the same card, what
  they come to, and when each is charged.
- **One job that fails no longer stops the others (in 0.2.1).** The server's regular jobs (reminders, charges at their
  deadlines, renewals, reconciliation with the card provider, receipts and the rest) ran one after another inside
  one guard, so one that kept throwing stopped every job after it, every 30 seconds (a weekly court on an archived
  court did, until that was fixed too). Each runs on its own now; one failing three runs in a row tells the owner
  and managers once (as a failing backup does, and `kumi doctor` shows it), and once more when every job works again.
- **Times staff type are the club's (in 0.2.1).** A date and time typed in the staff app (a program's date, moving one date,
  a tournament or league match, a club news email sent later) was read on the device's clock, so a staff phone set
  to another zone put a 5 PM class at the wrong hour. They're read on the club's clock now, whatever the device says,
  as the times the apps show already were.
- **A restore no longer brings back what was taken away on request (in 0.2.1 and before).** Going back to a minute, restoring a backup, an
  update's snapshot going back, or an export put back on the same server used to bring back an account deleted since,
  words taken back in a chat, a sign-in or assistant ended, and a no to club news. Now each is done again: the account
  is deleted again (at once, or as the server starts), and the rest stays as the club's database had it.
- **A restore no longer took away every staff authenticator.** The first version of the above compared each staff
  member's authenticator by a time read without its microseconds, so every restore removed every one, and an
  owner or manager without a passkey was asked to set up two-step again by email. Now the authenticator as it was
  last changed comes through whole: one set up again since is the new one (the old secret no longer works), one
  removed stays removed, and one nobody touched stays as it was. The same in an update's snapshot going back.
- **Deleting an account again after a restore no longer refunds anyone a second time.** It used to cancel the
  person's bookings, places and weekly court in the copy and refund them by the club's rule, although they had been
  refunded when the person ended them, before the restore; the payment provider paid the second refund. Now they're
  freed with no money moving, and the owner and managers get one list of what was paid on each, to check against
  the payment provider.
- **An email address taken off an account no longer signs anyone in after a restore (in 0.2.1 and before).** An attacker's address that
  the member undid came back in the copy and signed in as the member. Now an emailed code signs in only through one
  of the account's own sign-in addresses, the account's email, phone and own login come through as the database
  before it had them, and a kid's login removed by a parent stays removed.
- **Card money the payment provider has from after a backup is found (in 0.2.1 and before).** As the server next starts after any restore,
  it asks the provider for payments and refunds made since the copy's newest payment: a refund is recorded against its
  payment (so it can't be paid again), and a payment nothing here records is listed for the owner and managers under
  Reports, "Paid with nothing here", to refund in full or record as paid elsewhere (never refunded by itself; they hear
  once). Stripe's message for such a payment is noticed too, not answered silently. And before any job can let a
  payment go, every pending one is asked about, whatever its age, so a court paid after the copy is confirmed, not
  released and refunded. A charge Kumi made by itself after the backup (a renewal, a weekly court week, an unpaid
  share, a family card charge) isn't listed as unknown: Kumi makes it again by its own key and records it, so it waits
  for the jobs and closes as recorded, and is listed only if no record of it ever appears ("a charge Kumi made that
  this copy doesn't know"). Nothing Kumi records by then can be refunded from the list: "Refund it" is refused, and a
  refund already asked for is checked again before it goes. The staff hear once while anything is left (later ones
  join the same list), and the provider is read back to the copy's time, or the alert says it was cut short.
- **A refund made after a backup could be added to by the club's rule (in 0.2.1 and before).** A refund the provider made after the backup
  now counts against the place as well as the payment, and a booking or place it went with that's still booked here
  is listed under Reports ("Refunded after the backup, still booked here") for the staff to cancel without a refund or
  keep. Cancelling such a booking by the club's rule gives nothing more back for it (a $60 court under a 50% late rule,
  $30 already refunded: no $15 more); the staff can still choose a refund.
- After a restore, who asked for each deletion is kept with the account (the person, their family, or the club), and
  only the club's can be kept back (`--keep`, `--keep-staff-deleted`). An export newer than the server's database (the
  club come back) carries nothing back into it. Credit is no longer cut to what it was before: pay-outs since are
  repeated (never twice), and any member whose credit differs is listed for the staff, with gift cards voided or
  redeemed since, passes refunded or used since (no use comes back) and promo code uses since (still counted). `sudo
  kumi owner add <email>` gives the owner role when no owner can sign in. Backups' lists of deleted accounts include
  those still waiting to be deleted again.
- A restore now also repeats: a deletion still waiting on the database it replaces, a sign-in address or phone
  number taken away (an attacker's phone undone, a kid's own login removed), a family card removed, and a phone's
  notifications moved to someone else. A yes to texts or email comes through only for the number or address it was
  given for, never for an old one the copy still has. Club credit paid out at the desk or spent since stays gone
  (nobody's credit in the copy is more than was really left, so cash handed over can't be paid out twice), and a gift
  card redeemed or voided since stays so, its value in the redeemer's credit; wrong-code tries start again. An account deleted again is signed out at once, and its
  bookings, places and weekly court are cancelled by the club's rules (cards are refunded; money paid at the desk
  waits there, and the owner and managers hear once); the club's last owner keeps the owner role, and the restore
  says so. `kumi restore` lists each account it deletes again and who had deleted it; one the club had deleted can be
  kept with `--keep=<id>` (or `--keep-staff-deleted`); one its owner deleted is always deleted again. When the
  database it replaces can't be read, the restore says so plainly and uses the list of deleted accounts in the newest
  backup on the server (each backup now keeps one). A snapshot from before 0.3.0 going back lists who came back, by name and
  id, in a file in the backups folder, to be deleted again by hand.
- **A chat push before a restore could stop a new message's push after it.** Chat pushes keep no words, so they all
  looked alike to the check that stops a message going twice after a restore; it now tells them apart by message.
- An update said "the point-in-time archive isn't ready" when Postgres happened to be sending a piece of its log at
  that moment (in 0.2.0 and 0.2.1). Making the archive now waits that out and tries again, and only says so if it really isn't ready
  (one-server installs, `server-setup.sh` and the Docker `pitr` service alike).

### When updating
- The database changes (077 to 094) apply by themselves as the server starts, in one go; `kumi update` snapshots
  the database first, and `sudo kumi rollback --yes` goes back to 0.2.1 with it. A rollback to a release from before
  0.3.0 can't queue accounts deleted since the copy: it lists them in the backups folder to delete again by hand.
- Nothing else to do on a one-server install: Caddy's paths are the same as 0.2.1's. On Docker,
  `deploy/docker/update.sh v0.3.0`.
- A US club reads as before (US dollars, US formats, tax on top), except that its weeks start on Sunday.
- **What starts on, and what starts off.** Chats in games start on ("Players can message in their games", Settings,
  The club); juniors don't see them. Gift cards, passes, promo codes and members' weekly courts start off: nothing
  changes for members until the club turns each on or makes one. Public tournament pages show "Pair 1", "Pair 2"
  until the club shows names for that program, and never name a junior.
- **A club outside the US** sets its currency, formats, country and "Prices include tax" in Settings before its first
  payment (the currency can't change after one, nor the country once the club's own Stripe account exists). See the
  setup guide's "Running Kumi outside the US".
- **Before turning gift cards on**, check your state's rules on gift cards (expiry, fees, cash back for small
  balances, unclaimed property) with a lawyer. Kumi's never expire and carry no fees.

### Known limits
- Self-hosted only; a hosted service is planned.
- English and US Spanish. Outside the US, a club's currency, formats, tax-included prices, country and phone numbers
  are its own, but only courts and lessons are taxed, texts reach US and Canadian numbers only, and texting
  registration is for a US or Canadian number. Which countries first, more languages, data protection (GDPR in the
  EU and UK), VAT registration and invoice rules (a club's tax ID on receipts), texting elsewhere, ways to pay other
  than cards and local holidays are still to decide (the setup guide lists them).
- Cards (Apple Pay and Google Pay included), what the desk takes (cash, the club's own card reader, another way),
  club credit, gift cards, passes and promo codes. No bank debits or local ways to pay.
- Club credit can't pay for a membership yet (it renews from a card), nor a payment that saves a card for a later
  charge (a court's "pay my part", a weekly court's first week), courts paid together, or a junior's (the family
  card pays those); a court is paid from credit only when the credit covers all of it. Automatic charges (renewals,
  deadline charges) don't use credit. Gift cards are bought only by a signed-in member (not yet from the public
  page), and their code goes to the buyer, who gives it on (Kumi doesn't email the person it's for).
- A pass is one person's (not shared with family, not for a junior's place). A court pass covers a court paid whole
  by the one who booked it, not a share; a pass covers the price, so a booking shortened later gives nothing back,
  and a use the club's rules refund only in part is spent. A pass past its date keeps its unused value in the books
  until a manager refunds it.
- A program place partly paid at the desk is kept, never let go for being unpaid, and the rest of it is never
  reminded: it shows as owed on the roster and in the member's app.
- A card that goes through after its payment was called off always goes back in full, even when the place it
  was for stays booked at a new price (a date cancelled from a course): the member then pays the new price.
- The desk's day counts the whole club, not each location's drawer.
- A weekly court is weekly only (no every other week or several days a week); changing its court or time for all
  the weeks after one is done by ending it from that week and booking a new one (one week alone moves like any
  booking); a series the desk makes is paid at the desk week by week (the saved-card way is for one a member makes
  in the app).
- Chats are only between the people in a game. Juniors don't see chats yet, including those 13 to 17 with a login of
  their own; no photos or files; a changed message keeps no earlier version. A coach reads their own dates' chats in
  the members' app (the staff app's Chats is front desk and up). Staff hear about reports once an hour per chat, so
  someone reporting in many chats can still raise one alert for each of them in an hour.
- Tournaments and leagues are for doubles pairs. No consolation draw yet, no self-scheduling (players ask, staff
  move), and a league's pairs are fixed for the season (no subs for one match).
- Members who joined before the club linked its terms and privacy policy, or before it changed them, aren't
  asked to agree again. Kumi keeps the links, not the pages' words: keep a dated copy of a page you change at
  the same address.
- No app store apps (the members' app installs from the browser).
- Playtomic is read only, and needs one of its top two plans for the API keys.
- Texting registration is automatic for a toll-free number (`kumi texting`); a local number (10DLC) is
  registered by hand in Twilio.

## 0.2.1 (2026-11-04)

Money taken at the desk for memberships, program places and courts, with the desk's day for counting the
drawer; the club's own terms and privacy policy shown to its members, with what each one agreed to; lighter
first screens; what a real phone showed (the rest to pay, times on the club's clock, files that download, dark mode
that reads); and fixes to money bugs, several of them already in 0.2.0 and 0.1.0. Every club should update.

### Added
- **Email that can't arrive stops.** Resend's reports of a hard bounce, a spam complaint, or an address it won't send to
  any more reach the club through a signed webhook (`/webhooks/resend`, with `KUMI_RESEND_WEBHOOK_SECRET`), and that
  address gets no more of the club's email: sending to it again only hurts the club's sending name. The in-app copy of
  every message stays. The member's app says their email isn't arriving and asks them to change it; the person's page in
  the staff app says why, and the desk can send email to it again once it's fixed. Sign-in codes still go, since the
  person has just asked for one. `kumi doctor` checks that the sending domain is verified and that the reports are set
  up, and says how many addresses are held back.
- `kumi leaving on --email-domain=<domain>` says, in the owners' emails, what becomes of the domain the club's email
  comes from: the host's own stays with the host (`--email-domain-host`), the club's own moves to its own email account.
- **Going back to a minute, in Docker too.** Docker installs get the point-in-time backups one-server installs have:
  any minute of the last 14 days on the machine, and of the last 30 offsite (in the nightly copies' bucket, sealed with
  `KUMI_BACKUP_KEY`), a base backup every night at 3:37 club time, the monthly test, and the same `kumi doctor` checks.
  A new `pitr` service runs them beside Postgres, as Postgres's own user; the server's container sees none of it. With
  `kumi` stopped, `docker compose exec pitr kumi restore --to="2026-11-03 14:05" --yes` puts the database back as it
  was at that minute, with everything a restore keeps: nothing sent twice, the usage meter carried over, support
  access ended, a copy of the database as it was made first (`deploy/docker/README.md`).
- **The club's own terms and privacy policy reach its members.** Link them in Settings ("Terms for members" and
  "Privacy policy", or `terms_url` and `privacy_policy_url` under `club:` in club.yaml) and the members' app shows them
  where someone joins ("By joining, you agree to..."), beside the yes to texts (as carriers expect) and on the profile;
  the public pages link them at the foot, and the texts opt-in page beside the words members tick. Joining agrees to
  them: Kumi keeps the links each new member agreed to, in which language and when, and they're in the member's
  Download data; a yes to texts keeps the links shown beside it. A page opened before the club changed its links asks
  the member to look again. The texting registration gives Twilio the same links, and `kumi doctor` warns while the
  club texts with no privacy policy linked. With no links set, nothing changes. Templates to adapt are in
  `docs/templates`.
- **Memberships and program places paid at the desk**, as court bookings are: in cash, on the club's own card reader
  or another way, all of it or part now and the rest later, never more than is owed (Kumi keeps no credit). Every
  payment is in the books (the cash drawer, or clearing for the card reader), in the reports and on a receipt, and the
  member's app shows it like any other.
  - **A membership sold at the desk** (on the person's page or under Memberships, "Paid at the desk") covers one period
    from that day and doesn't renew by itself. Its member hears a week before it ends, and pays the next period at
    the desk (from two weeks before the end) or by card in the app when the plan is one members join there; nothing
    renews from that card. What's still owed on a period shows on the person's page, in the list and to the member,
    and is paid at the desk. One more person on a family plan from the desk adds their price to what's owed there.
  - **A period paid at the desk on a membership joined in the app** moves its renewal on a period, so the card isn't
    charged for it. A renewal whose card was declined can be paid at the desk the same way, which ends the retries
    and closes the staff alert.
  - **Paid twice for one period:** if the member had the card form open for a period that's then paid at the desk
    (or by the saved card's retry) and the card goes through as well, it doesn't add a second period. It pays what's
    still owed at the desk, the rest goes back to that card once, and the member hears what went back.
  - **A program place paid at the desk:** the staff sign the person up as usual, then "Record payment" on the roster,
    for all of it or part, in cash, on the club's card reader or another way. What the app still asks them to pay by
    card comes down to the rest, or goes once it's all paid. Paid at the desk
    while the member had the card form open and the card went through too, what's beyond the price goes back to the
    card by itself.
  - **A court booking** has the same "Record payment" on the Courts page (it was "Paid in cash", for all of it in
    cash only): all of it or part, in cash, on the card reader or another way.
  - The front desk can do all of it; two desks taking the same payment at once can't both record it. Read-only and
    moved clubs take nothing at the desk, as for everything else that takes money.
  - **The desk's day** under Reports ("At the desk"), for counting the drawer at closing: each day on the club's
    clock, what was paid at the desk in cash, on the card reader and another way, what was given back there, and the
    drawer (the cash taken, less the cash given back). A day opens to each payment and refund, what it was for and
    who recorded it, and a spreadsheet file has every line. For the club's money people, as receipts are.
- **Money paid at the desk goes back at the desk, never to a card.** A refund of it (a court cancelled by the club's
  rule, a booking made shorter, a place left or a program cancelled) waits on the person's page, "To give back at the
  desk", until someone hands it over and taps "Given back"; only then does it leave the cash drawer in the books, with a
  refund receipt. Their messages say it's theirs to collect at the desk. Front desk and up, and still while read-only.
- **Texting through a host's Twilio account.** A club texting from a subaccount of its host's Twilio account can
  name its own Secondary Customer Profile (Twilio's Trust Hub) in club.yaml, `texting.customer_profile_sid`, and the
  toll-free verification uses it (`docs/setup/accounts/twilio.md`).

### Changed
- **Readable in dark mode, and sized for a thumb.** Links, outlines and notes in the club's colour now use a tint of it
  that reads at 4.5:1 on each theme (a dark green on the dark theme was 2.25:1), and a button in the club's colour gets
  dark text when white wouldn't read. On a touch screen every button and link outside running text is at least 44 px.
- **Passkeys in plain words.** A phone that can't save a passkey (no screen lock) says so on the profile before anyone
  waits; a passkey that wasn't saved or didn't work says why in plain words, never the browser's own message.
- **The desk's day fits a phone.** On a narrow screen each day, and each line, stacks with its column names.
- **The usage meter survives a restore.** Restoring a backup, a minute or an update's snapshot, or an export onto the
  server the club ran on before, puts the meter back to the copy's counts, so what AI, texts and email cost after the
  copy was made went uncounted: a host billed too little and the cap let more through. Now each month keeps the larger
  count, and an 80% or cap message already said isn't said again. Where the database before it can't vouch (a new
  server after losing the old one), the restore says this month's count may be short, and so do `kumi usage` (`gaps`
  in `--json`) and `kumi doctor` until the month ends.
- **Asked once.** Asking for something that waits for a yes (the usage cap, support access, a refund that needs a
  second person) while the same ask already waits, by anyone, is refused with when it was asked: everyone who can say
  yes was told again, and two yeses did it twice.
- **Nothing offered that won't work.** While the club's app is read-only or has moved, the members' app says so in
  place of the buttons that book, join or sign up, instead of a refusal after the tap.
- **One notice at a time on a phone.** The notices at the top of both apps (read-only, moved, the day the club's Kumi
  ends, support access, a waiver, an email to add) show the first on a phone, with how many more there are.
- An update only ever runs its own script. `deploy/docker/update.sh` and `release.sh` read themselves in full before
  running anything (bash reads a script as it goes, and both change their own file while they run), and an update
  writes the `kumi` command beside it and moves it into place instead of rewriting the one `sudo kumi update` runs.
- `kumi read-only status`, `kumi moved status` and `kumi leaving status` give times on the club's clock, not as raw
  UTC, and `kumi doctor` gives the club's own day. The leaving status lists the emails to the owners under their own
  heading, and the moved switch in Settings says "We're staying on this server".
- **The sign-in cookie keeps to its own address.** Over HTTPS it's now `__Host-kumi_session` (Secure, `Path=/`, no
  domain), so another site under the same domain can't set or replace it: several clubs on one host's domain
  (`<slug>.kumi.club`) can't sign each other's visitors in as someone else. Over plain http, on a computer of one's
  own, it keeps its old name. For this release the old name is still read and moved to the new one, so nobody is
  signed out by the update; a host whose clubs never had it sets `KUMI_LEGACY_SESSION_COOKIE=0`.

- **Cancelling a court booking paid in cash** sent its refund to a card that was never used, which failed and showed
  as a refund to send again. It now waits at the desk (above), and the preview says "goes back at the desk".

### Fixed
Found by trying Kumi on a real Android phone:
- **A member was shown, and asked by card for, a place's whole price after paying part at the desk.** My places said
  "Pay $30.00" after $10 was paid in cash (Kumi charged the right $20, but said $30). It now says "Paid $10.00 of
  $30.00" and asks for the rest, for places and court bookings alike, and shows a place at the price the member was
  given (a member's price, say), not the program's.
- **Times showed in the phone's own time zone, not the club's.** A phone set to another zone (travelling, or just set
  wrong) showed a 5 PM clinic at 10 PM, on What's on, My places, a member's page in the staff app and elsewhere. Every
  date and time in both apps is now on the club's clock; a test keeps a new one from forgetting it.
- **The staff app's "now" line, and what counts as past, followed the phone's clock.** A phone hours slow put the line
  hours early. Both apps take the time from the server's answers instead.
- **The spreadsheet links under Reports, and Add to calendar, opened a blank page.** The app took them as its own
  pages. They download now (on Android the file goes to Downloads), and so does a data download linked in the inbox.
- **A walk-in's paid booking couldn't be refunded from the Courts page.** Cancelling it there only applied the club's
  rule; the choice (the club's rule, everything back, nothing back) was on a member's page, and a guest has none. The
  desk and up now choose there too; money paid at the desk goes back at the desk.
- **A coach's Reports page showed "Occupancy and revenue" at $0.00.** A coach doesn't see the club's money; their page
  is now their own lessons and sessions.

Found by a review of the money paid at the desk (above), most of it in code older than that change. Those
marked "in 0.2.0" or "since 0.1.0" are in the release a club runs now: update.
- **A payment called off while its card form was open could still be paid, and the money went unrecorded (in
  0.2.0).** Cancelling a booking (or a program, or a friend's share at the deadline) marked its payment failed but
  left the card form open at Stripe: the member could pay, the card was charged, and Kumi neither counted nor
  refunded it. Now the card payment is called off at Stripe too, and if the card goes through first, the money is
  recorded and all of it goes back to the card. A call-off that can't reach Stripe keeps trying (it was given up
  after eight tries), and the minute job asks Stripe about one not through yet, so a card paid meanwhile with its
  webhook lost is still found and sent back. The members' app asks about a called-off payment only for a few days,
  and how often anyone can ask the server to check a payment is limited.
- **A court booking whose hold ran out left its card payment open (since 0.1.0).** It's called off now, as when the
  booking is cancelled; with several courts in one card payment, once none of them is still wanted.
- **The desk cancelling a booking at the moment its card went through could stop one of them with a database
  deadlock (since 0.1.0).** Both now take the booking's payments first and then the booking, and any change ended to
  break a deadlock is tried once more (a charge made inside it carries a key that gives the same answer again, so
  one more person on a family plan is never charged twice for it).
- **A card payment settled twice at once was counted twice (in 0.2.0).** The card form's return, Stripe's webhook and
  the minute job can each settle a payment, and two at the same moment both did: the books counted it twice, a late
  renewal paid in the app could add two periods, a new member could get the membership and all of the payment back,
  and (since the desk change) a next period paid by card was added and all of it went back too. A payment is now
  settled once, whichever comes first; the others find it done, and one card payment for several dates settled
  through two of them at once no longer stops one with a database deadlock.
- **A refund could be more than was left of its payment (in 0.2.0).** Cancelling a booking that had been made shorter
  or moved somewhere cheaper (with part already back) worked the club's rule out from all that was paid, so the desk
  was told to hand back more than it took; a card's excess was refused by Stripe. Every refund now comes from what's
  left of each payment, and none is ever more than that.
- **A player who passed their place to a sub waited for their refund forever when the sub paid at the desk.** It's
  sent once the sub's place is paid in full, at the desk or by card.
- **A card could be asked for one amount while Kumi recorded another (in 0.2.0, for a program date made cheaper).**
  If the member was opening the card form at the moment the desk took part of the place (or a date was cancelled and
  the place cost less), the card form could go on to charge the old amount. What a card payment asks for is never
  changed now: it's called off and a new one asked for the rest, and a card form that was opening for the old one is
  stopped and called off at Stripe.
- **A pause between asking for a membership's next period and its card going through** turned the payment into a
  refund, as if the period had been paid another way, and left the renewal to fail. A membership now counts its
  periods, and a pause moves its dates, never the count.
- **A family card charged at the moment what it paid for changed (in 0.2.0)** (a court cancelled, or a place paid at
  the desk) kept the money with nothing recorded against it. All of it now goes back to the card at once.
- **One more person on a family plan from the desk, taken off before their price was paid,** left it owed, and adding
  them again owed it twice. Taken off unpaid, it comes off what's owed and they go at once; paid for, they stay to the
  end of the period and can be put back with nothing more to pay.
- **"1,200" in a money box was read as $1.20 (in 0.2.0).** Amounts in the staff app are read the US way, a comma between
  thousands and a point before the cents, in English and Spanish alike, and one that could mean either ("12,5") is
  refused with how to write it.
- **A page from a release since replaced** could draw with no words when its files were gone. Kumi tries again; if
  the server now runs another release it reloads once for it, and when the connection is the trouble it says the
  page didn't load, with a button to try again.
- **Who does desk money.** Recording money taken at the desk and handing it back are the staff's own: never support
  access, and never an assistant, which can't see money change hands (in 0.2.0 both could record a court booking's
  payment). A front desk kept to one location hands back money for its own location's bookings and places and
  sells memberships, which belong to no location. A coach looking at their own student's page no longer sees what's
  waiting at the desk for them, or refunds that failed.
- The desk's day reads from an index of the changes that take or hand back money at the desk, not all of them.
- **Every membership change belongs to no location**, like selling one: a front desk kept to one location gives,
  ends, pauses and changes memberships, and still reaches only its own location's bookings and programs.

### When updating
- If club.yaml names a privacy policy or terms under `texting:`, `kumi setup apply` links them for members too (while
  the club has none set), and the texting registration uses them either way. Members who joined before the links were
  set aren't asked to agree to them.
- Set up Resend's reports (`docs/setup/accounts/resend.md`, step 6): until then, `kumi doctor` warns, and nothing else
  changes.
- **Docker installs:** update as usual, `deploy/docker/update.sh <release>`. Postgres starts again once, on its new
  image (the same Postgres, with pgBackRest), now archiving its log; the server waits for it, as at any start. The new
  `pitr` service writes pgBackRest's settings from `.env`, makes the archive and takes the first base backup at once,
  and `kumi doctor` says how far back it reaches. The database's files stay as they are. Running the update again
  changes nothing. To leave point-in-time backups off, put `KUMI_PITR=0` in `.env` first. Going back to an earlier
  release with `update.sh rollback --yes` stops the `pitr` service and Postgres stops archiving; the archive is kept,
  and the next update to this one takes a base backup at once (the service takes one each time it starts), so the
  minutes since are reachable again; those in between aren't.
- **If the club texts,** link its privacy policy (and its terms) in Settings: carriers look for it beside the
  yes to texts, and `kumi doctor` warns until it's set. Templates to adapt are in `docs/templates`.
- Nothing else to do on a one-server install. The database changes apply when the server starts, and
  Caddy's paths are the same as 0.2.0's.

### Known limits
- Self-hosted only; a hosted service is planned.
- US clubs: US dollars and US formats, English and US Spanish, texts to US and Canadian numbers only.
- Cards only (Apple Pay and Google Pay included), and what the desk takes for bookings, memberships and
  program places (cash, the club's own card reader, another way); no credit, gift cards, vouchers or drop-in
  passes.
- A program place partly paid at the desk is kept, never let go for being unpaid, and the rest of it is never
  reminded: it shows as owed on the roster and in the member's app.
- A card that goes through after its payment was called off always goes back in full, even when the place it
  was for stays booked at a new price (a date cancelled from a course): the member then pays the new price.
- The desk's day counts the whole club, not each location's drawer.
- Members who joined before the club linked its terms and privacy policy, or before it changed them, aren't
  asked to agree again. Kumi keeps the links, not the pages' words: keep a dated copy of a page you change at
  the same address.
- Tournaments and leagues run as programs, without draws or fixtures. No chat between players, no
  recurring bookings, and no app store apps (the members' app installs from the browser).
- Playtomic is read only, and needs one of its top two plans for the API keys.
- Texting registration is automatic for a toll-free number (`kumi texting`); a local number (10DLC) is
  registered by hand in Twilio.

## 0.2.0 (2026-11-03)

A club can leave its host with everything, and share a hosted server safely: one monthly cap on what
outside services cost, Download everything, going back to a minute, support access only when the owner
gives it, and restores and moves that never send or charge twice.

### Added
- One monthly cap for what outside services cost the club: AI (answers from the club's facts, and drafts in
  its other language), texts and email are counted in the club's month, in dollars, on the staff app's new
  Usage page, in `kumi usage` (`--json` for a bill) and in `kumi doctor`. The owner sets the cap ($50 to
  start) and an amount allowed over it in a busy month; a manager can ask. At 80% and at the cap the owner
  and managers hear once each. Past it, what can wait waits until the 1st (drafts, club news emails, and
  texts that can go in the app and by email); answers from the club's facts, sign-in codes, confirmations
  and cancellations keep going, up to twice the limit.
- **Download everything.** The owner can download all of the club's data and settings in one file, sealed
  with a passphrase shown once (Settings in the staff app, or `kumi export` on the server). `kumi restore`
  puts it into another install of the same Kumi or a newer one: the secrets are sealed again with the new
  server's key, and it says what's left to set up there. A club can always leave, with everything.
- **Read-only**, a host's switch for an account that isn't paid (`kumi read-only on|off|status`). Everyone
  still signs in, sees everything, cancels with the usual refunds and downloads their data; nothing new is
  booked, joined, sold or charged, renewals wait, and both apps say so at the top.
- **The day the club's Kumi ends** (`kumi leaving on --date=YYYY-MM-DD`, for a club moving off its host or
  shutting its server down). Every owner is emailed at once, in their language, to download everything
  before then and save the passphrase, and reminded a week and a day before, each once, even while
  read-only or past the cap. The staff app shows the date to the owner and managers. `kumi leaving status`
  shows which emails went and when everything was last downloaded.
- **Support access, only when the owner gives it** (Settings, Support access): someone from outside the
  staff, such as the club's host or a contractor, for a set time (24 hours unless the owner says otherwise,
  7 days at most), to look only or to work like a manager. A manager can ask; the owner says yes. They sign in
  with their own account and two steps, never reach the club's money settings, roles, Download everything,
  deleting people or data, the vault, the usage cap or anything that needs a strong sign-in, and never work
  through an assistant. Everything they open and change is recorded for the owner, who hears when it's
  first used and when it ends, and can end it at once. It ends by itself, mid-session too.
- **What was waiting to go out is held after a move.** An export carries the emails, texts and notices the
  old server hadn't sent yet, and the old server, still running, sends them itself. Restored on another
  server, they're held there instead of going twice; the restore and `kumi doctor` say how many. Once the old
  server is off, `kumi held send --yes` sends them as they would have gone, or `kumi held drop --yes` drops
  them (`kumi held` lists them first).
- **Going back to a minute** (point-in-time backups): Postgres's log goes to pgBackRest at least once a minute,
  with a base backup every night, on the server (14 days) and offsite beside the nightly copies (30 days,
  sealed with a key made from `KUMI_BACKUP_KEY`). `sudo kumi restore --to="2026-11-03 14:05" --yes` puts the
  database back as it was at that minute on the club's clock, through a scratch copy and the usual safe restore.
  `kumi pitr status` says how far back it reaches; `kumi doctor` checks it, and a monthly test restores a random
  recent minute and checks it stopped there. The target: lose at most about a minute, back within an hour.
- **Nothing goes out twice after any restore.** Restoring a backup, a minute, or an update's snapshot (a failed
  update, or `kumi rollback`) carries over what the database before it had already sent, so those messages
  don't go again; a notice it had handled is held for `kumi held send|drop`, since its messages may have gone.
  Where the database before it can't vouch (a new server after losing the old one), everything waiting is held,
  as after a move.
- **Nor what the jobs make again.** A reminder, notice or club news whose "already said" record was written after
  the backup isn't in the backup, so after a restore the job makes it again: a new message with the same words.
  The restore keeps a fingerprint of every email, text and push the database before it had sent that the backup
  has no row for (the person, the kind, the channel, the exact words and link). For a week, a message made again
  with that fingerprint is marked as sent at its earlier time instead of going twice, once per fingerprint; the
  in-app inbox copy stays. After the week the same words go as new. `kumi restore` says how many it kept.
- **Moved** (`kumi moved on [--to=<url>]`, or the owner's "We're moving" under Download everything): the club's
  Kumi now runs elsewhere, so this server sends members nothing (emails, texts, notifications), takes nothing
  new, as when read-only, and both apps point to the new address. Turned on before the export, only one server
  ever talks to members: what was still waiting travels in the file, and the new server sends it, once, with
  nothing held.
- **Approve or decline what someone asked for.** When a manager asks for something only the owner does (support
  access, the usage cap, connecting Stripe), or a refund needs a second person, everyone who can say yes is told
  once, in the app and by email, and Changes shows it at the top with Approve and Decline. The person who asked
  hears the answer, with the reason if one was given. Saying yes needs what the change itself needs, a strong
  sign-in included.

### Changed
- **A restore takes only what Kumi makes.** Restoring a backup, an export or a minute replays the file's database
  as Kumi's own database role, so a file made by someone else (a host the club is leaving) could have brought a
  trigger that copies members' messages out, or one that keeps support access open, running unseen. Now, after
  the restore and Kumi's migrations, the database's functions, triggers, rules, views, row policies, schemas,
  extensions, operators, types, table grants and role or database settings must be exactly those Kumi's
  migrations make (`apps/server/src/shape.json`; what the server's own database already had, such as a managed
  Postgres's extras, is allowed back). If not, the database as it was goes back in and the file is refused,
  naming what wasn't Kumi's.
- **Undo is judged as the change it undoes.** Undoing a change needs what the change itself needs: an owner's
  change (the usage cap, removing a manager) can't be put back by a manager, whose undo waits for the owner, as
  asking for the change would; and an undo of something that's the app's alone or needs a strong sign-in
  can't come from an assistant, or without that sign-in.
- **Support access ends on a move**, and the owners are told why. A restore keeps ended access ended: the
  restore carries over what the database before it had ended, and where it can't vouch, all of it ends.
- An export's passphrase is stretched with scrypt at 2^17 (it was 2^15), and a file says what it was made with,
  so older files still open; a file asking for more than Kumi ever uses is refused.
- Point-in-time backups never open the club's database as Postgres's superuser. Their jobs (as the postgres user,
  whose archive it is) sign in as the `kumi` role, which Kumi's own `pg_hba` and `pg_ident` files now allow for
  the `kumi` database only; in the scratch copy a restore makes, the club's database is read and dumped as the role
  that owns it (refused if that's a superuser), with only Postgres's catalog on the search path, and the scratch
  copy lets Postgres's superuser into its postgres database only. Before, a trigger
  or function the `kumi` role had left in its database would have run with the superuser's rights when the hourly
  job wrote its heartbeat or the monthly test read the copy. The dump of a minute is made under umask 077 in a
  folder only the postgres user opens (`/var/lib/postgresql/kumi-pitr`); it was readable by everyone while it was
  made.
- An update reads the API paths and policy it gives Caddy from the release it just built, which the kumi user
  built: they now go into root's Caddyfile only if they're plain paths and a policy with nothing that could end
  Caddy's quoted string or open a block of its own, or the update stops with nothing changed.
- The nightly backup and the monthly restore test get the server's sandbox (`ProtectSystem=strict`, a /tmp of
  their own, writing only in the backups folder), and a built release is left with nothing setuid.
- A card charge (a renewal, a booking's deadline, a family card) asks Stripe for the one it already has, by Kumi's
  own id for it, before charging: the database put back to before a charge (a backup, a minute, an export
  elsewhere) can't charge the card again, even after Stripe has forgotten the request. Charges Kumi makes carry
  that id; charges made by Kumi 0.1.0 don't, so this can't see them.
- Saying yes to a change that needs a strong sign-in (an owner approving a manager's request) needs one too.
- The monthly text cap in segments is folded into the one cap. Settings, Texts still shows the month's texts.
- A club that ran on a hosted Kumi (Stripe Connect) and moves to its own server reaches its earlier
  payments with its own Stripe keys, so refunds of them work.
- The Docker backup service knows the club's address (for exports).
- A refund asks Stripe for the one it already has, by Kumi's own id for it, before sending: one sent before (by
  a club's old server, or long enough ago that Stripe has forgotten the request) is recorded, never sent
  twice. Refunds Kumi sends carry that id. Refunds sent by Kumi 0.1.0 don't, so this can't see them.
- An account Kumi made for support access, with no role at the club, can't connect an assistant: there's no
  consent screen for it, and a connection it already had stops working.
- The server listens on 127.0.0.1 only (`KUMI_LISTEN_ADDRESS`), not every address; the Docker image sets
  `0.0.0.0`, since Caddy is another container there. For a server several clubs share, `KUMI_SOCKET` makes a
  club listen on a unix socket instead of a port, so no other club's process can reach it or pass itself off
  as the club's proxy (which got around the sign-in limits, and could read `/health/deep`).
- An update gives Caddy the new release's config, so paths a release adds reach the server without running
  `server-setup.sh` again. Caddy checks it before anything switches (a config it refuses changes nothing) and
  takes it without dropping connections; if Caddy won't take it, the update is undone. Going back puts the
  previous release's config back. A config changed by hand is left as it is, and the update says so.
- Point-in-time backups, as found running them on real servers: an S3 storage on its own port (not 443) gets it
  as pgBackRest's port setting; the commands run as the postgres user name it in the database address; `sudo kumi
  pitr test` (and tick, extract) runs as the postgres user, and doctor's hints say so; the monthly test of an
  archive less than ten minutes old is skipped, not reported as failing; a refused or failed restore leaves no
  `.part` file or copy from the archive behind; and `kumi held` says it's after a move or a restore.
- A club that has moved says so when it refuses something, with its new address if the owner gave one.
- In Spanish, the staff app's settings are called Configuración everywhere, as in its menu.
- Support access, as seen in a browser: the owner's record says what was opened in the staff app's words, not
  addresses; Usage tells support it can't change the cap; ending it takes the banner away at once; and someone
  whose access has ended (or a member in the staff app) is told so, instead of pages that don't load.
- The staff app's Changes page can be opened or reloaded directly (its data moved to `/staff/changes`).

### When updating
- Nothing to do for the point-in-time jobs' new sign-in: the update writes Kumi's `kumi_hba.conf` and
  `kumi_ident.conf` beside Postgres's, puts an include line at the top of `pg_hba.conf` and `pg_ident.conf`, and
  reloads Postgres (it doesn't start again). If the update says the postgres user can't sign in as kumi,
  `kumi doctor` will show the point-in-time jobs failing: check those two files.
- If you ran `server-setup.sh` with Kumi ce7f772 or earlier, run it once more: Postgres's archive command is
  renamed to one pgBackRest accepts (`pgbackrest-archive-push`), or the first base backup fails with error 068.
  Postgres only reloads; it doesn't start again.
- Point-in-time backups need `server-setup.sh` run once more on a one-server install, after the update
  (`KUMI_HOST=app.yourclub.com bash /opt/kumi/app/deploy/server-setup.sh`): it turns them on and starts Postgres
  again once, which the club's apps ride through. Run before the update, the next update sets pgBackRest up.
  Docker installs don't have them yet.
- Nothing else to do. The cap starts at $50 a month, whatever the text cap was. Prices are list prices; set
  `KUMI_PRICES` if your providers charge you differently (`docs/settings.md`).
- If something other than Caddy on the same machine reaches the server's port, set
  `KUMI_LISTEN_ADDRESS=0.0.0.0` (or that machine's address) in the settings first.
- If you changed Caddy's config (`/etc/caddy/Caddyfile`) by hand, updates leave it as it is: add new paths
  there yourself, or run `server-setup.sh` again (which writes Kumi's own). This release also takes `/changes
  /changes/*` out of the API's paths.

## 0.1.0 (2026-11-02)

The first release: a club can run on it on its own, or run its events with it alongside Playtomic.

### What Kumi 0.1.0 does
- Members book and pay for courts in the club's own app (the whole court, or only their part), open
  matches to players of their level, and find a sub when they can't make it.
- Clinics, courses, socials and Americanos, signed up for as a whole or date by date, with waitlists,
  a minimum to run, and refunds by the club's own rules. Private lessons with the club's coaches.
- Fair levels: scores both sides confirm, a sentence on why a level moved, and reviews the club answers.
- Memberships, founding offers sold before opening, family plans, and juniors under their parents' care,
  with a login of their own from 13 if the parents allow.
- Card payments, Apple Pay and Google Pay into the club's own Stripe account, with no commission, and a
  receipt for every payment and refund.
- Messages by the app's inbox, email, push and, optionally, text, with consent and quiet hours kept.
  Members can ask the club and get its own answers word for word, or a person.
- A staff app for the desk on a phone or computer: the day on the courts, people, programs, money,
  reports, roles and two-step sign-in. Members and staff can connect their own AI assistant.
- English and US Spanish throughout, including the club's own words.
- One server or Docker, with nightly backups, sealed offsite copies, a monthly restore test, and updates
  that put themselves back if something goes wrong.

### Installing
Start at [`docs/setup/README.md`](docs/setup/README.md), with the code at `git checkout v0.1.0`. You'll
need a domain, a server with 2 GB of memory (about $12 a month) or a machine with Docker, a Stripe
account, a Resend account for email, and storage for offsite backups (Cloudflare R2 or Backblaze B2).
Texts (Twilio) and "ask the club" (TypeSafe or Anthropic) are optional. The owner's time is about a day,
spread over a week or two while Stripe checks the business. Two things people miss: turn on "Members book
courts in the app" (Settings, The club), which starts off; and keep practice mode on until the owner says
to go live.

### Known limits
- Self-hosted only; a hosted service is planned.
- US clubs: US dollars and US formats, English and US Spanish, texts to US and Canadian numbers only.
- Cards only (Apple Pay and Google Pay included); no credit, gift cards, vouchers or drop-in passes. The
  desk records cash for bookings, not yet for memberships or program places.
- Tournaments and leagues run as programs, without draws or fixtures. No chat between players, no
  recurring bookings, and no app store apps (the members' app installs from the browser).
- Playtomic is read only, and needs one of its top two plans for the API keys.
- Texting registration is automatic for a toll-free number (`kumi texting`); a local number (10DLC) is
  registered by hand in Twilio.

### Everything in 0.1.0

**Court bookings**
- Giving a court its own hours names any booking or program date already there that the new hours leave
  outside; they stay booked for the staff to move or cancel.
- A member's page in the staff app lists their court bookings and lessons (the last 30 days and those to
  come). Front desk and up cancel one there, choosing the club's rule, everything back or nothing back, or
  refund part of a card payment on one that stays (refunding is its own decision, apart from leaving). Cash paid at the desk goes back at the desk.
- The desk can't record more than a booking still owes (its price, tax included, less what's been paid and
  not refunded): Kumi keeps no credit for later, so the extra would have nowhere to go. Part now and the rest
  later is fine.
- Opening hours and special days, court blocks, and a Courts page for staff to see the day, book at the
  desk (taking cash), block courts and cancel. No double bookings, even when many try at once.
- Prices by court, day, time and season, sales tax, and booking rules that bookings keep once made.
- Members book in the app and pay the whole court, or only their part: the others join from a link
  and pay theirs, and what's unpaid at the club's deadline goes once on the organiser's saved card
  (saved, never held). Cancelling refunds what the club's rules give, and anyone who paid between the
  cancel's preview and its confirm gets all of theirs back. Calendar links.
  An open match works differently (below): nothing goes on the host's card.
  A court is shared 2 or 4 ways, never more. Someone who still owes on a court (the deadline charge
  didn't go through, or time owed at the desk on a booking that's over) can't book, join or ask to join
  in the app until it's paid at the desk; staff can still book for them.
- Several courts the same day in one checkout (whole courts): one card payment for all of them, at
  each court's own price (member prices included), and one message. Each court is still its own
  booking, cancelled on its own, with its part of the payment refunded. If someone takes one of the
  courts while the payment is going through, that court's part comes back and the rest stay booked.
- Messages for confirmations, shares paid, cancellations, money owed, and a reminder before playing.
- Occupancy and revenue by day, with a CSV export. Revenue has courts, lessons, programs and memberships
  (starts, renewals and a family's extra people, less refunds) each on its own line.
- A court's own hours: an outdoor court that closes at dusk, or one that opens later, inside the
  location's hours or outside them. A day it has no hours of its own follows the location's. The
  location's special days apply to every court, unless a court has its own for that date. Free courts,
  desk and member bookings, moves, a lesson's court, the Courts page (shading when a court is closed)
  and the occupancy report all use each court's own hours; a program date on a closed court is a warning.
  A booking left outside its court's hours (kept when the hours changed) still counts as booked in the
  report; only the occupancy, the share of open time used, leaves it out.
  On the Courts page, the desk's forms (book, move or change the length, block, change a repeating
  block's times) offer only the times the chosen court is open that day, and only lengths that end by
  its closing.
- Courts blocked every week ("Courts 1 and 2 every Tuesday 18:00 to 20:00, for the league"), from a
  date until a date or with no end. Each date is an ordinary block, so nothing else can take the court
  then. Bookings already in the way stay (the block leaves that court free that day) or are cancelled,
  with their players told and what they get back chosen separately. Opening one date, ending from a
  date, ending them all, and changing the times work for this date, this and the following ones, or all.
  A booking made between the preview and the confirm stays too: the block leaves that court that day.
- The Courts page lists every repeating block with dates still to come: its courts, days, times, dates,
  reason and next date. From the list, staff change its courts, days, times, end date, reason or note
  for one date, from a date on, or for every date still to come, or end it, with the same preview of the
  bookings in the way.
- The Courts page is the desk's day: courts across and time down (sideways on a phone), what's on now
  and next on each court with what's owed and who's running late, and the alerts that need someone,
  each shown until one of the staff marks it handled, for everyone. The date shows its weekday. A coach
  (with no other staff role) sees their own lessons in full and anyone else's booking only as "Booked".
- Staff move a booking to another time or court, or make it longer or shorter, by dragging it (or on
  buttons, or with the arrow keys), always through the preview. A lesson moves only when its coach is
  free then, and a program date moves through the same "this date" change as on its page. Moving keeps
  the price paid unless staff ask for it to be priced again; added time is owed at the desk; time taken
  off gives back by the club's cancellation rule, all of it or nothing, as staff choose. The players
  (and a lesson's coach) are told. On a phone or tablet, the drag handle and the bottom edge take a
  fingertip (about 44 pixels) without looking bigger.

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
  (a friendly unless they say so), until the score is in. The front desk names players on a member's
  court too, from the Courts page (anyone, found by name), and a court booked at the desk for a member
  gets the players link like one booked in the app. A walk-in under a guest name has none. The desk copies
  a booking's players link from the Courts page; it opens at the members' address.
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
- A coach with no other staff role reads their own work: their schedule, students, programs, courts, levels
  and their own earnings. The club's money, the member list and contact details (except their own students'),
  memberships, messages and settings say "staff only", and the staff app doesn't offer them.
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
  time, then whoever is booked into their sessions and lessons in the next 30 days, with when they're
  next. Front desk and up open any coach's from the Coaches page.

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
  A court or lesson a kid shares "pay my part" counts in full against their monthly limit, since what the
  others don't pay goes on the family card at the deadline. At the deadline, whatever would take the kid
  over their limit (or with no card saved) isn't charged: a parent is asked to pay it in the app.

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
- All the club's receipts for any dates (up to a year) under Reports, for the same money people, with a
  spreadsheet file: refunds as negative amounts, so a column adds up to what came in, and a name that starts
  like a formula kept as text. Each opens as the printable receipt, as on a person's page. A member's data
  download includes their receipts (one a parent paid for them, without the parent's card).

**Memberships**
- Someone taken off a family plan stays covered until the period ends; adding them back in that time puts
  them back with no second charge.
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
- A refund that can't reach the card provider (an outage) tries again, waiting 30 seconds, then longer each
  time up to an hour between tries. After about an hour it's marked as not gone through, so it no longer counts
  as paid back and the owner and managers hear once. They send it again from the person's page ("Refunds that
  didn't go through"); it's the same refund to the provider, so it never goes out twice.
- The owner and managers hear once when a renewal is declined (not at every try): who, the plan, the
  amount, the bank's reason when it gives one, the next try and the last day, with a link to the
  member. It waits on the Courts page's alerts until it's handled, or closes by itself when the
  renewal is paid after all (they hear that too). If the last try fails, they hear the membership
  ended, and that takes its place on the alerts. Staff ending it themselves closes the alert too, and
  nothing is tried again. A founding member's declined first charge says it's the first payment, not a
  renewal.
- Members cancel in the app (it runs to the end of what's paid) and can change their mind until then.
- The club pauses a membership until a date (an injury, a long trip): no benefits and nothing charged
  meanwhile, and the paid time left moves to after the pause; ending a pause early gives the unused
  time back to the renewal date.
- Founding offers: a plan for the first so many members, starting on a date. Joining before then
  saves the card without charging it; the first charge is on the start date.
- Founding members get the plan's member prices, program discounts and booking window from the day
  their card is saved, not the start date (a plan setting, on by default; included sessions still
  start with the membership). Giving up the place before the start keeps what was already paid. Their
  Membership page says the perks apply already.
  Someone who gives up a founding place before the start can't take it again in the app (joining and
  leaving again would keep the member prices for nothing); staff can still add them.
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
- A place taken and not paid for is held a day (or until 2 hours before its first date, if sooner). The
  member is reminded once, halfway; then the place goes to the next person on the waitlist and they're told.
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
- Weekly drop-in clinics and socials signed up date by date (chosen when the program is made, and
  changeable until anyone signs up): each date has its own places, roster, waitlist with timed offers,
  "tell me when a place opens", minimum to run (decided before each date, so a short date is cancelled
  alone), attendance and coach. Members tick the dates they want on What's On and pay for them in one
  card payment, with one message; a full date goes on its own waitlist. Each date is priced as it would
  be alone (the member price), and included sessions are used in date order while the period has any.
  Leaving a date follows the club's cancel rule for that date, and frees that date's place only.
  Cancelling a date gives everyone on it all of what they paid back (or staff choose nothing, with a
  reason). Changing places for "this date", "this and following" or "all" sets each date's own places.
  Staff see one date's roster at a time, and give a free place on a date. Receipts, My places, the
  coach's students and the public page show the date. Courses, leagues and tournaments stay whole.
- The desk signs a member up for one or several dates of a program signed up date by date, from its
  page in the staff app: a date with room is a place, a full one the waitlist. The member pays by card in
  the app and gets one message with every date and the amount (not one a date). The program's public
  page says each date's places, not only the next date's.
- A place given up before it was paid calls off what was still owed for it; if its card form was
  already open and the money arrives anyway, all of it goes back.
- A new program's results change levels by default for socials, leagues and tournaments, and not for
  clinics and courses (they're for learning); staff can tick or untick it, and the preview says which.
  Programs already made keep what they have.
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
  manage go with them. The owner can do either for a member who asks (a manager asks the owner; once
  the owner approves, the manager who asked is sent the download link, theirs alone, for 15 minutes), and
  the club is told each time. A parent who alone manages a junior downloads the junior's data or deletes
  their account from Family; with another parent in the family, the club does it.
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
  A club answer that states a general rule (an age range, opening hours) counts when it settles the
  asker's case ("Can my 8 year old play?" gets the juniors answer).
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
- Club news emails carry one-click unsubscribe (the mail app's own unsubscribe button, and a link at the foot): it stops club news by
  email with no sign-in, and nothing else. Members turn club news on or off in Profile too. The link is on
  the members' app's address (`KUMI_MEMBER_URL`), never the staff app's.
- Tags: the club's own words for members ("league A"), put on a member's page. The People list searches by
  name, email or phone and narrows to a tag or a saved group. Tags, and the groups, templates and messages
  a staff member made, are in the data file; deleting an account takes the tags off and kills the old
  unsubscribe link.

**The club's own words in both languages**
- A plan's name and description, a program's name, the waiver, the public page's blurb, a coach's bio and a
  price's name each have an optional version in the club's other language, under the field in the staff app.
  A member reads their language's version, and the club's own words where there isn't one: on the members'
  app, the public page, previews, messages, texts and receipts (a receipt names the program or plan in each
  language). Court and location names stay as written.
- Programs can be renamed, with their name in the other language.
- With an Anthropic key in the settings, "Offer a draft" fills the other-language field from the club's own
  words through Claude Haiku. A person reads it and saves it; nothing is saved by itself. Staff only, 40 an hour each.
- Accepting the waiver records which language it was read in. The data download and the club's receipts file
  keep both versions.

**The public page**
- The staff app's "see the public page" opens it at the members' address.
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
  START turns texts back on; HELP is answered with the club's name (both only for US and Canadian numbers,
  once a day each per number, at most 60 an hour in all, so a flood of them can't use up the club's texts).
  Codes are guarded against SMS pumping (the bot check, no Caribbean or premium numbers, limits per number,
  person and club, counted one at a time so codes asked for at the same moment can't slip past them). A kid
  with their own login says yes once a parent turns texts on. Twilio's delivery reports are checked
  against its signature; `kumi doctor` and `/health/deep` report texts. US carriers must approve the
  club's texting registration before real texts reach anyone.
- `kumi texting plan | apply | status` registers the club's texting with US carriers through its own Twilio
  account, toll-free: it buys a toll-free number (only with `--yes`: it's on the club's bill) or uses one
  the club has, makes a Messaging Service sending replies and delivery reports to the server, and sends the
  toll-free verification with the business's details from club.yaml's new `texting:` section and Kumi's own
  description, sample texts and opt-in. Members' consent is shown to the carriers' reviewers on a new page,
  `/public/texts` on the members' address, with the exact words members tick. Each step is recorded, so
  running it again carries on where it stopped. The server asks Twilio how the review is going every hour;
  the owner and managers get one message when it's decided, Settings shows where it stands, and texts start
  by themselves when it's approved, from that Messaging Service (a sender named in the settings file still
  wins). A rejection comes with each reason and its fix; `apply` sends the corrected verification while
  Twilio allows edits, and a new one (with `--yes`) after. Local numbers (A2P 10DLC) stay in Twilio's
  console. With Twilio keys but no sender, the server starts and texts stay off.
- Texts are counted per club month in carrier segments, the way Twilio bills them (160 plain characters in
  one, 153 a part when longer; 70 and 67 for anything outside the plain alphabet), with an estimate at the
  club's price per segment (1.26 cents to start) and Twilio's own price when its delivery report gives one.
  A monthly cap, 1,500 segments to start (about $19), is set in Settings, Texts by the owner or a manager,
  at once. At 80% the owner and managers hear once, and once more at the cap. Past the cap, texts that can
  wait aren't sent: the message is in the member's inbox and goes by email where they have one. Sign-in and
  confirm-number codes and the HELP and START answers carriers require keep going up to twice the cap (at
  least 100 segments), so nobody is locked out; past that, phone sign-in says to use email. A new month
  starts fresh, and raising the cap lets texts go again at once and closes the cap's alert on Today.
  Settings shows this month and the eleven before it; `kumi doctor` and `/health/deep` show the month too.
- A message's preview of who it reaches names only people it will reach (club news never names someone left
  out for having said no). Creating an Americano (or another format) says so in its preview.

**Signing in and roles**
- Signing in, or joining, by a code texted to a US or Canadian mobile number, when the club texts: "Use my
  mobile number instead" on the sign-in page. A new number joins with a name and language, and no email is
  needed; the app then asks (never requires) for one, confirmed by a code, for receipts by email and to sign
  in if the phone is lost. A number belongs to one account. The answer is the same whether or not a number
  has an account; codes live 10 minutes, take five tries, and count with the profile's number codes (three a
  number and 30 for the club an hour, plus the bot check). A sign-in code needs no yes to texts: it's a text
  the person asked for. Staff can sign in this way too, and still owe their second step; a junior only once
  their parents have given them a login. In practice mode the code is in the server's log, as an emailed one is.
  Connecting an assistant can sign in by texted code too ("Use my mobile number instead" on its sign-in page);
  there it only texts a number already confirmed on an account, since connecting never makes one.
- A confirmed number signs in, so adding or changing it in Profile follows the passkey rule: right after
  signing in, and with the passkey or authenticator for someone who has one. The person's email hears, with
  a link (14 days) that takes the number back and signs everyone out, and the old number is told it's no
  longer on the account. Another account's number gets the same answer as a free one, and no text.
- Every code (sign-in, an email change, a number) counts each try before comparing it, so tries made at once
  can't get past five, and a right one is used up in the same step. An assistant's sign-in code is swapped
  once; a refresh token is refreshed one at a time, and a second at the same moment ends its chain.
- Registering an assistant (anyone may) is limited to 10 an hour from one address and 16 KB, keeping only its
  name and the few fields Kumi uses; starting a passkey sign-in is limited per address too. Old codes and
  assistants never connected within a week are tidied hourly.
- Two-step sign-in for staff: a passkey (both steps by itself), or the emailed code followed by a code from
  an authenticator app. Setting one up shows a QR code and the key to type, then ten recovery codes, shown
  once and kept only as slow hashes, each good once. Owners, managers and anyone with a role the club made
  must use it (the default), or every staff role if the club says so in Settings; members can choose it
  for themselves. Until the second step is given, nothing but giving it (or signing in again, or out)
  answers; setting a first one up is open only to someone who has none. Adding a passkey or an authenticator
  for someone who already has either needs a session that used it, so a mailbox alone can't make a second
  step of its own. Wrong authenticator codes count per person, five in 15 minutes, in the apps and on an
  assistant's sign-in page together. The owner can
  start someone's second step over (a lost phone): their authenticator, recovery codes and passkeys go and
  they're signed out everywhere; `kumi reset-sign-in <email>` does it on the server for an owner who is
  locked out. Connecting an agent asks for the second step too.
- Members change their own email in Profile: a code to the new address, then the old address is told, with
  a link (good 14 days, once) that puts it back and signs everyone out, assistants too, and turns off the
  account's passkeys, authenticator app and recovery codes and a sign-in number confirmed in the 14 days
  before the change or since, so whoever changed it can't come back another way. With a passkey, the
  change needs the passkey or two steps. Adding or changing to an address another account uses answers the
  same as a free one; that address hears someone tried, and no working code is made.
  Staff change it for a member at the desk the same way, from the person's page: signed in with a passkey or
  two steps, they send the code to the new address and the member reads it out; the old address is told,
  with its link back, and the change is kept with who made it. Owners, managers and front desk (or a role the
  club made covering members) can; a staff member's email is theirs or the owner's to change.
- A weekly spending limit for a person's own assistant (Claude, ChatGPT and others, through the club's MCP
  address): chosen when they connect it, nothing unless they pick $25, $50, $100 or $200. It counts what they
  themselves pay for what the assistant books this week (from Monday, the club's clock), less refunds of
  those; over it, the preview stops and says to do it in the app, and it's checked again on confirming, so
  two previews can't both squeeze in. Profile, Assistants shows each one's week, changes its limit (up to
  $500) or disconnects it, which ends its tokens at once. The owner and managers see a member's assistants on
  their page and can disconnect one there. Staff working for the club through an assistant
  aren't limited. The assistant's "whoami" says what's left.
  Also counted: one more person on a family plan (charged to the plan's payer), a membership resumed (its
  next period), a court or lesson shared "pay my part" (in full until the others pay), and anything the
  assistant books for a junior the person manages.
- A person's assistant reads what they read in the app: where and how to book, free courts, a court's price,
  open clinics, courses, socials and matches, their bookings and places, level and membership, the club's
  answers, and coaches' lesson times.
- The club's MCP address works on the members' address too (`https://<members' address>/mcp`), and Profile,
  Assistants shows it with how to connect one. Each address names itself as the resource, as assistants
  such as Claude check when connecting.
- An assistant can't raise its own weekly limit, delete the account or change how the person signs in (passkeys, the authenticator app, recovery codes); those are done in the app. An
  assistant can disconnect itself but no other. A preview an assistant made can't be applied by anyone once
  it's disconnected. Staff disconnecting a member's assistant see whose account it's from, not "for you".
- What an assistant spends counts what's really charged or on the person's hook. A court shared "pay my
  part" counts in full until the others pay (what they don't pay goes on the organiser's card at the
  deadline), and the preview says so: "It counts $60.00 against your assistant's weekly limit until the
  others pay". Each share paid by someone else comes off. A hold that lapses unpaid, a payment called off or a
  place given up counts nothing; a preview never confirmed never counted. An open match still counts only the
  person's own place, since its host never pays for empty ones.
- More stays in the app, never through an assistant: accepting a waiver, moving one's own level, downloading
  one's data, the family card and saved cards, a parent's say over their children (a junior's login and rules,
  a charge past them, inviting or accepting a second parent, leaving the family or taking a junior out of it),
  saying yes to texts or club news (an assistant can still turn them off), and
  every change that needs a strong sign-in (club settings, roles, the vault, payment account), whatever the
  person signed in with. They're left off the assistant's tool list and refused if called.
- A short tool list for assistants, which they read on every turn: descriptions are a line each, and the
  list leaves out what only checking needs (the long patterns for ids and times, the widest number limits);
  every argument is still checked in full when a tool is called. Tools only Kumi's own code calls aren't
  listed.
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
  staff authenticators, the push signing key and the vault. Production won't start without it.
  `kumi rotate-key` moves
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
  the check starts failing, the owner and managers are told once, and once more when it works again (its alert
  closes by itself). `kumi restore` restores a local or
  offsite backup, and keeps the server's own record of its backups as it was (so doctor doesn't go back to
  the night the backup was made). Backup files and update snapshots can be read only by the server's own user.
- A restore never leaves the club empty: `kumi restore` checks the file is a backup it can read before
  touching anything, keeps a copy of the database as it is (`kumi-<time>-before-restore.dump`), and puts that
  copy back if the restore fails. Only if that fails too does the server stay stopped, with the copy named. The
  monthly restore test refuses a scratch database that is the live one.
- Old offsite copies can be left to the storage's own rules (`KUMI_OFFSITE_PRUNE=0`): then Kumi never deletes
  offsite, and the key on the server needs no right to delete, so whoever takes the server can't wipe the
  offsite copies too. The offsite guide says how on R2 (lifecycle and bucket lock rules) and B2 (lifecycle
  rules and a key without delete); doctor says which way the server works.
- The server watches three more things the same way, telling the owner and managers once when one starts
  failing and once when it works again: texts (more than a fifth of at least 5 in a day not getting through), ask
  the club's model (more than a fifth of at least 5 questions in a day with no decision), and, once Twilio has
  approved the club's texting number, the number itself (approval withdrawn, the number gone from the account,
  or Twilio refusing texts because of it, checked hourly).
- Backups run at 3:17 at night on the club's clock, and the restore test on the 1st at 4:17, whatever the
  server's clock is (Docker's is UTC). The timer, or Docker's backup service, checks every hour; a server
  that was off at 3:17 catches up at its next check. In Docker, doctor's hints name the backup service and
  Docker's own guide.
- Every backup keeps its own file, named by the club's date and time (`kumi-2026-11-30T0317.dump`, and its
  offsite copy `daily/kumi-2026-11-30T0317.dump.enc`), so a backup run by hand never replaces the night's,
  here or offsite. The monthly offsite copy is the first good backup of the club's month and is never replaced.
- Cancelling some dates of a course brings a place not paid for yet down to the dates left (its price and
  what's owed), the way a paid place gets those dates' share back; a card form already opened for the old
  amount is called off and a new one asked.
- Ask the club's answer email waits 5 minutes and isn't sent when the member already saw the answer in the
  app (their question opened after it, or the inbox copy read).
- `/health` and `kumi doctor` name the commit installed, on a fresh Docker install too.
- Two addresses: the staff app's (`KUMI_PUBLIC_URL`) and the members' (`KUMI_MEMBER_URL`, which the
  install sets; without it, the staff address without its `staff.`). `kumi doctor` checks both answer.
- `/health/deep` (on the server itself, or for an owner or manager): the database, the outbox, the last
  backup, offsite copy and restore test, and disk space. `/health` names the release's commit.
- English and US Spanish throughout. Security: rate limits, no cross-site changes, strict headers,
  two-step sign-in for staff, bot protection.
- On the one-server install, everything in `/opt/kumi` is root's: the kumi user builds each release, then
  it becomes root's before it runs, so nothing running as kumi (the server, or a package's install step) can
  change what `sudo kumi ...` runs later. `sudo kumi rollback` and `sudo kumi releases` use root's own copy of
  `release.sh`. Caddy reads the apps like anyone else and isn't in the kumi group, so it can't read the
  settings file.
- In Docker, the server connects to the database as `kumi_app`, which owns the club's database and nothing
  more, not as the database's superuser. Behind Docker's Caddy, sign-in limits and the bot check count each
  visitor (`KUMI_TRUST_PROXY`, set by `compose.yaml`), not the proxy as one.
- Live (out of practice mode) without email, the server won't start: sign-in codes would only go to its log.
- A person's AI assistant connecting with a published identity: the server fetches it only from a public
  address, at most 64 KB, within 5 seconds, and saves it once someone allows it; the consent page is limited
  per address.
- Every spreadsheet Kumi hands out keeps names as text, so one that looks like a formula never runs.
- Light apps: each app downloads only its own wording, in the person's language. The staff app's first
  screen carries only the courts day and a coach's schedule; every other page loads when opened, and the
  pages in a person's menu are fetched quietly once their first page is up, so both open quickly on a phone.

**When updating:** nothing; this is the first release. A server set up from a pre-release build is moved
over by its next update: on the one-server install, `/opt/kumi` and its releases become root's, the kumi
user gets `/var/lib/kumi` as its own folder, and Caddy leaves the kumi group (Caddy restarts, a few seconds);
in Docker, `update.sh` moves the database to `kumi_app` once, with the server stopped for a minute, and
warns if `.env` can be read by others (`chmod 600 .env`).
