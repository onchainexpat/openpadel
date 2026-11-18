# Accounting export for Xero and QuickBooks Online

An openPadel plugin: early each morning it sends the club day before to the club's own Xero or QuickBooks Online as one
manual journal: takings by kind (courts, lessons, programs, memberships, anything else), refunds, sales tax, card fees,
card payouts, club credit, gift cards and passes. It is a separate program. It talks to the club only through the
club's door (`/mcp`, with its own token) and to Xero or Intuit through their public APIs, and needs nothing but Node 24
or later: no packages, no database.

Its manifest is [docs/plugins/examples/accounting-export/openpadel-plugin.json](../../docs/plugins/examples/accounting-export/openpadel-plugin.json)
(the same one is in openPadel's bundled catalog). It changes nothing at the club, reads the club's money, and moves no
money: it only reports.

## What it sends

Amounts and kinds only. Each journal line is a total for the day, such as "Court takings [takings.courts] -120.00" or
"Card fees [card.fees] 4.07". No member's name, email, phone number, booking or payment leaves the club.

## What it does

- **One journal per club day**, in the club's own time zone. Once the club's clock passes the send time (`send_at`,
  06:00 unless set), every day that's over and not yet sent goes, oldest first, from `start_date` on. After the plugin
  (or the accounting system) was down, it catches up the same way, never out of order: it stops at the first day that
  fails and tries again later.
- **Balanced to the cent.** The club's books are double entry: each day's lines (debits positive, credits negative)
  add up to zero, in integer cents, and the plugin checks that again before it sends. A day with nothing in it sends
  nothing.
- **Never twice.** Before it sends a day, it asks the accounting system for that day's reference (Xero: the narration
  "openPadel 2026-11-15 (Club)"; QuickBooks: the document number `OP-20261115`). What's there is what was sent,
  whatever the plugin remembers, so a lost state file or a crash between "sent" and "noted" never sends a day again.
  Each POST also carries an idempotency key (Xero's `Idempotency-Key`, QuickBooks' `requestid`), and the plugin writes
  down what it's about to send before it sends it.
- **Late changes.** A refund made after a day was sent is in the club's books on the day it was made, so it goes in
  that day's journal. A change dated back to a day already sent (a card payment found after a restore, say) is caught
  the next morning: the last 7 sent days are read again, and a day whose books changed gets an adjusting journal of
  the difference, dated the day it's sent and naming the day it corrects ("openPadel adjustment to 2026-11-15 #1",
  QuickBooks `OP-20261115-A1`). It's sent once: the next read finds it.
- **Accounts from the settings.** Each line goes to the account its setting names. A line whose account isn't set
  goes to `account_other` (a suspense account), and the Money card says how many did.
- **Its cards.** On Connectors: "Connect Xero" (the owner's link), then "Connected to <organisation>", the last day
  sent, the next send, and anything wrong. On Money: where it sends, the last day sent, the next send, lines without
  an account, and anything wrong. Both in English and Spanish. A club whose openPadel doesn't show plugin cards yet is
  asked again hourly; the export works the same without them.
- **Never a day without Stripe's figures.** When the club can't read a day's card fees or payouts from Stripe
  (`money_books` says `"error"` for them), that day isn't sent, and nor is any day after it: they wait in order and are
  tried again with the same backoff. The Money card says "Waiting for Stripe to send Tue, Dec 1" (tone warn). After 3
  days of it, the card says Stripe hasn't answered for 3 days and health reports it (`failing: "stripe_long"`, HTTP
  503); days still aren't sent without those figures. A club with no Stripe account sends days without them.
- **Failures.** A 429 waits out its Retry-After (up to a minute, twice) before giving up for the minute; a provider
  that's down or doesn't answer is tried again after 5 seconds, doubling to 5 minutes; an access token the provider
  refuses is refreshed once; a refresh token it refuses (the app disconnected, or unused for 60 days) makes the
  Connectors card ask the owner to connect again. Health (below) says what's failing.

## Setting it up at the club

The club's agent installs it, and the owner says yes to the preview (see [docs/plugins/README.md](../../docs/plugins/README.md)):

