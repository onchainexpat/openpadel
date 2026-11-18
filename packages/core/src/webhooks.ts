// Signed event webhooks (docs/agents/webhooks.md). An agent, or the owner, names an address and the events it wants
// (booking.cancelled, payment.failed, ...: WEBHOOK_TOPICS, the outbox's own event names). After each change commits,
// its events are copied from the outbox to a delivery for each subscription that wants them and whose reader (the
// agent's own person, or the person who subscribed) reads that part of the club (roles.ts, readAreas), then POSTed:
//
//   POST <url>
//   content-type: application/json
//   openpadel-event: booking.cancelled
//   openpadel-delivery: 812
//   openpadel-signature: t=1763300000,v1=<hex HMAC-SHA256 of "<t>.<body>" under the subscription's secret>
//   {"id":"evt_8812","type":"booking.cancelled","created_at":"...","data":{"booking_id":"...","by":"..."}}
//
// Each delivery is tried up to 8 times, the wait doubling from 30 seconds to an hour. An address that keeps failing
// (15 tries in a row, or failing for a day) is paused, what was waiting for it is dropped, and the owner hears once.
// The secret is sealed (sealed.ts) and shown once, to whoever subscribed; afterwards only its last four characters.
// The addresses: https, and never this server's own network, in production (setWebhookRules; the server checks the
// address it connects to as well, apps/server/src/webhooks.ts).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { backoffMs } from "./outbox.ts";
import { readAreas } from "./roles.ts";
import { openText, sealText } from "./sealed.ts";

/** The events a webhook can ask for, each with the part of the club (roles.ts AREAS) its reader must read. Its data is
 *  the event's own (ids, and a few amounts and times): what changed is read through the door afterwards. */
export const WEBHOOK_TOPICS: Record<string, string> = {
  "booking.created": "bookings", "booking.confirmed": "bookings", "booking.cancelled": "bookings", "booking.moved": "bookings",
  "booking.player_added": "bookings", "booking.player_removed": "bookings", "booking.player_left": "bookings", "booking.joined": "bookings",
  "booking.no_show": "bookings", "open_match.opened": "bookings", "court.blocked": "bookings", "court.freed": "bookings",
  "payment.succeeded": "money", "payment.failed": "money", "refund.failed": "money", "booking.refunded": "money",
  "membership.started": "memberships", "membership.renewed": "memberships", "membership.cancelled": "memberships", "membership.ended": "memberships",
  "membership.payment_failed": "memberships",
  "program.published": "programs", "program.min_cancelled": "programs", "enrolment.booked": "programs", "enrolment.left": "programs",
  "enrolment.removed": "programs", "waitlist.offered": "programs",
  "person.created": "members", "person.signed_up": "members",
  // Someone's answer to club news by email turned yes, or turned no (they said no, stopped from an email's link or by
  // texting STOP, or their account was deleted: `why`). Only the person's id: the list itself is a read (club_news).
  "club_news.joined": "club_news", "club_news.left": "club_news",
  "game.scored": "levels", "result.confirmed": "levels",
};
export const WEBHOOK_TOPIC_NAMES = Object.keys(WEBHOOK_TOPICS).sort();
/** The test event (webhook.test): sent whatever the subscription asked for. */
export const TEST_TOPIC = "webhook.test";
/** What a plugin is sent when its settings change (plugins.ts): sent to it alone, whatever it asked for. */
export const PLUGIN_CONFIGURED_TOPIC = "plugin.configured";
export const WEBHOOK_MAX_ATTEMPTS = 8;
/** Paused after this many failed tries in a row, or after failing this long. */
export const PAUSE_AFTER_FAILURES = 15, PAUSE_AFTER_MS = 24 * 3600_000;
/** How long a signature's time is good for, for whoever checks it (verifyWebhookSignature). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** Live webhooks a club may have at once. */
export const MAX_WEBHOOKS = 50;
/** Events looked at again behind the cursor, for a change that committed after a later one was copied (its id is lower). */
const LOOKBACK_IDS = 1000, LOOKBACK_MS = 15 * 60_000;

