// WhatsApp, a message channel a plugin sends for the club (plugins/whatsapp, docs/plugins/README.md "A message
// channel"). The plugin never chooses who gets what and never reads members: the server does, as for texts.
//
//   - A member says yes in the app (consent.whatsapp, the words kept with their version), then links their number by
//     sending the club's WhatsApp number the code the app shows them. That proves the number is theirs, in any country,
//     and opens WhatsApp's 24-hour window for the club's answer.
//   - Messages are written like texts (messages.ts): what a member needs to know soon (WHATSAPP_KINDS), never news of
//     what they did themselves, after quiet hours unless it's essential.
//   - sendWhatsApp checks each again as it goes (their yes, their number, quiet hours, stale) and hands the plugin only
//     what it must send: the number, the approved template's name and its words, the language, and the same words as
//     plain text for when WhatsApp's 24-hour window is open. It goes signed, as a delivery on the plugin's own webhook
//     (topic message.send), retried like any event.
//   - What comes back goes through the door, as the plugin's own changes (PLUGIN_OWN): how each message went
//     (plugin.message_status), STOP and WhatsApp's own opt-out (plugin.channel_stop: WhatsApp off for whoever has that
//     number, at once, and what waits for it dropped), and anything else a member writes (plugin.channel_reply: a code
//     links their number; anything else goes to the front desk as a question to the club).
import { createHash, randomInt } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, t, type Lang } from "@kumi/i18n";
import { defineAction, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { atLocal, localParts } from "./clock.ts";
import { keyword, TEXT_KINDS } from "./texts.ts";
import { pluginOfPerson } from "./plugin_cards.ts";
import { skipRepeatsAfterRestore } from "./repeats.ts";
import { movedAway } from "./club_exit.ts";
import { QUIET, quietUntil } from "./messages.ts";
import type { Manifest } from "./plugin_manifest.ts";

/** The version of the words a member says yes to. A new wording gets a new version, and the old yes stands. */
export const WHATSAPP_FORM = "whatsapp-2026-11-18";
/** What goes by WhatsApp, for a member who said yes: what they need to know soon, as texts. Never club news. */
export const WHATSAPP_KINDS = TEXT_KINDS;
/** The templates the club's Meta account must have approved (plugins/whatsapp/README.md), each in English and
 *  Spanish, and the messages each one carries. Each takes two parameters: the club's name, and the message. */
export const WHATSAPP_TEMPLATES: Record<string, readonly string[]> = {
  openpadel_place: ["offered", "match_place_offered"],
  openpadel_update: [...TEXT_KINDS].filter((k) => k !== "offered" && k !== "match_place_offered"),
};
export const templateFor = (kind: string) => Object.entries(WHATSAPP_TEMPLATES).find(([, kinds]) => kinds.includes(kind))?.[0] ?? "openpadel_update";
/** The topic of a message handed to a channel plugin, on its own webhook. */
export const CHANNEL_SEND_TOPIC = "message.send";
/** A link code is good for an hour; a number gets this many wrong ones an hour. */
export const LINK_CODE_MINUTES = 60, LINK_TRIES_PER_HOUR = 5;
/** A message older than this isn't sent: no late news after an outage or a long pause. */
const TOO_OLD_MS = 24 * 3600_000;
const PHONE = z.string().check(z.regex(/^\+[1-9]\d{7,14}$/), z.describe("The member's WhatsApp number as WhatsApp gives it, in E.164 (+34612345678)"));
const hashOf = (phone: string) => createHash("sha256").update(`whatsapp:${phone}`).digest("hex");
/** +34612345678 as "ending in 5678": what a preview says of a number. */
const ending = (phone: string) => phone.slice(-4);

// ---- The channel ----
/** The plugin that sends WhatsApp for the club: installed and not removed, with its status. Null when there's none. */
export async function whatsappPlugin(db: Db | Trx) {
  const rows = await db.selectFrom("plugin").leftJoin("webhook_subscription as s", "s.id", "plugin.subscription_id")
    .select(["plugin.id", "plugin.name", "plugin.status", "plugin.manifest", "plugin.settings", "plugin.subscription_id", "s.paused_at"])
    .where("plugin.status", "!=", "removed").execute();
  return rows.find((r) => (r.manifest as Manifest).channel?.kind === "whatsapp") ?? null;
}
/** Whether members can turn WhatsApp on now: its plugin is on. */
export async function whatsappOn(db: Db | Trx): Promise<boolean> {
  return (await whatsappPlugin(db))?.status === "on";
}
/** The club's own WhatsApp number, from the plugin's setting its manifest names: digits only, for a wa.me link. */
export async function clubWhatsappNumber(db: Db | Trx): Promise<string | null> {
  const p = await whatsappPlugin(db);
  if (!p) return null;
  const key = (p.manifest as Manifest).channel!.address_setting, v = (p.settings as Record<string, unknown> | null)?.[key];
  const digits = typeof v === "string" ? v.replace(/\D/g, "") : "";
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

// ---- Who can be sent WhatsApp ----
export async function whatsappNumber(db: Db | Trx, personId: string): Promise<string | null> {
  return (await db.selectFrom("whatsapp_number").select("phone").where("person_id", "=", personId).executeTakeFirst())?.phone ?? null;
}
/** Their latest answer to WhatsApp: yes, no, or never asked. */
export async function whatsappAnswer(db: Db | Trx, personId: string): Promise<boolean | null> {
  const c = await db.selectFrom("channel_consent").select("granted").where("person_id", "=", personId).where("channel", "=", "whatsapp").where("purpose", "=", "account")
    .orderBy("at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst();
  return c ? c.granted : null;
}
/** The linked number of someone who said yes to WhatsApp, or why not. A junior hears through their parents. */
export async function whatsappable(db: Db | Trx, personId: string): Promise<{ phone: string } | { why: string }> {
  const p = await db.selectFrom("person").select(["junior", "status", "redacted_at"]).where("id", "=", personId).executeTakeFirst();
  if (!p || p.redacted_at || p.status === "archived") return { why: "no person" };
  if (p.junior) return { why: "junior" };
  if ((await whatsappAnswer(db, personId)) !== true) return { why: "no consent" };
  const phone = await whatsappNumber(db, personId);
  return phone ? { phone } : { why: "no number" };
}
async function clubName(db: Db | Trx): Promise<string> {
  return (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;
}

// ---- Saying yes or no ----
export const consentWhatsapp = defineAction({
  name: "consent.whatsapp", version: 1,
  input: z.object({ person_id: z.uuid(), granted: z.boolean(), form_version: z.optional(z.string().check(z.maxLength(40))), app: z.optional(z.enum(["member", "staff"])),
    device: z.optional(z.string().check(z.maxLength(300))) }),
  owners: async (_db, i) => [i.person_id],
  async plan(ctx, i) {
    if (!(await whatsappOn(ctx.db))) throw new KumiError("error.whatsapp_off", {}, 409);
    const p = await ctx.db.selectFrom("person").select(["junior"]).where("id", "=", i.person_id).executeTakeFirst();
    if (!p) throw new KumiError("error.not_found", { thing: both("thing.person") }, 404);
    const answer = await whatsappAnswer(ctx.db, i.person_id), phone = await whatsappNumber(ctx.db, i.person_id);
    if (i.granted) {
      if (p.junior) throw new KumiError("error.whatsapp_kid");
      if (i.form_version !== WHATSAPP_FORM) throw new KumiError("error.texts_form_old");
      // Yes again while the number still isn't linked: a new code.
      if (answer === true && phone) throw new KumiError("error.nothing_changed");
    } else if (answer !== true) throw new KumiError("error.nothing_changed");
    const club = await clubName(ctx.db);
    const key = !i.granted ? "plan.consent.whatsapp_no" : phone ? "plan.consent.whatsapp_yes" : "plan.consent.whatsapp_yes_link";
    return { title: both("action.consent.whatsapp"), summary: both(key, { club, ending: phone ? ending(phone) : "" }), reads: [], ownerIds: [i.person_id], undo: { kind: "reversible" },
      details: { answer, phone } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { answer: boolean | null; phone: string | null }, lang: Lang = ctx.actor.lang === "es" ? "es" : "en";
    if (d.answer !== i.granted) {
      const club = i.granted ? await ctx.trx.selectFrom("club").select(["name", "terms_url", "privacy_policy_url"]).executeTakeFirstOrThrow() : null;
      const evidence = { phone: d.phone, app: i.app ?? null, device: i.device ?? null, via: ctx.actor.via, lang,
        ...(club ? { words: t(lang, "ui.whatsapp_consent", { club: club.name }), ...(club.terms_url || club.privacy_policy_url ? { terms_url: club.terms_url, privacy_policy_url: club.privacy_policy_url } : {}) } : {}) };
      await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: i.person_id, channel: "whatsapp", purpose: "account", granted: i.granted, source: "profile",
        form_version: i.granted ? WHATSAPP_FORM : null, evidence: JSON.stringify(evidence), at: ctx.now }).execute();
    }
    await ctx.trx.deleteFrom("whatsapp_link_code").where((w) => w.or([w("person_id", "=", i.person_id), w("expires_at", "<", ctx.now)])).execute();
    // Turning it off in the app unlinks their number too (STOP keeps it, so turning back on needs no new code): to use
    // another number, they turn it off and on again.
    if (!i.granted) { await ctx.trx.deleteFrom("whatsapp_number").where("person_id", "=", i.person_id).execute(); return { linked: false }; }
    if (d.phone) return { linked: true };
    // The code they send from WhatsApp to link their number (GET /my/whatsapp shows it to them alone).
    for (let n = 0; n < 20; n++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const r = await ctx.trx.insertInto("whatsapp_link_code").values({ person_id: i.person_id, code, expires_at: new Date(ctx.now.getTime() + LINK_CODE_MINUTES * 60_000), created_at: ctx.now })
        .onConflict((oc) => oc.doNothing()).executeTakeFirst();
      if (Number(r.numInsertedOrUpdatedRows ?? 0)) break;
    }
    return { linked: false };
  },
});

/** The member's WhatsApp card (GET /my/whatsapp): whether the club sends WhatsApp, their answer, their number's last
 *  four, the code to send while it isn't linked, and the club's number to send it to. */
export async function whatsappCard(db: Db | Trx, personId: string, lang: Lang, now = new Date()) {
  const on = await whatsappOn(db);
  const p = await db.selectFrom("person").select("junior").where("id", "=", personId).executeTakeFirst();
  const phone = await whatsappNumber(db, personId), code = await db.selectFrom("whatsapp_link_code").select(["code", "expires_at"]).where("person_id", "=", personId)
    .where("expires_at", ">", now).executeTakeFirst();
  const club = await clubName(db), number = on ? await clubWhatsappNumber(db) : null;
  const send = code ? t(lang, "ui.whatsapp_link_text", { code: code.code }) : null;
  return { on, kid: Boolean(p?.junior), answer: await whatsappAnswer(db, personId), linked_ending: phone ? ending(phone) : null,
    code: code ? { code: code.code, expires_at: code.expires_at, send, link: number && send ? `https://wa.me/${number}?text=${encodeURIComponent(send)}` : null } : null,
    club_number: number ? `+${number}` : null, form: { version: WHATSAPP_FORM, words: t(lang, "ui.whatsapp_consent", { club }) } };
}

// ---- Sending ----
/** One line of words, as a template's parameter must be (no line breaks or tabs, never four spaces in a row). */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 900);
/** When the next quiet hours begin, in the club's time (a message that isn't essential mustn't go after then). */
function nextQuiet(now: Date, tz: string): Date {
  const p = localParts(now, tz), today = atLocal(p.y, p.m, p.d, QUIET.from, tz);
  if (today > now) return today;
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return atLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), QUIET.from, tz);
}

