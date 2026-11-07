# openpadel: every club command

Made by `node tools/gen_cli_reference.ts` from the actions and reads the assistant door offers; don't edit it by hand
(`apps/server/test/cli_reference.test.ts` fails when it's out of date). How to sign in, the flags every command
takes and the exit codes are in [README.md](README.md).

Who may: with the club's built-in roles as they come (Settings, Roles changes them). Whatever the role, a command is
only ever offered to someone allowed it, never does more than the person could in the app, and some changes are
only ever made in the app (accepting a waiver, the family card, money handed over at the desk): those aren't here.

## Reads

### openpadel booking-options

Where and how to book. The club's locations (with their ids), the lengths a court can be booked for, how many days ahead you may book, and the deadlines for sharing the cost and cancelling.

Who may: anyone signed in, about themselves.

```
openpadel booking-options
```

### openpadel free-courts

Free courts. Each court at a location that is free on a date for a length, with every start time it's free (UTC). Use a court id and start from here in openpadel booking request.

Who may: anyone signed in, about themselves.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--location` | location: a name or an id | needed |  |
| `--date` | date YYYY-MM-DD | needed | A club date, YYYY-MM-DD |
| `--minutes` | whole number | needed | 60, 90 or 120, as openpadel booking-options lists |

```
openpadel free-courts --location Main --date 2026-11-20 --minutes 90
```

### openpadel court-price

What a court costs. The price of a court at a time and length for this person (their member price, if they have one), with tax.

Who may: anyone signed in, about themselves.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--court` | court: a name or an id | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed | ISO time, as openpadel free-courts gives it |
| `--minutes` | whole number | needed |  |

```
openpadel court-price --court "Court 1" --starts-at "2026-11-20 18:00" --minutes 90
```

### openpadel open-programs

Clinics, courses and socials. Clinics, courses and socials open for sign-up: dates, places left, level band and this person's price. Programs signed up date by date list each date's places.

Who may: anyone signed in, about themselves.

```
openpadel open-programs
```

### openpadel open-matches

Open matches. Open matches this person can join or ask to join: court, time, level band, places left and the price of a place.

Who may: anyone signed in, about themselves.

```
openpadel open-matches
```

### openpadel my-chats

Chats in my games. The chats in the games the person plays in (court bookings with named players, open matches, program dates), with how many messages are unread. Reading only: an assistant never posts in a chat.

Who may: anyone signed in, about themselves.

```
openpadel my-chats
```

### openpadel game-chat

A game's chat. One game's chat, as the person reads it (kind and id from openpadel my-chats). Reading only: it doesn't mark anything read, and an assistant never posts.

Who may: anyone signed in, about themselves.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--kind` | booking \| session | needed |  |
| `--id` | text | needed |  |

```
openpadel game-chat --kind booking --id ...
```

### openpadel my-places

My bookings and places. This person's court bookings, matches, lessons and program places to come, with what they owe.

Who may: anyone signed in, about themselves.

```
openpadel my-places
```

### openpadel my-competitions

My tournaments and leagues. This person's tournament and league entries: invitations to answer, their partner, their next matches (court and time), results, scores to confirm, and the group or league table. Scores go through openpadel fixture enter, openpadel result confirm or openpadel result dispute.

Who may: anyone signed in, about themselves.

```
openpadel my-competitions
```

### openpadel my-credit

My club credit. This person's club credit: what they hold and what came and went. Read only: credit is spent in the members' app, never through an assistant.

Who may: anyone signed in, about themselves.

```
openpadel my-credit
```

### openpadel my-gift-cards

My gift cards. Gift cards this person bought or redeemed, with whether each is ready to give, used or voided (never their codes: those are in the members' app, where redeeming is too).

Who may: anyone signed in, about themselves.

```
openpadel my-gift-cards
```

### openpadel my-passes

My passes. This person's passes (uses left, what each covers, any date to use it by) and the passes the club sells. Read only: a pass is spent in the members' app, never through an assistant; buying one is pass.buy.

Who may: anyone signed in, about themselves.

```
openpadel my-passes
```

### openpadel my-level

My level. This person's level, how it moved and why, and their games.

Who may: anyone signed in, about themselves.

```
openpadel my-level
```

### openpadel my-membership

My membership. This person's membership: the plan, its perks and the next payment.

Who may: anyone signed in, about themselves.

```
openpadel my-membership
```

### openpadel club-answers

The club's answers. The club's own answers to common questions (hours, parking, prices, rules), word for word. Quote them; for anything else, openpadel question ask asks the staff.

Who may: anyone signed in, about themselves.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--q` | text |  | Words to search for; empty lists them all |

```
openpadel club-answers
```

### openpadel lesson-coaches

Coaches for lessons. The coaches who give private lessons, with their ids and rates by length.

Who may: anyone signed in, about themselves.

```
openpadel lesson-coaches
```

### openpadel lesson-times

A coach's lesson times. When a coach gives a lesson of a length on a date, with a court free. Use a time from here in openpadel lesson request.

Who may: anyone signed in, about themselves.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--coach` | coach: a name or an id | needed |  |
| `--date` | date YYYY-MM-DD | needed | A club date, YYYY-MM-DD |
| `--minutes` | whole number | needed |  |

```
openpadel lesson-times --coach "Ana Ruiz" --date 2026-11-20 --minutes 90
```

### openpadel people

People. The club's people whose name matches, with their ids, roles and tags (emails shortened). Use an id from here wherever a change asks for a person.

Who may: staff (each sees what their staff screens show).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--q` | text |  | A name (or part of one) to search for; empty lists the first ones by name. Emails and phone numbers aren't searched here |
| `--role` | text |  | staff, or one role's key: owner, manager, front_desk, coach, accountant |
| `--limit` | whole number |  |  |

```
openpadel people
```

### openpadel person-page

A person's page. One person's page, as the staff app shows it: bookings, places, membership, family, what they owe and what's owed back (contact details shortened).

Who may: staff (each sees what their staff screens show).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |

```
openpadel person-page --person "Maria Lopez"
```

### openpadel locations

Locations. The club's locations, with their ids and time zones.

Who may: staff (each sees what their staff screens show).

```
openpadel locations
```

### openpadel courts

Courts. The club's courts (or one location's), with their ids, location and kind.

Who may: staff (each sees what their staff screens show).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--location` | location: a name or an id |  |  |

```
openpadel courts
```

### openpadel coaches

Coaches. The coaches, with their ids, profiles, lesson hours and time off (a coach sees only their own).

Who may: staff (each sees what their staff screens show).

```
openpadel coaches
```

### openpadel programs

Programs. The club's clinics, courses, socials, leagues and tournaments (the latest 100), with their ids, places booked and waitlisted, and first date.

Who may: staff (each sees what their staff screens show).

```
openpadel programs
```

### openpadel program-page

A program. One program: its dates (with their ids, courts and coach), roster and waitlist.

Who may: staff (each sees what their staff screens show).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |

```
openpadel program-page --program "Tuesday drills"
```

### openpadel day

The day at a location. A location's courts for a day (today unless a date is given): each booking, block and program date, who's playing and what's owed, as the desk's Courts page shows it.

Who may: staff (each sees what their staff screens show).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--location` | location: a name or an id | needed |  |
| `--date` | date YYYY-MM-DD |  | A club date, YYYY-MM-DD |

```
openpadel day --location Main
```

### openpadel alerts

Alerts. What needs someone at the club now: places left empty at the last minute, questions waiting, money owed, programs short of their minimum, refunds that failed.

Who may: staff (each sees what their staff screens show).

```
openpadel alerts
```

### openpadel reports

Reports. A location's money and use, day by day, between two dates (both included), as the Reports page shows it.

Who may: staff (each sees what their staff screens show).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--location` | location: a name or an id | needed |  |
| `--from` | date YYYY-MM-DD | needed | A club date, YYYY-MM-DD |
| `--to` | date YYYY-MM-DD | needed | A club date, YYYY-MM-DD |

```
openpadel reports --location Main --from 2026-11-20 --to 2026-11-20
```

### openpadel memberships

Memberships. The membership plans, how many hold each, and the members on them (emails shortened).

Who may: staff (each sees what their staff screens show).

```
openpadel memberships
```

### openpadel questions

Members' questions. Members' questions to the club: waiting for an answer (the default), answered or closed.

Who may: staff (each sees what their staff screens show).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--view` | waiting \| answered \| closed |  |  |

