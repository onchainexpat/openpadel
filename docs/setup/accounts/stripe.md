# Card payments: Stripe

**What it's for:** members pay for clinics, socials, Americanos, courts and memberships by card
(Apple Pay and Google Pay work too, as cards), and refunds go straight back to the card. The money goes into the club's own
Stripe account and Stripe pays it out to the club's bank. openPadel takes no commission and never sees
card numbers: they go from the member's browser to Stripe.
**Who does what:** the owner creates the Stripe account and gives Stripe the business, identity
and bank details on Stripe's own pages. Never through the agent or the chat. The agent sets openPadel up
and runs the tests.
**Time and cost:** 20 minutes to sign up, then Stripe checks the business, which can take a few days.
Stripe charges its usual card fee per payment and keeps it when a payment is refunded. Memberships
renew from the card the member joined with, charged by openPadel when each period ends, so there's no
Stripe Billing subscription and no Billing fee on top.
**`openpadel doctor` checks:** `payments`, `wallets`.

## Steps

1. **Owner: create the Stripe account** at stripe.com and complete "Activate payments" with the
   club's legal name, address and bank account. Start this first; it's the slowest part.
2. **Owner: copy the test keys** (Developers, then API keys, with "Test mode" on): the publishable
   key `pk_test_...` and the secret key `sk_test_...`. Type them into the server's settings file:
   ```
   KUMI_STRIPE_SECRET_KEY=sk_test_...
   KUMI_STRIPE_PUBLISHABLE_KEY=pk_test_...
   ```
3. **Owner: add the webhook** (Developers, then Webhooks, then Add endpoint):
   - URL: `https://staff.app.yourclub.com/webhooks/stripe`
   - Events: `payment_intent.succeeded`, `payment_intent.payment_failed`,
     `payment_intent.canceled` and `setup_intent.succeeded` (a card saved for a founding membership, or a family card)
   - Then copy its signing secret into the settings file: `KUMI_STRIPE_WEBHOOK_SECRET=whsec_...`

   Payments are also checked every 30 seconds, so a missed webhook never loses one; the webhook
   just makes it instant.
4. **Owner: turn off Stripe's own receipt emails** (Settings, then Customer emails, then "Successful
   payments" and "Refunds" off). openPadel sends a receipt for every payment and refund itself, in the
   member's language and in the app; with Stripe's on too, members get two. openPadel never asks Stripe to
   email one.
5. **Agent:** `systemctl restart kumi`, then `openpadel doctor`: `payments` should say test mode, and
   `wallets` that Apple Pay and Google Pay are on for the members' address. Stripe shows them on the
   card form only on a web address registered with it; the server registers the members' address
   itself when it starts (Settings, then Payment method domains, in Stripe's dashboard lists it), and
   Stripe does Apple's check, so there's no file to put on the server. Test mode and live mode
   register separately: after going live, the server registers it for live as it restarts.
6. **Test:** in the members' app, sign up for a paid clinic and pay with 4242 4242 4242 4242 (any
   future date, any CVC): a receipt arrives within a minute (Profile, then Receipts, and by email). Then
   take that member off in the staff app with a refund, and check the refund in Stripe's dashboard and
   the refund receipt.

## Going live (only when the owner says so)
Stripe has finished checking the business, and the club has practised with test payments. In the
settings file, replace both keys with the live ones (`sk_live_...`, `pk_live_...`), add a live-mode
webhook with the same URL and events and use its secret, and restart. openPadel refuses a live key
unless `NODE_ENV=production` (the server setup sets it).

## Common problems
- **`payments` fails, "a LIVE Stripe key outside production":** use the test keys on anything that
  isn't the club's real server.
- **"Pay" does nothing for members:** the publishable key is missing or from a different Stripe
  account than the secret key.
- **Stripe asks for more information:** only the owner can answer, in Stripe's dashboard.
- **No Apple Pay or Google Pay on the card form:** `openpadel doctor`'s `wallets` line says why. They need
  the members' app on a public HTTPS address, a browser and device that has them set up (Safari with a
  card in Apple Wallet; Chrome with a card saved in Google Pay), and the domain registered (restart the
  server to register it again). A domain switched off in Stripe's dashboard is switched back on.
