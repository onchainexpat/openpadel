// What Kumi tells people (messages.md). Events become messages after their change commits: each lands
// in the person's in-app inbox at once, and its email copy waits for the sender job, outside quiet
// hours unless it's essential. Every row keeps the exact words sent and the event behind it.
import { sql } from "kysely";
import { both, dateTime, money, t, pickLang, type Key, type Lang, type Params, type Text } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import type { Handler, OutboxEvent } from "./outbox.ts";
import { uuidv7 } from "./ids.ts";

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

/** Quiet hours in the club's time, by default 9 pm to 8 am (messages.md). */
export const QUIET = { from: 21, until: 8 };
/** An event older than this tells nobody: no late news after an outage, or for events from before messages. */
const TOO_OLD_MS = 24 * 3600_000;
const MAX_SEND_ATTEMPTS = 5;

type Purpose = "account" | "staff";
interface Draft {
  to: string;
  kind: string;                 // msg.<kind>.subject and msg.<kind>.body in the catalogs
  params: Params;
  purpose: Purpose;
  essential: boolean;           // sign-ins, confirmations, removals, money: ignore quiet hours
  email: boolean;               // also by email, or the inbox only
  link?: string;
  staleAt?: Date | null;        // not worth sending after this
}

function localParts(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    .formatToParts(d).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, min: p.minute! };
}
/** The instant the clock in `tz` shows that local date and hour. */
function atLocal(y: number, m: number, d: number, h: number, tz: string): Date {
  const want = Date.UTC(y, m - 1, d, h);
  let guess = want;
  for (let i = 0; i < 2; i++) { const p = localParts(new Date(guess), tz); guess -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - want; }
  return new Date(guess);
}
/** When quiet hours end, if `now` is inside them in the club's time; otherwise null. */
export function quietUntil(now: Date, tz: string, q = QUIET): Date | null {
  const p = localParts(now, tz);
  if (p.h >= q.until && p.h < q.from) return null;
  if (p.h < q.until) return atLocal(p.y, p.m, p.d, q.until, tz);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return atLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), q.until, tz);
}

// ---- What each event says, and to whom ----
type Ctx = { db: Db; tz: string };
const amount = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const when = (d: Date | null, tz: string): Text => d ? { en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) } : { en: "", es: "" };
const NOTHING: Text = { en: "", es: "" };

/** The enrolment, its program and when it starts (its own date, or the program's first). */
async function place(db: Db, enrolmentId: string) {
  const e = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id")
    .select(["enrolment.id", "enrolment.person_id", "enrolment.program_id", "enrolment.session_id", "enrolment.price_cents", "enrolment.waitlist_position", "enrolment.left_reason", "program.name"])
    .where("enrolment.id", "=", enrolmentId).executeTakeFirstOrThrow();
  const s = await db.selectFrom("session").select((eb) => eb.fn.min("starts_at").as("s")).where("program_id", "=", e.program_id).where("status", "!=", "cancelled")
    .$if(Boolean(e.session_id), (q) => q.where("id", "=", e.session_id!)).executeTakeFirst();
  return { ...e, start: (s?.s as Date | null) ?? null };
}
async function paidFor(db: Db, enrolmentId: string): Promise<number> {
  const r = await db.selectFrom("payment").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", enrolmentId).where("status", "=", "succeeded").executeTakeFirst();
  return Number(r?.c ?? 0);
}
async function owes(db: Db, enrolmentId: string): Promise<number> {
  const r = await db.selectFrom("payment").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", enrolmentId).where("status", "=", "pending").executeTakeFirst();
  return Number(r?.c ?? 0);
}
/** Owners and managers: who hears about money that went wrong and clashes with Playtomic. */
async function managers(db: Db): Promise<string[]> {
  const rows = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.person_id")
    .where("role.key", "in", ["owner", "manager"]).where("person_role.active", "=", true).distinct().execute();
  return rows.map((r) => r.person_id);
}
function refundLine(outcome: string, cents: number, paid: number): Text {
  if (cents > 0) return both(outcome === "credit" ? "msg.refund_credit" : "msg.refund_card", { amount: amount(cents) });
  return paid > 0 ? both("msg.refund_none") : NOTHING;
}

