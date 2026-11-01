# Offsite backups: Cloudflare R2 or Backblaze B2

**What it's for:** a copy of every night's backup somewhere other than the club's server. The server
keeps 14 days of backups on its own disk, which don't survive losing the server. With this set up, each
night's backup also goes to storage the club owns, sealed with the club's backup key, and Kumi keeps 30
daily copies and 12 monthly ones there. Once a month Kumi restores the newest one into a scratch database
and checks every table, so the club knows the backups really work.
**Who does what:** the owner creates the storage account, the bucket and its key, and types the key
into the server. The agent sets up the rest and checks it. The agent never sees the keys.
**Time and cost:** 20 minutes. A club's nightly backup is a few MB, so 30 daily and 12 monthly copies fit
easily in the free allowance both offer (about 10 GB in 2026; check their pricing pages). R2 charges
nothing to download; B2 charges a little past a free daily allowance. Either is fine.
**`kumi doctor` checks:** `offsite`, `restore_test`, `backups`.

## Before either: the backup key

Offsite copies are sealed with `KUMI_BACKUP_KEY`, a key of its own, not the server's. `server-setup.sh`
makes one in `/etc/kumi/kumi.env`; a server set up before it needs one made (the agent runs this; it
prints nothing):

```bash
grep -q '^KUMI_BACKUP_KEY=.' /etc/kumi/kumi.env || echo "KUMI_BACKUP_KEY=$(head -c 32 /dev/urandom | base64)" >> /etc/kumi/kumi.env
```

**Owner: keep a copy of it away from the server**, in a password manager. Without it, the offsite
copies can't be opened, and the copy on the server is lost with the server. Look at it yourself, in your
own terminal, never through the chat:

```bash
sudo grep -E '^KUMI_(BACKUP|SECRET)_KEY=' /etc/kumi/kumi.env
```

Keep `KUMI_SECRET_KEY` there too. It seals the few secrets inside the database (the vault, staff
authenticators, the push key). A restore without it brings back everything else, and those few need
setting up again.

## Cloudflare R2

1. **Owner: turn R2 on** in the Cloudflare dashboard (R2 Object Storage). Cloudflare asks for a payment
   method even for the free allowance.
2. **Owner: create a bucket**, for example `yourclub-kumi-backups`. Location: automatic. Leave public
   access off.
3. **Owner: create a key for that bucket only:** R2, then Manage API tokens, then Create API token.
   Permissions: **Object Read & Write**. Apply to: **that bucket only**. Cloudflare shows the
   **Access Key ID**, the **Secret Access Key** (once) and the endpoint,
   `https://<account id>.r2.cloudflarestorage.com`.
4. **Owner: add them to the server's settings**, typed in, never through the chat:
   ```bash
   sudo nano /etc/kumi/kumi.env
   ```
   ```
   KUMI_OFFSITE_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
   KUMI_OFFSITE_BUCKET=yourclub-kumi-backups
   KUMI_OFFSITE_ACCESS_KEY_ID=...
   KUMI_OFFSITE_SECRET_ACCESS_KEY=...
   KUMI_OFFSITE_REGION=auto
   ```
5. **Agent: check it** (below).

## Backblaze B2

1. **Owner: create a B2 account** at backblaze.com (B2 Cloud Storage).
2. **Owner: create a bucket**, for example `yourclub-kumi-backups`: **private**, Object Lock **off**
   (Kumi deletes copies past 30 days and 12 months; a lock would stop it). Note the bucket's endpoint,
   such as `s3.us-west-004.backblazeb2.com`.
3. **Owner: set the bucket's lifecycle to "Keep only the last version of the file".** B2 otherwise keeps
   every deleted copy as a hidden old version, still stored and billed.
4. **Owner: create a key for that bucket only:** Application Keys, then Add a New Application Key.
   Allow access to: **that bucket**. Type: **Read and Write**. B2 shows the **keyID** and the
   **applicationKey** (once).
5. **Owner: add them to the server's settings**, typed in, never through the chat:
   ```
   KUMI_OFFSITE_ENDPOINT=https://s3.us-west-004.backblazeb2.com
   KUMI_OFFSITE_BUCKET=yourclub-kumi-backups
   KUMI_OFFSITE_ACCESS_KEY_ID=<keyID>
   KUMI_OFFSITE_SECRET_ACCESS_KEY=<applicationKey>
   KUMI_OFFSITE_REGION=us-west-004
   ```
6. **Agent: check it** (below).

## Agent: check it

```bash
sudo systemctl restart kumi        # not needed for the backup itself, but keeps everything on the same settings
kumi backup                        # tonight's backup now, and its offsite copy
kumi offsite                       # what's there: daily/kumi-<date>.dump.enc and .json.enc, monthly/kumi-<month>...
kumi restore-test                  # restore the newest offsite copy into a scratch database and check it
kumi doctor                        # offsite and restore_test should be ok
```

With Docker: `docker compose up -d` after editing `.env`, then the same commands as
`docker compose exec backup kumi ...`.

If `kumi backup` says `HTTP 403 SignatureDoesNotMatch` or `AccessDenied`, the key or its bucket is
wrong; `NoSuchBucket`, the bucket name or the endpoint. The error is said once to the owner and managers
by email too, and again only after it has worked in between.

## Restoring after losing the server

1. Set up a new server with `server-setup.sh` and ship the code (see [server.md](server.md)).
2. **Owner:** put `KUMI_BACKUP_KEY` and the five `KUMI_OFFSITE_*` settings from the password manager into
   the new server's `/etc/kumi/kumi.env`. If you kept the old `KUMI_SECRET_KEY`, add it as
   `KUMI_SECRET_KEY_PREVIOUS` (the new server made its own `KUMI_SECRET_KEY`).
3. `sudo kumi restore offsite:latest --yes` (it stops the server, restores, and starts it again), then
   `kumi rotate-key` and `kumi doctor`.