// ---- Signing ----
/** The hex HMAC-SHA256 of "<timestamp>.<body>" under the secret (the whole "whsec_..." string, as UTF-8). */
export function webhookSignature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}
/** The openpadel-signature header. */
export const signatureHeader = (secret: string, timestamp: number, body: string) => `t=${timestamp},v1=${webhookSignature(secret, timestamp, body)}`;
/** What a receiver does (docs/agents/webhooks.md has the same in a few lines): the header's time is recent, and its
 *  signature is the body's, compared in constant time. */
export function verifyWebhookSignature(secret: string, header: string, body: string, nowSeconds = Math.floor(Date.now() / 1000), tolerance = SIGNATURE_TOLERANCE_SECONDS): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t), v1 = parts.v1 ?? "";
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > tolerance || !/^[0-9a-f]{64}$/.test(v1)) return false;
  return timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(webhookSignature(secret, t, body), "hex"));
}

// ---- Addresses ----
export interface WebhookRules { httpsOnly: boolean; hostOk: (host: string) => boolean; scrub: (data: unknown) => unknown }
let rules: WebhookRules = { httpsOnly: false, hostOk: () => true, scrub: (d) => d };
/** The server's rules (main.ts): https and public addresses only in production; how event data is shortened (emails and
 *  phones, as the door shows them). Tests and development keep the defaults: any address, http too. */
export function setWebhookRules(r: Partial<WebhookRules>): void { rules = { ...rules, ...r }; }
export function webhookRules(): WebhookRules { return rules; }
/** An address a webhook may be sent to, as it will be kept; refused in words otherwise. */
export function checkWebhookUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new KumiError("error.webhook_url", {}, 400); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new KumiError("error.webhook_url", {}, 400);
  if (rules.httpsOnly && u.protocol !== "https:") throw new KumiError("error.webhook_https", {}, 400);
  if (u.username || u.password) throw new KumiError("error.webhook_url_login", {}, 400);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || !rules.hostOk(host)) throw new KumiError("error.webhook_private", { host }, 400);
  u.hash = "";
  return u.toString();
}
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

// ---- The actions ----
const topicList = z.array(z.enum(WEBHOOK_TOPIC_NAMES as [string, ...string[]])).check(z.minLength(1), z.maxLength(WEBHOOK_TOPIC_NAMES.length));
const urlInput = z.string().check(z.minLength(8), z.maxLength(500), z.describe("Where to POST each event: an https address (http and the server's own network only outside production)"));
/** The topics in words, for a preview: "booking.cancelled, payment.failed". */
const topicsText = (t: string[]): Text => ({ en: t.join(", "), es: t.join(", ") });
/** Of these topics, the ones the reader doesn't read (their part of the club isn't theirs). */
async function unreadable(db: Db | Trx, personId: string, topics: string[]): Promise<string[]> {
  const areas = await readAreas(db, personId);
  return areas === null ? [] : topics.filter((t) => !areas.includes(WEBHOOK_TOPICS[t]!));
}
/** Who a new subscription reads as: the agent asking, or the agent named (by the owner, for it), or the person asking. */
async function subscriber(ctx: PlanCtx, agentId: string | undefined): Promise<{ personId: string; agentId: string | null; name: string }> {
  const id = ctx.actor.agentId ?? agentId;
  if (ctx.actor.agentId && agentId && agentId !== ctx.actor.agentId) throw new KumiError("error.agent_not_for_agents", {}, 403);
  if (id) {
    // A plugin gets the events its manifest names, with its plugin, and no others.
    const p = await ctx.db.selectFrom("plugin").select("name").where("agent_id", "=", id).where("status", "!=", "removed").executeTakeFirst();
    if (p) throw new KumiError("error.webhook_is_plugins", { name: p.name });
    const a = await ctx.db.selectFrom("agent").select(["person_id", "name", "revoked_at", "kind"]).where("id", "=", id).executeTakeFirst();
    if (!a || a.kind !== "club" || !a.person_id) throw new KumiError("error.not_found", { thing: both("thing.agent") }, 404);
    if (a.revoked_at) throw new KumiError("error.agent_revoked", {}, 409);
    return { personId: a.person_id, agentId: id, name: a.name ?? "" };
  }
  if (!ctx.actor.personId) throw new KumiError("error.forbidden_reason", { reason: both("reason.no_role") }, 403);
  const p = await ctx.db.selectFrom("person").select("display_name").where("id", "=", ctx.actor.personId).executeTakeFirstOrThrow();
  return { personId: ctx.actor.personId, agentId: null, name: p.display_name };
}
async function liveHook(db: Db | Trx, id: string, opts: { pluginToo?: boolean } = {}) {
  const { row, read } = await readRow(db, "webhook_subscription", id, "thing.webhook");
  if (!row.active) throw new KumiError("error.not_found", { thing: both("thing.webhook") }, 404);
  // A plugin's webhook goes and changes with its plugin (plugins.ts): its address and events are its manifest's.
  if (!opts.pluginToo) {
    const p = await db.selectFrom("plugin").select("name").where("subscription_id", "=", id).where("status", "!=", "removed").executeTakeFirst();
    if (p) throw new KumiError("error.webhook_is_plugins", { name: p.name });
  }
  return { row, read };
}
/** Whose a subscription is: its reader (an agent's own person, or the person who made it). */
const hookOwner = async (db: Db | Trx, id: string) => {
  const s = await db.selectFrom("webhook_subscription").select("person_id").where("id", "=", id).executeTakeFirst();
  return s ? [s.person_id] : [];
};

