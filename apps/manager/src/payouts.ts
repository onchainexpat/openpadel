// The Money page's payouts (Payments.tsx, from /staff/money/payouts): the day each is due in the bank, and the next
// one still on its way.

export type PayoutRow = { id: string; amount_cents: number; currency: string; status: "paid" | "pending" | "in_transit" | "failed" | "canceled"; arrives_on: string; created_at: string };

/** A payout's day ("Tue, Oct 28"): a date with no time (YYYY-MM-DD), so it's read as that day wherever the reader is. */
export function payoutDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00Z`));
}

/** The next payout to arrive: the soonest one still on its way or scheduled. Null when none is. */
export function nextPayout(rows: PayoutRow[]): PayoutRow | null {
  return rows.filter((r) => r.status === "pending" || r.status === "in_transit").sort((a, b) => a.arrives_on.localeCompare(b.arrives_on))[0] ?? null;
}
