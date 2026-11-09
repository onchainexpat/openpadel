# Domain, server and HTTPS

**What it's for:** the address members and staff use, and the machine openPadel runs on.
**Who does what:** the owner buys the domain and the server (both need a payment card) and adds
the DNS records. The agent does everything on the server over SSH.
**Time and cost:** about an hour. A domain is about $10 to $30 a year; a server with 2 GB of memory
is about $12 a month at DigitalOcean, Hetzner, Vultr or Linode.
**`openpadel doctor` checks:** `database`, `migrations`, `address`, `backups`.

## Have ready
- A domain the club controls, or a subdomain of the club's existing one.

## Steps

1. **Owner: create the server.** Ubuntu 24.04, 2 GB of memory, in the region nearest the club. Add
   an SSH key when asked (not a password), so the agent can sign in with it: your agent makes one with
   `ssh-keygen` and gives you the line from its `.pub` file to paste in.
2. **Owner: add two DNS records** at the domain's registrar, both type A and both pointing at the
   server's IP address. With `app.yourclub.com` as the members' address:

   | Type | Host | Value |
   |---|---|---|
   | A | `app` | the server's IP |
   | A | `staff.app` | the server's IP |

   Check they've spread: `dig +short app.yourclub.com` and `dig +short staff.app.yourclub.com`
   both print the IP (usually within minutes).

   DNS at Cloudflare? Set both records to **DNS only** (the grey cloud, not proxied). Caddy on the
   server gets the certificates itself.
3. **Agent: set up the server**, from a copy of the newest release (its tag in place of `vX.Y.Z`):
   ```bash
   git clone https://github.com/<your-org>/openpadel && cd openpadel && git checkout vX.Y.Z
   ssh root@SERVER 'KUMI_HOST=app.yourclub.com bash -s' < deploy/server-setup.sh
   deploy/ship.sh root@SERVER
   ```
   `server-setup.sh` installs a firewall, Postgres 17, Node 24, Caddy (which gets HTTPS
   certificates and renews them itself), openPadel as a service, the `openpadel` command and a nightly
   backup. It's safe to run again. `ship.sh` sends the committed code, builds both apps and
   restarts openPadel; run it again to update.
4. **Agent: `ssh root@SERVER openpadel doctor`.** It shows `database` ok and `club` missing; that's
   expected. Carry on with `club.yaml` ([README](../README.md), step 4); `address` is checked once the
   club exists.

## The settings file
`/etc/kumi/kumi.env` holds the server's settings and keys, readable only by root and openPadel. The
owner adds keys by typing them in (`sudoedit /etc/kumi/kumi.env`); after any change,
`systemctl restart kumi`. Never commit this file or print it.

## Backups
Every night at 3:17 (the club's time) the server saves the whole database to `/var/backups/kumi/kumi-DATE.dump` (named by
the club's date and time, such as `kumi-2026-11-30T0317.dump`; a backup run by hand gets a file of its own) and
keeps 14 days. A backup on the same disk doesn't survive losing the server, so set up the sealed
offsite copy too ([offsite-backups.md](offsite-backups.md), step 5j). Don't copy the dumps to a laptop:
they hold every member's details unencrypted.

**Restoring** (everything since that backup is lost):
```bash
sudo openpadel restore /var/backups/kumi/<file>.dump --yes   # or: sudo openpadel restore offsite:latest --yes
openpadel doctor
```

## Updating
Read the release's notes in [`CHANGELOG.md`](../../../CHANGELOG.md) first, then ship the new release
and check:
```bash
git fetch && git checkout v0.x.y && deploy/ship.sh root@SERVER
ssh root@SERVER openpadel doctor
```
`ship.sh` takes a snapshot of the database first and puts everything back by itself if the new release
doesn't come up. Database changes apply when the server starts. To go back later:
`sudo openpadel rollback --yes` on the server (everything since the update is lost; see
[`deploy/README.md`](../../../deploy/README.md)).

## Logs
`journalctl -u kumi -f` shows what openPadel is doing. Until email is set up, sign-in codes appear there.

## Common problems
- **`address` fails with a certificate or connection error:** the DNS records don't point at the
  server yet, or ports 80 and 443 are closed by the provider's own firewall. Caddy retries by itself
  once DNS is right; `journalctl -u caddy` says why it's waiting.
- **The apps show "403":** run `server-setup.sh` again; it lets Caddy read the built apps.
- **`migrations` warns:** restart openPadel (`systemctl restart kumi`); it applies them when it starts.
