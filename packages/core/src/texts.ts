// Texts (SMS), through the club's own Twilio account (messages.md). Only to US and Canadian numbers, only
// to a number its person confirmed with a code, and only after they said yes in the app. That yes is kept with
// the wording's version, the number and what they said it on. A kid with a login of their own can say yes once
// their parents switch texts on for them; a junior without one is texted through their parents, like any
// message. STOP (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) to the club's number turns off every channel at
// once, for everyone that number belongs to; START turns texts back on.
//
// Texts are for what a member needs to know soon (TEXT_KINDS): a place offered with a deadline, a booking or
// class the club cancelled or moved. Everything else stays in the app, by push and by email. Each text starts
// with the club's name, ends with how to stop, and keeps to the plain text alphabet (GSM-7), so one emoji or
// accent never doubles what it costs.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, t, type Lang, clubFormat } from "@kumi/i18n";
import { defineAction, runAsSystem } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { countHeld, countText, textAllowed, textPrice } from "./text_usage.ts";
import { skipRepeatsAfterRestore } from "./repeats.ts";
import { movedAway } from "./club_exit.ts";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";

/** The version of the words a member says yes to. A new wording gets a new version, and the old yes stands. */
export const TEXTS_FORM = "texts-2026-11-01";

// ---- Whether this server texts at all ----
let texting = false;
/** Set when the server starts: on when the club's Twilio account is set up. */
export function setTexting(on: boolean): void { texting = on; }
export function textingOn(): boolean { return texting; }

/** What a text is about, when the member said yes to texts: what they need to know soon. Never club news. */
export const TEXT_KINDS = new Set(["offered", "match_place_offered", "booking_cancelled", "lesson_cancelled", "booking_moved", "lesson_moved", "booking_lost",
  "match_not_filled", "program_cancelled", "program_cancelled_minimum", "dates_cancelled", "dates_changed", "removed"]);

// ---- Numbers ----
// North American numbers outside the US and Canada (the Caribbean and Bermuda): the same +1, but not ours to
// text, and where SMS pumping sends its premium-rate traffic. US territories stay in.
const ELSEWHERE = new Set(["242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664", "721", "758", "767", "784", "809", "829", "849", "868", "869", "876"]);
// Area codes that aren't a place: personal numbers (5XX), US government (710), international inbound (456), paid
// toll-free (880-882). Codes whose last two digits match (N00, N11, 8XX toll-free, 6XX in Canada) aren't either.
const NOT_A_PLACE = new Set(["456", "521", "522", "523", "524", "525", "526", "527", "528", "529", "532", "535", "538", "542", "543", "545", "546", "547", "549", "550",
  "552", "553", "554", "556", "558", "569", "578", "589", "710", "880", "881", "882"]);

/** A US or Canadian number as +1XXXXXXXXXX, from however it was typed; null for anything else. */
export function usPhone(input: string): string | null {
  const s = input.trim();
  if (!/^[+\d\s().\-]{7,24}$/.test(s)) return null;
  let d = s.replace(/\D/g, "");
  if (s.startsWith("+") && !d.startsWith("1")) return null;   // another country's code
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  const area = d.slice(0, 3), exchange = d.slice(3, 6);
  if (!/^[2-9]/.test(area) || !/^[2-9]/.test(exchange) || exchange.slice(1) === "11") return null;
  if (area[1] === area[2] || ELSEWHERE.has(area) || NOT_A_PLACE.has(area)) return null;
  return `+1${d}`;
}
/** A number from any country as E.164 (+34612345678), read in the club's country when typed without a +; null if
 *  it isn't a real number. Texts still go only to US and Canadian numbers (usPhone): others are told so, and get email. */
export function anyPhone(input: string, country: string = clubFormat().country ?? "US"): string | null {
  const p = parsePhoneNumberFromString(input.trim(), country as CountryCode);
  return p && p.isValid() ? p.number : null;
}
/** A number Kumi may text, as +1XXXXXXXXXX: typed without a + it's read in the club's country first, so a Mexican
 *  club's "55 1234 5678" is Mexico City (+52), never a US number that happens to share the digits. Only a US or
 *  Canadian result is textable, and only in a US or Canadian club unless it was typed with +1. Null otherwise. */
