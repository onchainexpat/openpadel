# Moving in, step by step

The staff app guides a club's move from the system it runs on today, in five steps: **Connect the old system,
Review, Practice run, Switch-over, Wrap up** (Settings, "Moving in, step by step", at `/settings/moving-in`; the
owner and managers). The guide ties together the pages that do the work, and keeps where the club is: its source,
its step, when it plans to switch over, the items staff say are done, and whether the owner called the move
finished. That state is the club's data, so it changes only through previewed changes (`move.*`), each in Changes
with an undo.

The guide never writes to the old system, sends nobody anything and moves no money. Each step's real work stays where
it was: Customers' import, the Playtomic page, and Moving in (wallets and memberships). For the Playtomic details
(the mirror, its stages, the take-over), see [moving-from-playtomic.md](moving-from-playtomic.md); for wallets and
memberships, [playtomic-wallets-and-memberships.md](playtomic-wallets-and-memberships.md).

An agent works the same steps from the command line (or the club's `/mcp` connector, where each is a preview and a
confirm): `openpadel moving-in` reads where the club is, and `openpadel move ...` changes it. Every change previews
first; show the person the preview's words and confirm only on their say-so.

| Step | In the staff app | From the command line |
|---|---|---|
| Where the club comes from | Connect: Playtomic, CourtReserve, Playbypoint or Spreadsheets | `openpadel move source --source courtreserve` |
| CourtReserve's or Playbypoint's files, step by step | Connect, "Bring the files in" | `openpadel move-in courtreserve --members members.xlsx [--apply]` (on the server) |
| Go to a step (forward or back) | The buttons under each step | `openpadel move step --step review` |
| When to switch over | Switch-over: date and time | `openpadel move switch-at --at "2026-11-17 06:00"` |
| An item is done (or not) | The checkboxes in Switch-over and Wrap up | `openpadel move check --item close_bookings --done` |
| Finish the move | Wrap up: Finish the move (a manager asks the owner) | `openpadel move finish` |
| Where the club is, and the practice run's comparison | The page itself | `openpadel moving-in --json` |

Going on to a step never waits on the one before: the preview says how many items earlier steps still have open,
and the staff decide. Going back to any step opens a finished move again.

## 1. Connect the old system

Choose where the club runs today. The step says what comes across by itself, what needs a file, and what never moves.