export const webhookSubscribe = defineAction({
  name: "webhook.subscribe", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ url: urlInput, topics: topicList, agent_id: z.optional(z.uuid().check(z.describe("For a club agent (it gets what the agent may read); left out, for whoever subscribes"))) }),
  async plan(ctx, i) {
    const url = checkWebhookUrl(i.url), who = await subscriber(ctx, i.agent_id), topics = [...new Set(i.topics)].sort();
    const live = Number((await ctx.db.selectFrom("webhook_subscription").select((eb) => eb.fn.countAll<string>().as("n")).where("active", "=", true).executeTakeFirstOrThrow()).n);
    if (live >= MAX_WEBHOOKS) throw new KumiError("error.webhook_too_many", { count: MAX_WEBHOOKS });
    const unread = await unreadable(ctx.db, who.personId, topics);
    if (unread.length === topics.length) throw new KumiError("error.webhook_reads_nothing", { name: who.name });
    const lines: Text[] = [both("plan.webhook.subscribe", { url: hostOf(url), topics: topicsText(topics), name: who.name })];
    if (unread.length) lines.push(both("plan.webhook.unreadable", { topics: topicsText(unread) }));
    return { title: both("action.webhook.subscribe"), summary: { en: lines.map((l) => l.en).join(" "), es: lines.map((l) => l.es).join(" ") },
      reads: [], ownerIds: [who.personId], undo: { kind: "reversible" }, details: { url, topics, person_id: who.personId, agent_id: who.agentId } };
  },
  async apply(ctx, _i, p) {
    const d = p.details as { url: string; topics: string[]; person_id: string; agent_id: string | null };
    const id = uuidv7(), secret = `whsec_${randomBytes(32).toString("base64url")}`;
    await ctx.insert("webhook_subscription", { id, url: d.url, topics: d.topics, person_id: d.person_id, agent_id: d.agent_id, secret_sealed: sealText(secret),
      secret_last4: secret.slice(-4), created_by: ctx.actor.personId, created_at: ctx.now });
    return { subscription_id: id, secret_last4: secret.slice(-4) };
  },
  // The signing secret, once, to whoever subscribed: never in the change log.
  async after(db, _i, result) {
    const r = result as { subscription_id: string; secret_last4: string };
    const s = await db.selectFrom("webhook_subscription").select("secret_sealed").where("id", "=", r.subscription_id).executeTakeFirst();
    return { ...r, secret: s ? openText(s.secret_sealed) : null, signature_header: "openpadel-signature" };
  },
});