/** Hand the plugin the WhatsApp messages that are due. Each is checked again first (they may have said no, or STOP,
 *  or unlinked their number since it was written); stale ones are dropped, not sent late; one written during quiet
 *  hours waits them out unless it's essential. With no WhatsApp plugin any more, what waits is dropped; with it
 *  paused, it waits (and goes stale). The row keeps the exact words handed over. */
export async function sendWhatsApp(db: Db, o: { memberUrl?: string; now?: Date; limit?: number } = {}): Promise<{ handed: number; dropped: number; waiting: number }> {
  const now = o.now ?? new Date(), out = { handed: 0, dropped: 0, waiting: 0 };
  await skipRepeatsAfterRestore(db, now);
  if (await movedAway(db)) return out;
  const due = await db.selectFrom("outbound_message").select(["id", "person_id", "kind", "body", "link", "lang", "essential", "purpose", "stale_at", "created_at", "attempts"])
    .where("status", "=", "waiting").where("channel", "=", "whatsapp").where("send_after", "<=", now).orderBy("send_after").limit(o.limit ?? 50).execute();
  if (!due.length) return out;
  const ch = await whatsappPlugin(db);
  const drop = async (id: string, why: string) => { await db.updateTable("outbound_message").set({ status: "dropped", sent_at: null, failure: why }).where("id", "=", id).execute(); out.dropped++; };
  if (!ch) { for (const m of due) await drop(m.id, "whatsapp off"); return out; }
  const live = ch.status === "on" && Boolean(ch.subscription_id) && !ch.paused_at;
  const club = await db.selectFrom("club").select(["name", "time_zone"]).executeTakeFirstOrThrow();
  for (const m of due) {
    const old = now.getTime() - new Date(m.created_at).getTime() > TOO_OLD_MS;
    if (!live) { if ((m.stale_at && m.stale_at <= now) || old) await drop(m.id, (m.stale_at && m.stale_at <= now) ? "stale" : "whatsapp paused"); else out.waiting++; continue; }
    // Claimed first, so two server processes never hand over the same one.
    const claimed = await db.updateTable("outbound_message").set({ status: "sent", sent_at: now }).where("id", "=", m.id).where("status", "=", "waiting").executeTakeFirst();
    if (!Number(claimed.numUpdatedRows)) continue;
    const to = await whatsappable(db, m.person_id);
    const why = m.stale_at && m.stale_at <= now ? "stale" : old ? "too old" : "why" in to ? to.why : null;
    if (why) { await drop(m.id, why); continue; }
    const quiet = !m.essential && m.purpose !== "staff" ? quietUntil(now, club.time_zone) : null;
    if (quiet) { await db.updateTable("outbound_message").set({ status: "waiting", sent_at: null, send_after: quiet }).where("id", "=", m.id).execute(); out.waiting++; continue; }
    const lang: Lang = m.lang === "es" ? "es" : "en", phone = (to as { phone: string }).phone;
    // The app's address for it, as texts have (texts.ts, textWords).
    const where = m.link && o.memberUrl ? ` ${o.memberUrl.replace(/\/$/, "")}${m.link === "/" ? "" : m.link}` : "";
    const words = oneLine(`${m.body}${where}`);
    const text = `${club.name}: ${words}\n\n${t(lang, "whatsapp.stop")}`;
    const sendBefore = [m.stale_at, m.essential ? null : nextQuiet(now, club.time_zone)].filter((x): x is Date => Boolean(x)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const body = JSON.stringify({ id: `msg_${m.id}`, type: CHANNEL_SEND_TOPIC, created_at: now.toISOString(), data: {
      message_id: m.id, channel: "whatsapp", to: phone, language: lang, template: { name: templateFor(m.kind), parameters: [oneLine(club.name), words] }, text,
      essential: m.essential, send_before: sendBefore ? sendBefore.toISOString() : null } });
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("webhook_delivery").values({ subscription_id: ch.subscription_id!, event_id: null, topic: CHANNEL_SEND_TOPIC, body, next_attempt_at: now }).execute();
      await trx.updateTable("outbound_message").set({ body: text, attempts: m.attempts + 1 }).where("id", "=", m.id).execute();
    });
    out.handed++;
  }
  return out;
}