```bash
openpadel plugin install --name accounting-export
openpadel plugin configure --plugin accounting-export --settings '{"provider": "xero", "start_date": "2026-12-01", "account_courts": "200", "account_card": "610", "account_other": "999"}'
```

| Setting | What |
|---|---|
| `provider` | `xero` (the default) or `quickbooks`. |
| `send_at` | The club's time the day before is sent, `HH:MM` (06:00). |
| `start_date` | The first club day sent, `YYYY-MM-DD` (required). Days before it are never sent. |
| `account_courts` | Court takings (required). In Xero, an account code; in QuickBooks, the account's number, or its name. |
| `account_lessons`, `account_programs`, `account_memberships`, `account_other_income` | Takings of each kind. |
| `account_refunds` | Refunds. Left empty, a refund comes off the account it was taken into. |
| `account_tax` | Sales tax collected (less tax refunded). |
| `account_card` | The card provider's clearing account (required): card payments in; card refunds, fees and payouts out. |
| `account_card_fees` | The card provider's fees (an expense). |
| `account_bank` | The bank account payouts arrive in. |
| `account_cash` | Cash taken at the desk. |
| `account_receivable` | What players owe the club. |
| `account_credit`, `account_gift_cards`, `account_passes` | Club credit, gift cards and passes the club owes (liabilities). |
| `account_other` | Anything else (required): a suspense account. |

### Connecting Xero (the owner)

