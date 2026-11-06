// Texts in the members' app and from Twilio (texts.ts in core has the rules). A member confirms their number
// with a texted code, then says yes in the app. Codes are guarded like sign-in codes, and more, since each one
// costs the club and a script could aim them at premium numbers (SMS pumping): the bot check, US and Canadian
// numbers only, and at most 3 codes a number, 5 a person and 30 for the whole club in an hour (sign-in codes by
// text count too: auth.ts).
// Twilio posts texts to the club's number and its delivery reports here, signed with the auth token.
import { createHash, randomInt } from "node:crypto";
import { Hono, type Context } from "hono";
import * as z from "zod/mini";
import { sql } from "kysely";
import { t, type Lang } from "@kumi/i18n";
import { confirmedPhone, countText, keyword, KumiError, segments, textAllowed, runAsSystem, showPhone, startNumber, stopNumber, textingOn, textsAnswer, textStatus, textWords, TEXTS_FORM, TextError,
  UNSUBSCRIBED, anyPhone, usPhone, uuidv7, type Db, type Texter, type Trx } from "@kumi/core";
import { RateLimiter } from "./limits.ts";
import { validSignature } from "./twilio.ts";
import { sendUndoLink, tryCode } from "./auth.ts";
import { mayAddSecondStep } from "./passkeys.ts";
import type { Mailer } from "./mailer.ts";

export const CODE_MINUTES = 10, MAX_TRIES = 5, PER_NUMBER = 3, PER_PERSON = 5, PER_CLUB = 30;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const codeHash = (challengeId: string, code: string) => sha(`${challengeId}:${code}`);
/** Texted codes, sign-in and confirm-number alike, are counted and written one at a time (a transaction lock). */
export const lockCodes = (trx: Trx) => sql`SELECT pg_advisory_xact_lock(hashtext('kumi:texted_codes'))`.execute(trx);
/** Texted codes asked for this past hour: for a number, a person, or the whole club. */
export async function countCodes(db: Db | Trx, now: Date, by: { target?: string; person_id?: string } = {}): Promise<number> {
  const hour = new Date(now.getTime() - 3600_000);
  return Number((await db.selectFrom("auth_challenge").select((eb) => eb.fn.countAll<string>().as("n")).where("kind", "in", ["phone_code", "phone_sign_in"]).where("created_at", ">", hour)
    .$if(by.target !== undefined, (q) => q.where("target", "=", by.target!)).$if(by.person_id !== undefined, (q) => q.where("person_id", "=", by.person_id!)).executeTakeFirstOrThrow()).n);
}

type Me = { id: string; method: string; created_at: Date } | null;
export interface TextDeps {
  db: Db; texter: Texter | null; authToken: string | null;
  /** Twilio posts to this server's address (the staff one); a member's link in a reply is the members' address. */
  publicUrl: string; memberUrl: string;
  me: (c: Context<any>) => Me; lang: (c: Context<any>) => Lang; now: () => Date;
  botGuard: (c: Context<any>) => Promise<"ok" | "honeypot">;
  /** A changed sign-in number is told to the person's email, with a link that takes it back. */
  mailer?: Mailer; undoUrl?: (token: string) => string;
}