export function textablePhone(input: string, country: string = clubFormat().country ?? "US"): string | null {
  const s = input.trim();
  if (s.startsWith("+") || country === "US" || country === "CA") return usPhone(s);
  const p = anyPhone(s, country);
  return p && p.startsWith("+1") ? usPhone(p) : null;
}
/** +15035550123 as (503) 555-0123. */
export const showPhone = (e164: string) => /^\+1\d{10}$/.test(e164) ? `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}` : e164;

// ---- The plain text alphabet ----
const GSM = new Set([..."@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"]);
const GSM_EXT = new Set([..."^{}\\[~]|€"]);   // two characters each
const PLAIN: Record<string, string> = { á: "a", í: "i", ó: "o", ú: "u", â: "a", ê: "e", î: "i", ô: "o", û: "u", ã: "a", õ: "o", ë: "e", ï: "i", ç: "Ç",
  Á: "A", Í: "I", Ó: "O", Ú: "U", Â: "A", Ê: "E", Î: "I", Ô: "O", Û: "U", È: "E", Ì: "I", Ò: "O", Ù: "U", À: "A",
  "‘": "'", "’": "'", "‚": "'", "“": "\"", "”": "\"", "„": "\"", "–": "-", "—": "-", "…": "...", " ": " ", " ": " ", "\t": " " };
/** The text in the plain text alphabet: accents GSM-7 lacks lose them, curly quotes straighten, anything else goes. */
export function gsm7(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) out += GSM.has(ch) || GSM_EXT.has(ch) ? ch : PLAIN[ch] ?? "";
  return out.replace(/ {2,}/g, " ").trim();
}
/** How many texts a carrier counts (and Twilio bills) this as. Plain: 160 characters in one, 153 a part when
 *  longer, with ^{}\\[~]|€ taking two and never split between parts. Anything else is sent as UCS-2: 70 in one,
 *  67 a part, counted in UTF-16 units (an emoji takes two), and a pair is never split either. */
export function segments(text: string): number {
  const chars = [...text], plain = chars.every((ch) => GSM.has(ch) || GSM_EXT.has(ch));
  const width = (ch: string) => plain ? (GSM_EXT.has(ch) ? 2 : 1) : ch.length;
  const total = chars.reduce((a, ch) => a + width(ch), 0), one = plain ? 160 : 70, part = plain ? 153 : 67;
  if (total <= one) return 1;
  let parts = 1, used = 0;
  for (const ch of chars) { const w = width(ch); if (used + w > part) { parts++; used = 0; } used += w; }
  return parts;
}

// ---- What came in ----
const COURTESY = new Set(["please", "pls", "plz", "thanks", "thank", "you", "thx", "ty", "kindly", "now", "por", "favor", "gracias"]);
const STOP_WORDS = new Set(["stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "optout", "opt out", "revoke", "stop messaging me", "stop texting me",
  "stop texting", "stop messages", "stop texts", "no more texts", "no more messages", "para", "parar", "alto", "baja", "cancelar", "detener"]);
const START_WORDS = new Set(["start", "unstop", "yes"]), HELP_WORDS = new Set(["help", "info", "ayuda"]);
/** What a text to the club's number asks for. Only the whole message counts (CANCEL inside a sentence is
 *  about a booking); courtesy words and emoji around it don't matter. Something that looks like a stop but
 *  isn't one exactly is "near_stop": it gets asked, never guessed. */
export function keyword(body: string): "stop" | "start" | "help" | "near_stop" | null {
  const words = body.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const core = words.filter((w) => !COURTESY.has(w)).join(" ");
  if (STOP_WORDS.has(core)) return "stop";
  if (START_WORDS.has(core)) return "start";
  if (HELP_WORDS.has(core)) return "help";
  if (/\b(stop|unsubscribe|opt out|optout|remove me|baja)\b/.test(words.join(" "))) return "near_stop";
  return null;
}