1. At [developer.xero.com](https://developer.xero.com), My Apps, **New app**: a *Web app*, with the **redirect URI**
   the plugin's card on Connectors shows (`https://<the club's staff address>/plugins/accounting-export/callback`).
2. Copy its **Client id**, and under Configuration **Generate a secret**.
3. In the club's vault, add them as `accounting-export/XERO_CLIENT_ID` and `accounting-export/XERO_CLIENT_SECRET`, or on
   the server with `openpadel plugin secret accounting-export XERO_CLIENT_ID`. While the `provider` setting is `xero`
   (the default), the club asks the owner for these two (a vault request, and the plugin's card on Connectors needs
   attention until they're there); the QuickBooks keys aren't asked for. Choosing `quickbooks` asks for those instead.
4. On Connectors, press **Connect Xero** on the plugin's card, sign in to Xero and allow the organisation. The owner or
   a manager may press it (both see Connectors): whoever signs in to Xero connects the club's organisation.

The plugin asks for `offline_access accounting.transactions accounting.settings.read`. Xero gives apps made after
March 2026 granular scopes instead; if the app's scopes differ, set `XERO_SCOPES` in the plugin's environment to the
ones Xero lists for manual journals, with `offline_access`.

### Connecting QuickBooks Online (the owner)

1. At [developer.intuit.com](https://developer.intuit.com), Dashboard, create an app for **QuickBooks Online and
   Payments** with the `com.intuit.quickbooks.accounting` scope, and add the **redirect URI** the card shows under
   Keys and credentials (Production).
2. Add its Client ID and Client Secret in the club's vault as `accounting-export/QUICKBOOKS_CLIENT_ID` and
   `accounting-export/QUICKBOOKS_CLIENT_SECRET`.
3. Set the plugin's `provider` to `quickbooks`, and press **Connect QuickBooks** on its card.

### What happens when the owner connects

The card's link is the provider's sign-in, with a one-time `state` and a PKCE challenge the plugin keeps (good for 24
hours). The provider sends the owner's browser back to the club at `/plugins/accounting-export/callback`; the club
passes the query on to the plugin as a POST to `<its address>/callback`, signed with the registration's hook secret
(`openpadel-signature`), and sends the browser to its own Connectors page: nothing the plugin answers is shown at the
club's address. The plugin checks the signature and the state (one it didn't give, or one used already, is refused and
nothing is kept), trades the code for tokens, and keeps the refresh token (and QuickBooks' company id) in the club's
vault through the door, as `XERO_REFRESH_TOKEN`, `QUICKBOOKS_REFRESH_TOKEN` and `QUICKBOOKS_COMPANY_ID`: keys its
manifest marks `kept_by_plugin`. Whoever installed it never sees them.

Both providers hand out a new refresh token each time one is used. The plugin keeps each new one in the vault
(`plugin_secret_keep_preview`, then `_confirm`) before it does anything else with the access token. If the club's door
doesn't take it right then, the plugin holds it (in its state file where it has one) and keeps it on the next tick;
Xero lets the old one work for 30 minutes meanwhile. Access tokens live in memory only.

## What the club gives it (the door)

| Tool | What |
|---|---|
| `plugin_settings` | Its settings, and which keys are in the vault. |
| `plugin_secret` `{ name }` | A key its manifest declares. |
| `plugin_secret_keep_preview` `{ name, value }`, `plugin_secret_keep_confirm` `{ run_id }` | Keeps a key its manifest marks `kept_by_plugin`; anything else is refused. |
| `money_books` `{ from, to }` | The club's books by club day (at most 31 days): `{ currency, time_zone, today, days: [{ date, complete, fees, payouts, lines: [{ key, cents }] }] }`, each day's lines summing to 0. |
| `plugin_card_put_preview` / `_confirm` | Its `connectors` and `money` cards. |

The book line keys: `takings.<kind>` and `refunds.<kind>` (courts, lessons, programs, memberships, after_restore,
other; net of tax), `tax`, `credit.added` / `credit.used`, `gift_cards.sold` / `gift_cards.used`, `passes.sold` /
`passes.used`, `card.in` / `card.out`, `card.fees` / `card.fees_out`, `bank.payouts` / `card.payouts_out`, `cash.in` /
`cash.out`, `receivable.up` / `receivable.down`, `refunds_payable`, `adjustment`, `brought_in`. Each journal line's
description ends with its key in brackets, which is how the plugin reads back what a journal said.

## Running it

### On the club's own server (local)

```bash
node tools/pack.ts --release-url https://github.com/openpadel/plugin-accounting-export/releases/download/v0.1.0/accounting-export-0.1.0.tar.gz
```

makes `dist/accounting-export-0.1.0.tar.gz` (the same bytes every time from the same files) and
`dist/openpadel-plugin.local.json`, the manifest with `run.mode` `local` pinning it by SHA-256. Publish the archive at
that address and install with that manifest; then `sudo openpadel plugin service accounting-export --apply`. The club
writes `OPENPADEL_URL`, `OPENPADEL_MCP`, `OPENPADEL_TOKEN`, `OPENPADEL_WEBHOOK_SECRET`, `OPENPADEL_HOOK_SECRET` and
`PORT` into its environment; it listens on 127.0.0.1 and keeps its state in systemd's `STATE_DIRECTORY` when it's
given one (without one it keeps it in memory, and still never sends a day twice).

### On any host (remote)

```bash
PORT=8080 STATE_DIR=/var/lib/accounting-export node src/main.ts
```

behind https at the manifest's `run.url`. The club POSTs its signed registration to `<url>/register` (checked against
the club's key at `/.well-known/openpadel-plugin-key`), `plugin.configured` events to `<url>/events`, and browsers'
returns to `<url>/callback`. `OPENPADEL_CLUBS` (a comma-separated list of club addresses) limits who may register;
`OPENPADEL_DEV=1` lets a club on http (this machine) register.

### Health

`GET <url>/health`: `{ ok, provider, connected, last_sent_day, next_send_at, failing }`, 503 while sending fails or
the provider asks to be connected again. Nothing in it names the club or its organisation. Waiting for keys or a
start date isn't failing: the cards say what's missing.

## Tests

`node --test test/*.test.ts` (and the repository's `npm test`): a fake club, a fake Xero and a fake QuickBooks on
127.0.0.1.

## Limits

- Amounts are sent with two decimals; a currency without cents (JPY, say) isn't handled yet.
- A day's journal in QuickBooks takes at most 9 adjustments (`OP-20261115-A1` to `-A9`).
- After the state file is lost, the first send reads back every day since `start_date` from the provider once.
- Xero's and Intuit's own limits apply (Xero: 60 calls a minute and 5,000 a day per organisation).
