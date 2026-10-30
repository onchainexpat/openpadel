# Setting up Kumi for your club

This guide is written for a club owner and for the owner's AI agent (Claude Code, Codex or another)
working together. The agent can do most of it. The owner does the parts that need their identity,
their payment details or their decision; each step says which is which.

**Agents:** read the rules at the top of [`AGENTS.md`](../../AGENTS.md) first. Then run
`kumi doctor --json` (once the server exists) and work on the first check that isn't `ok`.

Kumi runs on the club's own server ("self-hosted"). A hosted service, where Kumi runs it for you,
is planned but not offered yet.

## What you end up with

- The members' app at your address, for example `https://app.yourclub.com`, and the staff app at
  `https://staff.app.yourclub.com`. Both work on a phone or a computer, in English and Spanish.
- Court bookings members make and pay for in the app (the whole court, or their own part), and staff
  manage at the desk; clinics, socials and Americanos with waitlists and refunds.
- Email from your own domain, card payments into your own Stripe account, nightly backups.

## The order

Start the slow items first: Stripe checks a new business account before it pays out, which can
take a few days.

| # | Step | Who | Time | Guide |
|---|---|---|---|---|
| 1 | Collect the club's details | Agent drafts from the club's website, owner checks | 30 min | [club-packet.md](club-packet.md) |
| 2 | Create the Stripe account (start now, it's the slowest) | Owner | 20 min, then days of checks | [accounts/stripe.md](accounts/stripe.md) |
| 3 | Domain, server and HTTPS | Owner buys, agent sets up | 1 hour | [accounts/server.md](accounts/server.md) |
| 4 | Describe the club in `club.yaml`, preview, apply | Agent, owner approves the plan | 20 min | below |
| 5 | Email from the club's domain | Owner signs up, agent sets up | 30 min | [accounts/resend.md](accounts/resend.md) |
| 5b | Bring in the existing members (optional) | Owner exports a spreadsheet, agent imports | 15 min | below |
| 5c | Courts, prices and booking rules | Owner decides, staff app | 20 min | below |
| 5d | Membership plans (optional) | Owner decides, staff app | 10 min | below |
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

In the staff app's Settings: each location's opening hours and special days, court prices (by day,
time and season), the sales tax rate, and the booking rules (how far ahead, how many at once, the
cancellation window, when unpaid shares are charged). Members only book courts in the app once
"Members book courts in the app" is on; leave it off while the club books courts in Playtomic.

### Step 5d: memberships (optional)

If the club sells memberships, add its plans under Memberships in the staff app: a name, the price a
month or a year, and how far ahead its members can book courts when that's longer than the club's
rule. Member prices on courts are court prices for chosen plans (Settings, Prices: tick the plans).
Where a member price and an everyone price have the same priority, the member price wins.

Members join in the app (Membership) and pay by card. Kumi renews each membership from that card when
its month or year is up, at the price the member joined at. If the card is declined, the membership
carries on while Kumi tries again two days later and three days after that, and the member can pay
with another card meanwhile; after the third try it ends. Members cancel in the app, and it runs to
the end of what they've paid. A plan with "join in the app" off is only given at the desk.

For a founding offer (a new club selling memberships before it opens), give a plan a limit, a start
date, or both. Members who join before the start date save their card, without being charged, and
keep their place; Kumi makes the first charge on the start date and renews monthly or yearly from
there. A place whose card isn't saved within two hours is let go, so the limit only counts real
members. Members can give up their place before the start, and nothing is charged.

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

### Notifications

Nothing to set up. Each member turns notifications on for their own phone in Profile, and from then
on every message the app sends them also arrives as a notification (quiet hours apply, as for email).
On an iPhone they have to add the app to the Home Screen first (Share, then Add to Home Screen); on
Android and computers it works in the browser. Staff turn them on in the staff app for staff alerts.

### Step 8: practice

Practice mode (`KUMI_PRACTICE=1`, on by default) sends real email only to the addresses in
`KUMI_MAIL_TEST_TO`, so the staff can try everything on themselves: create a clinic, sign up, pay
with Stripe's test card (4242 4242 4242 4242, any future date, any CVC), take someone off with or
without a refund, run an Americano night.

### Step 9: go live

Only when the owner says so:

1. Stripe: switch to live keys ([accounts/stripe.md](accounts/stripe.md), "Going live").
2. Email: remove `KUMI_PRACTICE=1` from `/etc/kumi/kumi.env`.
3. `systemctl restart kumi`, then `kumi doctor`: everything should be `ok`.
4. Tell members where the app is. Kumi doesn't send that announcement for you.

## Commands, and where they run

`kumi` runs on the server: `ssh root@your-server kumi doctor`. Every command takes `--json` (for
agents) and `--lang=es` (for Spanish), and none of them prompts or prints a secret.

| Command | What it does |
|---|---|
| `kumi setup plan [file]` | What setting the club up from the file would change. Changes nothing. |
| `kumi setup apply [file]` | Makes those changes, through the same checked and audited actions the apps use. |
| `kumi import members <file.csv> [--apply]` | Adds members from a spreadsheet; a preview unless `--apply`. Emails nobody. |
| `kumi doctor` | Checks the database, the club, the address, email, payments, Playtomic and backups. |