// ---- Who can be texted ----
/** The confirmed number of someone who said yes to texts (and, for a kid, whose parents allow them), or why not. */
export async function textable(db: Db | Trx, personId: string): Promise<{ phone: string } | { why: string }> {
  const p = await db.selectFrom("person").leftJoin("kid_rule", "kid_rule.person_id", "person.id").select(["person.junior", "person.own_login", "person.status", "person.redacted_at", "kid_rule.texts"])
    .where("person.id", "=", personId).executeTakeFirst();
  if (!p || p.redacted_at || p.status === "archived") return { why: "no person" };
  if (p.junior && !(p.own_login && p.texts)) return { why: "junior" };
  const phone = await confirmedPhone(db, personId);
  if (!phone) return { why: "no number" };
  if ((await textsAnswer(db, personId)) !== true) return { why: "no consent" };
  return { phone };
}
export async function confirmedPhone(db: Db | Trx, personId: string): Promise<string | null> {
  return (await db.selectFrom("auth_identity").select("value").where("person_id", "=", personId).where("kind", "=", "phone").where("verified_at", "is not", null)
    .orderBy("verified_at", "desc").limit(1).executeTakeFirst())?.value ?? null;
}
/** Their latest answer to texts: yes, no, or never asked. */
export async function textsAnswer(db: Db | Trx, personId: string): Promise<boolean | null> {
  const c = await db.selectFrom("channel_consent").select("granted").where("person_id", "=", personId).where("channel", "=", "sms").where("purpose", "=", "account")
    .orderBy("at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst();
  return c ? c.granted : null;
}
async function clubName(db: Db | Trx): Promise<string> {
  return (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;
}

// ---- Saying yes or no ----
export const consentTexts = defineAction({
  name: "consent.texts", version: 1,
  input: z.object({ person_id: z.uuid(), granted: z.boolean(), form_version: z.optional(z.string().check(z.maxLength(40))), app: z.optional(z.enum(["member", "staff"])),
    device: z.optional(z.string().check(z.maxLength(300))) }),
  owners: async (_db, i) => [i.person_id],   // a confirmed number, a kid's rules and their answer are theirs
  async plan(ctx, i) {
    if (!textingOn()) throw new KumiError("error.texts_off", {}, 409);
    const p = await ctx.db.selectFrom("person").leftJoin("kid_rule", "kid_rule.person_id", "person.id").select(["person.junior", "person.own_login", "kid_rule.texts"])
      .where("person.id", "=", i.person_id).executeTakeFirst();
    if (!p) throw new KumiError("error.not_found", { thing: both("thing.person") }, 404);
    const phone = await confirmedPhone(ctx.db, i.person_id);
    if (i.granted) {
      if (p.junior && !(p.own_login && p.texts)) throw new KumiError("error.texts_kid_off");
      if (!phone) throw new KumiError("error.phone_not_confirmed");
      if (i.form_version !== TEXTS_FORM) throw new KumiError("error.texts_form_old");
    }
    if ((await textsAnswer(ctx.db, i.person_id)) === i.granted || (!i.granted && (await textsAnswer(ctx.db, i.person_id)) === null)) throw new KumiError("error.nothing_changed");
    const club = await clubName(ctx.db);
    return { title: both("action.consent.texts"), summary: both(i.granted ? "plan.consent.texts_yes" : "plan.consent.texts_no", { club, phone: showPhone(phone ?? "") }),
      reads: [], ownerIds: [i.person_id], undo: { kind: "reversible" }, details: { phone } };
  },
  async apply(ctx, i, plan) {
    const phone = (plan.details as { phone: string | null }).phone, lang: Lang = ctx.actor.lang === "es" ? "es" : "en";
    // What they said yes to, word for word, with what they said it on, and the club's terms and privacy links shown beside it.
    const club = i.granted ? await ctx.trx.selectFrom("club").select(["name", "terms_url", "privacy_policy_url"]).executeTakeFirstOrThrow() : null;
    const evidence = { phone, app: i.app ?? null, device: i.device ?? null, via: ctx.actor.via, lang,
      ...(club ? { words: t(lang, "ui.texts_consent", { club: club.name }), ...(club.terms_url || club.privacy_policy_url ? { terms_url: club.terms_url, privacy_policy_url: club.privacy_policy_url } : {}) } : {}) };
    await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: i.person_id, channel: "sms", purpose: "account", granted: i.granted, source: "profile",
      form_version: i.granted ? TEXTS_FORM : null, evidence: JSON.stringify(evidence), at: ctx.now }).execute();
    return null;
  },
});