const composers: Record<string, (c: Ctx, p: any) => Promise<Draft[]>> = {
  async "enrolment.booked"({ db, tz }, p: { enrolment_id: string }) {
    const e = await place(db, p.enrolment_id), due = await owes(db, e.id);
    // With something to pay, the confirmation comes with the payment; until then it's in the inbox only.
    if (due > 0) return [{ to: e.person_id, kind: "booked_to_pay", params: { name: e.name, when: when(e.start, tz), amount: amount(due) }, purpose: "account", essential: false, email: false, link: "/places" }];
    return [{ to: e.person_id, kind: "booked", params: { name: e.name, when: when(e.start, tz) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "payment.succeeded"({ db, tz }, p: { payment_id: string }) {
    const pay = await db.selectFrom("payment").select(["enrolment_id", "amount_cents", "person_id"]).where("id", "=", p.payment_id).executeTakeFirstOrThrow();
    if (!pay.enrolment_id) return [];
    const e = await place(db, pay.enrolment_id);
    return [{ to: pay.person_id, kind: "paid", params: { name: e.name, when: when(e.start, tz), amount: amount(pay.amount_cents) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "payment.failed"({ db }, p: { payment_id: string }) {
    const pay = await db.selectFrom("payment").select(["enrolment_id", "amount_cents", "person_id"]).where("id", "=", p.payment_id).executeTakeFirstOrThrow();
    if (!pay.enrolment_id) return [];
    const e = await place(db, pay.enrolment_id);
    return [{ to: pay.person_id, kind: "payment_failed", params: { name: e.name, amount: amount(pay.amount_cents) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "enrolment.waitlisted"({ db }, p: { enrolment_id: string }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "waitlisted", params: { name: e.name, position: e.waitlist_position ?? 1 }, purpose: "account", essential: false, email: false, link: "/places" }];
  },
  async "waitlist.offered"({ db, tz }, p: { enrolment_id: string; offer_id: string }) {
    const e = await place(db, p.enrolment_id);
    const o = await db.selectFrom("waitlist_offer").select("expires_at").where("id", "=", p.offer_id).executeTakeFirstOrThrow();
    return [{ to: e.person_id, kind: "offered", params: { name: e.name, when: when(e.start, tz), until: when(o.expires_at, tz) }, purpose: "account", essential: false, email: true, link: "/", staleAt: o.expires_at }];
  },
  async "waitlist.offer_expired"({ db }, p: { enrolment_id: string }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "offer_expired", params: { name: e.name }, purpose: "account", essential: false, email: true, link: "/places", staleAt: e.start }];
  },
  async "enrolment.left"({ db, tz }, p: { enrolment_id: string; refund_outcome: string; refund_cents: number }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "left", params: { name: e.name, when: when(e.start, tz), refund: refundLine(p.refund_outcome, p.refund_cents, await paidFor(db, e.id)) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "enrolment.removed"({ db, tz }, p: { enrolment_id: string; reason: string; refund_outcome: string; refund_cents: number }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "removed", params: { name: e.name, when: when(e.start, tz), reason: both(`reason.${p.reason}` as Key), refund: refundLine(p.refund_outcome, p.refund_cents, await paidFor(db, e.id)) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "enrolment.transferred"({ db, tz }, p: { from: string; to: string; pay: "sub_pays" | "gift" }) {
    const from = await place(db, p.from), to = await place(db, p.to);
    const names = await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", [from.person_id, to.person_id]).execute();
    const name = (id: string) => names.find((n) => n.id === id)?.display_name ?? "";
    const due = await owes(db, to.id), paid = await paidFor(db, from.id);
    const drafts: Draft[] = [
      { to: from.person_id, kind: "passed_on", params: { name: from.name, when: when(from.start, tz), sub: name(to.person_id),
        refund: p.pay === "sub_pays" && paid > 0 ? both("msg.refund_after_sub", { amount: amount(paid), sub: name(to.person_id) }) : NOTHING }, purpose: "account", essential: true, email: true, link: "/places" },
      { to: to.person_id, kind: "passed_to_you", params: { name: to.name, when: when(to.start, tz), person: name(from.person_id),
        pay: due > 0 ? both("msg.pay_to_keep", { amount: amount(due) }) : both("msg.paid_for") }, purpose: "account", essential: true, email: true, link: "/places" },
    ];
    return drafts;
  },
  async "refund.failed"({ db }, p: { refund_id: string }) {
    const r = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("person", "person.id", "payment.person_id")
      .select(["refund.amount_cents", "refund.failure", "refund.enrolment_id", "person.display_name"]).where("refund.id", "=", p.refund_id).executeTakeFirstOrThrow();
    const e = r.enrolment_id ? await place(db, r.enrolment_id) : null;
    const params = { amount: amount(r.amount_cents), person: r.display_name, name: e?.name ?? "", failure: r.failure ?? "" };
    return (await managers(db)).map((to) => ({ to, kind: "refund_failed", params, purpose: "staff" as const, essential: false, email: true, link: e ? `/programs/${e.program_id}` : "/" }));
  },
  async "mirror.conflict"({ db, tz }, p: { court_name: string | null; start: string; type: string }) {
    const params = { court: p.court_name ?? "", when: when(new Date(p.start), tz), type: p.type.toLowerCase().replace(/_/g, " ") };
    return (await managers(db)).map((to) => ({ to, kind: "mirror_conflict", params, purpose: "staff" as const, essential: false, email: true, link: "/playtomic" }));
  },
};

/** Write an event's messages: the inbox copy now, the email copy for the sender. Safe to run twice. */
async function compose(db: Db, ev: OutboxEvent, now = new Date()): Promise<number> {
  if (now.getTime() - new Date(ev.created_at).getTime() > TOO_OLD_MS) return 0;
  const club = await db.selectFrom("club").select(["time_zone", "default_language"]).executeTakeFirstOrThrow();
  const drafts = await composers[ev.topic]!({ db, tz: club.time_zone }, ev.payload);
  let written = 0;
  for (const d of drafts) {
    const person = await db.selectFrom("person").select(["locale", "email", "status", "redacted_at"]).where("id", "=", d.to).executeTakeFirst();
    if (!person || person.redacted_at || person.status === "archived") continue;
    const lang: Lang = pickLang(person.locale, pickLang(club.default_language));
    const words = { subject: t(lang, `msg.${d.kind}.subject` as Key, d.params), body: t(lang, `msg.${d.kind}.body` as Key, d.params).replace(/\s+$/, "") };
    const base = { event_id: ev.id, person_id: d.to, kind: d.kind, purpose: d.purpose, essential: d.essential, lang, ...words, link: d.link ?? null, stale_at: d.staleAt ?? null };
    const rows = [{ ...base, id: uuidv7(now.getTime()), channel: "inbox", status: "sent", send_after: now, sent_at: now }];
    if (d.email && person.email) {
      // Staff alerts and essential messages go straight away; the rest wait out quiet hours.
      const wait = d.essential || d.purpose === "staff" ? null : quietUntil(now, club.time_zone);
      rows.push({ ...base, id: uuidv7(now.getTime()), channel: "email", status: "waiting", send_after: wait ?? now, sent_at: null as any });
    }
    const r = await db.insertInto("outbound_message").values(rows as any).onConflict((oc) => oc.columns(["event_id", "person_id", "kind", "channel"]).doNothing()).execute();
    written += r.reduce((n, x) => n + Number(x.numInsertedOrUpdatedRows ?? 0), 0);
  }
  return written;
}

/** The outbox handlers for messages, one per event that tells someone something. */
export const messageHandlers: Record<string, Handler> = Object.fromEntries(Object.keys(composers).map((topic) => [topic, (db: Db, _p: unknown, ev?: OutboxEvent) => compose(db, ev!).then(() => {})]));

/** Whether the person's latest answer for this channel and purpose is no (consent is append-only). */
async function refused(db: Db | Trx, personId: string, channel: string, purpose: string): Promise<boolean> {
  const c = await db.selectFrom("channel_consent").select("granted").where("person_id", "=", personId).where("channel", "=", channel).where("purpose", "=", purpose)
    .orderBy("at", "desc").limit(1).executeTakeFirst();
  return c?.granted === false;
}

/** Send the emails that are due. Ones gone stale are dropped, not sent late; a failure is tried again. */
export async function sendEmails(db: Db, mailer: Mailer, now = new Date(), limit = 50): Promise<{ sent: number; dropped: number; failed: number }> {
  const out = { sent: 0, dropped: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const done = await db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom("outbound_message").innerJoin("person", "person.id", "outbound_message.person_id")
        .select(["outbound_message.id", "outbound_message.person_id", "outbound_message.purpose", "outbound_message.essential", "outbound_message.subject", "outbound_message.body",
          "outbound_message.stale_at", "outbound_message.attempts", "person.email"])
        .where("outbound_message.status", "=", "waiting").where("outbound_message.channel", "=", "email").where("outbound_message.send_after", "<=", now)
        .orderBy("outbound_message.send_after").limit(1).forUpdate("outbound_message").skipLocked().executeTakeFirst();
      if (!m) return null;
      // Consent is checked now, at the send: a member who said no to email since still isn't emailed,
      // except what they can't do without (sign-ins, confirmations, money).
      const why = !m.email ? "no email" : !m.essential && m.purpose !== "staff" && await refused(trx, m.person_id, "email", m.purpose) ? "no consent" : m.stale_at && m.stale_at <= now ? "stale" : null;
      if (why) {
        await trx.updateTable("outbound_message").set({ status: "dropped", failure: why }).where("id", "=", m.id).execute();
        return "dropped" as const;
      }
      try {
        await mailer.send({ to: m.email!, subject: m.subject, text: m.body });
        await trx.updateTable("outbound_message").set({ status: "sent", sent_at: now, attempts: sql`attempts + 1` }).where("id", "=", m.id).execute();
        return "sent" as const;
      } catch (e) {
        const gaveUp = m.attempts + 1 >= MAX_SEND_ATTEMPTS;
        // Try again in a few minutes, longer each time.
        await trx.updateTable("outbound_message").set({ status: gaveUp ? "failed" : "waiting", attempts: sql`attempts + 1`, failure: String((e as Error).message).slice(0, 500),
          send_after: new Date(now.getTime() + 5 * 60_000 * 2 ** m.attempts) }).where("id", "=", m.id).execute();
        return "failed" as const;
      }
    });
    if (!done) break;
    out[done]++;
  }
  return out;
}
