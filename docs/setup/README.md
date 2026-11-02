# Setting up Kumi for your club

This guide is written for a club owner and for the owner's AI agent (Claude Code, Codex or another)
working together. The agent can do most of it. The owner does the parts that need their identity,
their payment details or their decision; each step says which is which.

**Agents:** read the rules at the top of [`AGENTS.md`](../../AGENTS.md) first. Then follow the steps
below in order, running `kumi doctor --json` (once the server exists) after each one and fixing any
`fail`. `off` is an optional piece the club hasn't chosen, and the practice-mode `warn`s stay until
go-live.

Kumi runs on the club's own server ("self-hosted"). A hosted service, where Kumi runs it for you,
is planned but not offered yet.

## What you end up with

- The members' app at your address, for example `https://app.yourclub.com`, and the staff app at
  `https://staff.app.yourclub.com`. Both work on a phone or a computer, in English and Spanish. What the club
  writes itself (plans, programs, the waiver, the public page's blurb, coaches' bios) can be written in both
  languages too: under each field, an optional one for the other language, with a draft offered when the
  server has an Anthropic key (step 5h).
- Court bookings members make and pay for in the app (the whole court, or their own part), and staff
  manage at the desk; clinics, socials and Americanos with waitlists and refunds.
- Email from your own domain, card payments into your own Stripe account, nightly backups.

## The order

Start the slow items first: Stripe checks a new business account before it pays out, which can
take a few days.