export const webhookUpdate = defineAction({
  name: "webhook.update", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ subscription_id: z.uuid(), url: z.optional(urlInput), topics: z.optional(topicList), resume: z.optional(z.boolean()) }),
  owners: (db, i) => hookOwner(db, i.subscription_id),
  async plan(ctx, i) {
    const { row, read } = await liveHook(ctx.db, i.subscription_id);
    const lines: Text[] = [], patch: Record<string, unknown> = {};
    if (i.url !== undefined) {
      const url = checkWebhookUrl(i.url);
      if (url !== row.url) { patch.url = url; lines.push(both("plan.webhook.url", { url: hostOf(url) })); }
    }
    if (i.topics !== undefined) {
      const topics = [...new Set(i.topics)].sort();
      if (topics.join() !== [...row.topics].sort().join()) {
        const unread = await unreadable(ctx.db, row.person_id, topics);
        if (unread.length === topics.length) throw new KumiError("error.webhook_reads_nothing", { name: "" });
        patch.topics = topics; lines.push(both("plan.webhook.topics", { topics: topicsText(topics) }));
        if (unread.length) lines.push(both("plan.webhook.unreadable", { topics: topicsText(unread) }));
      }
    }
    if (i.resume && row.paused_at) { Object.assign(patch, { paused_at: null, paused_why: null, failures: 0, failing_since: null }); lines.push(both("plan.webhook.resume")); }
    if (!lines.length) throw new KumiError("error.nothing_changed");
    return { title: both("action.webhook.update"), summary: { en: [both("plan.webhook.update", { url: hostOf(row.url) }).en, ...lines.map((l) => l.en)].join(" "), es: [both("plan.webhook.update", { url: hostOf(row.url) }).es, ...lines.map((l) => l.es)].join(" ") },
      reads: [read], ownerIds: [row.person_id], undo: { kind: "reversible" }, details: { patch } };
  },
  async apply(ctx, i, p) {
    await ctx.update("webhook_subscription", i.subscription_id, (p.details as { patch: Record<string, unknown> }).patch);
    return null;
  },
});

export const webhookRemove = defineAction({
  name: "webhook.remove", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ subscription_id: z.uuid() }),
  owners: (db, i) => hookOwner(db, i.subscription_id),
  async plan(ctx, i) {
    const { row, read } = await liveHook(ctx.db, i.subscription_id);
    return { title: both("action.webhook.remove"), summary: both("plan.webhook.remove", { url: hostOf(row.url) }), reads: [read], ownerIds: [row.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.update("webhook_subscription", i.subscription_id, { active: false });
    await ctx.trx.updateTable("webhook_delivery").set({ status: "dropped" }).where("subscription_id", "=", i.subscription_id).where("status", "=", "waiting").execute();
    return null;
  },
});

export const webhookTest = defineAction({
  name: "webhook.test", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ subscription_id: z.uuid() }),
  owners: (db, i) => hookOwner(db, i.subscription_id),
  async plan(ctx, i) {
    const { row } = await liveHook(ctx.db, i.subscription_id);
    return { title: both("action.webhook.test"), summary: both("plan.webhook.test", { url: hostOf(row.url) }), reads: [], ownerIds: [row.person_id], undo: { kind: "none", note: both("reason.webhook_test_sent") } };
  },
  async apply(ctx, i) {
    const id = `test_${uuidv7()}`;
    const body = JSON.stringify({ id, type: TEST_TOPIC, created_at: ctx.now.toISOString(), data: { subscription_id: i.subscription_id, note: "A test from openPadel. Nothing happened at the club." } });
    await ctx.trx.insertInto("webhook_delivery").values({ subscription_id: i.subscription_id, event_id: null, topic: TEST_TOPIC, body, next_attempt_at: ctx.now }).execute();
    return { test_id: id };
  },
});

