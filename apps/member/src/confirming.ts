// A card payment the card form has taken (Stripe said yes) that Kumi hasn't recorded yet: the check after the form,
// Stripe's webhook or the minute job records it, usually within seconds, sometimes a minute. Until then the app
// shows it as "Paid, thank you: confirming" and offers no Pay button for it, on any page and after a reload (kept
// for this tab, a few minutes). Opening its card form again couldn't charge twice anyway (the server answers "paid"
// for one that's gone through), but a second Pay button invites the try.
const KEY = "kumi.confirming";
/** How long a taken payment reads as confirming, at most: by then it's recorded, or it's worth paying again. */
export const CONFIRMING_MS = 3 * 60_000;
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const here = new Map<string, number>();
function session(): Store | null { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } }
function read(s: Store | null): Record<string, number> {
  try { return { ...Object.fromEntries(here), ...(JSON.parse(s?.getItem(KEY) ?? "{}") as Record<string, number>) }; } catch { return Object.fromEntries(here); }
}
/** The card form took this payment: confirming from now (the server's now, serverNow, passed in by Pay.tsx). */
export function markConfirmingAt(paymentId: string, now: number, s: Store | null = session()): void {
  const all = Object.fromEntries(Object.entries(read(s)).filter(([, at]) => now - at < CONFIRMING_MS));
  all[paymentId] = now; here.set(paymentId, now);
  try { s?.setItem(KEY, JSON.stringify(all)); } catch { /* private window: this page still knows */ }
}
/** It didn't go through after all (the bank said no): no longer confirming. */
export function clearConfirming(paymentId: string, s: Store | null = session()): void {
  const all = read(s); delete all[paymentId]; here.delete(paymentId);
  try { s?.setItem(KEY, JSON.stringify(all)); } catch { /* as above */ }
}
/** Whether this payment, still waiting in the list, was taken by the card form a moment ago. */
export function isConfirmingAt(paymentId: string | null | undefined, now: number, s: Store | null = session()): boolean {
  if (!paymentId) return false;
  const at = read(s)[paymentId];
  return at !== undefined && now - at < CONFIRMING_MS;
}