/** A number confirmed with a code becomes theirs. A different number from before: a yes to texts was for the old one, so it ends. */
export const phoneConfirm = defineAction({
  name: "phone.confirm", version: 1, system: true, internal: true,
  input: z.object({ person_id: z.uuid(), phone: z.string().check(z.regex(/^\+1\d{10}$/)) }),
  async plan(ctx, i) {
    const other = await ctx.db.selectFrom("auth_identity").select("person_id").where("kind", "=", "phone").where("value", "=", i.phone).where("person_id", "!=", i.person_id).executeTakeFirst();
    if (other) throw new KumiError("error.phone_taken");
    return { title: both("action.phone.confirm"), summary: both("plan.phone.confirm", { phone: showPhone(i.phone) }), reads: [], ownerIds: [i.person_id], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const before = await confirmedPhone(ctx.trx, i.person_id);
    if (before === i.phone) return { already: true };
    await ctx.trx.deleteFrom("auth_identity").where("person_id", "=", i.person_id).where("kind", "=", "phone").execute();
    await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: i.person_id, kind: "phone", value: i.phone, verified_at: ctx.now }).execute();
    await ctx.update("person", i.person_id, { phone: i.phone });
    if (before && (await textsAnswer(ctx.trx, i.person_id)) === true)
      await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: i.person_id, channel: "sms", purpose: "account", granted: false, source: "number_changed",
        form_version: null, evidence: JSON.stringify({ from: before, to: i.phone }), at: ctx.now }).execute();
    return null;
  },
});

const CHANNELS = ["sms", "email", "push", "whatsapp"] as const, PURPOSES = ["account", "invites", "club_news"] as const;
/** STOP to the club's number: every channel and purpose turned off at once, for whoever that number is. */
export const textStop = defineAction({
  name: "text.stop", version: 1, system: true, internal: true,
  input: z.object({ phone: z.string().check(z.regex(/^\+\d{8,15}$/)), said: z.string().check(z.maxLength(160)) }),
  async plan(ctx, i) {
    return { title: both("action.text.stop"), summary: both("plan.text.stop", { phone: showPhone(i.phone) }), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const people = await ctx.trx.selectFrom("auth_identity").select("person_id").where("kind", "=", "phone").where("value", "=", i.phone).execute();
    for (const p of people) for (const channel of CHANNELS) for (const purpose of PURPOSES)
      await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: p.person_id, channel, purpose, granted: false, source: "text_stop", form_version: null,
        evidence: JSON.stringify({ phone: i.phone, said: i.said }), at: ctx.now }).execute();
    // Club news by email stops with the rest: a marketing sync (the club_news list's readers) hears it.
    for (const p of people) await ctx.emit("club_news.left", { person_id: p.person_id, why: "text_stop" });
    return { people: people.length };
  },
});
/** START: texts back on for whoever that number is and once said yes in the app. The other channels stay as
 *  they are: those are turned back on in the app. */
export const textStart = defineAction({
  name: "text.start", version: 1, system: true, internal: true,
  input: z.object({ phone: z.string().check(z.regex(/^\+\d{8,15}$/)) }),
  async plan(ctx, i) {
    return { title: both("action.text.start"), summary: both("plan.text.start", { phone: showPhone(i.phone) }), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const people = await ctx.trx.selectFrom("auth_identity").select("person_id").where("kind", "=", "phone").where("value", "=", i.phone).where("verified_at", "is not", null)
      .where((eb) => eb.exists(eb.selectFrom("channel_consent").select("id").whereRef("channel_consent.person_id", "=", "auth_identity.person_id")
        .where("channel", "=", "sms").where("purpose", "=", "account").where("granted", "=", true).where("source", "=", "profile"))).execute();
    for (const p of people) if ((await textsAnswer(ctx.trx, p.person_id)) !== true)
      await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: p.person_id, channel: "sms", purpose: "account", granted: true, source: "text_start", form_version: null,
        evidence: JSON.stringify({ phone: i.phone }), at: ctx.now }).execute();
    return { people: people.length };
  },
});
export async function stopNumber(db: Db, phone: string, said: string, now = new Date()) {
  return (await runAsSystem(db, "text.stop", { phone, said: said.slice(0, 160) }, "text", { now })).result as { people: number };
}
export async function startNumber(db: Db, phone: string, now = new Date()) {
  return (await runAsSystem(db, "text.start", { phone }, "text", { now })).result as { people: number };
}

// ---- Sending ----
export interface TextOut { to: string; body: string; statusCallback?: string }
/** The club's texting account. A refusal says whether trying again could help (a network or server problem)
 *  or not (the number can't take texts, or it replied STOP). */
export interface Texter { send(text: TextOut): Promise<{ ref: string | null }> }
export class TextError extends Error {
  readonly code: string; readonly permanent: boolean;
  constructor(code: string, message: string, permanent: boolean) { super(message); this.code = code; this.permanent = permanent; }
}
/** Twilio's answer for a number that replied STOP to the club's number. */
export const UNSUBSCRIBED = "21610";

