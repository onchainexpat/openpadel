# Email: Resend

**What it's for:** sign-in codes, and the messages Kumi sends: a place offered from the waitlist,
confirmations, removals and refunds, and staff alerts. Without it, all of that only reaches the
server's log.
**Who does what:** the owner creates the Resend account and adds the DNS records. The agent adds
the domain in Resend (or tells the owner what to click), checks the records and sets Kumi up.
**Time and cost:** 30 minutes. Resend's free plan (October 2026) sends 3,000 emails a month and 100 a
day, across up to 3 domains. A busy club will pass 100 a day once members use it; Pro is $20 a
month for 50,000 with no daily limit.
**`kumi doctor` checks:** `email`.

## Steps

1. **Owner: create a Resend account** at resend.com, just for the club. Sharing one with another
   business shares its daily limit, and its reputation if either gets suspended.
2. **Add the domain in Resend** (Domains, then Add domain). Use a subdomain such as
   `mail.yourclub.com`, so email problems never touch the main domain. Region: the nearest to the
   club.
3. **Owner: add the DNS records Resend shows** at the domain's registrar: a TXT record for DKIM,
   two CNAMEs for sending, and optionally a DMARC TXT. Resend's hosts are relative to the main
   domain (for example `resend._domainkey.mail`). Copy the long DKIM value exactly.
4. **Agent: check they're live** before asking Resend to verify:
   ```bash
   dig +short TXT resend._domainkey.mail.yourclub.com
   dig +short CNAME send.mail.yourclub.com
   ```
   Then click "verify" in Resend. It usually takes minutes.
5. **Owner: create an API key** (API keys, then Create) with **Sending access** only, limited to
   the domain. Add it to the server's settings file by typing it in, never through the chat:
   ```
   KUMI_RESEND_API_KEY=re_...
   KUMI_MAIL_FROM="Your Club <hello@mail.yourclub.com>"
   KUMI_MAIL_REPLY_TO=desk@yourclub.com          # optional: where replies go
   KUMI_MAIL_TEST_TO=owner@example.com,staff@example.com   # practice mode only
   ```
6. **Agent:** `systemctl restart kumi`, then `kumi doctor`. While `KUMI_PRACTICE=1` is set, only the
   `KUMI_MAIL_TEST_TO` addresses get real email; everyone else's is held and logged.
7. **Test:** sign in to the staff app as an address on the test list; the code should arrive
   within a minute. Check the spam folder the first time.

## Common problems
- **Resend says the domain isn't verified:** a record is missing or mistyped (the DKIM value is
  the usual one). Compare `dig` with what Resend shows.
- **`email` fails with "KUMI_MAIL_FROM isn't set":** add it; it must be an address on the
  verified domain.
- **Emails land in spam:** add the DMARC record, and send from the subdomain you verified.
- **Resend's dashboard shows nothing yet:** on a new account it can lag. The inbox is the real test.