```
openpadel questions
```

## Changes

Each one previews first (exit code 10) and changes nothing until `openpadel confirm <run_id>`, or the same command with `--yes`.

### action

#### openpadel action undo

Undo a change. Who may: owner, manager.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--run-id` | id | needed |  |

```
openpadel action undo --run-id <id>
```

### alert

#### openpadel alert handle

Mark a staff alert handled. Who may: owner, manager, front desk.

Its preview reads: "Mark this as handled for everyone: {subject}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--event-id` | text | needed |  |
| `--kind` | match_late_cancel_staff \| question_unanswered_staff \| booking_balance_due_staff \| program_min_short \| program_min_cancelled_staff \| refund_failed \| ops_failed_staff \| ops_restore_staff \| membership_payment_failed_staff \| membership_ended_unpaid_staff \| usage_reached_staff \| usage_paused_staff \| chat_reported_staff | needed |  |

```
openpadel alert handle --event-id ... --kind match_late_cancel_staff
```

### assistant

#### openpadel assistant disconnect

Disconnect an assistant. Who may: owner, manager, member (their own).

Its preview reads: "Disconnect {client}. It can't see or change anything for you until you connect it again."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--grant-id` | id | needed |  |

```
openpadel assistant disconnect --grant-id <id>
```

### attendance

#### openpadel attendance mark

Mark attendance. Who may: owner, manager, front desk, coach (their own).

Its preview reads: "Attendance at {what}, {when}: {marks}.{told}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--session-id` | id |  |  |
| `--booking-id` | id |  |  |
| `--marks` | JSON list | needed |  |

```
openpadel attendance mark --marks '[...]'
```

### booking

#### openpadel booking add-player

Add a player. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Add {person} as a player on your booking on {court}, {when}. There's nothing for them to pay. They're told, and they can enter the score after the game."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel booking add-player --booking-id <id> --person "Maria Lopez"
```

#### openpadel booking answer-ask

Answer a request to join. Who may: owner, manager, front desk, member (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--request-id` | id | needed |  |
| `--approve` | yes/no (the flag alone is yes) | needed |  |

```
openpadel booking answer-ask --request-id <id> --approve
```

#### openpadel booking ask

Ask to join a match. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Ask {host} to let you into their match on {court}, {when}. If they say yes, your place is held for {hours} while you pay {share}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--note` | text |  |  |

```
openpadel booking ask --booking-id <id> --person "Maria Lopez"
```

#### openpadel booking cancel

Cancel a booking. Who may: owner, manager, front desk, coach (their own), member (their own).

Its preview reads: "Cancel booking {code}; the court is free again."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--reason` | text |  |  |
| `--refund` | rule \| full \| none \| credit |  |  |

```
openpadel booking cancel --booking-id <id>
```

#### openpadel booking create

Book a court. Who may: owner, manager, front desk.

Its preview reads: "Book {court}, {when}, for {minutes} minutes, for {who}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--court` | court: a name or an id | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |
| `--minutes` | whole number | needed |  |
| `--person` | person: a name or an id |  |  |
| `--guest-name` | text |  |  |
| `--price-cents` | whole number (cents) |  |  |
| `--note` | text |  |  |

```
openpadel booking create --court "Court 1" --starts-at "2026-11-20 18:00" --minutes 90
```

#### openpadel booking drop-saved-place

Stop saving a place. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Stop saving a place for {friend}. It opens for anyone in the band."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-player-id` | id | needed |  |

```
openpadel booking drop-saved-place --booking-player-id <id>
```

#### openpadel booking extend

Change how long a booking runs. Who may: owner, manager, front desk.

Its preview reads: "Make booking {code} ({who}) on {court}, {when}, run {minutes} minutes instead of {old}, until {until}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--minutes` | whole number | needed | How long it runs now, from the same start: longer or shorter. |
| `--refund` | rule \| full \| none |  | What goes back when less is owed: the club's cancellation rule (the default), all of it, or nothing. |

```
openpadel booking extend --booking-id <id> --minutes 90
```

#### openpadel booking give-place

Give an empty place free. Who may: owner, manager, front desk.

Its preview reads: "Give {person}'s place in the match on {court}, {when} to {to}, free: nothing is charged. {person} gets back {total} in all ({why})."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-player-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--refund` | rule \| full \| none |  |  |

```
openpadel booking give-place --booking-player-id <id> --person "Maria Lopez"
```

#### openpadel booking join

Join a booking. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Join {organiser}'s booking: {court}, {when}. Your part is {share}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--invite-code` | text |  |  |
| `--booking-id` | id |  |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel booking join --person "Maria Lopez"
```

#### openpadel booking join-players

Join a booking as a player. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Join {booker}'s booking on {court}, {when} as a player. The court is paid for, so there's nothing to pay."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--invite-code` | text | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel booking join-players --invite-code ... --person "Maria Lopez"
```

#### openpadel booking leave

Can't make a match. Who may: owner, manager, front desk, member (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel booking leave --booking-id <id> --person "Maria Lopez"
```

#### openpadel booking mark-no-show

Mark a player who didn't come. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Mark {person} as not having come to the match on {court}, {when}. It goes on their record for 90 days, and they're told."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-player-id` | id | needed |  |

```
openpadel booking mark-no-show --booking-player-id <id>
```

#### openpadel booking move

Move a booking. Who may: owner, manager, front desk.

Its preview reads: "Move booking {code} ({who}) from {from} to {to}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--court` | court: a name or an id | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |
| `--reprice` | yes/no (the flag alone is yes) |  | Price it again at the new time and court (a court booking). Otherwise the price stays as paid. |
| `--refund` | rule \| full \| none |  | What goes back when less is owed: the club's cancellation rule (the default), all of it, or nothing. |

```
openpadel booking move --booking-id <id> --court "Court 1" --starts-at "2026-11-20 18:00"
```

#### openpadel booking offer-place

