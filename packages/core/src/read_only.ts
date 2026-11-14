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
  // The switch itself, the owner's download of everything, and saying the club has moved (club_exit.ts).
  "club.read_only", "club.export", "club.moved", "club.moved_host",
  // The day the club's Kumi ends, and the owner's reminders to download everything before then (leaving.ts).
  "club.leaving", "club.leaving_remind",
  // Letting someone in to help (leaving, say), ending it, and recording it (support.ts).
  "support.grant", "support.end", "support.seen", "support.expire", "support.end_all",
  // Signing in and keeping the account safe.
  "person.sign_up", "person.sign_in_undo", "person.reset_sign_in", "email.add", "email.change", "phone.confirm", "person.update_profile",
  "person.factor_add", "person.factor_codes", "person.factor_remove", "person.passkey_add", "person.passkey_remove", "assistant.disconnect",
  // The person's own say: what reaches them, their data, their account, who they share it with.
  "consent.texts", "consent.club_news", "consent.unsubscribe", "text.stop", "text.start", "privacy.export", "privacy.erase", "privacy.erase_again", "friend.remove",
  "household.leave", "household.remove_junior", "household.withdraw_invite", "kid.remove_login", "kid.decline_request", "kid.withdraw_request", "family_card.remove", "card.remove",
  // Leaving, cancelling, and the money that goes back with it (leaving and refunding stay separate decisions).
  "booking.cancel", "booking.repeat_end", "weekly.end_all", "booking.leave", "booking.remove_player", "booking.refund", "booking.withdraw_ask", "booking.withdraw_offer", "booking.drop_saved_place",
  "enrolment.leave", "enrolment.remove", "entry.withdraw", "entry.decline", "program.cancel", "series.cancel", "program.unwatch", "membership.cancel", "membership.switch_cancel", "membership.end", "membership.remove_person",
  "membership.pause", "broadcast.cancel", "question.close", "alert.handle",
  // Keeping players' chats safe: a player's report, and the club hiding a message or stopping someone posting (chat.ts).
  "chat.report", "chat.hide", "chat.stop", "chat.allow",
  // Kumi's own bookkeeping: recording what already happened at Stripe or Twilio, receipts, refunds going out (handed back at the desk too),
  // holds and offers running out, reminders of what's booked, and tidying.
  "payment.settle", "refund.settle", "refund.resend", "refund.give_back", "credit.pay_out", "gift_card.void", "gift_card.resend", "pass.refund", "receipt.issue", "receipt.resend", "club.payment_account_status", "texting.registration_record",
  "membership.card_saved", "family_card.saved", "card.saved", "booking.lapse", "booking.release_seat", "booking.settle_shares", "booking.remind", "waitlist.expire_offers",
  "enrolment.unpaid", "membership.lapse", "program.decide", "program.min_heads_up", "result.auto_confirm", "question.alert", "question.decide",
  "ops.report_failure", "ops.report_cleared", "club.usage_alert", "mirror.apply", "block_series.extend", "broadcast.deliver",
  // The email service's reports, and the desk letting email go to an address again (email_suppression.ts).
  "email.report", "person.email_unsuppress",
]);

/** Money going out, and leaving or cancelling with money back: allowed while read-only (members are paid back), but
 *  not once the club has moved to another server. The move took the bookings, credit and gift cards with it, so the
 *  new server pays them back; paid here too, the money would go out twice. */
export const MOVED_REFUSED = new Set([
  "refund.give_back", "refund.resend", "credit.pay_out", "gift_card.void", "pass.refund", "booking.refund",
  "booking.cancel", "booking.repeat_end", "weekly.end_all", "booking.leave", "booking.remove_player", "booking.withdraw_ask", "booking.withdraw_offer",
  "enrolment.leave", "enrolment.remove", "entry.withdraw", "program.cancel", "series.cancel", "membership.cancel", "membership.end", "membership.remove_person",
  // A program decided here (cancelled for too few, everyone refunded) would be refunded again on the new server.
  "program.decide",
]);

/** Since when the club is read-only, or null. */
export async function readOnlySince(db: Db | Trx): Promise<Date | null> {
  const c = await db.selectFrom("club").select("read_only_since").executeTakeFirst();
  return c?.read_only_since ?? null;
}
/** Read-only, or moved to another server (club_exit.ts): nothing new is taken here either way. */
export async function isReadOnly(db: Db | Trx): Promise<boolean> {
  const c = await db.selectFrom("club").select(["read_only_since", "moved_at"]).executeTakeFirst();
  return Boolean(c?.read_only_since || c?.moved_at);
}

/** Why nothing new is taken here, said as it is: moved (with the new address, when the owner gave one), or read-only. */
async function refusal(db: Db | Trx): Promise<KumiError | null> {
  const c = await db.selectFrom("club").select(["read_only_since", "moved_at", "moved_to"]).executeTakeFirst();
  if (c?.moved_at) return c.moved_to ? new KumiError("error.moved_to", { url: c.moved_to }, 403) : new KumiError("error.moved", {}, 403);
  return c?.read_only_since ? new KumiError("error.read_only", {}, 403) : null;
}

/** The action contract's check: refuses an action that doesn't work while read-only. */
export async function readOnlyGate(db: Db | Trx, action: string): Promise<void> {
  if (READ_ONLY_ALLOWED.has(action) && !MOVED_REFUSED.has(action)) return;
  const e = MOVED_REFUSED.has(action) ? await movedRefusal(db) : await refusal(db);
  if (e) throw e;
}
async function movedRefusal(db: Db | Trx): Promise<KumiError | null> {
  const c = await db.selectFrom("club").select(["moved_at", "moved_to"]).executeTakeFirst();
  if (!c?.moved_at) return null;
  return c.moved_to ? new KumiError("error.moved_to", { url: c.moved_to }, 403) : new KumiError("error.moved", {}, 403);
}

/** For the code that opens a card form or charges a saved card outside an action: nothing new is charged. */
export async function refuseWhenReadOnly(db: Db | Trx): Promise<void> {
  const e = await refusal(db);
  if (e) throw e;
}
