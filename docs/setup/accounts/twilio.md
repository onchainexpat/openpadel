# Texts: Twilio

**What it's for:** a text when something needs a member soon: a place offered with a deadline, or a booking
or class the club cancelled or moved. Members choose texts in the app (Profile, Texts): they confirm their
number with a texted code, then tick the yes themselves. Without Twilio, members still get all of it by push
and email. Optional.
**Who does what:** the owner creates the Twilio account, puts its keys in the settings file and writes the
business's details in club.yaml. The agent runs `kumi texting`, which buys a toll-free number, makes the
Messaging Service and registers the club's texting with US carriers, then checks it.
**Time and cost:** an hour of setup, then the carriers' review: about three business days for a toll-free
number. Twilio's prices (October 2026): about $0.0083 a text plus a carrier fee of about $0.003, and a
toll-free number at $2.15 a month; toll-free has no registration or campaign fees. Kumi keeps texts to one
segment where it can.
**`kumi doctor` checks:** `texts`.

US carriers block texts from numbers that aren't registered. **Until the club's registration is approved,
real texts won't reach anyone.** Kumi turns texts on by itself when Twilio approves.

## Steps

1. **Owner: create a Twilio account** at twilio.com, just for the club, and upgrade it from the trial (a
   trial only texts numbers you've confirmed in Twilio).
2. **Owner: add the keys** to the server's settings file by typing them in, never through the chat. The
   Account SID and Auth Token are on the Twilio console's home page (the live ones, not the test credentials):
   ```
   KUMI_TWILIO_ACCOUNT_SID=AC...
   KUMI_TWILIO_AUTH_TOKEN=...
   KUMI_SMS_TEST_TO=+15035550123,+15035550124     # practice mode only: who gets real texts
   ```
   The agent restarts Kumi (`systemctl restart kumi`).
3. **Owner: the business's details** go in club.yaml's `texting:` section (club.example.yaml has every
   field): the legal name exactly as registered, the EIN, the address, the website, who Twilio contacts, and
   about how many texts a month. No keys go in club.yaml. **The club's website and privacy policy must be
   live and public first**, and the privacy policy should say members' mobile numbers aren't shared with
   anyone for marketing; carriers turn registrations down for that more than anything.
4. **Agent: `kumi texting plan`.** It says what it would do and what club.yaml is still missing, and
   changes nothing. Show it to the owner: the verification it sends is the owner's word about the business.
5. **Agent, once the owner agrees: `kumi texting apply --yes`.** It:
   - buys a toll-free number that can text (or uses `texting.number`, one the club already has);
   - makes a Messaging Service, "Club name texts (Kumi)", sending texts members reply with to
     `https://staff.yourclub.com/webhooks/twilio/sms` and delivery reports to `.../webhooks/twilio/status`
     (the staff app's address, `KUMI_PUBLIC_URL`), and puts the number in it;
   - sends the toll-free verification: account notices and sign-in codes to the club's own members, who opt
     in on a web form in the app. Kumi writes the use case, a real sample text and the opt-in description
     itself, and points the reviewers at `https://yourclub.com/public/texts`, a page on the members' address
     showing the exact words members tick. Add screenshots of your own with `texting.opt_in_image_urls`.

   Running it again carries on where it stopped and never buys or sends anything twice. Without `--yes` it
   stops before anything that costs money.
6. **Owner: Twilio's console, once.** In the Messaging Service's Opt-out management, clear Twilio's own
   replies to HELP and START, since Kumi answers those with the club's name; leave STOP's.
7. **Wait for the review.** `kumi texting status` (or Settings, Texts) says where it stands. The server asks
   Twilio every hour; the owner and managers get one email when it's decided. Once approved, texts go from
   the Messaging Service, with nothing to change in the settings.
8. **If Twilio says no:** `kumi texting status` gives each reason with what fixes it (a business name that
   doesn't match the IRS records, a website that isn't live). Correct club.yaml, then `kumi texting apply`
   sends the corrected one while Twilio allows edits (about seven days); after that, `kumi texting apply --yes`
   sends a new one.
9. **Test:** in the members' app, signed in as someone on the test list, open Profile, then Texts: ask for a
   code, confirm it, tick the yes and turn texts on. Then text HELP to the club's number: the answer should
   start with the club's name.

**Already have a registered number?** Skip `kumi texting`: put `KUMI_TWILIO_MESSAGING_SERVICE_SID=MG...` (or
`KUMI_TWILIO_FROM=+1...`, one number) in the settings file and point the Messaging Service's incoming texts at
`https://staff.yourclub.com/webhooks/twilio/sms` yourself. A sender in the settings file always wins.

**Texting a lot more (local numbers, A2P 10DLC).** Toll-free suits a club's volume. A club that texts tens of
thousands a month, or wants a local number, registers A2P 10DLC in Twilio's console instead: a brand for the
club (about $4.50, plus $41.50 for the standard vetting), then a campaign (a $15 vetting, then about $10 a
month), reviewed in one to three weeks. Use the same description, sample texts and opt-in page Kumi sent for
toll-free (`kumi texting plan --json` prints them), then put the Messaging Service's `MG...` in the settings
file. Kumi doesn't register 10DLC by itself yet.

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
- **Texts fail with 30034 or 30032:** the registration isn't approved yet (or was turned down).
  `kumi texting status` says which.
- **`kumi texting` says test credentials:** registering needs the account's live Account SID and Auth Token.
- **A member says they never got the code:** a landline (Kumi says so), a number that once replied STOP
  (they text START to the club's number first), or the per-hour limits.
- **`texts` says test credentials:** Twilio's test credentials never reach a phone. Use the live ones.
