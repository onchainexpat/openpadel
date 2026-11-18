# Moving a club from CourtReserve (or Playbypoint)

For the club's agent, and for staff doing it themselves: bringing members, memberships, club credit, upcoming
bookings and event sign-ups over from CourtReserve's reports, one step at a time, each previewed before anything
changes. Playbypoint works the same way from its own reports ([below](#playbypoint)). The guided move-in's five steps
([moving-in.md](moving-in.md)) wrap around this: choose CourtReserve on Connect, bring the files in here, then the
practice run compares the files with what came over.

openPadel never signs in to CourtReserve and never writes to it. The owner exports the reports and hands over the
files; whatever has to change in CourtReserve (closing bookings, stopping renewals, zeroing credit) the staff change
there themselves.

## What the agent asks the owner for

Ask the owner to export these, each as Excel (CourtReserve's reports export to Excel) or CSV, and to save them where
the agent can read them on the server, or to choose them in the staff app (Settings, Moving in, Connect, "Bring the
files in from CourtReserve"):

1. **Members.** In CourtReserve: Reports, Members. Under Setup Report Output tick Member #, Email, Phone, Membership,
   Membership Start Date, Membership End Date (or Next Payment Date), Account Credit and the marketing email status.
   Run Report, then Export to Excel. This one file brings the members, their memberships and their club credit.
2. **Memberships, if the members file doesn't have their dates.** Reports, Membership Report (current memberships,
   with start, end and next payment dates), Run Report, Export to Excel.
3. **Upcoming bookings.** Reports, Reservations, Custom dates from today to the last booking ahead, all courts and
   reservation types. Run Report, Export to Excel.
4. **Event sign-ups.** Reports, Events, Registrant Detail, for the events still to come. Run Report, Export to Excel.
   Set each event up here as a program first (Programs), with its dates: the sign-ups go into those.

Card details never move: members add a card here the first time they pay. Packages (punch cards) don't come over
yet: CourtReserve's Packages report exists, but neither its columns nor a per-member packages list is documented, so
set them up here as passes. What was paid in CourtReserve stays there, and so does any refund of it.

## From the command line

On the server, as the owner, each a preview unless `--apply`:

```
openpadel move-in courtreserve --members members.xlsx --bookings reservations.xlsx --programs registrants.xlsx \
  --map "Gold Monthly=Gold" --map "Junior Annual=skip" --court "Court 9=Court 2" --event "Tuesday Clinic=Clinic"
```

- Each file is read by the server first (`move.upload`): the preview says how many lines it can use, which column it
  read as what, and every line it couldn't use, with why. Then each step previews, in order: members, memberships
  (`--memberships <file>`, else the members file), club credit (`--credit <file>`, else the members file), upcoming
  bookings, event sign-ups.
- `--map` gives the plan here for each membership there (by its name or id here, or `skip`); `--court` the court here
  for a court there whose name isn't the same; `--event` the program here for each event. A name with no choice is
  listed in the preview.
- `--take-back` takes back credit that's less in the newer file than what came over before (see below).
- `--json` gives each step's preview words, for the agent to show the owner. Show them, and run it again with
  `--apply` only on the owner's say-so.

These steps aren't offered through the club's `/mcp` door or `openpadel login`: like a members' import and the
Playtomic move, rows an assistant typed could make credit from nothing, so they're the staff app's or the server's.
The door's `moving_in` read (`openpadel moving-in --json`) shows the files read and what came over.

## Each step

**Members** (`move.members`). Each line is matched to someone here by their CourtReserve member number (kept from
the first import), else their email. New people become members; anyone already here keeps their name and email and
gets only what's new: a phone when they have none, their member number, and a yes to club news when the file says
yes and they've never answered here. A yes counts only from a column that says someone opted in to marketing email;
an "Unsubscribe from marketing emails" column is never read, since a no there isn't a yes. A line with no email or
member number, or a bad email, is listed and left. The same person on two lines counts once. Nobody is emailed.
Undo archives the people it added.

**Memberships** (`move.memberships`; the owner's, a manager asks). Choose the plan here for each membership there.
For each member, the one running longest carries over, paid through its date there: the end date, or the day before
the next payment. Nothing is charged now. On a plan members join in the app it renews here from that day on a card
they add (they're reminded a week before; without a card it ends that day); on a desk plan the next period is paid at
the desk. The preview leaves out, by name, anyone who holds a membership here already, one with no date, and a plan
that's full, and counts those whose memberships have all ended. Stop them renewing in CourtReserve before their dates.
Undo ends them.

**Club credit** (`move.credit`; the owner's, a manager asks). The Account Credit column becomes club credit here:
money the club owes the member, in the books against the "brought in" account, never a payment or revenue (the same
as Playtomic's wallets). One total per member, so a newer file moves only the difference. Less in a newer file is
left as it is unless staff choose Take back, and then only what came over that they still hold here. A negative
amount is what they owe there and is never brought (settle it there); two lines with different amounts, an amount
that can't be read, another currency or more than $10,000 for one person (sized for the club's currency) are listed
and left. Zero the balances in CourtReserve in the same hour, so nobody spends the same money twice. It can't be
undone as such: read a corrected file and run it again, with Take back if it's less.

**Upcoming bookings** (`move.bookings`). Each reservation still to come becomes a booking here on the court of the same
name (or the one chosen), at the same time on that court's clock, with its players: who booked as the organiser
(matched by number, email or a name only one member here has, which the preview says), the others as members or
guests by name. Each takes its court time like any booking: the courts are locked in id order and the database
refuses two things on one court at once, so a reservation that clashes with something here is listed and left.
Money paid there stays there: nothing is owed here, and cancelling one here gives nothing back (a refund, if any, is
made in CourtReserve). Someone who booked and isn't a member here, a court with no match, a past reservation and one
brought before are listed or counted. Nobody is told. Undo cancels them and frees the courts.

**Event sign-ups** (`move.programs`). Each event there is mapped to a program here. A sign-up becomes a place: in the
session that day (at that time, if there are two) for a program signed up to per session, or in the whole program
while it has a date to come. Each place is marked paid in CourtReserve, so nothing is owed or refunded here. Someone
who isn't a member here, a day with no session, a session that's passed and a full program are listed and left; a
waitlisted, cancelled or withdrawn line isn't a place. Undo takes the places back.

## The columns read

CourtReserve doesn't publish its exports' columns. openPadel reads them by the names CourtReserve documents in its
member import template, its Members, Reservations and Event Registrant Detail reports and its API, ignoring case,
spaces, punctuation and accents, and starting at the first line that names one (a report's title lines are skipped).
**These haven't been checked against a real CourtReserve export yet:** the upload's preview lists the columns read,
so look at it and at the lines left out before going on, and rename a column in the file if it isn't picked up.

| What | Column names read |
|---|---|
| Who | First Name and Last Name (or Name, Member Name, Player), Email, Member # (or Member Number, Member ID) |
| Phone, club news | Phone Number, Cell Phone, Mobile; a yes in Email Opted In, Marketing Email Opt In, Marketing Email Status (Subscribed), Marketing Consent |
| Membership | Membership Name, Membership, Membership Type, Current Membership, Plan; Membership Status or Status |
| Its dates | Membership Start Date, Start Date; Paid Through, Membership End Date, End Date, Expiration Date; else Membership Next Payment Date, less a day |
| Club credit | Account Credit, Credit Balance, Credit, Club Credits, Wallet Balance (not Balance, Amount Due, or Balance Forwards or Balance Credits, which can be what's owed) |
| Bookings | Courts or Court; Date with Start Time and End Time (or Start and End with the day in them, or Duration); Players (names, with emails if there); Organizer or Booked By; Reservation Type; Reservation # or Reservation ID; a Status that says cancelled is left out |
| Sign-ups | Event Name, Event or Program; Event Date or Session Date; Start Time; the person's columns as above; Registration Status (waitlist, cancelled or withdrawn are left out) |

A day reads as 2026-11-20, 11/20/2026 (the month first unless the club writes dates with the day first), Nov 20,
2026, or the number Excel keeps a date as; a time as 6:00 PM or 18:00.

### CourtReserve's API

CourtReserve documents an API (api.courtreserve.com, Basic authentication with a key the club makes under Settings,
Additional Features, Integrations, API Access; on its higher plans). It has members with their marketing consent,
membership reports, reservations and event registrations, but no account-credit balance or packages per member.
openPadel doesn't read it yet: the files work on every plan, and credit needs the Members report anyway. A reader
that takes the club's key from the vault and feeds the same steps is the next piece, if clubs ask for it.

## Playbypoint

Playbypoint has no API a club can use for this (it offers webhooks for new payments and check-ins only), so its
reports come over as files, the same way. Choose Playbypoint on Connect, then "Bring the files in from Playbypoint",
or on the server `openpadel move-in playbypoint --members memberships.csv --bookings bookings.csv --programs attendance.csv`.
Its Reporting area exports each report as CSV with the columns shown (show a hidden column first where it says so):

1. **Members, memberships and credit.** Reports, Reporting, Memberships: show the Email and Paid Through columns, then
   Export. For members with no membership, Reports, Reporting, All Players too (show Phone), as a second people file.
   Credit: a report with each player's wallet balance or club credits, if the club's Club Credits report lists them;
   otherwise give it by hand from each player's page.
2. **Upcoming bookings.** Reports, Reporting, Booking Details, Timing: Upcoming, then Export.
3. **Program sign-ups.** Reports, Reporting, Program Attendance, the sessions still to come (show Email), then Export.

| What | Column names read |
|---|---|
| Who | Player or Member (the person's name), Email, Phone |
| Membership | Plan, Status (Active, Trial, Upcoming carry over; Expired, Paused don't; Cancelling carries over and ends on its date), Joined, Paid Through, else Current Billing Period End |
| Club credit | Wallet balance, Club credits, Credits |
| Bookings | Court, Start and End (a day and time each), Players, Type |
| Sign-ups | Program, Session Date, Start Time, Player, Email, Status |

**These haven't been checked against a real Playbypoint export yet**, the same as its users list. A level (NPRP) still
comes from the users list through Customers, Import ([moving-in.md](moving-in.md#playbypoints-list)). Packages and
booking passes don't come over: Playbypoint documents no export of them.

## Sources

Read 18 Nov 2026; the same list is in `packages/core/src/move_read.ts`.

- CourtReserve member import template: https://help.courtreserve.com/en/articles/4051118-member-list-import
- CourtReserve Members report: https://intercom.help/courtreserve/en/articles/4281605-members-report
- CourtReserve reports overview: https://intercom.help/courtreserve/en/articles/12140612-overview-courtreserve-reports
- CourtReserve Reservations report: https://intercom.help/courtreserve/en/articles/11379006-reservations-report
- CourtReserve Packages report: https://intercom.help/courtreserve/en/articles/11200046-packages-report
- CourtReserve Event Registrant Detail: https://help.courtreserve.com/en/articles/4665671-create-an-event-registrant-detail-report
- CourtReserve API: https://intercom.help/courtreserve/en/articles/12771256-understanding-the-courtreserve-api,
  https://intercom.help/courtreserve/en/articles/10414722-set-up-api-access-integration,
  https://api.courtreserve.com/swagger/docs/ORGANIZATION
- Playbypoint reports: https://help.playbypoint.com/en/articles/12288353-accessing-reports-in-playbypoint,
  https://help.playbypoint.com/en/articles/11101224-how-to-export-reports
- Playbypoint All Players: https://help.playbypoint.com/en/articles/15605028-all-players-report
- Playbypoint Memberships: https://help.playbypoint.com/en/articles/15958811-memberships-report
- Playbypoint Booking Details: https://help.playbypoint.com/en/articles/16311942-booking-details-report
- Playbypoint Program Attendance: https://help.playbypoint.com/en/articles/15811374-program-attendance-report
- Playbypoint club credits and wallet: https://help.playbypoint.com/en/articles/11725341-how-to-add-club-credits-to-a-player
- Playbypoint webhooks: https://help.playbypoint.com/en/articles/12204677-guide-to-real-time-notifications-with-playbypoint-webhooks