| # | Step | Who | Time | Guide |
|---|---|---|---|---|
| 1 | Collect the club's details | Agent drafts from the club's website, owner checks | 30 min | [club-packet.md](club-packet.md) |
| 2 | Create the Stripe account (start now, it's the slowest) | Owner | 20 min, then days of checks | [accounts/stripe.md](accounts/stripe.md), step 1 only |
| 3 | Domain, server and HTTPS | Owner buys, agent sets up | 1 hour | [accounts/server.md](accounts/server.md) |
| 4 | Describe the club in `club.yaml`, preview, apply | Agent, owner approves the plan | 20 min | below |
| 5 | Email from the club's domain | Owner signs up, agent sets up | 30 min | [accounts/resend.md](accounts/resend.md) |
| 5b | Bring in the existing members (optional) | Owner exports a spreadsheet, agent imports | 15 min | below |
| 5c | Courts, prices and booking rules, and turning on court booking | Owner decides, staff app | 20 min | below |
| 5d | Membership plans (optional) | Owner decides, staff app | 10 min | below |
| 5e | The public page (optional) | Owner, staff app | 10 min | below |
| 5f | Coaches and private lessons (optional) | Each coach, staff app | 10 min a coach | below |
| 5g | The waiver, and families with juniors (optional) | Owner, staff app | 10 min | below |
| 5h | Common questions, and ask the club (optional): a decision model answers from them | Front desk drafts, owner checks; owner signs up for the model, agent sets it up | 1 hour, plus 15 min | below, and [accounts/ask-the-club.md](accounts/ask-the-club.md) |
| 5i | Messages to members: tags, groups and the daily email cap | Owner decides, front desk | 15 min | below |
| 5j | Offsite backups, and the keys to keep | Owner creates the storage key, agent sets up | 20 min | [accounts/offsite-backups.md](accounts/offsite-backups.md) |
| 5k | Texts (optional): the club's own Twilio number, registered with US carriers | Owner signs up and registers, agent sets up | 1 hour, then days to weeks of review | [accounts/twilio.md](accounts/twilio.md) |
| 6 | Card payments, in test mode first | Owner copies keys, agent sets up | 30 min | [accounts/stripe.md](accounts/stripe.md) |
| 7 | Playtomic, only if the club also uses it | Owner creates keys, agent sets up | 20 min | [accounts/playtomic.md](accounts/playtomic.md) |
| 8 | Practice with the club's own staff | Everyone | a few days | below |
| 9 | Go live | Owner decides | 10 min | below |

### Step 4: the club itself

Copy [`club.example.yaml`](../../club.example.yaml) to `/etc/kumi/club.yaml` on the server and fill
it in: the club's name and time zone, the owner, each location with its courts, and the staff with
their roles. No secrets go in this file.

```bash
kumi setup plan       # what would change; changes nothing
kumi setup apply      # makes those changes
kumi doctor           # what's next
```

Show the owner the plan before applying. Running it again only adds what's new; renaming or
removing things is done in the staff app, where the preview shows what each change affects.

The owner then signs in to the staff app with their email address. A code arrives by email (or,
before email is set up, appears in the server log: `journalctl -u kumi | grep '\[mail'`).

Owners and managers sign in with two steps. The first time, the staff app asks the owner to set up a
second step: a passkey on their phone or computer (both steps at once), or an authenticator app (Google
Authenticator, Microsoft Authenticator, 1Password and the like) with ten recovery codes to keep
somewhere safe. If the owner ever loses all of them, an agent on the server runs
`kumi reset-sign-in owner@yourclub.com`, and the owner sets it up again at the next sign-in.

### Step 5b: members

Members can join by themselves: they enter their email in the members' app, get a code, and give
their name and whether they want club news (that answer is kept as their consent). The club can
close sign-up so only staff add people.

To bring in an existing list, export it as CSV from a spreadsheet, Playtomic or the old system. It
needs a Name column (or First name and Last name), and Email and Language if there are any:

```bash
kumi import members members.csv           # what would be added, and every line that can't be used
kumi import members members.csv --apply   # add them
```

People already in Kumi (by email) are left as they are, and nobody is emailed: telling members
about the app is the club's own announcement. Staff can do the same from People in the staff app.

### Step 5c: courts, prices and rules

**Turn on "Members book courts in the app"** (Settings, The club). It starts off. Leave it off only
while the club's courts are booked in Playtomic, or until the doors open (step 9).

In the staff app's Settings: each location's opening hours and special days (a court can have its own
week, such as an outdoor court that closes at dusk, and its own special day; any day it has none of its
own, it keeps the location's), court prices (by day,
time and season), the sales tax rate, and the booking rules (how far ahead, how many at once, the
cancellation window, and the "pay my part" deadline). At that deadline, unpaid shares of a booking go
on its organiser's saved card; an open match that isn't full is cancelled instead, and everyone in it
gets back all they paid. After the deadline a member can still open a same-day match, until the
same-day cutoff (2 hours before the start, set beside the deadline): each player pays when they join,
and one not full at the cutoff is cancelled the same way. Members only book courts in the app once "Members book courts in the app" is
on; leave it off while the club books courts in Playtomic. Paying for whole courts, a member can book
several the same day in one card payment (each counts toward "how many at once"); each is still its
own booking, cancelled on its own. Whoever books a whole court names the other players (or shares the booking's
players link): nobody added pays, and with four on it the score can be entered and, if the booker says
so, count for levels. The front desk can name players on a member's court from the Courts page.

Before the deadline, a player who can't make a match gets their money back straight away. After it,
what they get back is the club's choice, set in the same place: a percent for when their own sub takes
the place, one for when the club fills it with a paying player, and one for when nobody takes it (or
staff give it away free). The defaults are 100, 100 and 0. The front desk is told when a place is left
empty after the deadline, and fills it from the Courts page; staff can choose a different refund there,
case by case.

The Courts page is the desk's day: a column per court with the time down the side, what's on now and
next on each court (who's playing, what's owed, who said they're running late), and the alerts that need
someone (a place left empty at the last minute, a question waiting, money owed, a program short of its
minimum, a refund that failed). An alert stays until one of the staff marks it handled, and then it's gone
for everyone. Staff move a booking by dragging its handle to another time or court, and change its length
by dragging its bottom edge; the same is on buttons and the arrow keys. Every change shows its preview
first, and the players are told. A move keeps the price paid unless staff tick "price it again"; more
time is owed at the desk; less time gives back what the club's cancellation rule says (or all, or
nothing, as staff choose). Money paid at the desk is given back at the desk.

Staff block courts from the Courts page, once or every week: "Courts 1 and 2 every Tuesday 18:00 to
20:00" from a date, until a date or with no end (its dates are made a year ahead, and on as the year
moves). A booking already in the way stays, and the block leaves that court free that day, or staff
cancel it: its players are told, and what they get back is chosen on its own (all of it by default,
since the club called it off). A blocked date's buttons open just that date, end the block from that
date, or end every date to come, and its times can be changed for that date, that date and the ones
after it, or all of them. Under the grid, "Repeating blocks" lists each one with its next date: change its
courts, days, times, end date, reason or note there (for one date, from a date on, or all of it), or end it.

