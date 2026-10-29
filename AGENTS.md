# Working on Kumi (for coding agents and people)

## Read first
The design specs are being moved into `docs/` as each milestone needs them. Until then they live
in the private research folder this project grew from: the data model, the action catalogue,
permissions, messages, decisions (where a decision model replaces an LLM), the stack, the v1
scope and the roadmap.

## Rules that are not up for debate
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
   Spanish is US and Latin American Spanish: a court is a "cancha", an accountant a "contador",
   and "tú" throughout.
5. **Everything runs on the club's time zone,** never the server clock.
6. **Messages:** consent checked on the server before every send, STOP always works, quiet hours
   respected, and texts kept to the plain GSM-7 alphabet (no emoji in texts).
7. **No em dashes** in anything a member, player or club reads.
8. **Migrations are plain SQL,** numbered, applied once, never edited after they ship.
9. **Dependencies are pinned exactly,** to releases at least two weeks old.
10. **TypeScript that Node can run directly:** no enums, namespaces or parameter properties.

## Commits
Commit with explicit paths (`git commit -m "..." -- path ...`), small and with a message that
says why.
