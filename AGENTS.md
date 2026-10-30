# Kumi, for agents and people

Kumi is free, open-source software that runs a padel club (see `README.md`). This file is read by
coding agents such as Claude Code and Codex. There are two jobs, with their own rules:

- **Setting up Kumi for a club** (an owner, or the owner's agent): start at
  [`docs/setup/README.md`](docs/setup/README.md) and follow the rules just below.
- **Changing Kumi's code:** the rules further down.

## Setting up a club: the rules
1. **Run `kumi doctor --json` first and after every step,** and work on the first check that isn't
   `ok`. Each check names the guide that fixes it.
2. **Never ask the owner to paste a secret into the chat** (API keys, passwords, codes). Tell them
   which setting it is and where it goes (`/etc/kumi/kumi.env` on the server), and let them type it
   there themselves. Never print the settings file or a key.
3. **Never ask for a Social Security number, ID, bank account or card details.** Stripe collects
   those on its own pages, from the owner directly.
4. **The owner creates every outside account** (domain, server, Stripe, Resend, Playtomic API keys)
   and does every step that asks for identity, payment or a legal promise. You tell them exactly
   what to click and what to choose.
5. **Preview before changing:** `kumi setup plan` before `kumi setup apply`, and show the owner the
   plan. Change the club only through `kumi` and the apps, never in the database directly.
6. **Nothing reaches real members or real money during setup.** Keep practice mode on, use test
   Stripe keys, and only turn either off when the owner says so in their own words.

## Changing Kumi's code

### Read first
The design specs are being moved into `docs/` as each milestone needs them. Until then they live
in the private research folder this project grew from: the data model, the action catalogue,
permissions, messages, decisions (where a decision model replaces an LLM), the stack, the v1
scope and the roadmap.

### Rules that are not up for debate
1. **Every write is an action** from the catalogue: typed input (Zod Mini), a permission check,
   a plan the person sees before anything changes, apply, an undo kind, an audit row, and an
   idempotency key. No route, job or agent writes to the database any other way.
2. **Leaving and refunding are separate decisions.** Removing someone from a booking, match or
   roster never moves money by itself; the plan shows what the refund rule gives and staff can
   change it, with a reason.
3. **Two things can't hold one court at one time,** enforced by the database's exclusion
   constraint. Every write that takes court time locks its courts first, in court-id order.
4. **English and Spanish for every string** a person sees, from the first commit. No string is
   written straight into a component or a message.
   Spanish is US and Latin American Spanish, with "tú" throughout. The words to use:
   - "cancha" (court), "contador" (accountant), "miembro" (member), "dueño" (owner);
   - "inscribirse" (sign up), "lugar" or "cupo" (a place), "agregar" (add), "vencer" (expire),
     "monto" (amount), "Listo" (done);
   - not Spain's "pista", "apuntarse", "plaza", "añadir", "caducar", "importe" or "Hecho".

   Phrase things about a person so they don't need a gender ("ya se inscribió", not "ya está
   inscrito"). The `thing.*` words carry their article ("la cancha"), since Spanish nouns have
   gender. A count goes in a plural message, never a plain one.
5. **Everything runs on the club's time zone,** never the server clock.
6. **Messages:** consent checked on the server before every send, STOP always works, quiet hours
   respected, and texts kept to the plain GSM-7 alphabet (no emoji in texts).
7. **No em dashes** in anything a member, player or club reads.
8. **Migrations are plain SQL,** numbered, applied once, never edited after they ship.
9. **Dependencies are pinned exactly,** to releases at least two weeks old.
10. **TypeScript that Node can run directly:** no enums, namespaces or parameter properties.

### Commits
Commit with explicit paths (`git commit -m "..." -- path ...`), small and with a message that
says why.
