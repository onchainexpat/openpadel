# Domain, server and HTTPS

**What it's for:** the address members and staff use, and the machine openPadel runs on.
**Who does what:** the owner buys the domain and the server (both need a payment card) and adds
the DNS records. The agent does everything on the server over SSH.
**Time and cost:** about an hour. A domain is about $10 to $30 a year; a server with 2 GB of memory
is about $12 a month at DigitalOcean, Hetzner, Vultr or Linode.
**`openpadel doctor` checks:** `database`, `migrations`, `address`, `backups`.

## Have ready
- A domain the club controls, or a subdomain of the club's existing one. No domain yet? A trial can run on
  a free address made from the server's IP ("No domain yet", below), and move to the club's domain later.

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
3. **Agent: set up the server**, from a copy of the newest release. Clone over https (it needs no GitHub
   key; `gh repo clone` uses ssh when gh is set to, and fails without one), check out the newest release
   tag, and read the setup docs from there on, since main can be ahead of the release:
   ```bash
   git clone https://github.com/onchainexpat/openpadel && cd openpadel
   git checkout "$(git tag --list 'v*' --sort=-v:refname | head -1)"
   ssh root@SERVER 'OPENPADEL_HOST=app.yourclub.com bash -s' < deploy/server-setup.sh
   deploy/ship.sh root@SERVER
   ```
   SSH options the server needs (a key file, a jump host, an ssh config) go where ssh takes them in the
   first command, and **after the target** for `ship.sh`, which passes them on to ssh:
   ```bash
   ssh -i ~/.ssh/club -J admin@bastion.example root@SERVER 'OPENPADEL_HOST=app.yourclub.com bash -s' < deploy/server-setup.sh
   deploy/ship.sh root@SERVER -i ~/.ssh/club -J admin@bastion.example     # or: deploy/ship.sh club-server -F ./ssh_config
   ```
   `server-setup.sh` installs a firewall, Postgres 17, Node 24, Caddy (which gets HTTPS
   certificates and renews them itself), openPadel as a service, the `openpadel` command and a nightly
   backup. It's safe to run again. `ship.sh` sends the committed code, builds both apps and
   restarts openPadel; run it again to update.
4. **Agent: `ssh root@SERVER openpadel doctor`.** It shows `database` ok and `club` missing; that's
   expected. Carry on with `club.yaml` ([README](../README.md), step 4); `address` is checked once the
   club exists.

## No domain yet: a trial address
For a trial before the club has its domain, skip the DNS records (step 2) and use the server's IP address
with dashes, followed by `.sslip.io`, as the address: for a server at `203.0.113.7`,
```bash
ssh root@SERVER 'OPENPADEL_HOST=203-0-113-7.sslip.io bash -s' < deploy/server-setup.sh
```
sslip.io is a free public DNS service that answers any name with the IP written in it, `staff.` in front
too, so the members' app is `https://203-0-113-7.sslip.io` and the staff app `https://staff.203-0-113-7.sslip.io`,
with real HTTPS certificates from Caddy. It's for trying openPadel out with the staff, not for members: the
address names the server, changes if the server does, and depends on a service the club doesn't control.

**Moving to the club's domain later** (before members join, ideally):
1. **Owner:** add the two DNS records of step 2 for the new address.
2. **Agent:** change the two addresses in the settings file, without printing it, then set Caddy up for
   the new names (server-setup.sh is safe to run again) and restart:
   ```bash
   ssh root@SERVER "sed -i 's#^OPENPADEL_PUBLIC_URL=.*#OPENPADEL_PUBLIC_URL=https://staff.app.yourclub.com#; s#^OPENPADEL_MEMBER_URL=.*#OPENPADEL_MEMBER_URL=https://app.yourclub.com#' /etc/kumi/kumi.env"
   ssh root@SERVER 'OPENPADEL_HOST=app.yourclub.com bash -s' < deploy/server-setup.sh
   ssh root@SERVER 'systemctl restart kumi && openpadel doctor'
   ```
3. Everyone signs in again at the new address. Passkeys belong to an address, so staff set theirs up again
   (an authenticator app carries over). Phone apps installed from the trial address are installed again
   from the new one. If Stripe or Resend were already connected, change their webhook addresses to the new
   one ([stripe.md](stripe.md), [resend.md](resend.md)); `openpadel doctor` says what's left.

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
`journalctl -u kumi -f` shows what openPadel is doing. Until email is set up, sign-in codes appear there:
the agent doesn't read them out to anyone. For the owner's first sign-in, `openpadel sign-in-link <their email>`
gives a one-time link instead ([README](../README.md), step 4).

## Common problems
- **`address` fails with a certificate or connection error:** the DNS records don't point at the
  server yet, or ports 80 and 443 are closed by the provider's own firewall. Caddy retries by itself
  once DNS is right; `journalctl -u caddy` says why it's waiting.
- **The apps show "403":** run `server-setup.sh` again; it lets Caddy read the built apps.
- **`migrations` warns:** restart openPadel (`systemctl restart kumi`); it applies them when it starts.