Every payment that goes through, and every refund, gets a numbered receipt for whoever paid, by email and
in the members' app (Profile, then Receipts). Staff with the club's money see someone's receipts on their
page and can send one again, and all the club's receipts for any dates (up to a year) under Reports, with a
spreadsheet file where refunds are negative amounts. Turn off Stripe's own receipt emails so members don't
get two ([accounts/stripe.md](accounts/stripe.md), step 4).

### Step 5d: memberships (optional)

If the club sells memberships, add its plans under Memberships in the staff app: a name, the price a
month or a year, and how far ahead its members can book courts when that's longer than the club's
rule. Member prices on courts are court prices for chosen plans (Settings, Prices: tick the plans).
Where a member price and an everyone price have the same priority, the member price wins.

A plan can also give members a discount on clinics and other programs (a percent or an amount off),
and include so many single sessions each membership period, free (say 4 clinics a month, of the
kinds ticked; courses never count). A program can have its own member price instead, set when it's
created or with Change prices on its page; it wins over the plan's discount. People already signed
up keep the price they agreed to, so a member price is fairest set before the first sign-up.

Members join in the app (Membership) and pay by card. Kumi renews each membership from that card when
its month or year is up, at the price the member joined at. If the card is declined, the membership
carries on while Kumi tries again two days later and three days after that, and the member can pay
with another card meanwhile; after the third try it ends. The owner and managers hear of the first
declined try (by email and in the staff app, once, not at every try), with the bank's
reason when it gives one and a link to the member, and it stays on the Courts page's alerts until
someone marks it handled. Paid after all, the alert closes by itself and they hear so; ended after the
last try, they hear that instead, and it takes the alert's place. Members cancel in the app, and it
runs to the end of what they've paid. A plan with "join in the app" off is only given at the desk.

A family plan covers a household on one card, the payer's: give the plan how many people it covers
(the payer included) and, if more can be added, the price of each one more a month or a year. The
payer joins in the app, then adds people from their family on the Membership page: the other parent,
grown-up children with their own login, and juniors (step 5g). Everyone added gets the plan's benefits
as their own, and its included sessions each. Someone added beyond the plan's number is charged their
price for the current period at once, and each renewal is the plan's price plus theirs. Someone taken
off keeps the benefits until the next renewal. Pausing or ending the membership does it for everyone
on it.

For a founding offer (a new club selling memberships before it opens), give a plan a limit, a start
date, or both. Members who join before the start date save their card, without being charged, and
keep their place; Kumi makes the first charge on the start date and renews monthly or yearly from
there. A place whose card isn't saved within two hours is let go, so the limit only counts real
members. Members can give up their place before the start, and nothing is charged. Once their card is
saved, founding members get the plan's member prices, program discounts and booking window straight
away (included sessions start with the membership); untick "Members who join before it starts get its
member prices and discounts straight away" to keep them for the start date.

The desk gives a membership on the person's page or under Memberships (a founding member, one paid
in cash, a free one), with an end date or without. Staff can also stop or restart an app
membership's renewal, or end any membership at once (no refund is made by ending it).

### Step 5e: the public page (optional)

In Settings, "Public page" puts the club's details on the web at `https://app.yourclub.com/public`:
its locations and hours, courts, prices, memberships (founding offers with places left) and upcoming
public events, each event on its own page. It's plain HTML, so search engines and AI assistants read
all of it, with schema.org markup for the club and its events, and a sitemap at `/public/sitemap.xml`.
Nothing about members is shown. "Join the club" goes to the app's sign-up, so before opening it works
as the interest list: people join with their email and say whether they want club news.

### Step 5f: coaches and private lessons (optional)

Give each coach the coach role on their page in the staff app (or in `club.yaml`). Then, under Coaches,
make their profile: a photo, a few lines about them, the levels and languages they teach, and a rate
for each lesson length they offer. The rate is the whole price, court included, and all of it goes to
the club. Add the hours they give lessons each week (more than one stretch a day is fine) and any time
off. Coaches can keep their own profile, hours and time off from the staff app; front desk and up can
keep anyone's.

Members then book a lesson under Lessons in the app: a coach, a length and a time when the coach gives
lessons and a court is free. They pay it all, or (2 to 4 players) each pays their part, like a court
booking, with what's unpaid at the deadline going on the booker's card. The court is booked with the
lesson, a coach can't be in two places at once, and lessons don't count toward the club's limit on
court bookings. Cancelling follows the club's cancellation rule; when the coach or the club calls a
lesson off, the players get everything back. The coach hears about each lesson booked, cancelled and
coming up, and sees their own two weeks under My schedule.

