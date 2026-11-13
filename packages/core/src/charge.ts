// What a member's change that costs money will charge, line by line, for the members' app's "Check before you
// confirm" sheet (packages/ui/src/Preview.tsx). Built inside each action's preview from the same numbers its apply
// charges (the quote, the shares, the program price), and kept with the stored plan, so the sheet says exactly what
// happens: never worked out again in the browser. A plan without one shows its summary alone, as before.
import { both, clubFormat, dateTime, money, type Key, type Params, type Text } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import { creditBalance } from "./money.ts";
import { kidOf } from "./kids.ts";
import { taxWord } from "./receipts.ts";
import type { Quote } from "./prices.ts";
import type { ProgramPrice } from "./program_prices.ts";

/** What a line is, for how the sheet shows it: a price, money off it (negative cents), tax on top or inside the
 *  price, the total, the part paid now of a shared one, what others pay (theirs, not this person's), or a note. */
export type ChargeKind = "item" | "member" | "included" | "tax" | "tax_included" | "total" | "your_part" | "others" | "later" | "note";
export interface ChargeLine { kind: ChargeKind; label: Text; cents: number | null }
/** `due_cents`: what this person is charged by the change (the plan's moneyCents, the payment apply makes). `how`: what
 *  pays it. `when`: when it's charged, and what happens to anything left at the deadline. */
export interface Charge { lines: ChargeLine[]; due_cents: number; how: Text; when: Text | null }

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const at = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });
const line = (kind: ChargeKind, key: Key, params: Params, cents: number | null): ChargeLine => ({ kind, label: both(key, params), cents });
export const chargeLine = line;
export { usd as chargeMoney, at as chargeAt };

/** The tax line of a price: added on top, or said as inside it. None when there's no tax. */
export async function taxLine(db: Db | Trx, o: { tax_cents: number; tax_bp: number; tax_included?: boolean }): Promise<ChargeLine | null> {
  if (!o.tax_cents) return null;
  const c = await db.selectFrom("club").select("tax_label").executeTakeFirstOrThrow();
  const rate = new Intl.NumberFormat(clubFormat().locale, { style: "percent", maximumFractionDigits: 2 }).format(o.tax_bp / 10_000);
  const word = taxWord(c.tax_label, Boolean(o.tax_included));
  return o.tax_included ? { kind: "tax_included", label: both("charge.tax_included", { tax: word, rate: { en: rate, es: rate } }), cents: o.tax_cents }
    : { kind: "tax", label: both("charge.tax", { tax: word, rate: { en: rate, es: rate } }), cents: o.tax_cents };
}

/** A court's price lines from its quote: the price for everyone, a member price as money off it (the same quote
 *  for nobody in particular, so the difference is the member price's own), the tax, and the total. */
export async function courtLines(db: Db | Trx, q: Quote, item: Text, everyone: Quote | null): Promise<ChargeLine[]> {
  const shown = (x: Quote) => x.tax_included ? x.total_cents : x.subtotal_cents;
  const off = q.member && everyone?.priced ? shown(everyone) - shown(q) : 0;
  const lines: ChargeLine[] = [{ kind: "item", label: item, cents: off > 0 ? shown(everyone!) : shown(q) }];
  if (off > 0) lines.push(line("member", "charge.member_price", { plan: q.member! }, -off));
  const tax = await taxLine(db, q);
  if (tax) lines.push(tax);
  lines.push(line("total", "charge.total", {}, q.total_cents));
  return lines;
}

/** A program place's lines: its price, a member price or an included session as money off, and what's paid. */
export function programLines(item: Text, price: ProgramPrice): ChargeLine[] {
  const lines: ChargeLine[] = [{ kind: "item", label: item, cents: price.full }];
  if (price.basis === "member" && price.full > price.cents) lines.push(line("member", "charge.member_price_program", {}, price.cents - price.full));
  if (price.basis === "included") lines.push(line("included", price.included ? "charge.included_n" : "charge.included", price.included ? { n: price.included.n, of: price.included.of } : {}, price.cents - price.full));
  return lines;
}

/** What pays it, said for this person: their family's card (a kid with a login), a card alone (a membership, a pass,
 *  a card saved for later charges, several paid together), or a card or their club credit when the credit can pay it
 *  (payment.use_credit): the member's own, all of it, or (a program place, `creditPart`) part with the card for the rest. */
export async function howPaid(ctx: { db: Db | Trx; actor: { personId: string | null } }, personId: string, due: number, o: { cardOnly?: boolean; creditPart?: boolean } = {}): Promise<Text> {
  if (due <= 0) return both("charge.how_nothing");
  if (await kidOf(ctx.db, personId)) return both("charge.how_family");
  if (o.cardOnly || ctx.actor.personId !== personId) return both("charge.how_card");
  const credit = await creditBalance(ctx.db, personId);
  return credit > 0 && (credit >= due || o.creditPart) ? both("charge.how_card_or_credit", { credit: usd(credit) }) : both("charge.how_card");
}

/** A charge from its parts: lines left out (null) are dropped, and nothing to pay has no "when". */
export function charge(lines: (ChargeLine | null)[], due: number, how: Text, when: Text | null): Charge {
  return { lines: lines.filter((l): l is ChargeLine => Boolean(l)), due_cents: due, how, when: due > 0 ? when : null };
}
