---
name: kumi-setup
description: Set up Kumi for a padel club, or check on one that's set up. Use when the owner asks to install Kumi, put their club on it, connect email, Stripe or Playtomic, fix something kumi doctor reports, or go live.
---

# Setting up Kumi for a club

1. Read the rules at the top of `AGENTS.md`. They are not optional: never ask for a secret in the
   chat, never collect identity or bank details, the owner creates every outside account, preview
   before applying, and nothing reaches real members or real money until the owner says so.
2. Follow `docs/setup/README.md` in order. Each step says what you do and what the owner does.
3. Once the server exists, run `ssh root@SERVER kumi doctor --json` first and after every step, and
   work on the first check that isn't `ok`. Each check names the guide that fixes it.
4. For the club itself: fill in `club.yaml` from `club.example.yaml` and the club packet
   (`docs/setup/club-packet.md`), run `kumi setup plan`, show the owner the plan, then
   `kumi setup apply`.
5. When a guide is wrong or a step fails in a way the guide doesn't cover, tell the owner, and say
   what the guide should have said.
