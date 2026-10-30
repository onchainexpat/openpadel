# Domain, server and HTTPS

**What it's for:** the address members and staff use, and the machine Kumi runs on.
**Who does what:** the owner buys the domain and the server (both need a payment card) and adds
the DNS records. The agent does everything on the server over SSH.
**Time and cost:** about an hour. A domain is about $10 to $30 a year; a server with 2 GB of memory
is about $12 a month at DigitalOcean, Hetzner, Vultr or Linode.
**`kumi doctor` checks:** `database`, `migrations`, `address`, `backups`.

## Have ready
- A domain the club controls, or a subdomain of the club's existing one.
- Somewhere to hold copies of the backups away from the server (see "Backups").

## Steps

1. **Owner: create the server.** Ubuntu 24.04, 2 GB of memory, in the region nearest the club. Add
   an SSH key when asked (not a password), so the agent can sign in with it.
2. **Owner: add two DNS records** at the domain's registrar, both type A and both pointing at the
   server's IP address. With `app.yourclub.com` as the members' address:

   | Type | Host | Value |
   |---|---|---|
   | A | `app` | the server's IP |
   | A | `staff.app` | the server's IP |

   Check they've spread: `dig +short app.yourclub.com` and `dig +short staff.app.yourclub.com`
   both print the IP (usually within minutes).
3. **Agent: set up the server**, from a checkout of this repository:
   ```bash
   ssh root@SERVER 'KUMI_HOST=app.yourclub.com bash -s' < deploy/server-setup.sh
   deploy/ship.sh root@SERVER
   ```
   `server-setup.sh` installs a firewall, Postgres 17, Node 24, Caddy (which gets HTTPS
   certificates and renews them itself), Kumi as a service, the `kumi` command and a nightly
   backup. It's safe to run again. `ship.sh` sends the committed code, builds both apps and
   restarts Kumi; run it again to update.
4. **Agent: `ssh root@SERVER kumi doctor`.** `address` should be `ok`. Then carry on with
   `club.yaml` ([README](../README.md), step 4).

## The settings file
`/etc/kumi/kumi.env` holds the server's settings and keys, readable only by root and Kumi. The
owner adds keys by typing them in (`sudoedit /etc/kumi/kumi.env`); after any change,
`systemctl restart kumi`. Never commit this file or print it.

## Backups
Every night at 3:17 the server saves the whole database to `/var/backups/kumi/kumi-DATE.dump` and
keeps 14 days. A backup on the same disk doesn't survive losing the server, so also copy them
somewhere else, such as a storage bucket or the owner's computer:
```bash
scp root@SERVER:/var/backups/kumi/kumi-$(date +%F).dump .
```

**Restoring** (onto a fresh server set up with the steps above):
```bash
systemctl stop kumi
sudo -u kumi pg_restore --clean --if-exists --no-owner -d kumi /var/backups/kumi/kumi-DATE.dump
systemctl start kumi && kumi doctor
```

## Updating
Read the release's notes in [`CHANGELOG.md`](../../../CHANGELOG.md) first, take a backup, then ship
the new release and check:
```bash
ssh root@SERVER 'sudo -u kumi pg_dump -Fc -d kumi -f /var/backups/kumi/before-update.dump'
git checkout v0.x.y && deploy/ship.sh root@SERVER
ssh root@SERVER kumi doctor
```
Database changes apply when the server starts. To go back, ship the previous release and restore
`before-update.dump` (see "Restoring").

## Logs
`journalctl -u kumi -f` shows what Kumi is doing. Until email is set up, sign-in codes appear there.

## Common problems
- **`address` fails with a certificate or connection error:** the DNS records don't point at the
  server yet, or ports 80 and 443 are closed by the provider's own firewall. Caddy retries by itself
  once DNS is right; `journalctl -u caddy` says why it's waiting.
- **The apps show "403":** run `server-setup.sh` again; it lets Caddy read the built apps.
- **`migrations` warns:** restart Kumi (`systemctl restart kumi`); it applies them when it starts.