const Start = z.object({ phone: z.string().check(z.maxLength(40)) });
const Verify = z.object({ code: z.string().check(z.regex(/^\s*\d{6}\s*$/)) });
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function textRoutes(d: TextDeps) {
  const { db } = d;
  const app = new Hono();
  const on = () => Boolean(d.texter) && textingOn();
  const who = (c: Context<any>) => { const me = d.me(c); if (!me) throw new KumiError("error.signed_out", {}, 401); return me.id; };
  const clubName = async () => (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;
  /** A new sign-in number: the person's email hears, with a link that takes it back, and the old number is told
   *  it's no longer on the account (one short text, counted like a code). */
  const toldOfNewNumber = async (personId: string, before: string | null, phone: string, lang: Lang, now: Date) => {
    const p = await db.selectFrom("person").select(["email"]).where("id", "=", personId).executeTakeFirstOrThrow();
    if (p.email && d.mailer && d.undoUrl) await sendUndoLink(db, d.mailer, personId, p.email, "auth.phone_changed_subject", "auth.phone_changed_body", { phone: showPhone(phone) }, d.undoUrl, now);
    if (!before || !d.texter) return;
    const body = textWords(await clubName(), t(lang, "sms.number_moved"), lang, null, d.memberUrl), segs = segments(body);
    if (!(await textAllowed(db, "code", segs, now)).ok) return;
    try { if ((await d.texter.send({ to: before, body })).ref) await countText(db, "code", segs, now); } catch { /* a stopped or dead old number: nothing to tell */ }
  };

  // What the Texts card on the profile shows.
  app.get("/my/texts", async (c) => {
    const id = who(c), lang = d.lang(c);
    const p = await db.selectFrom("person").leftJoin("kid_rule", "kid_rule.person_id", "person.id").select(["person.junior", "person.own_login", "kid_rule.texts"]).where("person.id", "=", id).executeTakeFirstOrThrow();
    const phone = await confirmedPhone(db, id);
    const pending = await db.selectFrom("auth_challenge").select("target").where("kind", "=", "phone_code").where("person_id", "=", id).where("consumed_at", "is", null)
      .where("expires_at", ">", d.now()).orderBy("created_at", "desc").executeTakeFirst();
    return c.json({ on: on(), phone: phone ? showPhone(phone) : null, waiting_code_for: pending ? showPhone(pending.target) : null, answer: await textsAnswer(db, id),
      kid: p.junior ? { allowed: Boolean(p.own_login && p.texts) } : null, form: { version: TEXTS_FORM, words: t(lang, "ui.texts_consent", { club: await clubName() }) } });
  });

  // A code to the number they typed.
  app.post("/my/phone/start", async (c) => {
    const id = who(c), lang = d.lang(c), now = d.now();
    if (!on()) throw new KumiError("error.texts_off", {}, 409);
    // A confirmed number signs in: like adding a passkey, right after signing in, and with the passkey or
    // authenticator for someone who has one.
    await mayAddSecondStep(db, d.me(c)!, now, "phone");
    const raw = await c.req.json().catch(() => ({}));
    const parsed = z.safeParse(Start, raw);
    if (!parsed.success) throw new KumiError("error.phone_bad", {}, 400);
    if ((await d.botGuard(c)) === "honeypot") return c.json({ sent: true });
    const phone = usPhone(parsed.data.phone);
    if (!phone) throw new KumiError(anyPhone(parsed.data.phone) ? "error.phone_not_textable" : "error.phone_bad", {}, 400);
    // Another account's number gets the same answer as a free one (numbers can't be probed): a code nobody is sent.
    const taken = Boolean(await db.selectFrom("auth_identity").select("person_id").where("kind", "=", "phone").where("value", "=", phone).where("person_id", "!=", id).executeTakeFirst());
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0"), cid = uuidv7(now.getTime());
    // Counted and written under one lock, shared with sign-in codes (auth.ts).
    await db.transaction().execute(async (trx) => {
      await lockCodes(trx);
      if (await countCodes(trx, now, { target: phone }) >= PER_NUMBER || await countCodes(trx, now, { person_id: id }) >= PER_PERSON) throw new KumiError("error.phone_too_many", {}, 429);
      if (await countCodes(trx, now) >= PER_CLUB) { console.warn(`texts: ${PER_CLUB} codes this hour already; not sending more until it calms down`); throw new KumiError("error.phone_too_many", {}, 429); }
      await trx.insertInto("auth_challenge").values({ id: cid, kind: "phone_code", person_id: id, target: phone, code_hash: codeHash(cid, taken ? randomInt(0, 2 ** 47).toString(36) : code), expires_at: new Date(now.getTime() + CODE_MINUTES * 60_000), consumed_at: null }).execute();
    });
    if (taken) return c.json({ sent: true, phone: showPhone(phone) });
    const body = textWords(await clubName(), t(lang, "sms.code", { code }), lang, null, d.memberUrl), segs = segments(body);
    // Codes keep going past the club's monthly cap, up to the meter's ceiling (usage.ts).
    if (!(await textAllowed(db, "code", segs, now)).ok) { await db.updateTable("auth_challenge").set({ consumed_at: now }).where("id", "=", cid).execute(); throw new KumiError("error.texts_paused", {}, 429); }
    try { if ((await d.texter!.send({ to: phone, body })).ref) await countText(db, "code", segs, now); }
    catch (e) {
      await db.updateTable("auth_challenge").set({ consumed_at: now }).where("id", "=", cid).execute();
      if (e instanceof TextError && e.code === UNSUBSCRIBED) throw new KumiError("error.phone_stopped", {}, 409);
      if (e instanceof TextError && e.permanent) throw new KumiError("error.phone_cant_text", {}, 400);
      throw e;
    }
    return c.json({ sent: true, phone: showPhone(phone) });
  });

  // The code back: the number is theirs.
  app.post("/my/phone/verify", async (c) => {
    const id = who(c), now = d.now();
    await mayAddSecondStep(db, d.me(c)!, now, "phone");
    const parsed = z.safeParse(Verify, await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new KumiError("error.bad_text_code", {}, 400);
    const ch = await db.selectFrom("auth_challenge").selectAll().where("kind", "=", "phone_code").where("person_id", "=", id).where("consumed_at", "is", null).orderBy("created_at", "desc").executeTakeFirst();
    if (!ch) throw new KumiError("error.phone_no_code", {}, 400);
    await tryCode(db, ch, parsed.data.code, now, "error.bad_text_code");
    const before = await confirmedPhone(db, id);
    await runAsSystem(db, "phone.confirm", { person_id: id, phone: ch.target }, "web", { now });
    if (before !== ch.target) await toldOfNewNumber(id, before, ch.target, d.lang(c), now);
    return c.json({ phone: showPhone(ch.target) });
  });

  // ---- From Twilio ----
  /** The form Twilio posted, if its signature is right for the address it posted to. */
  const signed = async (c: Context<any>): Promise<Record<string, string>> => {
    if (!d.authToken) throw new KumiError("error.not_found", { thing: { en: "texts", es: "mensajes" } }, 404);
    const form = await c.req.parseBody().catch(() => ({}));
    const params = Object.fromEntries(Object.entries(form).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    const url = `${d.publicUrl.replace(/\/$/, "")}${c.req.path}${new URL(c.req.url).search}`;
    if (!validSignature(d.authToken, url, params, c.req.header("x-twilio-signature"))) throw new KumiError("error.forbidden", {}, 403);
    return params;
  };
  const twiml = (c: Context<any>, say?: string) => c.body(`<?xml version="1.0" encoding="UTF-8"?><Response>${say ? `<Message>${xml(say)}</Message>` : ""}</Response>`, 200, { "content-type": "text/xml" });
  // One answer a day to a number that writes anything else, so two machines can't text each other forever.
  const answered = new RateLimiter(1, 86_400_000);
  // HELP and START are answered only for US and Canadian numbers, once a day each per number, and at most 60 an
  // hour in all: a flood of them from abroad (or from many numbers) can't spend the club's texts.
  const helpAnswered = new RateLimiter(1, 86_400_000), startAnswered = new RateLimiter(1, 86_400_000), keywordHour = new RateLimiter(60, 3_600_000);
  const mayAnswer = (from: string, which: RateLimiter, now: Date) => {
    const ok = usPhone(from) !== null && which.take(from, now.getTime()) && keywordHour.take("club", now.getTime());
    if (!ok) console.log(`[text in] a keyword from ${from.slice(0, -4)}**** not answered (outside US and Canada, or answered already)`);
    return ok;
  };

  // A text to the club's number. STOP turns everything off (Twilio itself confirms it, so nothing more is
  // said), START turns texts back on, HELP says what these texts are; anything else is told once a day that
  // replies aren't read here.
  app.post("/webhooks/twilio/sms", async (c) => {
    const p = await signed(c), now = d.now();
    const from = p.From ?? "", said = p.Body ?? "", word = keyword(said);
    if (!/^\+\d{8,15}$/.test(from)) return twiml(c);
    const person = await db.selectFrom("auth_identity").innerJoin("person", "person.id", "auth_identity.person_id").select(["person.locale"])
      .where("auth_identity.kind", "=", "phone").where("auth_identity.value", "=", from).executeTakeFirst();
    const lang: Lang = person?.locale === "es" ? "es" : "en", club = await clubName();
    const say = (key: Parameters<typeof t>[1], link: string | null) => textWords(club, t(lang, key), lang, link, d.memberUrl);
    // An answer is a text the club pays for too (text_usage.ts): HELP and START, which carriers require, go up to
    // the cap's ceiling like codes; the rest stop at the cap.
    const answer = async (text: string, use: "message" | "code") => {
      const segs = segments(text);
      if (!(await textAllowed(db, use, segs, now)).ok) return twiml(c);
      await countText(db, use, segs, now);
      return twiml(c, text);
    };
    if (word === "stop") { await stopNumber(db, from, said, now); return twiml(c); }
    if (word === "start") {
      const back = await startNumber(db, from, now);
      return mayAnswer(from, startAnswered, now) ? answer(back.people ? say("sms.start_on", null) : say("sms.start_none", "/profile"), "code") : twiml(c);
    }
    if (word === "help") return mayAnswer(from, helpAnswered, now) ? answer(say("sms.help", "/"), "code") : twiml(c);
    if (!answered.take(from, now.getTime())) return twiml(c);
    return answer(word === "near_stop" ? say("sms.near_stop", null) : say("sms.not_read", "/"), "message");
  });

  // Twilio's report on a text: delivered, or not.
  app.post("/webhooks/twilio/status", async (c) => {
    const p = await signed(c);
    if (p.MessageSid && p.MessageStatus) await textStatus(db, { ref: p.MessageSid, status: p.MessageStatus, errorCode: p.ErrorCode ?? null, price: p.Price ?? null, now: d.now() });
    return c.body(null, 204);
  });

  return app;
}
