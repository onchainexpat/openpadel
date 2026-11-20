// The icon beside a status's words (a pill or chip on a booking, a payment, a refund, a payout): done or paid, waiting,
// cancelled or failed, and a few of their own. Always beside the words, never instead of them. No Preact here: the
// tests read it.
import type { IconName } from "./icon_paths.ts";

const DONE: IconName = "circle-check-big", WAITING: IconName = "hourglass", STOPPED: IconName = "circle-x";
const BY_STATUS: Record<string, IconName> = {
  paid: DONE, done: DONE, sent: DONE, pass: DONE, credit: DONE, membership: DONE, free: DONE,
  pending: WAITING, in_transit: WAITING, waiting_for_sub: WAITING, waitlist: WAITING,
  cancelled: STOPPED, canceled: STOPPED, failed: STOPPED,
  unpaid: "credit-card", upcoming: "calendar-days", in_progress: "clock",
};

/** The icon for a status's key, or null for one that has none. */
export const statusIcon = (status: string): IconName | null => BY_STATUS[status] ?? null;