// ---- What the plugin tells the club ----
/** The live plugin this token is, if its manifest declares a channel: the only one these actions are for. */
async function channelOf(ctx: PlanCtx) {
  const p = await pluginOfPerson(ctx.db, ctx.actor.personId);
  if (!p || (p.manifest as Manifest).channel?.kind !== "whatsapp") throw new KumiError("error.plugin_channel_only", {}, 403);
  return p;
}

export const pluginMessageStatus = defineAction({
  name: "plugin.message_status", version: 1,
  input: z.object({
    message_id: z.uuid().check(z.describe("The message_id the club handed over in message.send")),
    status: z.enum(["sent", "delivered", "read", "failed"]).check(z.describe("sent (WhatsApp took it), delivered (on the phone), read, or failed (it won't arrive)")),
    ref: z.optional(z.string().check(z.minLength(1), z.maxLength(200), z.describe("WhatsApp's own id for the message (wamid...)"))),
    error: z.optional(z.string().check(z.maxLength(300), z.describe("Why it failed, in a few words, with WhatsApp's code"))),
  }),
  async plan(ctx, i) {
    await channelOf(ctx);
    const m = await ctx.db.selectFrom("outbound_message").select(["id", "status"]).where("id", "=", i.message_id).where("channel", "=", "whatsapp").executeTakeFirst();
    if (!m) throw new KumiError("error.not_found", { thing: both("thing.whatsapp_message") }, 404);
    return { title: both("action.plugin.message_status"), summary: both(`plan.whatsapp.status_${i.status}`), reads: [], ownerIds: [ctx.actor.personId!], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const patch: Record<string, unknown> = i.ref ? { provider_ref: i.ref } : {};
    if (i.status === "delivered") patch.delivered_at = ctx.now;
    if (i.status === "read") { patch.seen_at = ctx.now; patch.delivered_at = sql`coalesce(delivered_at, ${ctx.now})`; }
    if (i.status === "failed") Object.assign(patch, { status: "failed", failure: `whatsapp: ${i.error ?? "failed"}`.slice(0, 500) });
    if (Object.keys(patch).length) await ctx.trx.updateTable("outbound_message").set(patch).where("id", "=", i.message_id).execute();
    return null;
  },
});

/** WhatsApp off for whoever has this number, for every purpose, with what waits for them dropped (in the outbox and on
 *  its way to the plugin). Nothing else changes: their texts and email stay as they said. */
async function stopWhatsapp(trx: Trx, phone: string, said: string, now: Date): Promise<number> {
  const people = await trx.selectFrom("whatsapp_number").select("person_id").where("phone", "=", phone).execute();
  for (const p of people) {
    for (const purpose of ["account", "invites", "club_news"] as const)
      await trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: p.person_id, channel: "whatsapp", purpose, granted: false, source: "whatsapp_stop", form_version: null,
        evidence: JSON.stringify({ phone, said }), at: now }).execute();
    await trx.updateTable("outbound_message").set({ status: "dropped", failure: "stopped" }).where("person_id", "=", p.person_id).where("channel", "=", "whatsapp").where("status", "=", "waiting").execute();
  }
  await sql`UPDATE webhook_delivery SET status = 'dropped' WHERE status = 'waiting' AND topic = ${CHANNEL_SEND_TOPIC} AND (body::jsonb -> 'data' ->> 'to') = ${phone}`.execute(trx);
  return people.length;
}