/** A stand-in for tests: keeps what it was given, and fails the next send when told to. */
export class TestTexter implements Texter {
  sent: TextOut[] = [];
  failNext: TextError | null = null;
  private n = 0;
  async send(text: TextOut) {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.sent.push(text);
    return { ref: `SMtest${String(++this.n).padStart(26, "0")}` };
  }
  last(to: string) { return [...this.sent].reverse().find((x) => x.to === to); }
}

/** A text as it goes: the club's name first, the app's link if there is one, and how to stop last. */
export function textWords(club: string, body: string, lang: Lang, link: string | null, memberUrl: string): string {
  const where = link ? ` ${memberUrl.replace(/\/$/, "")}${link === "/" ? "" : link}` : "";
  return gsm7(`${club}: ${body}${where} ${t(lang, "sms.stop")}`);
}

const MAX_SEND_ATTEMPTS = 5;
/** Send the texts that are due. Each is checked again first (they may have said no, or lost their number,
 *  since it was written); stale ones are dropped, not sent late; a problem that may pass is tried again
 *  later, up to five times, and one that won't is given up on at once. The row keeps the exact words sent. */
export async function sendTexts(db: Db, texter: Texter, o: { memberUrl: string; statusCallback?: string; now?: Date; limit?: number }): Promise<{ sent: number; dropped: number; failed: number }> {
  const now = o.now ?? new Date(), out = { sent: 0, dropped: 0, failed: 0 };
  await skipRepeatsAfterRestore(db, now);   // after a restore, nothing the database before it had sent goes twice
  if (await movedAway(db)) return out;      // moved to another server (club_exit.ts): that one texts members now
  const due = await db.selectFrom("outbound_message").select(["id", "person_id", "body", "link", "lang", "stale_at", "attempts"])
    .where("status", "=", "waiting").where("channel", "=", "sms").where("send_after", "<=", now).orderBy("send_after").limit(o.limit ?? 50).execute();
  if (!due.length) return out;
  const club = await clubName(db);
  for (const m of due) {
    // Claimed first, so two server processes never send the same one.
    const claimed = await db.updateTable("outbound_message").set({ status: "sent", sent_at: now }).where("id", "=", m.id).where("status", "=", "waiting").executeTakeFirst();
    if (!Number(claimed.numUpdatedRows)) continue;
    const to = await textable(db, m.person_id);
    const why = m.stale_at && m.stale_at <= now ? "stale" : "why" in to ? to.why : null;
    if (why) { await db.updateTable("outbound_message").set({ status: "dropped", sent_at: null, failure: why }).where("id", "=", m.id).execute(); out.dropped++; continue; }
    const words = textWords(club, m.body, m.lang === "es" ? "es" : "en", m.link, o.memberUrl), segs = segments(words);
    // Past the club's monthly meter (usage.ts): not sent; the message is in their inbox, and goes by email.
    if (!(await textAllowed(db, "message", segs, now)).ok) { await heldByCap(db, m.id, words, now); out.dropped++; continue; }
    try {
      const r = await texter.send({ to: (to as { phone: string }).phone, body: words, ...(o.statusCallback ? { statusCallback: o.statusCallback } : {}) });
      await db.updateTable("outbound_message").set({ body: words, provider_ref: r.ref, attempts: m.attempts + 1, segments: r.ref ? segs : null }).where("id", "=", m.id).execute();
      if (r.ref) await countText(db, "message", segs, now);
      out.sent++;
    } catch (e) {
      const err = e instanceof TextError ? e : new TextError("network", (e as Error).message, false);
      const retry = !err.permanent && m.attempts + 1 < MAX_SEND_ATTEMPTS;
      await db.updateTable("outbound_message").set({ status: retry ? "waiting" : "failed", sent_at: null, body: words, attempts: m.attempts + 1, failure: `${err.code}: ${err.message}`.slice(0, 500),
        ...(retry ? { send_after: new Date(now.getTime() + 60_000 * 2 ** m.attempts) } : {}) }).where("id", "=", m.id).execute();
      // The number replied STOP to the club's number some time Kumi didn't hear about: it's off everywhere now.
      if (err.code === UNSUBSCRIBED) await stopNumber(db, (to as { phone: string }).phone, "STOP (reported by Twilio)", now);
      out.failed++;
    }
  }
  return out;
}

