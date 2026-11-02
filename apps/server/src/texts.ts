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
  UNSUBSCRIBED, usPhone, uuidv7, type Db, type Texter } from "@kumi/core";
import { RateLimiter } from "./limits.ts";
import { validSignature } from "./twilio.ts";

export const CODE_MINUTES = 10, MAX_TRIES = 5, PER_NUMBER = 3, PER_PERSON = 5, PER_CLUB = 30;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const codeHash = (challengeId: string, code: string) => sha(`${challengeId}:${code}`);

type Me = { id: string } | null;
export interface TextDeps {
  db: Db; texter: Texter | null; authToken: string | null;
  /** Twilio posts to this server's address (the staff one); a member's link in a reply is the members' address. */
  publicUrl: string; memberUrl: string;
  me: (c: Context<any>) => Me; lang: (c: Context<any>) => Lang; now: () => Date;
  botGuard: (c: Context<any>) => Promise<"ok" | "honeypot">;
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
    const raw = await c.req.json().catch(() => ({}));
    const parsed = z.safeParse(Start, raw);
    if (!parsed.success) throw new KumiError("error.phone_bad", {}, 400);
    if ((await d.botGuard(c)) === "honeypot") return c.json({ sent: true });
    const phone = usPhone(parsed.data.phone);
    if (!phone) throw new KumiError("error.phone_bad", {}, 400);
    const other = await db.selectFrom("auth_identity").select("person_id").where("kind", "=", "phone").where("value", "=", phone).where("person_id", "!=", id).executeTakeFirst();
    if (other) throw new KumiError("error.phone_taken", {}, 409);
    const hour = new Date(now.getTime() - 3600_000);
    const count = async (f: "target" | "person_id" | null, v?: string) => Number((await db.selectFrom("auth_challenge").select((eb) => eb.fn.countAll<string>().as("n"))
      .where("kind", "in", ["phone_code", "phone_sign_in"]).where("created_at", ">", hour).$if(f !== null, (q) => q.where(f!, "=", v!)).executeTakeFirstOrThrow()).n);
    if (await count("target", phone) >= PER_NUMBER || await count("person_id", id) >= PER_PERSON) throw new KumiError("error.phone_too_many", {}, 429);
    if (await count(null) >= PER_CLUB) { console.warn(`texts: ${PER_CLUB} codes this hour already; not sending more until it calms down`); throw new KumiError("error.phone_too_many", {}, 429); }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0"), cid = uuidv7(now.getTime());
    await db.insertInto("auth_challenge").values({ id: cid, kind: "phone_code", person_id: id, target: phone, code_hash: codeHash(cid, code), expires_at: new Date(now.getTime() + CODE_MINUTES * 60_000), consumed_at: null }).execute();
    const body = textWords(await clubName(), t(lang, "sms.code", { code }), lang, null, d.memberUrl), segs = segments(body);
    // Codes keep going past the monthly text cap, up to its ceiling (text_usage.ts).
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
    const parsed = z.safeParse(Verify, await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new KumiError("error.bad_text_code", {}, 400);
    const ch = await db.selectFrom("auth_challenge").selectAll().where("kind", "=", "phone_code").where("person_id", "=", id).where("consumed_at", "is", null).orderBy("created_at", "desc").executeTakeFirst();
    if (!ch) throw new KumiError("error.phone_no_code", {}, 400);
    if (ch.expires_at.getTime() < now.getTime()) throw new KumiError("error.code_expired", {}, 401);
    if (ch.attempts >= MAX_TRIES) throw new KumiError("error.too_many_attempts", {}, 429);
    if (ch.code_hash !== codeHash(ch.id, parsed.data.code.trim())) {
      await db.updateTable("auth_challenge").set({ attempts: sql`attempts + 1` }).where("id", "=", ch.id).execute();
      const exhausted = ch.attempts + 1 >= MAX_TRIES;
      throw new KumiError(exhausted ? "error.too_many_attempts" : "error.bad_text_code", {}, exhausted ? 429 : 401);
    }
    await db.updateTable("auth_challenge").set({ consumed_at: now }).where("id", "=", ch.id).execute();
    await runAsSystem(db, "phone.confirm", { person_id: id, phone: ch.target }, "web", { now });
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
    if (word === "start") return answer((await startNumber(db, from, now)).people ? say("sms.start_on", null) : say("sms.start_none", "/profile"), "code");
    if (word === "help") return answer(say("sms.help", "/"), "code");
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