export const pluginChannelStop = defineAction({
  name: "plugin.channel_stop", version: 1,
  input: z.object({ phone: PHONE, said: z.string().check(z.maxLength(200), z.describe("What they sent (STOP, BAJA), or how WhatsApp said they opted out")),
    ref: z.optional(z.string().check(z.minLength(1), z.maxLength(200), z.describe("WhatsApp's id for the message, so one that comes again counts once"))) }),
  async plan(ctx, i) {
    await channelOf(ctx);
    return { title: both("action.plugin.channel_stop"), summary: both("plan.whatsapp.stop", { ending: ending(i.phone) }), reads: [], ownerIds: [ctx.actor.personId!], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const p = await channelOf(ctx);
    if (i.ref) await ctx.trx.insertInto("channel_inbound").values({ ref: i.ref, plugin_id: p.id, from_hash: hashOf(i.phone), outcome: "stop", at: ctx.now }).onConflict((oc) => oc.doNothing()).execute();
    const people = await stopWhatsapp(ctx.trx, i.phone, i.said.slice(0, 200), ctx.now);
    const lang = await langFor(ctx.trx, i.phone);
    return { people, reply: t(lang, "whatsapp.stopped", { club: await clubName(ctx.trx) }) };
  },
});

/** The language to answer a number in: its member's, or the club's. */
async function langFor(db: Db | Trx, phone: string): Promise<Lang> {
  const r = await db.selectFrom("whatsapp_number").innerJoin("person", "person.id", "whatsapp_number.person_id").select("person.locale").where("whatsapp_number.phone", "=", phone).executeTakeFirst();
  const club = await db.selectFrom("club").select("default_language").executeTakeFirst();
  const l = r?.locale ?? club?.default_language ?? "en";
  return l === "es" || l.startsWith("es") ? "es" : "en";
}

type Outcome = "stop" | "link" | "desk" | "unknown" | "too_many";
/** What a message that came in is: STOP, a code to link a number, a member writing to the club, or a number the club
 *  doesn't know (too many wrong codes from it, and its codes aren't tried for an hour). */
async function outcomeOf(db: Db | Trx, phone: string, body: string, now: Date): Promise<{ outcome: Outcome; person: string | null }> {
  if (keyword(body) === "stop") return { outcome: "stop", person: null };
  const member = (await db.selectFrom("whatsapp_number").innerJoin("person", "person.id", "whatsapp_number.person_id").select("person.id").where("whatsapp_number.phone", "=", phone)
    .where("person.redacted_at", "is", null).executeTakeFirst())?.id ?? null;
  const code = body.match(/(?<!\d)(\d{6})(?!\d)/)?.[1];
  if (code) {
    const tries = Number((await db.selectFrom("channel_inbound").select((eb) => eb.fn.countAll<string>().as("n")).where("from_hash", "=", hashOf(phone)).where("outcome", "in", ["unknown", "too_many"])
      .where("at", ">", new Date(now.getTime() - 3600_000)).executeTakeFirstOrThrow()).n);
    const c = tries < LINK_TRIES_PER_HOUR ? await db.selectFrom("whatsapp_link_code").select("person_id").where("code", "=", code).where("expires_at", ">", now).executeTakeFirst() : undefined;
    if (c) return { outcome: "link", person: c.person_id };
    if (!member) return { outcome: tries < LINK_TRIES_PER_HOUR ? "unknown" : "too_many", person: null };
  }
  return member ? { outcome: "desk", person: member } : { outcome: "unknown", person: null };
}

export const pluginChannelReply = defineAction({
  name: "plugin.channel_reply", version: 1,
  input: z.object({ phone: PHONE, body: z.string().check(z.minLength(1), z.maxLength(4000), z.describe("What they wrote, as text")),
    ref: z.string().check(z.minLength(1), z.maxLength(200), z.describe("WhatsApp's id for the message (wamid...), so one that comes again is handled once")) }),
  async plan(ctx, i) {
    await channelOf(ctx);
    if (await ctx.db.selectFrom("channel_inbound").select("ref").where("ref", "=", i.ref).executeTakeFirst()) throw new KumiError("error.nothing_changed");
    const o = await outcomeOf(ctx.db, i.phone, i.body, ctx.now);
    return { title: both("action.plugin.channel_reply"), summary: both(`plan.whatsapp.reply_${o.outcome}`, { ending: ending(i.phone) }), reads: [], ownerIds: [ctx.actor.personId!],
      undo: { kind: "none" }, details: o };
  },
  async apply(ctx, i) {
    const p = await channelOf(ctx);
    // Decided again inside the change: a code taken or a STOP since the preview counts.
    const o = await outcomeOf(ctx.trx, i.phone, i.body, ctx.now);
    const r = await ctx.trx.insertInto("channel_inbound").values({ ref: i.ref, plugin_id: p.id, from_hash: hashOf(i.phone), outcome: o.outcome, at: ctx.now }).onConflict((oc) => oc.doNothing()).executeTakeFirst();
    if (!Number(r.numInsertedOrUpdatedRows ?? 0)) return { outcome: "duplicate", reply: null };
    const club = await clubName(ctx.trx);
    if (o.outcome === "stop") {
      const people = await stopWhatsapp(ctx.trx, i.phone, i.body.slice(0, 200), ctx.now);
      return { outcome: "stop", people, reply: t(await langFor(ctx.trx, i.phone), "whatsapp.stopped", { club }) };
    }
    if (o.outcome === "link") {
      // The number is this member's now (another account that had it loses it), and the code is spent.
      await ctx.trx.deleteFrom("whatsapp_number").where((w) => w.or([w("phone", "=", i.phone), w("person_id", "=", o.person!)])).execute();
      await ctx.trx.insertInto("whatsapp_number").values({ person_id: o.person!, phone: i.phone, linked_at: ctx.now }).execute();
      await ctx.trx.deleteFrom("whatsapp_link_code").where("person_id", "=", o.person!).execute();
      const on = (await whatsappAnswer(ctx.trx, o.person!)) === true;
      return { outcome: "link", reply: t(await langFor(ctx.trx, i.phone), on ? "whatsapp.linked" : "whatsapp.linked_off", { club }) };
    }
    if (o.outcome === "desk") {
      // To the front desk, as the member's question to the club: added to one still open from the last week, or a new one.
      const since = new Date(ctx.now.getTime() - 7 * 86400_000);
      const open = await ctx.trx.selectFrom("question").select(["id", "status", "waiting_since"]).where("asked_by", "=", o.person!).where("person_id", "=", o.person!)
        .where("status", "!=", "closed").where("created_at", ">", since).orderBy("created_at", "desc").limit(1).executeTakeFirst();
      const body = i.body.trim().slice(0, 2000);
      let questionId: string;
      if (open) {
        questionId = open.id;
        await ctx.update("question", open.id, { status: "open", waiting_since: open.status === "open" && open.waiting_since ? open.waiting_since : ctx.now, closed_at: null });
      } else {
        questionId = uuidv7();
        await ctx.insert("question", { id: questionId, person_id: o.person!, asked_by: o.person!, status: "open", waiting_since: ctx.now, created_at: ctx.now });
      }
      await ctx.insert("question_message", { id: uuidv7(), question_id: questionId, side: "member", author_id: o.person!, body: `${body}\n\n${t(await langFor(ctx.trx, i.phone), "whatsapp.came_by")}`, created_at: ctx.now });
      return { outcome: "desk", reply: t(await langFor(ctx.trx, i.phone), "whatsapp.to_desk", { club }) };
    }
    return { outcome: o.outcome, reply: t(await langFor(ctx.trx, i.phone), "whatsapp.unknown", { club }) };
  },
});