Each program date can name the coach who runs it (on the program's page); that coach then sets the
levels after it, and can't be booked for a lesson then. Reports shows lesson revenue apart from courts
(and programs and memberships, each its own line),
and each coach's lessons (paid, less refunds) and the dates they ran, with a CSV for payroll. A coach
sees their own; owners, managers and the accountant see everyone's.

Under My schedule each coach finds a calendar link to subscribe to in their phone's calendar (Google,
Apple or Outlook), so their lessons and dates show up there. The link is the key to it, so it's theirs
alone; making a new one stops the old. Each lesson and date also has its list of players, with their
level, a junior's parents and the waiver, where the coach (or front desk) marks who came, from the
start until 48 hours after. "Didn't come" goes on the player's no-show record, and the player is told.
My students lists everyone a coach worked with in the last 90 days.

### Step 5g: the waiver, and families with juniors (optional)

If the club asks players to accept a waiver, paste its text into Settings, Waiver. Every adult is
asked to accept it in the app before their first booking or sign-up, and a parent accepts it for each
of their juniors; changing the text later makes a new version, and everyone is asked again. Who
accepted which version, and when, shows on each person's page. Staff booking at the desk aren't
stopped by it, so check the person's page for walk-ins. With no text, nobody is asked.

Families need nothing set up. A parent adds their children under Family in the app (a name and a
birth year only: no login of their own until a parent turns one on, below) and invites the other parent with a link. Then either parent
signs a child up for clinics, books their lessons and pays, and both get the child's messages. Front
desk can add a junior from the parent's page in the staff app. A junior can't book courts or join open
matches. From the year they turn 18, a parent or staff give them their own login with an email address.

From the year a junior turns 13, a parent can turn on a login of their own on the Family page (the
kid's email address), and save a family card there. The kid then books and joins things themselves,
paid on that card at once, within rules the parents set: which kinds of booking they can make on their
own, and a monthly limit ($100 to start). Anything else comes to the parents to approve in the app.
Nothing to set up for the club; if the club uses Stripe, the webhook's `setup_intent.succeeded` event
(already needed for founding offers) also records family cards.

### Step 5h: common questions and the staff inbox (optional, but worth an hour)

Under Questions, Club facts, front desk writes the club's own answers to what members ask most: where
to park, the door code, what juniors bring, how to cancel. Each has a topic, and the question and the
answer in each of the club's languages. Members see the switched-on ones as Common questions in the
app (Ask), searched by plain words, before they ask anything, and the ones ticked "Also on the public
page" appear there too, marked up for search engines. A door code should stay unticked.

What members still want to know they ask in the app, which starts a thread (a parent can ask about a
junior). It lands on the Questions page in the staff app, the longest wait at the top, with who's
asking, their membership and level. Front desk and up answer it (the member hears in the app, by push
and by email), give it to someone, close it, or turn the answer into a club fact in one step. A member's
reply opens it again. If a question waits longer than the club's setting (2 hours to start, counted
only while the club is open), front desk and up hear once; Settings changes the hours, and 0 turns the
alert off. Members can start five new questions a day.

"Ask the club" can answer a new question from the club facts by itself, word for word, once the server
has a decision model (`docs/setup/accounts/ask-the-club.md`: a TypeSafe key for Jev, an Anthropic key for
Claude Haiku, or both). The question is saved with the staff first; then the model picks the one fact that
answers it completely, or hands it to the staff, in a second or two. It never writes anything itself, and
anything about the member's own bookings, money, membership or level, a complaint or an injury goes to a
person. Only the question's words and the facts go to the model: no names or details. Under the fact the
member can tap "That didn't answer it" or "Ask a person", and the question goes to the staff at once. Staff
see on the Questions page which fact Kumi sent and how sure it was, and a staff answer always wins. Every
decision is kept. Settings has a switch to stop it; without a model, every question goes to the staff.

The same Anthropic key offers drafts in the club's other language. Under each text the club writes itself (a
plan's name and description, a program's name, the waiver, the public page's blurb, a coach's bio, a price's
name) there's an optional field for the other language; "Offer a draft" fills it from the club's own words.
Read it and change what needs changing before saving: nothing is saved without a person. Members read their
language's version, and the club's own words where there isn't one.

### Step 5i: messages to members (optional)

