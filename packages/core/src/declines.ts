// Why a card payment or a refund didn't go through, in words a person can read. Stripe (and the stand-in) give
// codes like insufficient_funds or charge_already_refunded; no code is ever shown to anyone as it is. One that
// means nothing to a person (a processing hiccup, an unknown code) gives no reason at all.
import { both, type Key, type Text } from "@kumi/i18n";

const NOTHING: Text = { en: "", es: "" };

/** A charge's failure: the bank's reason Stripe passes on, a payment's status, or ours (no saved card). Lost or
 *  stolen cards read as declined, as Stripe advises, whoever reads it. */
const DECLINES: Record<string, Key> = {
  card_declined: "msg.decline_declined", generic_decline: "msg.decline_declined", do_not_honor: "msg.decline_declined", requires_payment_method: "msg.decline_declined",
  lost_card: "msg.decline_declined", stolen_card: "msg.decline_declined", pickup_card: "msg.decline_declined", fraudulent: "msg.decline_declined",
  restricted_card: "msg.decline_declined", call_issuer: "msg.decline_declined", transaction_not_allowed: "msg.decline_declined",
  insufficient_funds: "msg.decline_funds", card_velocity_exceeded: "msg.decline_limit", withdrawal_count_limit_exceeded: "msg.decline_limit",
  expired_card: "msg.decline_expired", authentication_required: "msg.decline_confirm", requires_action: "msg.decline_confirm",
  processing_error: "msg.decline_processing", "no saved card": "msg.decline_no_card", read_only: "msg.decline_read_only",
};
/** " (the card was declined)", to follow a sentence; or nothing. */
export function declineReason(failure: string | null | undefined): Text {
  const key = failure ? DECLINES[failure] : undefined;
  return key ? both("msg.decline_reason", { why: both(key) }) : NOTHING;
}

/** A refund's failure: Stripe's failure_reason on the refund, or the error it gave when asked for one. */
const REFUND_FAILURES: Record<string, Key> = {
  expired_or_canceled_card: "msg.refund_why_card_closed", lost_or_stolen_card: "msg.refund_why_card_closed",
  declined: "msg.refund_why_declined", card_declined: "msg.refund_why_declined",
  charge_already_refunded: "msg.refund_why_already",
  charge_disputed: "msg.refund_why_disputed", charge_for_pending_refund_disputed: "msg.refund_why_disputed",
  amount_too_large: "msg.refund_why_too_much",
  balance_insufficient: "msg.refund_why_balance", insufficient_funds: "msg.refund_why_balance",
  merchant_request: "msg.refund_why_stopped",
};
/** " (the payment was already refunded)", to follow a sentence; or nothing. */
export function refundReason(failure: string | null | undefined): Text {
  const key = failure ? REFUND_FAILURES[failure] : undefined;
  return key ? both("msg.decline_reason", { why: both(key) }) : NOTHING;
}