/** Kumi pauses an address that keeps failing: what waits for it is dropped, and the owner hears once. */
export const webhookPause = defineAction({
  name: "webhook.pause", version: 1, system: true, internal: true,
  input: z.object({ subscription_id: z.uuid(), why: z.string().check(z.maxLength(300)) }),
  async plan(ctx, i) {
    const { row, read } = await liveHook(ctx.db, i.subscription_id, { pluginToo: true });
    if (row.paused_at) throw new KumiError("error.nothing_changed");
    return { title: both("action.webhook.pause"), summary: both("plan.webhook.pause", { url: hostOf(row.url) }), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    await ctx.update("webhook_subscription", i.subscription_id, { paused_at: ctx.now, paused_why: i.why });
    await ctx.trx.updateTable("webhook_delivery").set({ status: "dropped" }).where("subscription_id", "=", i.subscription_id).where("status", "=", "waiting").where("topic", "!=", TEST_TOPIC).execute();
    await ctx.emit("webhook.paused", { subscription_id: i.subscription_id, why: i.why });
    return null;
  },
});

// ---- Copying events to deliveries ----
/** Copies the outbox's new events to a delivery for each live subscription that wants them and whose reader reads them.
 *  Safe to run twice over the same events (one delivery per subscription and event). */
export async function fanOutWebhooks(db: Db, now = new Date(), limit = 500): Promise<{ queued: number }> {
  const max = Number((await db.selectFrom("event_outbox").select((eb) => eb.fn.max("id").as("m")).executeTakeFirst())?.m ?? 0);
  const cur = await db.selectFrom("webhook_cursor").select("last_event_id").executeTakeFirst();
  if (!cur) { await db.insertInto("webhook_cursor").values({ last_event_id: String(max) }).onConflict((oc) => oc.doNothing()).execute(); return { queued: 0 }; }
  const from = Number(cur.last_event_id);
  const subs = await db.selectFrom("webhook_subscription").select(["id", "topics", "person_id", "created_at"]).where("active", "=", true).where("paused_at", "is", null).execute();
  const topics = [...new Set(subs.flatMap((s) => s.topics))];
  if (!topics.length) { if (max > from) await db.updateTable("webhook_cursor").set({ last_event_id: String(max) }).execute(); return { queued: 0 }; }
  const events = await db.selectFrom("event_outbox").select(["id", "topic", "payload", "created_at"]).where("topic", "in", topics).where("id", "<=", String(max))
    .where((w) => w.or([w("id", ">", String(from)), w.and([w("id", ">", String(Math.max(0, from - LOOKBACK_IDS))), w("created_at", ">", new Date(now.getTime() - LOOKBACK_MS))])]))
    .orderBy("id").limit(limit).execute();
  const reads = new Map<string, string[] | null>();
  const readsOf = async (personId: string) => { if (!reads.has(personId)) reads.set(personId, await readAreas(db, personId)); return reads.get(personId)!; };
  let queued = 0;
  for (const e of events) {
    const area = WEBHOOK_TOPICS[e.topic];
    if (!area) continue;
    let body: string | null = null;
    for (const s of subs) {
      if (!s.topics.includes(e.topic) || new Date(s.created_at).getTime() > new Date(e.created_at).getTime()) continue;
      const areas = await readsOf(s.person_id);
      if (areas !== null && !areas.includes(area)) continue;
      body ??= JSON.stringify({ id: `evt_${e.id}`, type: e.topic, created_at: new Date(e.created_at).toISOString(), data: rules.scrub(e.payload) });
      const r = await db.insertInto("webhook_delivery").values({ subscription_id: s.id, event_id: String(e.id), topic: e.topic, body, next_attempt_at: now })
        .onConflict((oc) => oc.columns(["subscription_id", "event_id"]).doNothing()).returning("id").executeTakeFirst();
      if (r) queued++;
    }
  }
  const reached = events.length >= limit ? Number(events[events.length - 1]!.id) : max;
  if (reached > from) await db.updateTable("webhook_cursor").set({ last_event_id: String(reached) }).where("last_event_id", "<", String(reached)).execute();
  return { queued };
}

// ---- Sending ----
/** POSTs a body with these headers and gives back the HTTP status; throws when the address can't be reached in time. */
export type WebhookPost = (url: string, body: string, headers: Record<string, string>) => Promise<number>;

/** Sends the deliveries that are due, each signed with its subscription's secret. */
export async function sendWebhooks(db: Db, post: WebhookPost, now = new Date(), limit = 50): Promise<{ sent: number; failed: number; paused: number }> {
  // Taken by one worker each (SKIP LOCKED), and put a little ahead so another run doesn't take one still being sent.
  const due = await db.transaction().execute(async (trx) => {
    const rows = await trx.selectFrom("webhook_delivery").select(["id", "subscription_id", "topic", "body", "attempts"]).where("status", "=", "waiting").where("next_attempt_at", "<=", now)
      .orderBy("id").limit(limit).forUpdate().skipLocked().execute();
    if (rows.length) await trx.updateTable("webhook_delivery").set({ attempts: sql`attempts + 1`, next_attempt_at: new Date(now.getTime() + 2 * 60_000) }).where("id", "in", rows.map((r) => r.id)).execute();
    return rows;
  });
  let sent = 0, failed = 0, paused = 0;
  for (const d of due) {
    const s = await db.selectFrom("webhook_subscription").select(["url", "secret_sealed", "active", "paused_at", "failures", "failing_since"]).where("id", "=", d.subscription_id).executeTakeFirst();
    if (!s || !s.active || (s.paused_at && d.topic !== TEST_TOPIC)) { await db.updateTable("webhook_delivery").set({ status: "dropped" }).where("id", "=", d.id).execute(); continue; }
    const t = Math.floor(now.getTime() / 1000), attempts = d.attempts + 1;
    const headers = { "content-type": "application/json", "user-agent": "openPadel-Webhooks/1", "openpadel-event": d.topic, "openpadel-delivery": String(d.id),
      "openpadel-signature": signatureHeader(openText(s.secret_sealed), t, d.body) };
    let status: number | null = null, error: string | null = null;
    try { status = await post(s.url, d.body, headers); if (status < 200 || status > 299) error = `HTTP ${status}`; }
    catch (e) { error = String((e as Error).message ?? e).slice(0, 200); }
    if (!error) {
      sent++;
      await db.updateTable("webhook_delivery").set({ status: "sent", sent_at: now, last_status: status, last_error: null }).where("id", "=", d.id).execute();
      await db.updateTable("webhook_subscription").set({ failures: 0, failing_since: null, last_ok_at: now, last_error: null }).where("id", "=", d.subscription_id).execute();
      continue;
    }
    failed++;
    const done = attempts >= WEBHOOK_MAX_ATTEMPTS;
    await db.updateTable("webhook_delivery").set({ status: done ? "failed" : "waiting", next_attempt_at: new Date(now.getTime() + backoffMs(attempts)), last_status: status, last_error: error })
      .where("id", "=", d.id).execute();
    const since = s.failing_since ?? now, failures = s.failures + 1;
    await db.updateTable("webhook_subscription").set({ failures, failing_since: since, last_error: error }).where("id", "=", d.subscription_id).execute();
    if (!s.paused_at && (failures >= PAUSE_AFTER_FAILURES || now.getTime() - new Date(since).getTime() >= PAUSE_AFTER_MS)) {
      await runAsSystem(db, "webhook.pause", { subscription_id: d.subscription_id, why: error }, "webhooks", { now });
      paused++;
    }
  }
  return { sent, failed, paused };
}

/** Every live webhook, for the club's list (Settings, Agents): where it goes, what for, whose reads it has, its secret's
 *  last four, whether it's paused and why, and how its last tries went. */
export async function clubWebhooks(db: Db | Trx) {
  const rows = await db.selectFrom("webhook_subscription").innerJoin("person", "person.id", "webhook_subscription.person_id").leftJoin("agent", "agent.id", "webhook_subscription.agent_id")
    .select(["webhook_subscription.id", "webhook_subscription.url", "webhook_subscription.topics", "webhook_subscription.secret_last4", "webhook_subscription.created_at",
      "webhook_subscription.paused_at", "webhook_subscription.paused_why", "webhook_subscription.failures", "webhook_subscription.last_ok_at", "webhook_subscription.last_error",
      "webhook_subscription.agent_id", "agent.name as agent_name", "person.display_name as person"])
    .where("webhook_subscription.active", "=", true)
    // A plugin's webhook is listed with its plugin (plugins.ts), where it's changed.
    .where((w) => w.not(w.exists(w.selectFrom("plugin").select("plugin.id").whereRef("plugin.subscription_id", "=", "webhook_subscription.id"))))
    .orderBy("webhook_subscription.created_at", "desc").execute();
  const out = [];
  for (const r of rows) {
    const c = await db.selectFrom("webhook_delivery").select(["status", (eb) => eb.fn.countAll<string>().as("n")]).where("subscription_id", "=", r.id)
      .where("created_at", ">", new Date(Date.now() - 7 * 864e5)).groupBy("status").execute();
    const count = (s: string) => Number(c.find((x) => x.status === s)?.n ?? 0);
    out.push({ ...r, for: r.agent_name ?? r.person, week: { sent: count("sent"), waiting: count("waiting"), failed: count("failed"), dropped: count("dropped") } });
  }
  return out;
}