Front desk and up write to members from Messages in the staff app. A message goes to a group: a set of
filters (members on a plan, a level range, the club's own tags, who played lately or hasn't, adults or
juniors, language, a program, a booking or place on a date, when they joined). Build one on the spot or
save it under Groups with a name; a saved group means whoever matches when it's used, and the count
beside the filters shows who that is now. Tags are the club's own words ("league A", "beginner 2025"),
put on a member's page; Groups also lists them, to rename or stop using.

There are two kinds of message, and the difference is the law as much as manners:

- **Club news** (events, offers, what's new) goes only to people who said yes to club news, when they
  joined or later in Profile. The preview says how many in the group are left out. Every club news email
  has a one-click unsubscribe that works without signing in.
- **A service notice** (a court closed, a clinic moved) needs no yes, because it's about the person's own
  booking or place, so Kumi only lets it go to people with a booking or place on a date, or in a program.
  Never use it for news or offers. One about something within a day goes straight away, even at night.

Juniors are reached through their parents. Write each message in every club language; `{first_name}`
and `{club}` are filled in for each person. Templates keep words to start from.

Email for messages to members is spread over days under the club's daily limit (Settings: 80 a day to
start). The email service has its own daily limit (Resend's free plan: 100 a day for everything), and the
club's own messages (sign-in codes, confirmations, receipts) need room. On a paid email plan, raise it.
Settings can also send owners and managers a copy of every message; the sender always gets one.

### Step 5j: offsite backups, and the keys to keep

The server backs itself up every night, but those copies are on its own disk. Follow
[accounts/offsite-backups.md](accounts/offsite-backups.md) to send each night's backup, sealed, to storage
the club owns (Cloudflare R2 or Backblaze B2; both have a free allowance far above a club's needs). Then:

- **Agent:** run `kumi backup`, `kumi offsite` and `kumi restore-test`; `kumi doctor` should show
  `offsite` and `restore_test` as `ok`. The restore test runs by itself once a month from then on.
- **Owner:** keep `KUMI_BACKUP_KEY` and `KUMI_SECRET_KEY` in a password manager. The agent never reads
  them: the owner looks at them on the server in their own terminal
  (`sudo grep -E '^KUMI_(BACKUP|SECRET)_KEY=' /etc/kumi/kumi.env`). Without the backup key, the offsite
  copies can't be opened.

The owner also has a **vault** in the staff app (Settings, then "The vault"): the club's keys and small
documents (a supplier login, the alarm code, the insurance certificate, the lease), sealed with the
server's key and seen only by the owner. Never paste those into a chat; the owner adds them there.

### Step 5k: texts (optional)

Members can choose a text when something needs them soon: a place offered with a deadline, or a booking or
class the club cancelled or moved. Everything else stays in the app, by push and by email. Texts go through
the club's own Twilio account, only to US and Canadian numbers, and only to members who confirmed their
number with a code and ticked the yes themselves (Profile, then Texts). STOP to the club's number turns every
message to that member off at once.

**US carriers must approve the club's texting first**: until then, real texts don't reach anyone. Kumi does
the registration through the club's own Twilio account, toll-free (reviewed in about three business days, no
brand or campaign fees): add the business's details to club.yaml's `texting:` section, then
`kumi texting plan` says what it would do and what's missing, and `kumi texting apply --yes` buys a toll-free
number (about $2.15 a month), makes the Messaging Service and sends the verification. The server asks Twilio
how the review is going every hour; the owner and managers hear once it's decided, and texts start by
themselves when it's approved. After that it checks the number hourly: if Twilio withdraws the approval, the
number leaves the account, or Twilio refuses texts because of the number, the owner and managers hear once (and
once more when it's fixed). A rejection is explained with its fix in `kumi texting status` and Settings;
correct club.yaml and run `kumi texting apply` again. [accounts/twilio.md](accounts/twilio.md) has the steps,
and the local-number (A2P 10DLC) path for clubs that text a lot more.

Once texts are set up, members can also sign in, or join, with a code texted to their mobile number instead
of an email ("Use my mobile number instead" on the sign-in page). Someone who joins that way needs no email;
the app asks for one afterwards, for receipts by email and to sign in if they lose the phone. In practice
mode the code is in the server's log (`journalctl -u kumi | grep 'text held'`), as an emailed one is.

### Programs: weekly dates, changes and a minimum to run

Add a program's dates on its page; "Dates, one a week" adds that many at the same club time, across
the clock changes. Each date still to come can be changed or cancelled: just it, it and the ones after
it, or every date still to come. The preview lists each date as it was and as it will be, anything in
the way (a booking, a block or another program on the court, or the coach teaching, in a lesson or
away), and who's signed up; they're told when it's confirmed. Places are for the whole program, so a
change to places is for all its dates, and new places go to the waitlist first. Cancelling one date of
a course paid once gives each player that date's share back; cancelling every date cancels the program
and gives everything back. Staff can choose all of it or nothing instead, with a reason.

A draft shows the card exactly as members will see it, with each date, before it's published.

A clinic or social can instead be signed up **date by date** ("Sign up date by date" when making it, or
on its page until anyone has signed up): a weekly drop-in where people come when they can. Each date
then has its own places, roster, waitlist, minimum and attendance. Members tick the dates they want on
What's On and pay once for all of them; a full date puts them on that date's waitlist, or they can ask
to hear when a place opens on it. Leaving a date follows the cancel rule for that date only. Changing
places on its dates sets each date's own; cancelling a date gives everyone on it all they paid back. On
the program's page, pick a date to see its roster, waitlist and who has a free place. A minimum is
decided before each date, so a short date is cancelled on its own and the others go ahead. The desk
signs someone up for dates from the program's page ("Sign someone up for dates"): the member pays by card
in the app, and hears once with every date and the amount. Its public page lists each date's places.

A program can need a minimum to run. At its decision time (Settings: 24 hours before its first date to
start, or the program's own), a program short of it is cancelled, everyone gets their money back, and
everyone is told; the front desk hears once before that (Settings: 24 hours earlier) how many it still
needs, which a message to members can help with. On a full program, members can ask to hear when a
place opens: the waitlist is offered places first, and once a place is open to anyone, everyone
watching hears once.

### Signing in, roles and bots

- **Two steps for staff.** Settings, "Sign-in and roles": owners, managers and the club's own roles (the
  default), or every staff role. Each person sets up a passkey or an authenticator app the first time
  they sign in after it applies to them; members can turn an authenticator on in Profile if they like.
  The owner can start someone's second step over from their page in the staff app.
- **The club's own roles.** Settings, then Roles: make one from nothing or copy a built-in one, and pick
  what it can do, area by area. Give it to someone on their page. It holds only what a manager can do
  without asking, and the people who have it see only those areas in the staff app.
- **Bot protection** is on by itself: sign-up, sign-in codes and card forms ask the browser to solve a
  small puzzle first, and a hidden field catches scripts that fill in everything. Nothing to set up. On a
  practice machine, `KUMI_BOT_CHECK=0` turns it off for scripts that sign in over the API; production
  refuses to start that way.
- **A member's own email.** Profile, Email: a member adds one (an account that joined by phone) or
  changes it. A code goes to the new address first. On a change, the old address is told, with a link good
  for 14 days that puts it back, signs everyone out of the account, connected assistants too, and turns off
  its passkeys, authenticator app and a sign-in number added lately, for a change they didn't make. Adding or
  changing the number they sign in with works the same way: right after signing in (with the passkey, for
  someone who has one), and their email hears with the same kind of link. Someone with a passkey changes it signed in with the passkey (or two steps). An
  address another account uses gets the same answer as a free one, so nobody can find out who's a member;
  that address is told someone tried, and no code that works is sent.
- **Members' own assistants.** A member (or anyone) can connect Claude, ChatGPT or another assistant to
  the club at `https://<the members' app's address>/mcp` (the staff app's address works too; Profile,
  Assistants shows it). They sign in on the club's own page (by an emailed
  code, or a texted one when the club texts), then choose how
  much it may spend for them each week: nothing (the default), $25, $50, $100 or $200. What counts is money
  they themselves pay for what the assistant books (courts, shares, places, lessons, memberships, extra
  time), this week from Monday on the club's clock: what's charged or still waiting to be paid, less what
  came back to the card. A hold that lapses unpaid counts nothing. A court shared "pay my part" counts in
  full until the others pay, since what they don't pay goes on the organiser's card; the preview says so.
  Over the limit, the preview stops and says to do it in the app. In Profile, Assistants, they see what each
  spent this week, change its limit (up to $500) or disconnect it. Staff working for the club through an
  assistant (a refund, someone else's booking) aren't limited, since it isn't their own money; every change
  is still previewed first, and an assistant never does more than the person could.
- **What an assistant never does.** Its own limit, how the person signs in, deleting the account,
  accepting a waiver, moving their own level, downloading their data, the family card and saved cards, a
  parent's say over their children (a junior's login and rules, a charge past them, a second parent, leaving
  the family), saying yes to texts or club news (it can turn them off), and anything that needs a strong sign-in, such as club settings,
  roles and the vault. Those are done in the club's app; an assistant isn't offered them and is refused if
  it tries.

### Members' data: a copy, and deleting an account

Nothing to set up. Each member has a "Your data" box in Profile: one button downloads a JSON file of
everything the club's Kumi holds about them and the juniors they manage, receipts included (other people appear only by
the names they already see in the app), and the other deletes their account. The owner can do the same
from a member's page in the staff app when the member asks by email or at the desk; a manager's request
waits for the owner. The member is told when the club downloads their data, and the club hears of
every download and deletion.

