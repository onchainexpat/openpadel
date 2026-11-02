# Texts: Twilio

**What it's for:** a text when something needs a member soon: a place offered with a deadline, or a booking
or class the club cancelled or moved. Members choose texts in the app (Profile, Texts): they confirm their
number with a texted code, then tick the yes themselves. Without Twilio, members still get all of it by push
and email. Optional.
**Who does what:** the owner creates the Twilio account, buys a number and registers the club's texting with
US carriers in Twilio's console. The agent sets Kumi up and checks it.
**Time and cost:** an hour of setup, then the carriers' review: a few days for a toll-free number, one to
three weeks for a local number (A2P 10DLC). Twilio's prices (October 2026): about $0.0083 a text plus a
carrier fee of about $0.003, a number at $1.15 a month (toll-free $2.15), and for a local number a
registration fee and about $10 a month for the campaign. Kumi keeps texts to one segment where it can.
**`kumi doctor` checks:** `texts`.

US carriers block texts from numbers that aren't registered. **Until the club's registration is approved,
real texts won't reach anyone**, and `kumi doctor` will show texts failing. Registration is the club's to do in
its own Twilio console for now.

## Steps

1. **Owner: create a Twilio account** at twilio.com, just for the club, and upgrade it from the trial (a
   trial only texts numbers you've confirmed in Twilio).
2. **Owner: get a number.** Toll-free is quicker to approve and suits a small club; a local number reads
   as the club's own. Phone Numbers, then Buy a number, with SMS.
3. **Owner: register it.** Toll-free: Messaging, then Regulatory compliance, then Toll-free verification.
   Local: Messaging, then Regulatory compliance, then A2P 10DLC (a brand for the club, then a campaign).
   Describe the use as account notifications to the club's own members, who opt in in the club's app, and
   use this as the sample opt-in: "Yes, Your Club may text me about my bookings and places. Message and
   data rates may apply. Reply STOP to stop, HELP for help." The club's website and privacy policy must be
   live first.
4. **Owner: make a Messaging Service** (Messaging, then Services), add the number to it, and in its
   Integration settings send incoming messages to a webhook:
   `https://staff.yourclub.com/webhooks/twilio/sms` (the staff app's address, `KUMI_PUBLIC_URL`).
   Twilio answers STOP itself. In the service's Opt-out management, clear Twilio's own replies to HELP and
   START, since Kumi answers those with the club's name; leave STOP's.
5. **Owner: add the settings** to the server's settings file by typing them in, never through the chat. The
   Account SID and Auth Token are on the Twilio console's home page:
   ```
   KUMI_TWILIO_ACCOUNT_SID=AC...
   KUMI_TWILIO_AUTH_TOKEN=...
   KUMI_TWILIO_MESSAGING_SERVICE_SID=MG...        # or KUMI_TWILIO_FROM=+15035550123, one number
   KUMI_SMS_TEST_TO=+15035550123,+15035550124     # practice mode only: who gets real texts
   ```
6. **Agent:** `systemctl restart kumi`, then `kumi doctor`. While `KUMI_PRACTICE=1` is set, only the
   `KUMI_SMS_TEST_TO` numbers get real texts; everyone else's are held and logged.
7. **Test:** in the members' app, signed in as someone on the test list, open Profile, then Texts: ask for a
   code, confirm it, tick the yes and turn texts on. Then text HELP to the club's number: the answer should
   start with the club's name.

## How Kumi texts
- Only US and Canadian numbers, and only to a number its member confirmed with a code. Each yes is kept with
  the words they saw, its version, the number and the device they said it on.
- Codes are guarded against people using them to run up the club's bill (SMS pumping): the bot check, no
  Caribbean or premium numbers, and at most 3 codes a number, 5 a member and 30 for the whole club an hour.
- STOP (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) turns off every message to that member, on every channel,
  at once. START turns texts back on; the rest they turn back on in the app.
- Texts wait out quiet hours like email, except the ones that can't wait (a cancellation by the club).
- A kid with a login of their own says yes for themselves, once a parent turns texts on for them on the
  Family page. A junior without a login is texted through their parents.

## Common problems
- **`texts` says Twilio refused the account and token:** a typo, or the token was changed in Twilio.
- **Texts fail with 30034 or 30032:** the registration isn't approved yet (or was turned down). Twilio's
  console says which.
- **A member says they never got the code:** a landline (Kumi says so), a number that once replied STOP
  (they text START to the club's number first), or the per-hour limits.
- **`texts` says test credentials:** Twilio's test credentials never reach a phone. Use the live ones.
