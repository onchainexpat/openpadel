// The Wallet's words for its lines (Wallet.tsx): what each change to club credit was, from the books' own kind of
// entry (the ledger_txn kinds that touch a member's credit), and its amount signed, in or out. A kind the app doesn't
// know yet reads as a plain change to credit, never a bare key. No Preact here: the tests read it.

const KINDS = {
  payment: "ui.credit_kind_payment",
  credit_grant: "ui.credit_kind_credit_grant",
  gift_card_redeemed: "ui.credit_kind_gift_card_redeemed",
  pass_use_back: "ui.credit_kind_pass_use_back",
  brought_in: "ui.credit_kind_brought_in",
  credit_payout: "ui.credit_kind_credit_payout",
} as const;
type Kind = keyof typeof KINDS;

/** The words for one change to club credit. */
export function creditKindKey(kind: string): (typeof KINDS)[Kind] | "ui.credit_kind_other" {
  return Object.hasOwn(KINDS, kind) ? KINDS[kind as Kind] : "ui.credit_kind_other";
}

/** An amount in (+$24.00) or out (−$12.00), with a real minus sign. */
export function signedCents(cents: number, format: (cents: number) => string): string {
  return `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${format(Math.abs(cents))}`;
}

const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay" };
/** A card brand as people write it (Stripe sends "visa", "amex"). */
export const brandName = (b: string) => BRANDS[b.toLowerCase()] ?? b.charAt(0).toUpperCase() + b.slice(1);
