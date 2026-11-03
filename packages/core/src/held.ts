// What was still waiting to go out when a club's export was made (migration 068). The export carries it, and the
// old server, which may still be running, sends it too. So restoring an export holds it here: nothing is sent
// twice, and nothing is lost. Whoever runs this server then says, once the old one is off: `kumi held send` (the
// old server never got to them) or `kumi held drop` (it did). Until then `kumi doctor` says they're waiting.
//
// Refunds are the exception: never held. The refund handler asks the card provider for the refund first (by
// Kumi's own id for it), so one the old server already sent is recorded here, not sent again.
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { messageHandlers } from "./messages.ts";
import { MONEY_TOPICS } from "./outbox.ts";

export interface HeldCounts { messages: number; events: number }

/** Hold everything still waiting: messages not yet sent, and events not yet turned into messages (one nobody
 *  handles, like club.set_up, waits forever anyway; refunds aren't held). Run by the restore of an export, right
 *  after its migrations and before this server does anything of its own. */
/** The events that can be held: those that become messages, refunds aside. */
export const holdableTopics = () => Object.keys(messageHandlers).filter((t) => !MONEY_TOPICS.has(t));

export async function holdPending(db: Db | Trx, now = new Date()): Promise<HeldCounts> {
  const topics = holdableTopics();
  const events = await db.updateTable("event_outbox").set({ held_at: now }).where("delivered_at", "is", null).where("held_at", "is", null)
    .where("topic", "in", topics).executeTakeFirst();
  const messages = await db.updateTable("outbound_message").set({ status: "held" }).where("status", "=", "waiting").executeTakeFirst();
  return { messages: Number(messages.numUpdatedRows), events: Number(events.numUpdatedRows) };
}

/** What's held, by kind: messages by what they are and how they'd go, events by topic, and the oldest of each. */
export async function heldSummary(db: Db | Trx) {
  const messages = await db.selectFrom("outbound_message").select(["kind", "channel", (e) => e.fn.countAll<string>().as("n"), (e) => e.fn.min("created_at").as("oldest")])
    .where("status", "=", "held").groupBy(["kind", "channel"]).orderBy("kind").orderBy("channel").execute();
  const events = await db.selectFrom("event_outbox").select(["topic", (e) => e.fn.countAll<string>().as("n"), (e) => e.fn.min("created_at").as("oldest")])
    .where("held_at", "is not", null).where("delivered_at", "is", null).groupBy("topic").orderBy("topic").execute();
  const total = (rows: { n: string }[]) => rows.reduce((s, r) => s + Number(r.n), 0);
  return {
    messages: total(messages), events: total(events),
    by_message: messages.map((r) => ({ kind: r.kind, channel: r.channel, count: Number(r.n), oldest: r.oldest as Date })),
    by_event: events.map((r) => ({ topic: r.topic, count: Number(r.n), oldest: r.oldest as Date })),
  };
}

/** Whoever runs the server sends what's held, or drops it. Sent, each goes as it would have: an offer or code
 *  that's run out meanwhile is dropped then, and quiet hours apply. Dropped, a receipt is still in the member's
 *  app, and the staff can send it again. */
export const heldRelease = defineAction({
  name: "club.held_release", version: 1, system: true, internal: true,
  input: z.object({ send: z.boolean() }),
  async plan(ctx, i) {
    const h = await heldSummary(ctx.db);
    return { title: both("action.club.held_release"), summary: both(i.send ? "plan.club.held_send" : "plan.club.held_drop", { count: h.messages + h.events }), reads: [],
      undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    if (i.send) {
      const m = await ctx.trx.updateTable("outbound_message").set({ status: "waiting" }).where("status", "=", "held").executeTakeFirst();
      const e = await ctx.trx.updateTable("event_outbox").set({ held_at: null }).where("held_at", "is not", null).where("delivered_at", "is", null).executeTakeFirst();
      return { sent: { messages: Number(m.numUpdatedRows), events: Number(e.numUpdatedRows) } };
    }
    const m = await ctx.trx.updateTable("outbound_message").set({ status: "dropped", failure: "held after the club moved here, then dropped" }).where("status", "=", "held").executeTakeFirst();
    // An event dropped is marked handled, and keeps when it was held: the record of what this server never did.
    const e = await ctx.trx.updateTable("event_outbox").set({ delivered_at: ctx.now }).where("held_at", "is not", null).where("delivered_at", "is", null).executeTakeFirst();
    return { dropped: { messages: Number(m.numUpdatedRows), events: Number(e.numUpdatedRows) } };
  },
});