Deleting waits until nothing is still running: bookings and places to come, a membership that would
charge again (or covers others), money owed, a kid's request. The member sees the list and how to clear
each. Then:

- **Removed:** their name (it becomes "Former member"), email, phone, sign-in addresses, passkeys,
  sessions, phones with notifications, agent access, friends, family links, the family card they saved,
  the kid rules for them, their notes, and the words of messages sent to them. Their name, email and
  phone are also taken out of the history: Changes, the events behind messages, other people's messages
  about something they were in, and other players' level reasons ("Won 6-3 with ..."). A junior only
  they manage is deleted the same way; a junior with another parent stays with that parent.
- **Kept:** payments, refunds and the ledger (the club's books need them), game results and levels
  (other players' levels are built on them), waiver acceptances and consent answers (the club's record
  of what was agreed), and the rows themselves, under "Former member". A membership that wouldn't
  charge again ends then, with nothing back for the rest of it.
- **Elsewhere:** Kumi can't reach copies outside it. Stripe keeps its own payment records, emails
  already delivered stay in inboxes, and backups keep the old data until they age out (14 days on the
  server; offsite, 30 daily copies and 12 monthly ones). Say so if a member asks.

The same address can join again later as a new member, with nothing of the old account.

### Moving the club, and read-only

A club can always take everything with it. The owner's **Download everything** (Settings in the staff
app, a passkey sign-in if the owner has a passkey) makes one file with all of the club's data: members,
bookings, payments, programs, levels, messages, settings, photos and documents, and the secrets Kumi keeps
sealed (staff authenticators, the push key, the vault). The file is sealed with a passphrase that Kumi
shows once, beside the download, and doesn't keep: put it in a password manager. On the server,
`kumi export` makes the same file, with a passphrase the owner types.