- **Playtomic:** the Third Party API (Champion and Master plans) copies bookings on linked courts and keeps an archive;
  the owner adds its three keys (`OPENPADEL_PLAYTOMIC_CLIENT_ID`, `OPENPADEL_PLAYTOMIC_SECRET`, `OPENPADEL_PLAYTOMIC_TENANT_ID`) to
  `/etc/kumi/kumi.env` themselves ([accounts/playtomic.md](accounts/playtomic.md)); the step shows whether they're on
  the server and how the last copy went, never their values. The customer export brings the members in
  ([README.md, step 5b](README.md#step-5b-members)).
- **CourtReserve:** there's no connection to CourtReserve; its reports come over as files the owner exports (Members,
  Reservations, Event Registrant Detail), each read by the server and then brought in step by step, each previewed:
  members, memberships, club credit, upcoming bookings and event sign-ups. Connect, "Bring the files in from
  CourtReserve" (`/settings/moving-in/courtreserve`), or `openpadel move-in courtreserve --members members.xlsx ...` on
  the server. What to ask the owner to export, click by click, and every rule: [moving-from-courtreserve.md](moving-from-courtreserve.md).
- **Playbypoint:** there's no connection to Playbypoint either. Its reports (Memberships, All Players, Booking
  Details, Program Attendance) come over the same way: "Bring the files in from Playbypoint", or
  `openpadel move-in playbypoint ...` ([moving-from-courtreserve.md, Playbypoint](moving-from-courtreserve.md#playbypoint)).
  Its users list still brings levels (NPRP) in: Customers, Import, with "The file is from: Playbypoint", or
  `openpadel import members users.csv --from playbypoint` on the server. See [Playbypoint's list](#playbypoints-list).
- **Spreadsheets:** any CSV or Excel file with the members (step 5b).

## 2. Review

What has come across so far, each with a link to where it's done: members brought in by an import or a Playtomic
link, provisional levels from another app, and for Playtomic the courts linked (and any not linked), its players read,
the credit brought over and the memberships carried over. Card details never move from any system.

## 3. Practice run

Keep practice mode on (`OPENPADEL_PRACTICE=1`, [README.md, step 8](README.md#step-8-practice)): email and texts go only to
the test addresses while staff try bookings, refunds and changes, and players stay on the old system. The step says
whether it's on.

"Does everything match?" sets the old records beside what came over, read live each time the page opens or "Check
now" is pressed, in counts and totals, naming nobody:

| Row | The old system's side | Here |
|---|---|---|
| Members | Playtomic's players as last read, or the latest customer export | those of them who are members here (by Playtomic id, else email) |
| Upcoming bookings on linked courts | Playtomic's, not cancelled | held here, or taken over |
| Memberships | players with a benefit | memberships carried over |
| Credit | the wallets' total, in the club's currency | the credit brought over |

The source is the one the last credit run used, else Playtomic's players, else the latest upload. Once the Playtomic
wallets are at zero, Playtomic's credit reads lower than what came over, as expected. The day-by-day differences
between Playtomic and openPadel stay on the Playtomic page; the step counts this week's. From CourtReserve or
Playbypoint, the old side is the latest file of each kind: the people in it (and how many of them are here), their
memberships still running, their credit, and the upcoming bookings, beside what came over. From spreadsheets, only the
members here are counted (there's nothing of the old system's to read).

## 4. Switch-over

A time for it (a quiet hour; nothing happens by itself then), and the list done in one sitting. openPadel ticks
what it can see for itself:

- the upcoming Playtomic player bookings are all taken over (Playtomic);
- the Playtomic wallets are said to be at zero, once credit was brought over (Playtomic);
- "Members book courts in the app" is on (Settings);
- practice mode is off on the server (only with the owner's say-so: [README.md, step 9](README.md#step-9-go-live)).

The staff tick the rest, which happens in the old system or out in the world: close new bookings there, stop its
membership renewals, let classes and programs already sold there run out, and the club's own announcement.
openPadel sends members nothing at the switch-over: each member sees a welcome with their bookings, level and credit
the first time they sign in.

## 5. Wrap up

How many of the members who came over have signed in, the bookings made here since the switch-over time, and the
credit that came across. openPadel ticks, for Playtomic: the keys are gone from the server's settings file, and the
last booking made in Playtomic has been played (leave the connection on until then). The staff tick: download the old
system's payments history and customer list one last time, cancel its plan (after its notice period), and point the
website's Book button, the Google Business Profile and the social media bios at the new app. Then the owner finishes
the move (a manager asks). The Playtomic archive stays, read only, on each member's page.

## Playbypoint's list

Playbypoint doesn't publish its export's columns, and openPadel hasn't been checked against a real Playbypoint export
yet. Its list is read by the names it most likely uses, ignoring case, spaces and accents, and the preview shows how
many people are ready and every line it couldn't use: check those before you confirm, and rename a column if it isn't
picked up.

| What | Column names read |
|---|---|
| Name | Name, Full name, or First Name and Last Name |
| Email, Phone, Club news | as in [step 5b](README.md#step-5b-members), and also Cell phone, Mobile number, Marketing opt in, Email opt in |
| Level (NPRP, 1 to 7) | Playbypoint level, PBP level, NPRP, NPRP level, NPRP rating, Playbypoint rating, Skill level, Level, Rating, Nivel |

A DUPR column is another scale and is never read. The level becomes a provisional start, as Playbypoint's (NPRP is
openPadel's own 0 to 7 range), never a floor. Memberships, credit, upcoming bookings and program sign-ups come from
Playbypoint's other reports, step by step: [moving-from-courtreserve.md, Playbypoint](moving-from-courtreserve.md#playbypoint).