/** A text the monthly cap kept back. It's in their inbox already; it goes by email too, where they have one and
 *  weren't getting this message by email anyway. */
async function heldByCap(db: Db, id: string, words: string, now: Date) {
  const m = await db.updateTable("outbound_message").set({ status: "dropped", sent_at: null, body: words, failure: "monthly cap reached" }).where("id", "=", id)
    .returning(["event_id", "person_id", "kind"]).executeTakeFirstOrThrow();
  await countHeld(db, now);
  const email = (await db.selectFrom("person").select("email").where("id", "=", m.person_id).executeTakeFirst())?.email;
  if (!email || !m.event_id) return;
  const inbox = await db.selectFrom("outbound_message").selectAll().where("event_id", "=", m.event_id).where("person_id", "=", m.person_id).where("kind", "=", m.kind)
    .where("channel", "=", "inbox").executeTakeFirst();
  if (!inbox) return;
  await db.insertInto("outbound_message").values({ id: uuidv7(now.getTime()), event_id: m.event_id, person_id: m.person_id, kind: m.kind, channel: "email", purpose: inbox.purpose,
    essential: inbox.essential, lang: inbox.lang, subject: inbox.subject, body: inbox.body, link: inbox.link, status: "waiting", send_after: now, stale_at: inbox.stale_at, failure: null, sent_at: null, read_at: null })
    .onConflict((oc) => oc.columns(["event_id", "person_id", "kind", "channel"]).doNothing()).execute();
}

/** Texting switched off: what was waiting to be texted won't be. */
export async function dropWaitingTexts(db: Db): Promise<number> {
  const r = await db.updateTable("outbound_message").set({ status: "dropped", failure: "texts off" }).where("channel", "=", "sms").where("status", "=", "waiting").executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/** Twilio's report on a text it took: when it reached the phone, or that it didn't (no retry: Twilio already
 *  tried, and the number won't change by itself). False when it isn't one of ours. */
export async function textStatus(db: Db, r: { ref: string; status: string; errorCode?: string | null; price?: string | null; now?: Date }): Promise<boolean> {
  const now = r.now ?? new Date();
  const m = await db.selectFrom("outbound_message").select(["id", "person_id", "status"]).where("provider_ref", "=", r.ref).where("channel", "=", "sms").executeTakeFirst();
  if (!m) return false;
  // What it cost, when Twilio says (its status reports often don't; the estimate stands then).
  if (r.price) await textPrice(db, r.ref, r.price, now);
  if (r.status === "delivered") await db.updateTable("outbound_message").set({ delivered_at: now }).where("id", "=", m.id).execute();
  else if (r.status === "undelivered" || r.status === "failed") {
    await db.updateTable("outbound_message").set({ status: "failed", failure: `twilio ${r.status}${r.errorCode ? ` ${r.errorCode}` : ""}` }).where("id", "=", m.id).execute();
    if (r.errorCode === UNSUBSCRIBED) { const phone = await confirmedPhone(db, m.person_id); if (phone) await stopNumber(db, phone, "STOP (reported by Twilio)", now); }
  }
  return true;
}

/** Texts in the last day, for /health/deep and `kumi doctor`. */
/** Twilio's refusals that are about the club's number itself, not the member's: not registered or verified any
 *  more (30032 toll-free, 30034 10DLC), or not a number that can send (21212, 21606, 21659). */
export const NUMBER_CODES = [21212, 21606, 21659, 30032, 30034];
/** How many texts in the last day Twilio refused because of the club's number. */
export async function numberFailures(db: Db, now = new Date()): Promise<number> {
  const re = `(^|[^0-9])(${NUMBER_CODES.join("|")})([^0-9]|$)`;
  const r = await sql<{ n: string }>`SELECT count(*) AS n FROM outbound_message WHERE channel = 'sms' AND status = 'failed'
    AND created_at > ${new Date(now.getTime() - 86_400_000)} AND failure ~ ${re}`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

export async function textCounts(db: Db, now = new Date()) {
  const rows = await sql<{ status: string; n: string }>`SELECT status, count(*) AS n FROM outbound_message WHERE channel = 'sms' AND created_at > ${new Date(now.getTime() - 86_400_000)} GROUP BY status`.execute(db);
  const by = Object.fromEntries(rows.rows.map((r) => [r.status, Number(r.n)]));
  return { sent: by.sent ?? 0, failed: by.failed ?? 0, dropped: by.dropped ?? 0, waiting: by.waiting ?? 0 };
}