To run the club somewhere else, install Kumi there (the same version or a newer one), put the file on the
new server and restore it instead of setting the club up:

```bash
sudo install -o kumi -m 600 kumi-export-20261130T1900Z.kumi /var/backups/kumi/
sudo kumi restore /var/backups/kumi/kumi-export-20261130T1900Z.kumi --yes   # asks for the passphrase
```

It works like restoring a backup (the database as it was is kept first), then brings the club up to this
Kumi, seals the secrets with the new server's key, and says what's left to set up there: the keys for
email, texts and payments are the old server's or its host's, so the new server gets its own. If the
club's web address changed, passkeys stop working (a passkey belongs to its address): people sign in
with a code and add one again. A club that took card payments on its own Stripe account through a hosted
Kumi puts that account's keys in `KUMI_STRIPE_SECRET_KEY` and `KUMI_STRIPE_PUBLISHABLE_KEY`, so refunds
of earlier payments still work.

**Read-only** is a host's switch for an account that isn't paid: `kumi read-only on` (and `off`, and
`status`). Nothing is held back: everyone still signs in, sees everything, looks after their account
and downloads their data, and the owner can download everything. People can still cancel and leave,
with the club's usual refunds. Nothing new is booked, joined, sold or charged, and the club's settings
don't change. Both apps say so at the top, and `kumi doctor` shows it. While it's on:

- renewals wait (no card is charged, and no membership ends for it); they go through when it's off;
- at a shared court's deadline nothing is charged: what's unpaid is owed at the desk, and the organiser
  is told why;
- unpaid program places and presale memberships aren't let go (nobody can pay), and a place someone
  gives up isn't offered to the waitlist;
