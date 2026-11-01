// The outbox worker's handlers: refunds first, then messages. An event whose topic nobody handles stays
// in the outbox undelivered, so /health/deep counts only the topics these pick up.
import { combine, messageHandlers, moneyHandlers } from "@kumi/core";

export const handlers = combine(moneyHandlers, messageHandlers);
export const handledTopics = Object.keys(handlers);