Find someone to take my place. Who may: owner, manager, front desk, member (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--to-person` | person: a name or an id |  |  |

```
openpadel booking offer-place --booking-id <id> --person "Maria Lopez"
```

#### openpadel booking refund

Refund a booking payment. Who may: owner, manager, front desk.

Its preview reads: "{amount} goes back to the card."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--payment-id` | id | needed |  |
| `--cents` | whole number | needed |  |
| `--reason` | text |  |  |

```
openpadel booking refund --booking-id <id> --payment-id <id> --cents 1
```

#### openpadel booking remove-player

Take a player off. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Take {person} off your booking on {court}, {when}. Nothing is paid or refunded, and they're told."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-player-id` | id | needed |  |

```
openpadel booking remove-player --booking-player-id <id>
```

#### openpadel booking reopen-place

Open an empty place in the app. Who may: owner, manager, front desk.

Its preview reads: "Open {person}'s place in the match on {court}, {when} in the app, for a player inside the band ({band}) to join and pay {share}. When one does, {person} gets back {total} in all ({why})."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-player-id` | id | needed |  |
| `--refund` | rule \| full \| none |  |  |

```
openpadel booking reopen-place --booking-player-id <id>
```

#### openpadel booking repeat

Book a court every week. Who may: owner, manager, front desk.

Its preview reads: "Book {pattern}, for {who}: {count} weeks, {first} to {last} ({price})."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--court` | court: a name or an id | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |
| `--minutes` | whole number | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--weeks` | whole number |  |  |
| `--until-date` | date YYYY-MM-DD |  |  |
| `--price-cents` | whole number (cents) |  |  |

```
openpadel booking repeat --court "Court 1" --starts-at "2026-11-20 18:00" --minutes 90 --person "Maria Lopez"
```

#### openpadel booking repeat-end

Cancel a weekly court from a date on. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Cancel {pattern} from {from} on: {count} booked weeks are cancelled."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--series-id` | id | needed |  |
| `--from-date` | date YYYY-MM-DD |  |  |
| `--refund` | rule \| full \| none |  |  |

```
openpadel booking repeat-end --series-id <id>
```

#### openpadel booking repeat-request

Book a court every week. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Book {pattern}: {count} weeks, {first} to {last} ({price}). You pay {now} for the first week now, and your card is saved for the rest: each later week is booked once it's within {days} of the day, and goes on that card {hours} before it starts. A week someone else has by then is left out, you'll hear, and it isn't charged. Cancel any week, or all the rest, under the club's cancel rules."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--court` | court: a name or an id | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |
| `--minutes` | whole number | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--weeks` | whole number | needed |  |

```
openpadel booking repeat-request --court "Court 1" --starts-at "2026-11-20 18:00" --minutes 90 --person "Maria Lopez" --weeks 8
```

#### openpadel booking request

Book a court. Who may: owner, manager, front desk, member (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--court` | court: a name or an id | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |
| `--minutes` | whole number | needed |  |
| `--pay` | whole \| split | needed |  |
| `--players` | whole number |  |  |
| `--person` | person: a name or an id | needed |  |
| `--open` | JSON |  |  |

```
openpadel booking request --court "Court 1" --starts-at "2026-11-20 18:00" --minutes 90 --pay whole --person "Maria Lopez"
```

#### openpadel booking request-courts

Book several courts. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Book {count} courts: {list}. {total} in all, paid now in one card payment. Each court is its own booking and can be cancelled on its own under the club's rule."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--courts` | JSON list | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel booking request-courts --courts '[...]' --person "Maria Lopez"
```

#### openpadel booking running-late

Say you're running late. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Tell the others in the match on {court}, {when} that you're running about {minutes} minutes late."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--minutes` | whole number | needed |  |

```
openpadel booking running-late --booking-id <id> --person "Maria Lopez" --minutes 90
```

#### openpadel booking save-place

Save a place for a friend. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Save a place in your match for {friend}. They pay their own {share} in the app. If it's still unpaid {hours} before, it counts as empty, and a match that isn't full then is cancelled."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel booking save-place --booking-id <id> --person "Maria Lopez"
```

#### openpadel booking set-rated

Count a game for levels. Who may: owner, manager, front desk, member (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--rated` | yes/no (the flag alone is yes) | needed |  |

```
openpadel booking set-rated --booking-id <id> --rated
```

#### openpadel booking take-place

Take someone's place in a match. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Take {name}'s place in the match on {court}, {when}: {share}, paid now. Once it's paid, the place is yours."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--code` | text | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel booking take-place --code ... --person "Maria Lopez"
```

#### openpadel booking withdraw-ask

Take back a request to join. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Take back your request to join the match on {court}, {when}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--request-id` | id | needed |  |

```
openpadel booking withdraw-ask --request-id <id>
```

#### openpadel booking withdraw-offer

Take back a place offer. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Take back the offer of your place in the match on {court}, {when}. You stay in the match."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--offer-id` | id | needed |  |

```
openpadel booking withdraw-offer --offer-id <id>
```

### broadcast

#### openpadel broadcast cancel

Call off a message. Who may: owner, manager, front desk.

Its preview reads: "Call off "{subject}", set for {when}. Nothing has gone yet."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--broadcast-id` | id | needed |  |

```
openpadel broadcast cancel --broadcast-id <id>
```

#### openpadel broadcast send

Send a message to a group. Who may: owner, manager, front desk.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--purpose` | club_news \| service | needed |  |
| `--segment-id` | id |  |  |
| `--filters` | JSON |  |  |
| `--subject-en` | text |  |  |
| `--body-en` | text |  |  |
| `--subject-es` | text |  |  |
| `--body-es` | text |  |  |
| `--send-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO |  |  |

```
openpadel broadcast send --purpose club_news
```

### coach

#### openpadel coach set-hours

Set a coach's lesson hours. Who may: owner, manager, front desk, coach (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--location` | location: a name or an id | needed |  |
| `--stretches` | JSON list | needed |  |

```
openpadel coach set-hours --person "Maria Lopez" --location Main --stretches '[...]'
```

#### openpadel coach set-photo

Change a coach's photo. Who may: owner, manager, front desk, coach (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--photo` | text | needed |  |

```
openpadel coach set-photo --person "Maria Lopez" --photo ...
```

#### openpadel coach set-profile

Save a coach profile. Who may: owner, manager, front desk, coach (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--bio` | text | needed |  |
| `--level-min` | number | needed |  |
| `--level-max` | number | needed |  |
| `--languages` | en \| es | needed |  |
| `--rates` | JSON list | needed |  |
| `--lessons` | yes/no (the flag alone is yes) | needed | Whether members can book private lessons with this coach in the app. |
| `--max-players` | whole number | needed |  |
| `--translations` | JSON |  |  |

```
openpadel coach set-profile --person "Maria Lopez" --bio ... --level-min 3.5 --level-max 8 --languages en --rates '[...]' --lessons --max-players 8
```

#### openpadel coach time-off-add

Add a coach's time off. Who may: owner, manager, front desk, coach (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--from` | date YYYY-MM-DD | needed |  |
| `--to` | date YYYY-MM-DD | needed |  |
| `--note` | text |  |  |

```
openpadel coach time-off-add --person "Maria Lopez" --from 2026-11-20 --to 2026-11-20
```

#### openpadel coach time-off-remove

Remove a coach's time off. Who may: owner, manager, front desk, coach (their own).

Its preview reads: "Remove this time off for {name}. Lessons can be booked then again."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--time-off-id` | id | needed |  |

```
openpadel coach time-off-remove --time-off-id <id>
```

### competition

#### openpadel competition draw

Make the draw. Who may: owner, manager, front desk.

Its preview reads: "The draw for {program}: {pairs} pairs, {how}. Matches are {match}; {matches} to play. Seeds: {seeds}.{left}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--format` | groups_knockout \| knockout \| league | needed |  |
| `--group-size` | number |  |  |
| `--match-format` | one_set \| pro_set \| best_of_three |  |  |
| `--legs` | number |  |  |
| `--match-minutes` | whole number |  |  |

```
openpadel competition draw --program "Tuesday drills" --format groups_knockout
```

#### openpadel competition public-names

Players' names on the public page. Who may: owner, manager, front desk.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--on` | yes/no (the flag alone is yes) | needed |  |

```
openpadel competition public-names --program "Tuesday drills" --on
```

#### openpadel competition schedule

Suggest times for the matches. Who may: owner, manager, front desk.

Its preview reads: "Put {count} matches on {courts}, from {first} to {last}. Players are told their court and time.{unplaced}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |

```
openpadel competition schedule --program "Tuesday drills"
```

### connector

#### openpadel connector map-court

Link a Playtomic court. Who may: owner, manager.

Its preview reads: "Playtomic's {resource} is {product}'s {court}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--resource-id` | text | needed |  |
| `--resource-name` | text |  |  |
| `--court` | court: a name or an id | needed |  |

```
openpadel connector map-court --resource-id ... --court "Court 1"
```

### consent

#### openpadel consent club-news

Club news by email. Who may: owner, manager, member (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--granted` | yes/no (the flag alone is yes) | needed |  |

```
openpadel consent club-news --person "Maria Lopez" --granted
```

#### openpadel consent texts

Texts. Who may: owner, manager, member (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--granted` | yes/no (the flag alone is yes) | needed |  |
| `--form-version` | text |  |  |
| `--app` | member \| staff |  |  |
| `--device` | text |  |  |

```
openpadel consent texts --person "Maria Lopez" --granted
```

### court

#### openpadel court archive

Archive a court. Who may: owner, manager.

Its preview reads: "Archive {name}. It won't be offered for new dates; past ones keep it."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--court` | court: a name or an id | needed |  |

```
openpadel court archive --court "Court 1"
```

#### openpadel court block

Block courts. Who may: owner, manager, front desk.

Its preview reads: "Block {courts} from {from} to {to} ({reason})."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--courts` | courts: names or ids, with commas | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |
| `--ends-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |
| `--reason` | maintenance \| fault \| resurfacing \| event \| other | needed |  |
| `--note` | text |  |  |

```
openpadel court block --courts "Court 1,Court 2" --starts-at "2026-11-20 18:00" --ends-at "2026-11-20 18:00" --reason maintenance
```

#### openpadel court block-repeat

Block courts every week. Who may: owner, manager, front desk.

Its preview reads: "Block {pattern}, {span}: {count} dates."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--courts` | courts: names or ids, with commas | needed |  |
| `--weekdays` | integers, with commas | needed |  |
| `--starts` | text | needed |  |
| `--ends` | text | needed |  |
| `--from-date` | date YYYY-MM-DD | needed |  |
| `--until-date` | date YYYY-MM-DD |  |  |
| `--reason` | maintenance \| fault \| resurfacing \| event \| other | needed |  |
| `--note` | text |  |  |
| `--in-the-way` | keep \| cancel |  |  |
| `--refund` | rule \| full \| none |  |  |

```
openpadel court block-repeat --courts "Court 1,Court 2" --weekdays 1,3 --starts ... --ends ... --from-date 2026-11-20 --reason maintenance
```

#### openpadel court block-repeat-edit

Change a repeating block. Who may: owner, manager, front desk.

Its preview reads: "Change the repeating block {which}: {pattern}, {count} dates."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--block-id` | id | needed |  |
| `--scope` | this \| following \| all | needed |  |
| `--courts` | courts: names or ids, with commas |  |  |
| `--weekdays` | integers, with commas |  |  |
| `--starts` | text |  |  |
| `--ends` | text |  |  |
| `--until-date` | date YYYY-MM-DD |  |  |
| `--reason` | maintenance \| fault \| resurfacing \| event \| other |  |  |
| `--note` | text |  |  |
| `--in-the-way` | keep \| cancel |  |  |
| `--refund` | rule \| full \| none |  |  |

```
openpadel court block-repeat-edit --block-id <id> --scope this
```

#### openpadel court block-repeat-end

End a repeating block. Who may: owner, manager, front desk.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--block-id` | id | needed |  |
| `--scope` | this \| following \| all | needed |  |

```
openpadel court block-repeat-end --block-id <id> --scope this
```

#### openpadel court create

Add a court. Who may: owner, manager.

Its preview reads: "Add {name} at {location}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--location` | location: a name or an id | needed |  |
| `--name` | text | needed |  |
| `--kind` | indoor \| covered_outdoor \| outdoor |  |  |

```
openpadel court create --location Main --name "Tuesday drills"
```

#### openpadel court hours-set

Set a court's own hours. Who may: owner, manager.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--court` | court: a name or an id | needed |  |
| `--days` | JSON list | needed |  |

```
openpadel court hours-set --court "Court 1" --days '[...]'
```

#### openpadel court unblock

Open courts again. Who may: owner, manager, front desk.

Its preview reads: "Open {courts} again."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--block-id` | id | needed |  |

```
openpadel court unblock --block-id <id>
```

#### openpadel court update

Change a court. Who may: owner, manager.

Its preview reads: "Save the changes to {name}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--court` | court: a name or an id | needed |  |
| `--name` | text |  |  |
| `--kind` | indoor \| covered_outdoor \| outdoor |  |  |
| `--bookable` | yes/no (the flag alone is yes) |  |  |
| `--sort` | whole number |  |  |

```
openpadel court update --court "Court 1"
```

### draw

#### openpadel draw generate

Make the rounds. Who may: owner, manager, front desk.

Its preview reads: "{rounds} rounds for {players} players on {courts}. Teams are {fair} on average.{sitout}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--session-id` | id | needed |  |
| `--rounds` | whole number | needed |  |
| `--points-per-game` | whole number |  |  |
| `--round-minutes` | whole number |  |  |

```
openpadel draw generate --session-id <id> --rounds 1
```

#### openpadel draw next-round

Make the next round. Who may: owner, manager, front desk.

Its preview reads: "Round {round} of {of}: {pairs}.{sitout}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--session-id` | id | needed |  |

```
openpadel draw next-round --session-id <id>
```

#### openpadel draw repair

Re-pair the rounds left. Who may: owner, manager, front desk.

Its preview reads: "Re-pair rounds {from} to {to} for the {players} players now on the roster. Rounds already played keep their scores."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--session-id` | id | needed |  |

```
openpadel draw repair --session-id <id>
```

### enrolment

#### openpadel enrolment accept-offer

Take an offered place. Who may: owner, manager, front desk, member (their own).

Its preview reads: "{person} takes the offered place in {name}{price}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--enrolment-id` | id | needed |  |

```
openpadel enrolment accept-offer --enrolment-id <id>
```

#### openpadel enrolment comp

Give a free place. Who may: owner, manager, front desk (with approval).

Its preview reads: "Give {person} a free place in {name}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--note` | text | needed |  |
| `--session-id` | id |  | The date, for a program signed up per date. |

```
openpadel enrolment comp --program "Tuesday drills" --person "Maria Lopez" --note "Rain on the outdoor courts"
```

#### openpadel enrolment join

Sign up. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Sign {person} up for {name}{price}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--session-id` | id |  | The date, for a program signed up per date. Several dates at once: enrolment.join_dates. |

```
openpadel enrolment join --program "Tuesday drills" --person "Maria Lopez"
```

#### openpadel enrolment join-dates

Sign up for dates. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Sign {person} up for {count} dates of {name}:"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--session-ids` | ids, with commas | needed | The dates (session ids) to sign up for. |

```
openpadel enrolment join-dates --program "Tuesday drills" --person "Maria Lopez" --session-ids <id>,<id>
```

#### openpadel enrolment leave

Leave. Who may: owner, manager, front desk, member (their own).

Its preview reads: "{person} leaves {name}. {refund}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--enrolment-id` | id | needed |  |

```
openpadel enrolment leave --enrolment-id <id>
```

#### openpadel enrolment remove

Remove from roster. Who may: owner, manager, front desk.

Its preview reads: "Take {person} off {name} ({reason}). {refund}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--enrolment-id` | id | needed |  |
| `--reason` | late_cancel \| no_show \| found_sub \| club \| other | needed |  |
| `--refund` | JSON |  |  |

```
openpadel enrolment remove --enrolment-id <id> --reason late_cancel
```

#### openpadel enrolment transfer

Pass a place on. Who may: owner, manager, front desk, member (their own).

Its preview reads: "{person}'s place in {name} goes to {sub}. {money}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--enrolment-id` | id | needed |  |
| `--to-person` | person: a name or an id | needed |  |
| `--pay` | sub_pays \| gift | needed |  |

```
openpadel enrolment transfer --enrolment-id <id> --to-person "Maria Lopez" --pay sub_pays
```

### entry

#### openpadel entry accept

Accept the invitation. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Play {program} with {partner}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--entry-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel entry accept --entry-id <id> --person "Maria Lopez"
```

#### openpadel entry decline

Decline the invitation. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Say no to playing {program} with {partner}. {partner} is told."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--entry-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel entry decline --entry-id <id> --person "Maria Lopez"
```

#### openpadel entry invite

Enter with a partner. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Enter {program} with {partner}. {partner} accepts from their app."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--partner` | person: a name or an id | needed |  |

```
openpadel entry invite --program "Tuesday drills" --person "Maria Lopez" --partner "Maria Lopez"
```

#### openpadel entry pair

Pair two players. Who may: owner, manager, front desk.

Its preview reads: "Pair {a} and {b} for {program}. They're both told."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--person-a` | person: a name or an id | needed |  |
| `--person-b` | person: a name or an id | needed |  |

```
openpadel entry pair --program "Tuesday drills" --person-a "Maria Lopez" --person-b "Maria Lopez"
```

#### openpadel entry withdraw

Withdraw the pair. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Withdraw {pair} from {program}. Its {count} matches still to play go to the other pairs as walkovers; results already played stand. Places in the program aren't changed: leaving it is its own step."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--entry-id` | id | needed |  |
| `--person` | person: a name or an id |  |  |

```
openpadel entry withdraw --entry-id <id>
```

### fact

#### openpadel fact create

Add a club fact. Who may: owner, manager, front desk.

Its preview reads: "Add a club fact under {topic}: "{question}". Members see it in Common questions{public}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--topic` | general \| hours \| prices \| bookings \| memberships \| programs \| lessons \| juniors \| rules \| parking \| facilities | needed |  |
| `--question-en` | text |  |  |
| `--answer-en` | text |  |  |
| `--question-es` | text |  |  |
| `--answer-es` | text |  |  |
| `--public` | yes/no (the flag alone is yes) |  |  |
| `--from-message-id` | id |  |  |

```
openpadel fact create --topic general
```

#### openpadel fact update

Change a club fact. Who may: owner, manager, front desk.

Its preview reads: "Change the club fact "{question}": {fields}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--fact-id` | id | needed |  |
| `--topic` | general \| hours \| prices \| bookings \| memberships \| programs \| lessons \| juniors \| rules \| parking \| facilities |  |  |
| `--question-en` | text |  |  |
| `--answer-en` | text |  |  |
| `--question-es` | text |  |  |
| `--answer-es` | text |  |  |
| `--public` | yes/no (the flag alone is yes) |  |  |
| `--active` | yes/no (the flag alone is yes) |  |  |

```
openpadel fact update --fact-id <id>
```

### fixture

#### openpadel fixture ask-move

Ask to move a match. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Ask the club to move your {program} match. The staff move it, and you're told the new time."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--fixture-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--note` | text | needed |  |

```
openpadel fixture ask-move --fixture-id <id> --person "Maria Lopez" --note "Rain on the outdoor courts"
```

#### openpadel fixture enter

Enter your match's score. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Your match against {opponents}: you {result} {score}. They have {hours} hours to confirm or dispute it. {counts}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--fixture-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--sets` | JSON list | needed |  |

```
openpadel fixture enter --fixture-id <id> --person "Maria Lopez" --sets '[...]'
```

#### openpadel fixture place

Put a match on a court. Who may: owner, manager, front desk.

Its preview reads: "{a} against {b} on {court}, {when}. The players are told."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--fixture-id` | id | needed |  |
| `--court` | court: a name or an id | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |

```
openpadel fixture place --fixture-id <id> --court "Court 1" --starts-at "2026-11-20 18:00"
```

#### openpadel fixture score

Enter a match's score. Who may: owner, manager, front desk.

Its preview reads: "{a} {score} {b}. It counts now.{window} {counts}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--fixture-id` | id | needed |  |
| `--sets` | JSON list | needed |  |
| `--final` | yes/no (the flag alone is yes) |  | The club's word is final: the players can't dispute it. Otherwise they can for 24 hours, as for any score. |

```
openpadel fixture score --fixture-id <id> --sets '[...]'
```

#### openpadel fixture walkover

Record a walkover. Who may: owner, manager, front desk.

Its preview reads: "{gave} gives the match: {winner} goes through."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--fixture-id` | id | needed |  |
| `--given-by` | person: a name or an id | needed |  |

```
openpadel fixture walkover --fixture-id <id> --given-by "Maria Lopez"
```

### friend

#### openpadel friend add

Add a friend. Who may: owner, manager, member (their own).

Its preview reads: "Add {name} as a friend. Once they add you back, you can save match places for each other."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--friend-id` | id | needed |  |

```
openpadel friend add --person "Maria Lopez" --friend-id <id>
```

#### openpadel friend add-by-code

Add a friend from their link. Who may: owner, manager, member (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--code` | text | needed |  |

```
openpadel friend add-by-code --person "Maria Lopez" --code ...
```

#### openpadel friend remove

Remove a friend. Who may: owner, manager, member (their own).

Its preview reads: "Remove {name} from your friends. You can't save match places for each other until you've both added each other again."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--friend-id` | id | needed |  |

```
openpadel friend remove --person "Maria Lopez" --friend-id <id>
```

### game

#### openpadel game score

Enter a score. Who may: owner, manager, front desk.

Its preview reads: "Round {round} on {court}: {a} to {b}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--game-id` | id | needed |  |
| `--a` | whole number | needed |  |
| `--b` | whole number | needed |  |

```
openpadel game score --game-id <id> --a 0 --b 0
```

### gift-card

#### openpadel gift-card buy

Buy a gift card. Who may: owner, manager, member (their own).

Its preview reads: "Buy a {amount} gift card. Once it's paid, its code is in the app, yours to give."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--cents` | whole number | needed |  |
| `--for-name` | text |  |  |
| `--message` | text |  |  |

```
openpadel gift-card buy --person "Maria Lopez" --cents 1
```

#### openpadel gift-card drop

Remove a gift card waiting for payment. Who may: owner, manager, member (their own).

Its preview reads: "Remove the {amount} gift card that's waiting for payment. It can't be paid after this; buy another if you want one."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--gift-card-id` | id | needed |  |

```
openpadel gift-card drop --gift-card-id <id>
```

#### openpadel gift-card resend

Remind the buyer of a gift card. Who may: owner, manager, front desk.

Its preview reads: "Remind the buyer that the gift card ending {last4} is waiting in their app."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--gift-card-id` | id | needed |  |

```
openpadel gift-card resend --gift-card-id <id>
```

### hours

#### openpadel hours exception-remove

Remove a special day. Who may: owner, manager.

Its preview reads: "{location} keeps its usual hours on {date}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--exception-id` | id | needed |  |

```
openpadel hours exception-remove --exception-id <id>
```

#### openpadel hours exception-set

Set a special day. Who may: owner, manager.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--location` | location: a name or an id | needed |  |
| `--date` | date YYYY-MM-DD | needed |  |
| `--opens` | text |  |  |
| `--closes` | text |  |  |
| `--note` | text |  |  |
| `--court` | court: a name or an id |  |  |

```
openpadel hours exception-set --location Main --date 2026-11-20
```

#### openpadel hours set

Set opening hours. Who may: owner, manager.

Its preview reads: "Set the opening hours at {location}: {hours}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--location` | location: a name or an id | needed |  |
| `--days` | JSON list | needed |  |

```
openpadel hours set --location Main --days '[...]'
```

### household

#### openpadel household add-junior

Add a junior. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Add {name} (born {year}) to your family. {name} has no login of their own: you sign them up, pay, and get their messages."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--display-name` | text | needed |  |
| `--birth-year` | whole number | needed |  |

```
openpadel household add-junior --person "Maria Lopez" --display-name ... --birth-year 1
```

#### openpadel household withdraw-invite

Take back an invite. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Take back the invite link. Nobody can use it after this."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--invite-id` | id | needed |  |

```
openpadel household withdraw-invite --invite-id <id>
```

### kid

#### openpadel kid decline-request

Say no to a request. Who may: owner, manager, front desk (their own), coach (their own), accountant (their own), member (their own).

Its preview reads: "Say no to {name}: {what}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--request-id` | id | needed |  |

```
openpadel kid decline-request --request-id <id>
```

#### openpadel kid withdraw-request

Take back a request. Who may: owner, manager, front desk (their own), coach (their own), accountant (their own), member (their own).

Its preview reads: "Take back your request: {what}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--request-id` | id | needed |  |

```
openpadel kid withdraw-request --request-id <id>
```

### lesson

#### openpadel lesson request

Book a private lesson. Who may: owner, manager, front desk, member (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--coach` | coach: a name or an id | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |
| `--minutes` | whole number | needed |  |
| `--court` | court: a name or an id |  |  |
| `--pay` | whole \| split | needed |  |
| `--players` | whole number |  | Players in the lesson. Paying each their part: 2 to 4. |
| `--person` | person: a name or an id | needed |  |

```
openpadel lesson request --coach "Ana Ruiz" --starts-at "2026-11-20 18:00" --minutes 90 --pay whole --person "Maria Lopez"
```

### level

#### openpadel level answer-review

Answer a level review. Who may: owner, manager, front desk, coach.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--outcome` | keep \| change | needed |  |
| `--level` | number |  |  |
| `--reason` | text |  |  |

```
openpadel level answer-review --person "Maria Lopez" --outcome keep
```

#### openpadel level request-review

Ask for a level review. Who may: owner, manager, front desk (with approval), coach, member (their own).

Its preview reads: "Ask the club to review your level ({level}). It's free: staff look at your games and answer in the app. You can ask once every {count} days.{note}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--note` | text |  |  |

```
openpadel level request-review --person "Maria Lopez"
```

#### openpadel level set

Change a level. Who may: owner, manager, front desk (with approval), coach.

Its preview reads: "Change {person}'s level from {before} to {after}: {reason}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--level` | number | needed |  |
| `--reason` | text | needed |  |

```
openpadel level set --person "Maria Lopez" --level 3.5 --reason "Rain on the outdoor courts"
```

#### openpadel level set-floor

Set a level floor. Who may: owner, manager, front desk (with approval), coach.

Its preview reads: "Set {person}'s floor at {floor}: {reason}. Results can't take their level below it."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--floor` | number | needed |  |
| `--reason` | text | needed |  |

```
openpadel level set-floor --person "Maria Lopez" --floor 0 --reason "Rain on the outdoor courts"
```

#### openpadel level set-session

Set levels after a session. Who may: owner, manager, front desk, coach (their own).

Its preview reads: "Set levels after {program}, {when}: {changes}. Reason: {reason}.{rest} Each player whose level changes is told."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--session-id` | id | needed |  |
| `--reason` | text | needed |  |
| `--levels` | JSON list | needed |  |

```
openpadel level set-session --session-id <id> --reason "Rain on the outdoor courts" --levels '[...]'
```

### location

#### openpadel location create

Add a location. Who may: owner, manager (with approval).

Its preview reads: "Add the location {name} ({tz})."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--name` | text | needed |  |
| `--time-zone` | text | needed |  |
| `--address` | text |  |  |
| `--postal-code` | text |  |  |
| `--region` | text |  |  |
| `--country` | text |  |  |

```
openpadel location create --name "Tuesday drills" --time-zone America/Los_Angeles
```

#### openpadel location update

Change a location. Who may: owner, manager (with approval).

Its preview reads: "Change {fields} for {name}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--location` | location: a name or an id | needed |  |
| `--name` | text |  |  |
| `--time-zone` | text |  |  |
| `--address` | text |  |  |
| `--postal-code` | text |  |  |
| `--region` | text |  |  |
| `--country` | text |  |  |

```
openpadel location update --location Main
```

### membership

#### openpadel membership add-person

Add someone to a family membership. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Add {name} to the {plan} membership, with its member benefits."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--membership-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel membership add-person --membership-id <id> --person "Maria Lopez"
```

#### openpadel membership cancel

Cancel a membership. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Cancel {person}'s {name} membership. It won't be charged again, and it runs until {until}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--membership-id` | id | needed |  |

```
openpadel membership cancel --membership-id <id>
```

#### openpadel membership end

End a membership. Who may: owner, manager, front desk.

Its preview reads: "End {person}'s {name} membership now. Member prices and the longer booking window stop; bookings already made keep their price."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--membership-id` | id | needed |  |
| `--note` | text |  |  |

```
openpadel membership end --membership-id <id>
```

#### openpadel membership grant

Give a membership. Who may: owner, manager, front desk.

Its preview reads: "Give {person} the {name} membership, with no end date."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--plan` | plan: a name or an id | needed |  |
| `--until` | date YYYY-MM-DD |  |  |
| `--note` | text |  |  |

```
openpadel membership grant --person "Maria Lopez" --plan Monthly
```

#### openpadel membership join

Join a membership. Who may: owner, manager, member (their own).

Its preview reads: "Join the {name} membership: {price}, paid now and then {period} from the same card until you cancel. Cancelling stops the next payment; it runs to the end of what's paid."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--plan` | plan: a name or an id | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel membership join --plan Monthly --person "Maria Lopez"
```

#### openpadel membership pause

Pause a membership. Who may: owner, manager, front desk.

Its preview reads: "Pause {person}'s {name} membership until {date}. Its benefits stop meanwhile."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--membership-id` | id | needed |  |
| `--until` | date YYYY-MM-DD | needed |  |
| `--note` | text |  |  |

```
openpadel membership pause --membership-id <id> --until 2026-11-20
```

#### openpadel membership pay-next

Pay the next period. Who may: owner, manager, member (their own).

| Flag | Takes | | What it is |
|---|---|---|---|
| `--membership-id` | id | needed |  |

```
openpadel membership pay-next --membership-id <id>
```

#### openpadel membership plan-remove

Stop offering a membership plan. Who may: owner, manager.

Its preview reads: "Stop offering the {name} membership. People who have it keep it."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--plan` | plan: a name or an id | needed |  |

```
openpadel membership plan-remove --plan Monthly
```

#### openpadel membership plan-set

Set up a membership plan. Who may: owner, manager.

Its preview reads: "Offer the {name} membership: {price}{window}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--plan` | plan: a name or an id |  |  |
| `--name` | text | needed |  |
| `--description` | text |  |  |
| `--price-cents` | whole number (cents) | needed |  |
| `--period` | month \| year | needed |  |
| `--days-ahead` | whole number |  |  |
| `--join-in-app` | yes/no (the flag alone is yes) |  |  |
| `--sort` | whole number |  |  |
| `--max-members` | whole number |  |  |
| `--starts-on` | date YYYY-MM-DD |  |  |
| `--perks-before-start` | yes/no (the flag alone is yes) |  |  |
| `--program-percent-off` | whole number |  |  |
| `--program-cents-off` | whole number |  |  |
| `--included-sessions` | whole number |  | Single sessions included each membership period, free |
| `--included-kinds` | clinic \| social \| tournament |  |  |
| `--family-size` | whole number |  | People covered, the payer included: a family plan |
| `--extra-person-cents` | whole number (cents) |  | Each person beyond family_size, each period; none: no more than family_size |
| `--translations` | JSON |  |  |

```
openpadel membership plan-set --name "Tuesday drills" --price-cents 3000 --period month
```

#### openpadel membership remove-person

Take someone off a family membership. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Take {name} off the {plan} membership. They keep its benefits until {date}, and it renews without them."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--membership-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel membership remove-person --membership-id <id> --person "Maria Lopez"
```

#### openpadel membership resume

Keep a membership. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Keep {person}'s {name} membership. It renews on {date} for {price}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--membership-id` | id | needed |  |

```
openpadel membership resume --membership-id <id>
```

#### openpadel membership unpause

End a pause early. Who may: owner, manager, front desk.

Its preview reads: "End the pause on {person}'s {name} membership now. Its benefits start again today, and the pause it didn't use comes off the renewal date."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--membership-id` | id | needed |  |

```
openpadel membership unpause --membership-id <id>
```

### pass

#### openpadel pass buy

Buy a pass. Who may: owner, manager, member (their own).

Its preview reads: "Buy {name}: {uses} uses for {price}. It's yours once it's paid."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--product-id` | id | needed |  |

```
openpadel pass buy --person "Maria Lopez" --product-id <id>
```

### payment

#### openpadel payment use-promo

Use a promo code. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Use the code {code} on {what}: {off} off, {left} left to pay."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--payment-id` | id | needed |  |
| `--code` | text | needed |  |

```
openpadel payment use-promo --payment-id <id> --code ...
```

### person

#### openpadel person create

Add a person. Who may: owner, manager, front desk.

Its preview reads: "Add {name} ({email}) as a member."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--display-name` | text | needed |  |
| `--email` | text |  |  |
| `--locale` | en \| es |  |  |

```
openpadel person create --display-name ...
```

#### openpadel person email-unsuppress

Send email to an address again. Who may: owner, manager, front desk.

Its preview reads: "Send the club's email to {name} at {email} again (it was held back: {reason}). If it fails again, it's held back again."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |

```
openpadel person email-unsuppress --person "Maria Lopez"
```

#### openpadel person import

Import members. Who may: owner, manager.

Its preview reads: "Add {people} as members. Nobody is emailed."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--rows` | JSON list | needed |  |

```
openpadel person import --rows '[...]'
```

#### openpadel person tag

Tag someone. Who may: owner, manager, front desk.

Its preview reads: "Tag {person} "{tag}"."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--tag-id` | id |  |  |
| `--name` | text |  |  |

```
openpadel person tag --person "Maria Lopez"
```

#### openpadel person untag

Take a tag off. Who may: owner, manager, front desk.

Its preview reads: "Take the tag "{tag}" off {person}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--tag-id` | id | needed |  |

```
openpadel person untag --person "Maria Lopez" --tag-id <id>
```

#### openpadel person update-profile

Change your profile. Who may: owner, manager, front desk (their own), coach (their own), accountant (their own), member (their own).

Its preview reads: "Change {fields} on your profile."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--display-name` | text |  |  |
| `--locale` | en \| es |  |  |

```
openpadel person update-profile --person "Maria Lopez"
```

### policy

#### openpadel policy set

Change the booking rules. Who may: owner, manager.

Its preview reads: "New booking rules (version {version}): book up to {days} days ahead; {max} upcoming bookings each; free cancellation until {hours} hours before, then {percent}% back; shared costs settled {split} hours before; a same-day open match has to be full {same_day} hours before; lengths of {lengths} minutes; a player who can't make a match after the deadline gets back {sub}% when their own sub takes the place, {filled}% when the club fills it with a paying player, and {empty}% when nobody takes it. Bookings already made keep their rules."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--days-ahead` | whole number |  |  |
| `--max-active` | whole number |  |  |
| `--free-cancel-hours` | whole number |  |  |
| `--late-refund-percent` | whole number |  |  |
| `--split-deadline-hours` | whole number |  |  |
| `--late-sub-refund-percent` | whole number |  |  |
| `--late-filled-refund-percent` | whole number |  |  |
| `--late-empty-refund-percent` | whole number |  |  |
| `--same-day-cutoff-hours` | whole number |  |  |
| `--lengths` | integers, with commas |  |  |

```
openpadel policy set
```

### price

#### openpadel price rule-remove

Stop using a price. Who may: owner, manager.

Its preview reads: "Stop using the price {name}. Bookings already made keep their price."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--rule-id` | id | needed |  |

```
openpadel price rule-remove --rule-id <id>
```

#### openpadel price rule-set

Set a court price. Who may: owner, manager.

Its preview reads: "Price {name} at {location}: {amount} an hour, {when}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--rule-id` | id |  |  |
| `--location` | location: a name or an id | needed |  |
| `--name` | text | needed |  |
| `--courts` | courts: names or ids, with commas |  |  |
| `--weekdays` | integers, with commas |  |  |
| `--starts` | text |  |  |
| `--ends` | text |  |  |
| `--valid-from` | date YYYY-MM-DD |  |  |
| `--valid-to` | date YYYY-MM-DD |  |  |
| `--cents-per-hour` | whole number | needed |  |
| `--priority` | whole number |  |  |
| `--plans` | plans: names or ids, with commas |  |  |
| `--translations` | JSON |  |  |

```
openpadel price rule-set --location Main --name "Tuesday drills" --cents-per-hour 0
```

### program

#### openpadel program cancel

Cancel a program. Who may: owner, manager.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--refund` | rule \| full \| none |  | rule: what was paid for these dates (all of it when nothing is left); full: everything paid; none: nothing. Other than the rule needs a note. |
| `--note` | text |  |  |

```
openpadel program cancel --program "Tuesday drills"
```

#### openpadel program create

Create a program. Who may: owner, manager.

Its preview reads: "Create {name} ({kind}), {capacity} places at {price}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--location` | location: a name or an id | needed |  |
| `--kind` | clinic \| course \| league \| tournament \| social | needed |  |
| `--format` | americano \| mexicano \| king_of_court |  |  |
| `--name` | text | needed |  |
| `--capacity` | whole number | needed |  |
| `--price-cents` | whole number (cents) | needed |  |
| `--member-price-cents` | whole number (cents) |  | What members pay instead (any plan). Empty: the plan's own discount on programs, if any. |
| `--level-min` | number |  |  |
| `--level-max` | number |  |  |
| `--refund-window-hours` | whole number |  |  |
| `--refund-inside-window` | none \| credit \| full |  |  |
| `--rated` | yes/no (the flag alone is yes) |  | Whether results change levels. Friendlies never do. Default: no for clinics and courses, yes for the rest. |
| `--min-players` | whole number |  | The fewest players it runs with. Short of it at the decision time, it's cancelled and everyone is paid back. |
| `--decide-hours` | whole number |  | How many hours before the first date the minimum is decided. Empty: the club's default. |
| `--translations` | JSON |  |  |
| `--sign-up` | whole_program \| per_session |  | whole_program (default): one place covers every date. per_session: each date has its own places, roster, waitlist and minimum, and people sign up for the dates they want (clinics and socials). |

```
openpadel program create --location Main --kind clinic --name "Tuesday drills" --capacity 8 --price-cents 3000
```

#### openpadel program publish

Publish a program. Who may: owner, manager.

Its preview reads: "Publish {name} so players can sign up."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |

```
openpadel program publish --program "Tuesday drills"
```

#### openpadel program set-minimum

Set a minimum to run. Who may: owner, manager.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--min-players` | whole number | needed |  |
| `--decide-hours` | whole number |  | Hours before the first date it's decided. Null: the club's default. |

```
openpadel program set-minimum --program "Tuesday drills" --min-players 1
```

#### openpadel program set-name

Rename a program. Who may: owner, manager.

Its preview reads: "Call {name} "{to}" from now on. Its places, dates and people stay as they are."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--name` | text | needed |  |
| `--translations` | JSON |  |  |

```
openpadel program set-name --program "Tuesday drills" --name "Tuesday drills"
```

#### openpadel program set-prices

Change a program's prices. Who may: owner, manager.

Its preview reads: "Set the price of {name} to {price}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--price-cents` | whole number (cents) | needed |  |
| `--member-price-cents` | whole number (cents) | needed | What members pay instead (any plan). Null: the plan's own discount on programs, if any. |

```
openpadel program set-prices --program "Tuesday drills" --price-cents 3000 --member-price-cents 3000
```

#### openpadel program set-sign-up

Change how people sign up. Who may: owner, manager.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--sign-up` | whole_program \| per_session | needed |  |

```
openpadel program set-sign-up --program "Tuesday drills" --sign-up whole_program
```

#### openpadel program unwatch

Stop hearing when a place opens. Who may: owner, manager, member (their own).

Its preview reads: "Stop telling {person} when a place opens in {name}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--watch-id` | id | needed |  |

```
openpadel program unwatch --watch-id <id>
```

#### openpadel program watch

Ask to hear when a place opens. Who may: owner, manager, member (their own).

Its preview reads: "Tell {person} once when a place opens in {name}. The waitlist is offered places first; when nobody there takes one, it goes to whoever signs up first."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--session-id` | id |  | The date, for a program signed up per date. |

```
openpadel program watch --program "Tuesday drills" --person "Maria Lopez"
```

### question

#### openpadel question answer

Answer a member's question. Who may: owner, manager, front desk.

Its preview reads: "Answer {person}: "{body}". They hear straight away.{close}"

| Flag | Takes | | What it is |
|---|---|---|---|
| `--question-id` | id | needed |  |
| `--body` | text | needed |  |
| `--close` | yes/no (the flag alone is yes) |  |  |

```
openpadel question answer --question-id <id> --body "Rain on the outdoor courts"
```

#### openpadel question ask

Ask the club. Who may: owner, manager, member (their own).

Its preview reads: "Ask the club{about}: "{body}". The staff answer in the app, and you hear when they do."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--person` | person: a name or an id | needed |  |
| `--body` | text | needed |  |

```
openpadel question ask --person "Maria Lopez" --body "Rain on the outdoor courts"
```

#### openpadel question ask-person

Ask a person. Who may: owner, manager, member (their own).

Its preview reads: "Ask a person at the club. Your question goes to the staff, who answer in the app."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--question-id` | id | needed |  |

```
openpadel question ask-person --question-id <id>
```

#### openpadel question assign

Give a question to someone. Who may: owner, manager, front desk.

Its preview reads: "Give {person}'s question to {to}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--question-id` | id | needed |  |
| `--to` | id | needed |  |

```
openpadel question assign --question-id <id> --to <id>
```

#### openpadel question close

Close a question. Who may: owner, manager, front desk, member (their own).

Its preview reads: "Close the question "{question}". A reply opens it again."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--question-id` | id | needed |  |

```
openpadel question close --question-id <id>
```

#### openpadel question not-answered

Say the answer didn't help. Who may: owner, manager, member (their own).

Its preview reads: "Tell the club that answer didn't help. Your question goes to the staff, who answer in the app."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--question-id` | id | needed |  |

```
openpadel question not-answered --question-id <id>
```

#### openpadel question reply

Reply to the club. Who may: owner, manager, member (their own).

Its preview reads: "Send to the club: "{body}"."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--question-id` | id | needed |  |
| `--body` | text | needed |  |

```
openpadel question reply --question-id <id> --body "Rain on the outdoor courts"
```

### receipt

#### openpadel receipt resend

Send a receipt again. Who may: owner, manager, front desk, accountant.

Its preview reads: "Email receipt {number} to {name} at {email} again."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--receipt-id` | id | needed |  |

```
openpadel receipt resend --receipt-id <id>
```

### refund

#### openpadel refund resend

Send a refund again. Who may: owner, manager.

Its preview reads: "Send {person} the {amount} refund for {what} again. It goes back to the card it was paid with."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--refund-id` | id | needed |  |

```
openpadel refund resend --refund-id <id>
```

### result

#### openpadel result confirm

Confirm a score. Who may: owner, manager, member (their own).

Its preview reads: "Confirm the score: {teamA} {score} {teamB}. Once confirmed, {counts}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--game-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |

```
openpadel result confirm --game-id <id> --person "Maria Lopez"
```

#### openpadel result dispute

Dispute a score. Who may: owner, manager, member (their own).

Its preview reads: "Dispute the score {teamA} {score} {teamB}. It won't count until the club decides."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--game-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--note` | text | needed |  |

```
openpadel result dispute --game-id <id> --person "Maria Lopez" --note "Rain on the outdoor courts"
```

#### openpadel result enter

Enter a score. Who may: owner, manager, member (their own).

Its preview reads: "Enter the score for your match on {court}, {when}: you and {partner} {result} {score} against {opponents}. They have {hours} hours to confirm or dispute it; after that it counts as entered, and {counts}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booking-id` | id | needed |  |
| `--person` | person: a name or an id | needed |  |
| `--partner` | person: a name or an id | needed |  |
| `--sets` | JSON list | needed |  |

```
openpadel result enter --booking-id <id> --person "Maria Lopez" --partner "Maria Lopez" --sets '[...]'
```

#### openpadel result resolve

Decide a disputed score. Who may: owner, manager, front desk.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--game-id` | id | needed |  |
| `--outcome` | keep \| correct \| set_aside | needed |  |
| `--sets` | JSON list |  |  |
| `--note` | text |  |  |

```
openpadel result resolve --game-id <id> --outcome keep
```

### segment

#### openpadel segment save

Save a group. Who may: owner, manager, front desk.

Its preview reads: "Save the group "{name}": {what}. It means whoever matches when it's used ({people} now)."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--name` | text | needed |  |
| `--filters` | JSON | needed |  |

```
openpadel segment save --name "Tuesday drills" --filters '{...}'
```

#### openpadel segment update

Change a group. Who may: owner, manager, front desk.

Its preview reads: "Change the group "{name}" to {what} ({people} now)."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--segment-id` | id | needed |  |
| `--name` | text |  |  |
| `--filters` | JSON |  |  |
| `--active` | yes/no (the flag alone is yes) |  |  |

```
openpadel segment update --segment-id <id>
```

### series

#### openpadel series cancel

Cancel dates. Who may: owner, manager.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--session-id` | id | needed |  |
| `--scope` | this \| following \| all | needed |  |
| `--refund` | rule \| full \| none |  | rule: what was paid for these dates (all of it when nothing is left); full: everything paid; none: nothing. Other than the rule needs a note. |
| `--note` | text |  |  |

```
openpadel series cancel --session-id <id> --scope this
```

#### openpadel series edit

Change dates. Who may: owner, manager.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--session-id` | id | needed |  |
| `--scope` | this \| following \| all | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO |  | A new date and time for this one date (scope this). |
| `--start-time` | text |  | Each date keeps its day and starts at this club time, such as 19:00. |
| `--minutes` | whole number |  | How long each date runs. |
| `--courts` | courts: names or ids, with commas |  |  |
| `--coach` | coach: a name or an id |  | Who runs them; null for nobody named. |
| `--capacity` | whole number |  | Places in the program, for all its dates. Signed up per date: the places on each date chosen (this, following, all). |

```
openpadel series edit --session-id <id> --scope this
```

### session

#### openpadel session add

Add a date. Who may: owner, manager.

Its preview reads: "Add {name} on {when}, on {courts}."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--program` | program: a name or an id | needed |  |
| `--starts-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |
| `--ends-at` | time: "YYYY-MM-DD HH:MM" on the club's clock, or ISO | needed |  |
| `--courts` | courts: names or ids, with commas | needed |  |
| `--coach` | coach: a name or an id |  | The coach who runs it: someone with the coach role, with no lesson then. |
| `--weeks` | whole number |  | How many dates, one a week at the same club time (1: just this one). |

```
openpadel session add --program "Tuesday drills" --starts-at "2026-11-20 18:00" --ends-at "2026-11-20 18:00" --courts "Court 1,Court 2"
```

#### openpadel session set-coach

Choose who runs a date. Who may: owner, manager, front desk.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--session-id` | id | needed |  |
| `--coach` | coach: a name or an id | needed |  |

```
openpadel session set-coach --session-id <id> --coach "Ana Ruiz"
```

### support

#### openpadel support end

End support access. Who may: owner, manager.

Its preview reads: "End {name}'s support access now. From this moment they can't open or change anything."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--grant-id` | id | needed |  |

```
openpadel support end --grant-id <id>
```

### tag

#### openpadel tag create

Make a tag. Who may: owner, manager, front desk.

Its preview reads: "Make the tag "{name}" for tagging members."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--name` | text | needed |  |

```
openpadel tag create --name "Tuesday drills"
```

#### openpadel tag update

Change a tag. Who may: owner, manager, front desk.

| Flag | Takes | | What it is |
|---|---|---|---|
| `--tag-id` | id | needed |  |
| `--name` | text |  |  |
| `--active` | yes/no (the flag alone is yes) |  |  |

```
openpadel tag update --tag-id <id>
```

### template

#### openpadel template save

Save a template. Who may: owner, manager, front desk.

Its preview reads: "Save the template "{name}"."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--name` | text | needed |  |
| `--subject-en` | text |  |  |
| `--body-en` | text |  |  |
| `--subject-es` | text |  |  |
| `--body-es` | text |  |  |

```
openpadel template save --name "Tuesday drills"
```

#### openpadel template update

Change a template. Who may: owner, manager, front desk.

Its preview reads: "Change the template "{name}"."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--template-id` | id | needed |  |
| `--name` | text |  |  |
| `--subject-en` | text |  |  |
| `--body-en` | text |  |  |
| `--subject-es` | text |  |  |
| `--body-es` | text |  |  |
| `--active` | yes/no (the flag alone is yes) |  |  |

```
openpadel template update --template-id <id>
```

### waiver

#### openpadel waiver clear

Stop asking for the waiver. Who may: owner, manager.

Its preview reads: "Stop asking for the club's waiver. The acceptances so far are kept."

```
openpadel waiver clear
```

#### openpadel waiver set

Set the waiver. Who may: owner, manager.

Its preview reads: "Set the club's waiver (version {version}). Everyone is asked to accept it before their first booking or sign-up, and parents accept it for each junior."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--body` | text | needed |  |
| `--translations` | JSON |  |  |

```
openpadel waiver set --body "Rain on the outdoor courts"
```

### weekly

#### openpadel weekly end-all

Stop every weekly court members booked in the app. Who may: owner, manager.

Its preview reads: "Stop {count} weekly courts members booked in the app ({members} members)."

| Flag | Takes | | What it is |
|---|---|---|---|
| `--booked` | keep \| cancel | needed |  |
| `--refund` | rule \| full \| none |  |  |

```
openpadel weekly end-all --booked keep
```
