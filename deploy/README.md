# Running Kumi on one server

For a club running Kumi itself, and for Kumi's own trial server. One small Ubuntu 24.04 server (2 GB of
memory is plenty for a club) runs Postgres 17, the API, both apps and HTTPS.

```bash
# once, on the new server, as root: KUMI_HOST is the members' app; staff use staff.<KUMI_HOST>
KUMI_HOST=app.yourclub.com bash server-setup.sh
# from a checkout, each time you update:
deploy/ship.sh root@your.server.ip
```

- **HTTPS** comes from Caddy and Let's Encrypt, for `KUMI_HOST` and `staff.KUMI_HOST`. Point both at the
  server in DNS first. Without a domain yet, `<ip-with-dashes>.sslip.io` works for a trial.
- **Settings** live in `/etc/kumi/kumi.env` (Stripe, Resend, Playtomic keys): edit, then
  `systemctl restart kumi`. Never commit them.
- **Practice mode** (`KUMI_PRACTICE=1`, the default here) sends real email only to `KUMI_MAIL_TEST_TO`.
  Remove it when the club switches over.
- **Backups:** `pg_dump` every night at 3:17 to `/var/backups/kumi`, kept 14 days. Copy them off the
  server too; a backup on the same disk doesn't survive losing the server.
- **Logs:** `journalctl -u kumi -f`. Until email is set up, sign-in codes are in that log.
