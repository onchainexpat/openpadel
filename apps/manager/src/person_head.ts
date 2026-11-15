// What the top of a person's page says, worked out from what the page already read (kept apart from the page so it's
// tested on its own): what's coming up for them, and the money lines of their Money card.

export type ComingBooking = { id: string; code: string; status: string; court: string; starts_at: string; organiser: boolean };
export type ComingSession = { id: string; starts_at: string; program_id: string; name: string; kind: string };
export type Coming =
  | { kind: "booking"; id: string; starts_at: string; court: string; code: string; organiser: boolean }
  | { kind: "session"; id: string; starts_at: string; program_id: string; name: string };

/** Their court bookings still to come (not cancelled) and the program dates they have a place on, soonest first, at most `max`. */
export function comingUp(bookings: ComingBooking[], sessions: ComingSession[], now: number, max = 5): Coming[] {
  const out: Coming[] = [
    ...bookings.filter((b) => b.status !== "cancelled" && new Date(b.starts_at).getTime() > now)
      .map((b) => ({ kind: "booking" as const, id: b.id, starts_at: b.starts_at, court: b.court, code: b.code, organiser: b.organiser })),
    ...sessions.filter((s) => new Date(s.starts_at).getTime() > now)
      .map((s) => ({ kind: "session" as const, id: s.id, starts_at: s.starts_at, program_id: s.program_id, name: s.name })),
  ];
  return out.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()).slice(0, max);
}

/** The Money card's figures: their club credit, what they owe on their membership now (not the next period's charge,
 *  which isn't owed yet), and what waits to go back to them (at the desk, or a card refund that didn't go through). */
export function moneyFigures(p: { credit_cents: number | null; membership: { due?: { cents: number; next: boolean } | null } | null;
  to_give_back: { amount_cents: number }[]; failed_refunds: { amount_cents: number }[] }) {
  const owed = p.membership?.due && !p.membership.due.next ? p.membership.due.cents : 0;
  const back = [...(p.to_give_back ?? []), ...(p.failed_refunds ?? [])].reduce((n, r) => n + r.amount_cents, 0);
  return { credit: Math.max(0, p.credit_cents ?? 0), owed, back };
}
