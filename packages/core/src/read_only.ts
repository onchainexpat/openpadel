// Read-only: what a club's Kumi still does when its host has switched it to read-only (an account that isn't
// paid; `kumi read-only on`). The rule is that the club's data is never held hostage, and no new money moves
// except back to members. So everyone still signs in, sees everything, looks after their own account and
// downloads their data, and the owner can download everything; people can still leave, cancel and be paid back.
// Nothing new is booked, joined, sold or charged, and nothing is changed for the club. The check is in the
// action contract (actions.ts), so it holds for the apps, assistants and jobs alike; the jobs that would charge
// a card or hand out a place skip themselves, and the card forms aren't opened.
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";

/** What still works while read-only. Everything else is refused, whoever asks. */
export const READ_ONLY_ALLOWED = new Set([
  // The switch itself, and the owner's download of everything.
  "club.read_only", "club.export",
  // The day the club's Kumi ends, and the owner's reminders to download everything before then (leaving.ts).
  "club.leaving", "club.leaving_remind",
  // Letting someone in to help (leaving, say), ending it, and recording it (support.ts).
  "support.grant", "support.end", "support.seen", "support.expire",
  // Signing in and keeping the account safe.
  "person.sign_up", "person.sign_in_undo", "person.reset_sign_in", "email.add", "email.change", "phone.confirm", "person.update_profile",
  "person.factor_add", "person.factor_codes", "person.factor_remove", "person.passkey_add", "person.passkey_remove", "assistant.disconnect",
  // The person's own say: what reaches them, their data, their account, who they share it with.
  "consent.texts", "consent.club_news", "consent.unsubscribe", "text.stop", "text.start", "privacy.export", "privacy.erase", "friend.remove",
  "household.leave", "household.remove_junior", "household.withdraw_invite", "kid.remove_login", "kid.decline_request", "kid.withdraw_request", "family_card.remove",
  // Leaving, cancelling, and the money that goes back with it (leaving and refunding stay separate decisions).
  "booking.cancel", "booking.leave", "booking.remove_player", "booking.refund", "booking.withdraw_ask", "booking.withdraw_offer", "booking.drop_saved_place",
  "enrolment.leave", "enrolment.remove", "program.cancel", "series.cancel", "program.unwatch", "membership.cancel", "membership.end", "membership.remove_person",
  "membership.pause", "broadcast.cancel", "question.close", "alert.handle",
  // Kumi's own bookkeeping: recording what already happened at Stripe or Twilio, receipts, refunds going out,
  // holds and offers running out, reminders of what's booked, and tidying.
  "payment.settle", "refund.settle", "refund.resend", "receipt.issue", "receipt.resend", "club.payment_account_status", "texting.registration_record",
  "membership.card_saved", "family_card.saved", "booking.lapse", "booking.release_seat", "booking.settle_shares", "booking.remind", "waitlist.expire_offers",
  "enrolment.unpaid", "membership.lapse", "program.decide", "program.min_heads_up", "result.auto_confirm", "question.alert", "question.decide",
  "ops.report_failure", "ops.report_cleared", "club.usage_alert", "mirror.apply", "block_series.extend", "broadcast.deliver",
]);

/** Since when the club is read-only, or null. */
export async function readOnlySince(db: Db | Trx): Promise<Date | null> {
  const c = await db.selectFrom("club").select("read_only_since").executeTakeFirst();
  return c?.read_only_since ?? null;
}
export async function isReadOnly(db: Db | Trx): Promise<boolean> { return (await readOnlySince(db)) !== null; }

/** The action contract's check: refuses an action that doesn't work while read-only. */
export async function readOnlyGate(db: Db | Trx, action: string): Promise<void> {
  if (READ_ONLY_ALLOWED.has(action)) return;
  if (await isReadOnly(db)) throw new KumiError("error.read_only", {}, 403);
}

/** For the code that opens a card form or charges a saved card outside an action: nothing new is charged. */
export async function refuseWhenReadOnly(db: Db | Trx): Promise<void> {
  if (await isReadOnly(db)) throw new KumiError("error.read_only", {}, 403);
}
