// What a promo code took off a payment counts toward a booking's price, though no money moved (promo_codes.ts).
// A code that left something to pay asks again for the rest (askAgain): that payment's amount_cents is the money and
// its discount_cents what the code took off. A code that took it all leaves the payment as it was, method 'promo',
// its whole share in amount_cents already. So every sum that weighs a booking's payments against its price (what's
// owed, the deadline's charge, the desk's limit, the screens) adds promoOff, and none adds it twice.
import { sql } from "kysely";

/** What a code took off this payment beyond its amount_cents: `p` is the payment table's name or alias in the query. */
export const promoOff = (p = "payment") => sql<number>`(CASE WHEN ${sql.ref(`${p}.method`)} = 'promo' THEN 0 ELSE ${sql.ref(`${p}.discount_cents`)} END)`;
/** A payment's part of a booking's price: its money and what a code took off. */
export const towardPrice = (p = "payment") => sql<number>`(${sql.ref(`${p}.amount_cents`)} + ${promoOff(p)})`;
