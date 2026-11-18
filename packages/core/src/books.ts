// The club's books, one club day at a time, as an accounting system wants them (docs/plugins/README.md, "money_books"):
// what the ledger (money.ts) moved that day on the club's clock, summed by kind of account, never by person, plus the
// card provider's fees and the payouts that reached the bank. Each day's lines balance (the ledger already does, and
// every line added here comes with its other side), so a plugin can send them as one journal without guessing.
//
// Lines are signed cents: positive is a debit, negative a credit. Takings and refunds are apart (a refund is its own
// line, never netted off the day's takings), and both are net of the tax the receipts say was in them. No names, no
// people, no bookings: amounts and kinds only.
import { sql } from "kysely";
import { localDate, onDate } from "./clock.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { paymentProvider } from "./money.ts";

export const BOOKS_MAX_DAYS = 31;
/** The kinds of takings a line is named for; any other revenue type is "other". */
export const TAKINGS_TYPES = ["courts", "lessons", "programs", "memberships", "after_restore", "other"] as const;
export interface BookLine { key: string; cents: number }
export interface BookDay { date: string; complete: boolean; fees: "known" | "unknown"; payouts: "known" | "unknown"; lines: BookLine[] }
export interface Books { currency: string; time_zone: string; today: string; days: BookDay[] }

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const nextDay = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };

/** Which line a ledger movement makes: by its account's kind, and its sign (positive, a debit). Null: one net line. */
function keyOf(kind: string, revenueType: string | null, cents: number): string {
  const up = cents > 0;
  switch (kind) {
    case "revenue": { const t = (TAKINGS_TYPES as readonly string[]).includes(revenueType ?? "") ? revenueType! : "other"; return up ? `refunds.${t}` : `takings.${t}`; }
    case "member_credit": return up ? "credit.used" : "credit.added";
    case "gift_cards": return up ? "gift_cards.used" : "gift_cards.sold";
    case "passes": return up ? "passes.used" : "passes.sold";
    case "provider_clearing": return up ? "card.in" : "card.out";
    case "cash_drawer": return up ? "cash.in" : "cash.out";
    case "receivable": return up ? "receivable.up" : "receivable.down";
    default: return kind;   // refunds_payable, adjustment, brought_in: one net line each
  }
}

/** The books for the club days from `from` to `to` (at most BOOKS_MAX_DAYS), on the club's clock. */
export async function moneyBooks(db: Db | Trx, from: string, to: string, now = new Date()): Promise<Books> {
  if (!YMD.test(from) || !YMD.test(to) || to < from) throw new KumiError("error.invalid_input", { details: "from and to (YYYY-MM-DD)" }, 400);
  const days: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) { days.push(d); if (days.length > BOOKS_MAX_DAYS) throw new KumiError("error.invalid_input", { details: `at most ${BOOKS_MAX_DAYS} days` }, 400); }
  const club = await db.selectFrom("club").select(["time_zone", "currency"]).executeTakeFirstOrThrow();
  const tz = club.time_zone, today = localDate(now, tz);
  const start = onDate(from, "00:00", tz), end = onDate(to, "24:00", tz);
  const dayOf = sql<string>`to_char(ledger_txn.at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;
  // Each transaction's movement on each kind of account (a person's credit summed with everyone's): its sign says
  // whether it's money in or out of that kind, so a refund is never netted into the day's takings.
  const moved = await db.selectFrom("ledger_entry").innerJoin("ledger_txn", "ledger_txn.id", "ledger_entry.txn_id").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id")
    .select([dayOf.as("day"), "ledger_txn.id as txn", "ledger_account.kind", "ledger_account.revenue_type", sql<string>`sum(ledger_entry.amount_cents)`.as("cents")])
    .where("ledger_txn.at", ">=", start).where("ledger_txn.at", "<", end)
    .groupBy(["day", "ledger_txn.id", "ledger_account.kind", "ledger_account.revenue_type"]).execute();
  // The tax in each day's receipts for courts and lessons (the only things taxed), as Reports reads it: what was taken
  // and what refunds gave back, apart.
  const taxRows = await db.selectFrom("receipt").innerJoin("payment", "payment.id", "receipt.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .innerJoin("booking", "booking.id", "booking_player.booking_id")
    .select([sql<string>`to_char(receipt.paid_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`.as("day"), sql<string>`CASE WHEN booking.kind = 'lesson' THEN 'lessons' ELSE 'courts' END`.as("type"),
      sql<boolean>`receipt.kind = 'refund'`.as("refund"), sql<string>`sum(receipt.tax_cents)`.as("cents")])
    .where("receipt.tax_cents", ">", 0).where("receipt.paid_at", ">=", start).where("receipt.paid_at", "<", end)
    .groupBy(["day", "type", "refund"]).execute();

  const provider = paymentProvider();
  let payouts: { arrivesOn: string; amountCents: number; status: string }[] | null = null;
  if (provider.listPayouts) { try { payouts = await provider.listPayouts(100); } catch { payouts = null; } }

  const out: BookDay[] = [];
  for (const date of days) {
    const sums = new Map<string, number>();
    const add = (key: string, cents: number) => { if (cents) sums.set(key, (sums.get(key) ?? 0) + cents); };
    for (const r of moved) if (r.day === date) { const c = Number(r.cents); if (c) add(keyOf(r.kind, r.revenue_type, c), c); }
    for (const r of taxRows) if (r.day === date) {
      const c = Number(r.cents);
      // Taken: the takings line gives up the tax (a smaller credit) and tax is owed. Refunded: the reverse.
      if (r.refund) { add(`refunds.${r.type}`, -c); add("tax", c); } else { add(`takings.${r.type}`, c); add("tax", -c); }
    }
    let fees: BookDay["fees"] = "unknown";
    if (provider.feesBetween) {
      try {
        const f = await provider.feesBetween(onDate(date, "00:00", tz), onDate(date, "24:00", tz));
        if (f !== null) { fees = "known"; add("card.fees", f); add("card.fees_out", -f); }
      } catch { fees = "unknown"; }
    }
    let paid: BookDay["payouts"] = "unknown";
    if (payouts) {
      paid = "known";
      const cents = payouts.filter((p) => p.status === "paid" && p.arrivesOn === date).reduce((n, p) => n + p.amountCents, 0);
      add("bank.payouts", cents); add("card.payouts_out", -cents);
    }
    const lines = [...sums].filter(([, c]) => c !== 0).map(([key, cents]) => ({ key, cents })).sort((a, b) => a.key.localeCompare(b.key));
    // The ledger balances each transaction, and each line added here has its other side: a day that doesn't sum to zero
    // is a bug, never something to send.
    const total = lines.reduce((n, l) => n + l.cents, 0);
    if (total !== 0) throw new Error(`the books for ${date} don't balance (${total} cents)`);
    out.push({ date, complete: date < today, fees, payouts: paid, lines });
  }
  return { currency: club.currency, time_zone: tz, today, days: out };
}
