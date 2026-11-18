---
name: openpadel-setup
description: Set up openPadel for a padel club, check on one that's set up, or work one day to day. Use when the owner asks to install openPadel, put their club on it, connect email, Stripe or Playtomic, fix something openpadel doctor reports, go live, or run the club's day (bookings, clinics, members) from the command line.
---

# Setting up openPadel for a club

1. Read the rules at the top of `AGENTS.md`. They are not optional: never ask for a secret in the
   chat, never collect identity or bank details, the owner creates every outside account, preview
   before applying, and nothing reaches real members or real money until the owner says so.
2. Clone over https (`git clone https://github.com/onchainexpat/openpadel`), check out the newest release tag
   (`git checkout "$(git tag --list 'v*' --sort=-v:refname | head -1)"`), and read the docs from that checkout:
   main can be ahead of the release. Then follow `docs/setup/README.md` in order. Each step says what you do
   and what the owner does. No domain yet: a trial on `<ip-with-dashes>.sslip.io` (docs/setup/accounts/server.md).
3. Once the server exists, run `ssh root@SERVER openpadel doctor --json` first and after every step, and
   work on the first check that isn't `ok`. Each check names the guide that fixes it. (`kumi` is the same command,
   and the only one on a server set up before `openpadel` existed, until its next update.)
4. For the club itself: fill in `club.yaml` from `club.example.yaml` and the club packet
   (`docs/setup/club-packet.md`), with the currency, each location's opening hours and one court price,
   run `openpadel setup plan`, show the owner the plan, then `openpadel setup apply`. The owner's first sign-in
   before email is set up: `openpadel sign-in-link <owner's email>` on the server, and give them the link
   without opening it (never read a code out of the log for them).
5. Much of what the guide does in the staff app (opening hours, prices, membership plans, coaches, the
   club's answers) you can do with the club's commands instead, once the owner signs you in:
   `openpadel login https://staff.<their address> --device --no-wait --json`, show them the link and the code,
   then `openpadel login ... --device` again (docs/cli/README.md). Show the owner each preview before
   `openpadel confirm`. What needs a strong sign-in (club settings, roles, the vault) stays in the staff app.
6. The two keys the owner keeps (step 5j): the owner reads them in their own terminal or the server provider's
   web console, never through you; `openpadel keys` shows only their last 4 characters, to check the copies.
7. The phone apps: tell the owner the members' and staff apps install from the club's own address, with its name
   and colour (`docs/setup/apps.md`). Store apps need the club's own developer accounts and fees: the owner enrols
   and pays; you never enrol one for them.
8. When a guide is wrong or a step fails in a way the guide doesn't cover, tell the owner, and say
   what the guide should have said.