- payments already under way at Stripe, refunds, receipts, reminders, sign-in codes and club news
  already scheduled still go out; assistants follow the same rules as the apps.

### Notifications

Nothing to set up. Each member turns notifications on for their own phone in Profile, and from then
on every message the app sends them also arrives as a notification (quiet hours apply, as for email).
On an iPhone they have to add the app to the Home Screen first (Share, then Add to Home Screen); on
Android and computers it works in the browser. Staff turn them on in the staff app for staff alerts.

### Levels

Nothing to set up. Staff can give a member who already has a level elsewhere (Playtomic, say) that
level to start from, with a reason, on their level page; after that, rated results move it (a new
clinic or course isn't rated unless staff tick "results change levels"; socials, leagues and tournaments
are, unless staff untick it). A new player who feels it's wrong can move it once, by up to half a level, in their first 5 rated games,
and anyone can ask the club for a review (free, once every 30 days). Staff answer reviews on the
Levels page, which also lists any level that moved more than 0.50 in 30 days. After a clinic, the coach
who ran it or the front desk sets the levels of everyone who came in one go, from that date on the
program's page.

### Step 8: practice

Practice mode (`KUMI_PRACTICE=1`, on by default) sends real email only to the addresses in
`KUMI_MAIL_TEST_TO`, so the staff can try everything on themselves: create a clinic, sign up, pay
with Stripe's test card (4242 4242 4242 4242, any future date, any CVC), take someone off with or
without a refund, run an Americano night.

### Step 9: go live

Only when the owner says so:

1. Stripe: switch to live keys ([accounts/stripe.md](accounts/stripe.md), "Going live").
2. Email: remove `KUMI_PRACTICE=1` from `/etc/kumi/kumi.env`.
3. `systemctl restart kumi`, then `kumi doctor`: nothing should say FAIL, and `offsite` and
   `restore_test` should be `ok`. Optional pieces the club skipped say `off`.
4. Turn on "Members book courts in the app" (Settings, The club) if it isn't on yet.
5. Tell members where the app is. Kumi doesn't send that announcement for you.

Selling a founding offer before opening (step 5d)? Go live when the sales start, since members' cards
and emails must be real; keep "Members book courts in the app" off until the doors open.

## Commands, and where they run

`kumi` runs on the server: `ssh root@your-server kumi doctor`. Every command takes `--json` (for
agents) and `--lang=es` (for Spanish), and none of them prints a secret. Only `kumi export` and restoring
an export ask for something: the file's passphrase, typed by the owner (it isn't shown), or piped in.

| Command | What it does |
|---|---|
| `kumi setup plan [file]` | What setting the club up from the file would change. Changes nothing. |
| `kumi setup apply [file]` | Makes those changes, through the same checked and audited actions the apps use. |
| `kumi import members <file.csv> [--apply]` | Adds members from a spreadsheet; a preview unless `--apply`. Emails nobody. |
| `kumi doctor` | Checks the database, the club, the address, email, texts, ask the club, payments, Apple Pay and Google Pay, Playtomic, backups, the offsite copy, the restore test and the server's key. |
| `kumi reset-sign-in <email>` | Starts someone's second sign-in step over: a lost phone, or an owner locked out. |
| `kumi texting plan \| apply \| status` | Registers the club's texting with US carriers through its own Twilio account ([accounts/twilio.md](accounts/twilio.md)). `apply --yes` to buy a number. |
| `kumi backup` | Tonight's backup now: the dump and its manifest, and the offsite copy if it's set up. |
| `kumi offsite` | What's kept offsite. |
| `kumi restore-test` | Restores the newest backup into a scratch database and checks every table. |
| `kumi rotate-key` | Seals every secret with `KUMI_SECRET_KEY` (the old key in `KUMI_SECRET_KEY_PREVIOUS`). |
| `kumi export [--out=<folder>]` | Everything the club needs to run somewhere else, in one file sealed with a passphrase the owner types. |
| `kumi read-only on \| off \| status` | The host's switch for an account that isn't paid: nothing new is booked or charged; everyone keeps their data. |
| `sudo kumi restore <file \| offsite:latest> --yes` | Replaces the database with a backup, or with a club's export: stops the server, restores, starts it. Everything since is lost. |
| `sudo kumi releases`, `sudo kumi rollback --yes` | Which release runs; going back to the previous one and its database (see `deploy/README.md`). |
