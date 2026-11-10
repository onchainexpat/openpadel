// Courts, programs, dates and rosters (data_model.md 7, action_catalogue.md section 4).
// The rule that matters most here: leaving and refunding are separate decisions (rule 9).
import * as z from "zod/mini";
import { sql, type ExpressionBuilder, type Selectable } from "kysely";
import { both, dateTime, money, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type PlanCtx } from "./actions.ts";
import type { DB, Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { mergeTranslations, textOf, translationsInput } from "./club_text.ts";
import { uuidv7 } from "./ids.ts";
import { account, paymentProvider, post } from "./money.ts";
import { isClubBlock } from "./playtomic.ts";
import { checkSessionCoach, coachBusy } from "./lessons.ts";
import { clashList, dateClashes, weekly } from "./program_clashes.ts";
import { afterBookingPayment } from "./booking_pay.ts";
import { afterMembershipPayment } from "./memberships.ts";
import { giftCardPaid } from "./gift_cards.ts";
import { passPaid } from "./passes.ts";
import { quietUntil } from "./messages.ts";
import { priceFor, programPerks, programPrice, priceWords, type ProgramPrice } from "./program_prices.ts";
import { manages, requireWaiver, withManagers } from "./households.ts";
import { paymentsWhat, paymentWhat } from "./kids.ts";
import { isReadOnly, refuseWhenReadOnly } from "./read_only.ts";
import { backSql, callOff, deskPaid, paidHow, recordAtDesk, refundAcross, refundDue, refundTo, revenueType } from "./desk_pay.ts";

/** How long a place offered from the waitlist is held. With texts it would be 2 hours; while email is
 *  the only way to reach people, it's doubled (messages.md). */
export const OFFER_HOURS = 4;
/** When an offer made now runs out. The clock starts when the person can be told (after quiet hours,
 *  so a place that opens at 10 pm isn't gone by morning), and never runs past the start. */
export function offerDeadline(now: Date, tz: string, start: Date | null): Date {
  const end = new Date((quietUntil(now, tz) ?? now).getTime() + OFFER_HOURS * 3600_000);
  return start && start < end ? start : end;
}
/** Refunds outside the rule above this need a second person (action_catalogue.md rule 4). */
export const TWO_PERSON_CENTS = 50_000;
const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const when = (at: Date, tz: string): Text => ({ en: dateTime(at, "en", tz), es: dateTime(at, "es", tz) });

async function personName(db: Db | Trx, id: string): Promise<string> {
  return (await readRow(db, "person", id, "thing.person")).row.display_name;
}
export async function clubTz(db: Db | Trx): Promise<string> { return (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone; }
export async function firstStart(db: Db | Trx, programId: string, sessionId?: string | null): Promise<Date | null> {
  const r = await db.selectFrom("session").select((eb) => eb.fn.min("starts_at").as("s")).where("program_id", "=", programId).where("status", "!=", "cancelled")
    .$if(Boolean(sessionId), (q) => q.where("id", "=", sessionId!)).executeTakeFirst();
  return (r?.s as Date | null) ?? null;
}
/** An offer from the waitlist that hasn't been taken, declined or run out holds its place. */
const holdsOffer = (eb: ExpressionBuilder<DB, "enrolment">, now: Date) => eb.exists(eb.selectFrom("waitlist_offer").select("waitlist_offer.id")
  .whereRef("waitlist_offer.enrolment_id", "=", "enrolment.id").where("waitlist_offer.outcome", "is", null).where("waitlist_offer.expires_at", ">", now));
// A program signed up for per date (a weekly drop-in clinic or social) has a roster for each date: its places, waitlist,
// offers and watches are that date's. Everything below takes the date (a session id) for those; null means the whole program.
export const perDate = (p: { sign_up?: string } | Record<string, any>) => p.sign_up === "per_session";
/** Places taken: everyone booked, plus places held for someone on the waitlist by an open offer. */
export async function takenCount(db: Db | Trx, programId: string, now: Date, sessionId: string | null = null): Promise<number> {
  const r = await db.selectFrom("enrolment").select((eb) => eb.fn.countAll<string>().as("n")).where("program_id", "=", programId)
    .$if(Boolean(sessionId), (q) => q.where("session_id", "=", sessionId!))
    .where((eb) => eb.or([eb("status", "=", "booked"), eb.and([eb("status", "=", "waitlisted"), holdsOffer(eb, now)])])).executeTakeFirstOrThrow();
  return Number(r.n);
}
/** How many places there are: the program's, or one date's own when it has one. */
export async function placesOf(db: Db | Trx, programId: string, sessionId: string | null = null): Promise<number> {
  const p = await db.selectFrom("program").select("capacity").where("id", "=", programId).executeTakeFirstOrThrow();
  if (!sessionId) return p.capacity;
  const s = await db.selectFrom("session").select("capacity_override").where("id", "=", sessionId).executeTakeFirst();
  return s?.capacity_override ?? p.capacity;
}
/** The next person to offer a place to: first on the waitlist who isn't already holding an offer. */
async function nextWaitlisted(db: Db | Trx, programId: string, now: Date, skip: string[] = [], sessionId: string | null = null) {
  return db.selectFrom("enrolment").selectAll().where("program_id", "=", programId).where("status", "=", "waitlisted")
    .$if(Boolean(sessionId), (q) => q.where("session_id", "=", sessionId!))
    .where((eb) => eb.not(holdsOffer(eb, now))).$if(skip.length > 0, (q) => q.where("id", "not in", skip)).orderBy("waitlist_position").limit(1).executeTakeFirst();
}
/** Where the next person on a waitlist goes: after the last one (each date has its own list). */
async function nextPosition(db: Db | Trx, programId: string, sessionId: string | null): Promise<number> {
  const r = await db.selectFrom("enrolment").select((eb) => eb.fn.max("waitlist_position").as("m")).where("program_id", "=", programId).where("status", "=", "waitlisted")
    .$if(Boolean(sessionId), (q) => q.where("session_id", "=", sessionId!)).executeTakeFirst();
  return Number(r?.m ?? 0) + 1;
}
const openOffer = (db: Db | Trx, enrolmentId: string, now: Date) => db.selectFrom("waitlist_offer").selectAll()
  .where("enrolment_id", "=", enrolmentId).where("outcome", "is", null).where("expires_at", ">", now).executeTakeFirst();
/** No new offers once the event (or, signed up per date, that date) has started. */
export const started = async (db: Db | Trx, programId: string, now: Date, sessionId: string | null = null) => { const s = await firstStart(db, programId, sessionId); return s !== null && s <= now; };
/** One date of a program signed up per date, still open to sign-ups: refused otherwise, and for a program signed up as a whole. */
export async function signUpDate(db: Db | Trx, p: { id: string; sign_up: string } | Record<string, any>, sessionId: string | null | undefined, now: Date) {
  if (!perDate(p)) { if (sessionId) throw new KumiError("error.whole_program_only"); return null; }
  if (!sessionId) throw new KumiError("error.pick_a_date");
  const s = await db.selectFrom("session").select(["id", "program_id", "starts_at", "status"]).where("id", "=", sessionId).executeTakeFirst();
  if (!s || s.program_id !== p.id) throw new KumiError("error.not_found", { thing: both("thing.session") }, 404);
  if (s.status === "cancelled") throw new KumiError("error.date_cancelled");
  if (new Date(s.starts_at) <= now) throw new KumiError("error.date_started");
  return s;
}

export type RefundOutcome = "none" | "credit" | "partial" | "full";
export interface Refund { outcome: RefundOutcome; cents: number; text: Text; changed: boolean }

/** What the club's rule gives when someone goes, and why, in both languages. */
export function ruleRefund(p: { price_cents: number; refund_window_hours: number; refund_inside_window: "none" | "credit" | "full" }, paid: number, reason: string, start: Date | null, now: Date): Refund {
  if (paid <= 0) return { outcome: "none", cents: 0, text: both("refund.nothing_paid"), changed: false };
  const hours = start ? Math.max(0, Math.floor((start.getTime() - now.getTime()) / 3600_000)) : Infinity;
  const inside = hours < p.refund_window_hours;
  if (reason === "no_show" || (inside && p.refund_inside_window === "none")) {
    const why = reason === "no_show" ? both("reason.no_show") : both("refund.why_inside", { hours, window: p.refund_window_hours });
    return { outcome: "none", cents: 0, text: both("refund.none", { why }), changed: false };
  }
  if (inside && p.refund_inside_window === "credit") return { outcome: "credit", cents: paid, text: both("refund.credit", { amount: usd(paid) }), changed: false };
  return { outcome: "full", cents: paid, text: both("refund.full", { amount: usd(paid) }), changed: false };
}

/** Whether the rule would give money back for leaving now (so an included session comes back too). */
const ruleGivesBack = (p: Parameters<typeof ruleRefund>[0], reason: string, start: Date | null, now: Date) => ruleRefund(p, 1, reason, start, now).outcome !== "none";

/** Staff may change the refund, with a reason; the plan says what was decided and why. */
function staffRefund(rule: Refund, paid: number, o: { outcome: RefundOutcome; cents?: number; note?: string } | undefined): Refund {
  if (!o || (o.outcome === rule.outcome && (o.cents ?? rule.cents) === rule.cents)) return rule;
  if (!o.note?.trim()) throw new KumiError("error.refund_note_needed", {}, 400);
  const cents = o.outcome === "none" ? 0 : o.outcome === "partial" ? Math.min(paid, Math.max(0, o.cents ?? 0)) : paid;
  const base = o.outcome === "none" ? both("refund.none", { why: both("refund.why_staff", { note: o.note }) })
    : o.outcome === "partial" ? both("refund.partial", { amount: usd(cents), paid: usd(paid) })
    : o.outcome === "credit" ? both("refund.credit", { amount: usd(cents) }) : both("refund.full", { amount: usd(cents) });
  return { outcome: o.outcome, cents, text: base, changed: true };
}

async function offerText(db: Db | Trx, programId: string, freesPlace: boolean, now: Date, sessionId: string | null = null): Promise<Text> {
  if (!freesPlace || await started(db, programId, now, sessionId)) return { en: "", es: "" };
  const next = await nextWaitlisted(db, programId, now, [], sessionId);
  return next ? both("plan.offer_next", { person: await personName(db, next.person_id) }) : { en: "", es: "" };
}
export const join2 = (a: Text, b: Text): Text => ({ en: a.en + b.en, es: a.es + b.es });

// ---- Courts and programs ----
export const courtCreate = defineAction({
  name: "court.create", version: 1,
  input: z.object({ location_id: z.uuid(), name: z.string().check(z.minLength(1)), kind: z.optional(z.enum(["indoor", "covered_outdoor", "outdoor"])) }),
  async plan(ctx, i) {
    const { row } = await readRow(ctx.db, "location", i.location_id, "thing.location");
    return { title: both("action.court.create"), summary: both("plan.court.create", { name: i.name, location: row.name }), reads: [], locationId: i.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { const id = uuidv7(); await ctx.insert("court", { id, location_id: i.location_id, name: i.name, kind: i.kind ?? "indoor" }); return { court_id: id }; },
});

const courtKind = z.enum(["indoor", "covered_outdoor", "outdoor"]);
export const courtUpdate = defineAction({
  name: "court.update", version: 1,
  input: z.object({ court_id: z.uuid(), name: z.optional(z.string().check(z.minLength(1))), kind: z.optional(courtKind), bookable: z.optional(z.boolean()), sort: z.optional(z.number().check(z.int())) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "court", i.court_id, "thing.court");
    return { title: both("action.court.update"), summary: both("plan.court.update", { name: row.name }), reads: [read], locationId: row.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const { court_id, ...rest } = i;
    await ctx.update("court", court_id, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
    return null;
  },
});

/** A court that's gone or no longer used. Its history stays; it's refused while dates still to come use it. */
export const courtArchive = defineAction({
  name: "court.archive", version: 1,
  input: z.object({ court_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "court", i.court_id, "thing.court");
    if (row.archived_at) throw new KumiError("error.not_found", { thing: both("thing.court") }, 404);
    const ahead = await ctx.db.selectFrom("court_time").select((eb) => eb.fn.countAll<string>().as("n")).where("court_id", "=", i.court_id).where("active", "=", true)
      .where("kind", "!=", "mirror").where(sql<boolean>`upper(during) > ${ctx.now}`).executeTakeFirstOrThrow();
    if (Number(ahead.n) > 0) throw new KumiError("error.court_in_use", { count: Number(ahead.n) });
    return { title: both("action.court.archive"), summary: both("plan.court.archive", { name: row.name }), reads: [read], locationId: row.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("court", i.court_id, { archived_at: ctx.now }); await ctx.emit("court.archived", { court_id: i.court_id }); return null; },
});

/** Whether a new program's results change levels when staff don't say: yes for socials, leagues and tournaments,
 *  which are played for a score with fair teams; no for clinics and courses, which are for learning. */
export const ratedByDefault = (kind: string) => kind !== "clinic" && kind !== "course";

export const programCreate = defineAction({
  name: "program.create", version: 1,
  input: z.object({
    location_id: z.uuid(), kind: z.enum(["clinic", "course", "league", "tournament", "social"]), format: z.optional(z.enum(["americano", "mexicano", "king_of_court"])),
    name: z.string().check(z.minLength(1)), capacity: z.number().check(z.int(), z.minimum(1)), price_cents: z.number().check(z.int(), z.minimum(0)),
    member_price_cents: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.describe("What members pay instead (any plan). Empty: the plan's own discount on programs, if any.")))),
    level_min: z.optional(z.number()), level_max: z.optional(z.number()),
    refund_window_hours: z.optional(z.number().check(z.int(), z.minimum(0))), refund_inside_window: z.optional(z.enum(["none", "credit", "full"])),
    rated: z.optional(z.boolean().check(z.describe("Whether results change levels. Friendlies never do. Default: no for clinics and courses, yes for the rest."))),
    min_players: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.describe("The fewest players it runs with. Short of it at the decision time, it's cancelled and everyone is paid back.")))),
    decide_hours: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(336), z.describe("How many hours before the first date the minimum is decided. Empty: the club's default.")))),
    translations: translationsInput("program"),
    sign_up: z.optional(z.enum(["whole_program", "per_session"]).check(z.describe("whole_program (default): one place covers every date. per_session: each date has its own places, roster, waitlist and minimum, and people sign up for the dates they want (clinics and socials)."))),
  }),
  async plan(ctx, i) {
    await readRow(ctx.db, "location", i.location_id, "thing.location");
    if (i.member_price_cents != null && i.member_price_cents > i.price_cents) throw new KumiError("error.member_price_higher");
    if (i.min_players != null && i.min_players > i.capacity) throw new KumiError("error.min_over_capacity", { capacity: i.capacity });
    // Per date only where each date stands on its own: a course is learned over its dates, a league or tournament is played over them.
    if (i.sign_up === "per_session" && i.kind !== "clinic" && i.kind !== "social") throw new KumiError("error.per_date_kinds");
    // The format too, when there is one ("social, Americano"), so the preview says how the night is played.
    const kind = i.format ? both("plan.program.kind_format", { kind: both(`kind.${i.kind}` as Key), format: both(`format.${i.format}` as Key) }) : both(`kind.${i.kind}` as Key);
    let summary = both("plan.program.create", { name: i.name, kind, capacity: i.capacity, price: usd(i.price_cents) });
    // Whether its results change levels: chosen, or the default for its kind (clinics and courses don't).
    summary = join2(summary, both((i.rated ?? ratedByDefault(i.kind)) ? "plan.program.rated" : "plan.program.unrated"));
    if (i.sign_up === "per_session") summary = join2(summary, both("plan.program.per_date"));
    if (i.member_price_cents != null) summary = join2(summary, both("plan.program.member_price", { amount: usd(i.member_price_cents) }));
    if (i.min_players != null) summary = join2(summary, both(i.sign_up === "per_session" ? "plan.program.min_line_date" : "plan.program.min_line", { min: i.min_players, hours: both("count.hours", { count: i.decide_hours ?? (await ctx.db.selectFrom("club").select("program_decide_hours").executeTakeFirstOrThrow()).program_decide_hours }) }));
    return { title: both("action.program.create"), summary, reads: [], locationId: i.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("program", { id, location_id: i.location_id, kind: i.kind, format: i.format ?? null, name: i.name, capacity: i.capacity, price_cents: i.price_cents, member_price_cents: i.member_price_cents ?? null,
      level_min: i.level_min ?? null, level_max: i.level_max ?? null, refund_window_hours: i.refund_window_hours ?? 24, refund_inside_window: i.refund_inside_window ?? "none", rated: i.rated ?? ratedByDefault(i.kind),
      min_players: i.min_players ?? null, decide_hours: i.decide_hours ?? null, sign_up: i.sign_up ?? "whole_program", translations: JSON.stringify(mergeTranslations({}, i.translations)) });
    return { program_id: id };
  },
});

/** A program's dates still to come, each with its courts and coach, as staff see them before publishing. */
export async function programDates(db: Db | Trx, programId: string, now: Date) {
  const rows = await db.selectFrom("session").leftJoin("person", "person.id", "session.coach_id").select(["session.id", "session.starts_at", "session.ends_at", "session.coach_id", "person.display_name as coach"])
    .where("session.program_id", "=", programId).where("session.status", "!=", "cancelled").where("session.starts_at", ">", now).orderBy("session.starts_at").execute();
  const courts = rows.length ? await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").select(["court_time.session_id", "court.id", "court.name"])
    .where("court_time.session_id", "in", rows.map((r) => r.id)).where("court_time.active", "=", true).orderBy("court.name").execute() : [];
  return rows.map((r) => { const mine = courts.filter((c) => c.session_id === r.id); return { ...r, court_ids: mine.map((c) => c.id), courts: mine.map((c) => c.name) }; });
}

/** What publishing would put in front of members, and anything in the way of its dates. */
export async function publishCheck(db: Db | Trx, programId: string, now: Date) {
  const p = await db.selectFrom("program").selectAll().where("id", "=", programId).executeTakeFirstOrThrow();
  const tz = await clubTz(db), dates = await programDates(db, programId, now);
  const clashes = await dateClashes(db, { programId, locationId: p.location_id, levelMin: p.level_min, levelMax: p.level_max, now, tz,
    slots: dates.map((d) => ({ start: new Date(d.starts_at), end: new Date(d.ends_at), courtIds: d.court_ids, coachId: d.coach_id })), skipSessions: dates.map((d) => d.id) });
  return { program: p, tz, dates, blocks: clashes.filter((c) => c.blocks), warnings: clashes.filter((c) => !c.blocks) };
}

export const programPublish = defineAction({
  name: "program.publish", version: 1,
  input: z.object({ program_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    if (row.status !== "draft") throw new KumiError("error.not_draft");
    const c = await publishCheck(ctx.db, i.program_id, ctx.now);
    if (c.blocks.length) throw new KumiError("error.dates_clash", { list: clashList(c.blocks) });
    // Exactly what members will see: the price (and members' price), the places, the minimum, then each date.
    let summary = join2(both("plan.program.publish", { name: textOf(row.name, row.translations, "name") }), both("plan.program.publish_card", { kind: both(`kind.${row.kind}` as Key), price: usd(row.price_cents), capacity: row.capacity }));
    if (row.member_price_cents !== null) summary = join2(summary, both("plan.program.member_price", { amount: usd(row.member_price_cents) }));
    if (row.min_players !== null) summary = join2(summary, both("plan.program.min_line", { min: row.min_players, hours: both("count.hours", { count: row.decide_hours ?? (await ctx.db.selectFrom("club").select("program_decide_hours").executeTakeFirstOrThrow()).program_decide_hours }) }));
    summary = join2(summary, c.dates.length ? both("plan.program.publish_dates", { count: c.dates.length }) : both("plan.program.no_dates"));
    for (const d of c.dates) summary = join2(summary, both(d.coach ? "plan.program.date_line_coach" : "plan.program.date_line", { when: when(new Date(d.starts_at), c.tz), courts: d.courts.join(", "), coach: d.coach ?? "" }));
    if (c.warnings.length) summary = join2(summary, both("plan.dates_warnings", { list: clashList(c.warnings) }));
    return { title: both("action.program.publish"), summary, reads: [read], locationId: row.location_id, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) { await ctx.update("program", i.program_id, { status: "published" }); await ctx.emit("program.published", { program_id: i.program_id }); return null; },
});

/** A program's price and member price. Places already taken keep what they were priced at; staff are told
 *  how many, since a member price is fairest set before the first sign-up. */
export const programSetPrices = defineAction({
  name: "program.set_prices", version: 1,
  input: z.object({ program_id: z.uuid(), price_cents: z.number().check(z.int(), z.minimum(0)),
    member_price_cents: z.nullable(z.number().check(z.int(), z.minimum(0), z.describe("What members pay instead (any plan). Null: the plan's own discount on programs, if any."))) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    if (i.member_price_cents !== null && i.member_price_cents > i.price_cents) throw new KumiError("error.member_price_higher");
    const taken = Number((await ctx.db.selectFrom("enrolment").select((eb) => eb.fn.countAll<string>().as("n")).where("program_id", "=", i.program_id).where("status", "in", ["booked", "waitlisted", "attended"]).executeTakeFirstOrThrow()).n);
    const member = i.member_price_cents === null ? both("plan.program.member_discount") : both("plan.program.member_price", { amount: usd(i.member_price_cents) });
    const summary = join2(both("plan.program.set_prices", { name: textOf(row.name, row.translations, "name"), price: usd(i.price_cents) }), member);
    return { title: both("action.program.set_prices"), summary: taken ? join2(summary, both("plan.program.prices_kept", { count: taken })) : summary, reads: [read], locationId: row.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("program", i.program_id, { price_cents: i.price_cents, member_price_cents: i.member_price_cents }); return null; },
});

/** Whether people sign up for the whole program or date by date. Only before anyone has signed up (or been on a
 *  waitlist): a roster can't be split into dates, or dates merged, after the fact. The club makes a new program instead. */
export const programSetSignUp = defineAction({
  name: "program.set_sign_up", version: 1,
  input: z.object({ program_id: z.uuid(), sign_up: z.enum(["whole_program", "per_session"]) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    if (row.sign_up === i.sign_up) throw new KumiError("error.nothing_changed");
    if (i.sign_up === "per_session" && row.kind !== "clinic" && row.kind !== "social") throw new KumiError("error.per_date_kinds");
    if (await ctx.db.selectFrom("enrolment").select("id").where("program_id", "=", row.id).executeTakeFirst()) throw new KumiError("error.sign_up_fixed");
    return { title: both("action.program.set_sign_up"), summary: both(i.sign_up === "per_session" ? "plan.program.set_per_date" : "plan.program.set_whole", { name: textOf(row.name, row.translations, "name") }), reads: [read], locationId: row.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    // Checked again under the program's lock, the one every sign-up takes.
    await ctx.trx.selectFrom("program").select("id").where("id", "=", i.program_id).forUpdate().execute();
    if (await ctx.trx.selectFrom("enrolment").select("id").where("program_id", "=", i.program_id).executeTakeFirst()) throw new KumiError("error.sign_up_fixed");
    await ctx.update("program", i.program_id, { sign_up: i.sign_up });
    return null;
  },
});

/** A program's name, and its name in the other language. Its places, dates and people stay as they are; members
 *  see the new name from now on (receipts and messages already sent keep the name they had). */
export const programSetName = defineAction({
  name: "program.set_name", version: 1,
  input: z.object({ program_id: z.uuid(), name: z.string().check(z.trim(), z.minLength(1), z.maxLength(120)), translations: translationsInput("program") }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    const to = textOf(i.name, mergeTranslations(row.translations, i.translations), "name");
    return { title: both("action.program.set_name"), summary: both("plan.program.set_name", { name: textOf(row.name, row.translations, "name"), to }), reads: [read], locationId: row.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const row = await ctx.trx.selectFrom("program").select("translations").where("id", "=", i.program_id).executeTakeFirstOrThrow();
    await ctx.update("program", i.program_id, { name: i.name, translations: JSON.stringify(mergeTranslations(row.translations, i.translations)) });
    return null;
  },
});

/** Court time already on these courts then. A Playtomic block lying inside the new event can be absorbed. */
async function courtTimeUnder(db: Db | Trx, i: { court_ids: string[]; starts_at: string; ends_at: string }) {
  const range = sql`tstzrange(${new Date(i.starts_at)}, ${new Date(i.ends_at)})`;
  const rows = await db.selectFrom("court_time").leftJoin("mirror_booking", "mirror_booking.court_time_id", "court_time.id")
    .select(["court_time.id", "court_time.court_id", "court_time.kind", "mirror_booking.ref", "mirror_booking.booking_type", sql<boolean>`${range} @> court_time.during`.as("inside")])
    .where("court_time.court_id", "in", i.court_ids).where("court_time.active", "=", true).where(sql<boolean>`court_time.during && ${range}`).execute();
  return rows.map((r) => ({ ...r, absorb: r.kind === "mirror" && Boolean(r.ref) && r.inside && isClubBlock(r.booking_type) }));
}

export const sessionAdd = defineAction({
  name: "session.add", version: 1,
  input: z.object({ program_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }), ends_at: z.iso.datetime({ offset: true }), court_ids: z.array(z.uuid()).check(z.minLength(1)),
    coach_id: z.optional(z.uuid().check(z.describe("The coach who runs it: someone with the coach role, with no lesson then."))),
    weeks: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(52), z.describe("How many dates, one a week at the same club time (1: just this one)."))) }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    const courts = await ctx.db.selectFrom("court").select(["id", "name", "location_id"]).where("id", "in", i.court_ids).where("archived_at", "is", null).execute();
    if (courts.length !== new Set(i.court_ids).size || courts.some((c) => c.location_id !== p.location_id)) throw new KumiError("error.not_found", { thing: both("thing.court") }, 404);
    const tz = await clubTz(ctx.db), dates = weekly(new Date(i.starts_at), new Date(i.ends_at), i.weeks ?? 1, tz);
    for (const d of dates) if ((await courtTimeUnder(ctx.db, { court_ids: i.court_ids, starts_at: d.start.toISOString(), ends_at: d.end.toISOString() })).some((c) => !c.absorb)) throw new KumiError("error.court_taken");
    let coach: string | null = null;
    for (const d of dates) if (i.coach_id) coach = await checkSessionCoach(ctx, i.coach_id, d.start, d.end);
    // The coach away then blocks it; another program at the same time for the same players is worth a word.
    const clashes = await dateClashes(ctx.db, { programId: p.id, locationId: p.location_id, levelMin: p.level_min, levelMax: p.level_max, now: ctx.now, tz, skipSessions: [],
      slots: dates.map((d) => ({ start: d.start, end: d.end, courtIds: [], coachId: i.coach_id ?? null })) });
    const off = clashes.filter((c) => c.kind === "coach_off"), warnings = clashes.filter((c) => !c.blocks);
    if (off.length) throw new KumiError("error.dates_clash", { list: clashList(off) });
    const names = courts.map((c) => c.name).join(", ");
    let summary = dates.length === 1 ? both("plan.session.add", { name: textOf(p.name, p.translations, "name"), when: when(dates[0]!.start, tz), courts: names })
      : both("plan.session.add_weekly", { name: textOf(p.name, p.translations, "name"), count: dates.length, first: when(dates[0]!.start, tz), last: when(dates[dates.length - 1]!.start, tz), courts: names });
    if (coach) summary = join2(summary, both("plan.session.add_coach", { coach }));
    if (warnings.length) summary = join2(summary, both("plan.dates_warnings", { list: clashList(warnings) }));
    return { title: both("action.session.add"), summary, reads: [read], locationId: p.location_id, undo: { kind: "reversible" }, details: { dates: dates.map((d) => ({ start: d.start.toISOString(), end: d.end.toISOString() })) } };
  },
  async apply(ctx, i, plan) {
    // The coach first (one booking of a coach at a time), then the courts, in court-id order (spikes/booking_race.md).
    const dates = (plan.details as { dates: { start: string; end: string }[] }).dates;
    if (i.coach_id) {
      await ctx.trx.selectFrom("person").select("id").where("id", "=", i.coach_id).forUpdate().execute();
      for (const d of dates) if ((await coachBusy(ctx.trx, i.coach_id, new Date(d.start), new Date(d.end), ctx.now)).length) throw new KumiError("error.changed");
    }
    for (const id of [...i.court_ids].sort()) await ctx.trx.selectFrom("court").select("id").where("id", "=", id).forUpdate().execute();
    const ids: string[] = [];
    for (const d of dates) {
      const under = await courtTimeUnder(ctx.trx, { court_ids: i.court_ids, starts_at: d.start, ends_at: d.end });
      if (under.some((c) => !c.absorb)) throw new KumiError("error.court_taken");
      // The club already blocked these courts in Playtomic for this event: the event takes over the hold.
      for (const c of under) await ctx.update("court_time", c.id, { active: false });
      const sessionId = uuidv7(), held = new Map<string, string>();
      await ctx.insert("session", { id: sessionId, program_id: i.program_id, starts_at: new Date(d.start), ends_at: new Date(d.end), coach_id: i.coach_id ?? null });
      try {
        for (const court of i.court_ids) {
          const id = uuidv7(); held.set(court, id);
          await ctx.insert("court_time", { id, court_id: court, during: sql`tstzrange(${new Date(d.start)}, ${new Date(d.end)})`, kind: "session", session_id: sessionId });
        }
      } catch (e: any) { if (e?.code === "23P01") throw new KumiError("error.court_taken"); throw e; }
      for (const c of under) await ctx.update("mirror_booking", c.ref!, { status: "covered", court_time_id: null, clash_id: held.get(c.court_id)! });
      ids.push(sessionId);
    }
    return { session_id: ids[0], session_ids: ids };
  },
});

// ---- Rosters ----
/** Where a program is, for ActionDef.owners: undefined when there's no such program (its preview says so). */
export async function programLocation(db: Db | Trx, programId: string | null | undefined): Promise<string | undefined> {
  if (!programId) return undefined;
  return (await db.selectFrom("program").select("location_id").where("id", "=", programId).executeTakeFirst())?.location_id;
}
/** A person's place in a program, signing up or giving it up: theirs, and the parents' who manage a junior. */
const signingUp = async (db: Db | Trx, i: { program_id: string; person_id: string }) => ({ ownerIds: await withManagers(db, [i.person_id]), locationId: await programLocation(db, i.program_id) });
/** A place someone holds: whose it is (a junior's parents too) and where. */
export async function placeOwners(db: Db | Trx, enrolmentId: string) {
  const e = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id").select(["enrolment.person_id", "program.location_id"]).where("enrolment.id", "=", enrolmentId).executeTakeFirst();
  return { ownerIds: await withManagers(db, [e?.person_id]), locationId: e?.location_id };
}

export const enrolmentJoin = defineAction({
  name: "enrolment.join", version: 1,
  input: z.object({ program_id: z.uuid(), person_id: z.uuid(),
    session_id: z.optional(z.uuid().check(z.describe("The date, for a program signed up per date. Several dates at once: enrolment.join_dates."))) }),
  // Whether someone has a place already, and their price (a member's), are theirs.
  owners: signingUp,
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    if (p.status !== "published") throw new KumiError("error.not_published");
    // A tournament or league once drawn takes no more places: someone signing up then could never enter it.
    if ((p.kind === "tournament" || p.kind === "league") && await ctx.db.selectFrom("competition").select("program_id").where("program_id", "=", p.id).where("status", "!=", "void").executeTakeFirst())
      throw new KumiError("error.competition_drawn");
    const date = await signUpDate(ctx.db, p, i.session_id, ctx.now), sid = date?.id ?? null;
    const person = await personName(ctx.db, i.person_id);
    if (await placeOf(ctx.db, i.program_id, i.person_id, sid)) throw new KumiError("error.already_signed_up", { person });
    await requireWaiver(ctx, i.person_id);
    // A junior's parents sign them up: their rows are the parents' too.
    const owners = await withManagers(ctx.db, [i.person_id]);
    const full = (await takenCount(ctx.db, i.program_id, ctx.now, sid)) >= await placesOf(ctx.db, i.program_id, sid);
    // Their own price: a member price, or an included session (only for a real place, not the waitlist).
    const price = await programPrice(ctx.db, i.program_id, i.person_id, ctx.now, { included: !full });
    const onDate = date ? both("plan.enrolment.on_date", { when: when(new Date(date.starts_at), await clubTz(ctx.db)) }) : { en: "", es: "" };
    if (full) {
      const pos = await nextPosition(ctx.db, i.program_id, sid);
      return { title: both("action.enrolment.join"), summary: join2(both("plan.enrolment.waitlist", { person, name: textOf(p.name, p.translations, "name"), position: pos }), onDate), reads: [read], locationId: p.location_id, ownerIds: owners, undo: { kind: "compensating" }, details: { status: "waitlisted", position: pos, price } };
    }
    return { title: both("action.enrolment.join"), summary: join2(both("plan.enrolment.join", { person, name: textOf(p.name, p.translations, "name"), price: priceWords(price) }), onDate), reads: [read], locationId: p.location_id, ownerIds: owners, undo: { kind: "compensating" }, moneyCents: price.cents, details: { status: "booked", price } };
  },
  async apply(ctx, i, plan) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();   // one join at a time per program
    const planned = (plan.details as { status: string; position?: number; price: ProgramPrice });
    const sid = i.session_id ?? null;
    const nowFull = (await takenCount(ctx.trx, i.program_id, ctx.now, sid)) >= await placesOf(ctx.trx, p.id, sid);
    if ((planned.status === "booked") === nowFull) throw new KumiError("error.changed");   // the last place went meanwhile, or one opened up
    const price = await lockedPrice(ctx, i.program_id, i.person_id, planned.status === "booked");
    if (price.cents !== planned.price.cents || price.basis !== planned.price.basis) throw new KumiError("error.changed");   // a price or their membership changed meanwhile
    const id = uuidv7();
    await ctx.insert("enrolment", { id, program_id: i.program_id, session_id: sid, person_id: i.person_id, status: planned.status, waitlist_position: planned.position ?? null, ...priced(price) });
    await ctx.emit(planned.status === "booked" ? "enrolment.booked" : "enrolment.waitlisted", { enrolment_id: id });
    await endWatches(ctx, i.program_id, i.person_id, [sid]);
    const pay = planned.status === "booked" ? await requestPayment(ctx, id, i.person_id, price.cents) : null;
    return { enrolment_id: id, status: planned.status, ...(pay ?? {}) };
  },
});

/** Someone's place (or waitlist place) in a program, or on one date of it. */
const placeOf = (db: Db | Trx, programId: string, personId: string, sessionId: string | null) => db.selectFrom("enrolment").select("id").where("program_id", "=", programId)
  .where("person_id", "=", personId).where("status", "in", ["booked", "waitlisted"]).$if(Boolean(sessionId), (q) => q.where("session_id", "=", sessionId!)).executeTakeFirst();

const bookedPlace = (db: Db | Trx, programId: string, personId: string, sessionId: string | null) => db.selectFrom("enrolment").select("id").where("program_id", "=", programId)
  .where("person_id", "=", personId).where("status", "=", "booked").$if(Boolean(sessionId), (q) => q.where("session_id", "=", sessionId!)).executeTakeFirst();

/** Signed up (or on the waitlist) now: a watch on the program, or on those dates, has done its job. */
async function endWatches(ctx: ApplyContext, programId: string, personId: string, sessionIds: (string | null)[]) {
  for (const w of await ctx.trx.selectFrom("program_watch").select(["id", "session_id"]).where("program_id", "=", programId).where("person_id", "=", personId).where("told_at", "is", null).where("ended_at", "is", null).execute())
    if (sessionIds.includes(w.session_id)) await ctx.update("program_watch", w.id, { ended_at: ctx.now });
}

/** Several dates of a program signed up per date, in one go: a place on each date with room, the waitlist on each one
 *  that's full, and one card payment for the lot. Each date is priced as it would be alone (a member price), except
 *  included sessions, which are used up in date order while the period has any left. */
export const enrolmentJoinDates = defineAction({
  name: "enrolment.join_dates", version: 1,
  input: z.object({ program_id: z.uuid(), person_id: z.uuid(), session_ids: z.array(z.uuid()).check(z.minLength(1), z.maxLength(20), z.describe("The dates (session ids) to sign up for.")) }),
  owners: signingUp,
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    if (p.status !== "published") throw new KumiError("error.not_published");
    if (!perDate(p)) throw new KumiError("error.whole_program_only");
    const person = await personName(ctx.db, i.person_id), tz = await clubTz(ctx.db);
    const dates = [];
    for (const id of [...new Set(i.session_ids)]) {
      const d = (await signUpDate(ctx.db, p, id, ctx.now))!;
      if (await placeOf(ctx.db, p.id, i.person_id, d.id)) throw new KumiError("error.already_on_date", { person, when: when(new Date(d.starts_at), tz) });
      dates.push(d);
    }
    dates.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
    await requireWaiver(ctx, i.person_id);
    const each = await datesPriced(ctx.db, p, i.person_id, dates.map((d) => d.id), ctx.now);
    const total = each.reduce((n, x) => n + (x.status === "booked" ? x.price.cents : 0), 0);
    let summary = both("plan.enrolment.join_dates", { person, name: textOf(p.name, p.translations, "name"), count: dates.length });
    for (const [k, x] of each.entries()) summary = join2(summary, x.status === "booked"
      ? both("plan.enrolment.date_line", { when: when(new Date(dates[k]!.starts_at), tz), price: priceWords(x.price) })
      : both("plan.enrolment.date_line_waitlist", { when: when(new Date(dates[k]!.starts_at), tz), position: x.position! }));
    if (total > 0) summary = join2(summary, both("plan.enrolment.dates_total", { amount: usd(total) }));
    return { title: both("action.enrolment.join_dates"), summary, reads: [read], locationId: p.location_id, ownerIds: await withManagers(ctx.db, [i.person_id]), undo: { kind: "compensating" },
      moneyCents: total, details: { dates: each } };
  },
  async apply(ctx, i, plan) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();   // one join at a time per program
    const planned = (plan.details as { dates: DatePriced[] }).dates;
    // An included session in the plan: the membership is locked before the prices are looked at again.
    const perks = planned.some((x) => x.price.basis === "included") ? await programPerks(ctx.trx, i.person_id, ctx.now) : null;
    if (perks?.included_sessions) await ctx.trx.selectFrom("membership").select("id").where("id", "=", perks.membership_id).forUpdate().execute();
    const now = await datesPriced(ctx.trx, p, i.person_id, planned.map((x) => x.session_id), ctx.now);
    if (now.some((x, k) => x.status !== planned[k]!.status || x.price.cents !== planned[k]!.price.cents || x.price.basis !== planned[k]!.price.basis)) throw new KumiError("error.changed");
    const ids: string[] = [], toPay = now.filter((x) => x.status === "booked" && x.price.cents > 0);
    // Someone else (the desk) signing them up: they hear it once, every date and what to pay, not a message a date.
    const forOther = ctx.actor.personId !== i.person_id;
    const group = toPay.length > 1 ? uuidv7() : null;
    let firstPayment: string | null = null;
    for (const x of now) {
      const id = uuidv7(); ids.push(id);
      await ctx.insert("enrolment", { id, program_id: p.id, session_id: x.session_id, person_id: i.person_id, status: x.status, waitlist_position: x.position ?? null, ...priced(x.price) });
      await ctx.emit(x.status === "booked" ? "enrolment.booked" : "enrolment.waitlisted", { enrolment_id: id, ...(forOther && x.status === "booked" ? { by_other: true } : {}) });
      if (x.status === "booked" && x.price.cents > 0) {
        const pay = uuidv7(); firstPayment ??= pay;
        await ctx.insert("payment", { id: pay, person_id: i.person_id, amount_cents: x.price.cents, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", enrolment_id: id, group_id: group });
      }
    }
    await endWatches(ctx, p.id, i.person_id, now.map((x) => x.session_id));
    if (forOther && now.some((x) => x.status === "booked")) await ctx.emit("enrolment.signed_up_for_you", { person_id: i.person_id, enrolment_ids: ids });
    return { enrolment_ids: ids, ...(firstPayment ? { payment_id: firstPayment } : {}) };
  },
});

interface DatePriced { session_id: string; status: "booked" | "waitlisted"; position: number | null; price: ProgramPrice }
/** Each date as it stands for this person: a place (and its price) or the waitlist (and where). Included sessions are
 *  taken in date order, one per date, while there are any left. */
async function datesPriced(db: Db | Trx, p: { id: string; kind: string; price_cents: number; member_price_cents: number | null } | Record<string, any>, personId: string, sessionIds: string[], now: Date): Promise<DatePriced[]> {
  const perks = await programPerks(db, personId, now);
  let used = 0;
  const out: DatePriced[] = [];
  for (const sid of sessionIds) {
    const full = (await takenCount(db, p.id, now, sid)) >= await placesOf(db, p.id, sid);
    const price = priceFor(p as { id: string; kind: string; price_cents: number; member_price_cents: number | null }, perks, true, { included: !full, usedExtra: used });
    if (price.basis === "included") used++;
    out.push({ session_id: sid, status: full ? "waitlisted" : "booked", position: full ? await nextPosition(db, p.id, sid) : null, price });
  }
  return out;
}

/** The price inside the change: with an included session, the membership is locked first, so two sign-ups at
 *  once can't both take its last one. */
async function lockedPrice(ctx: ApplyContext, programId: string, personId: string, included: boolean): Promise<ProgramPrice> {
  const perks = included ? await programPerks(ctx.trx, personId, ctx.now) : null;
  if (perks?.included_sessions) await ctx.trx.selectFrom("membership").select("id").where("id", "=", perks.membership_id).forUpdate().execute();
  return programPrice(ctx.trx, programId, personId, ctx.now, { included });
}
/** The enrolment columns for a price. */
const priced = (pr: ProgramPrice) => ({ price_cents: pr.cents, price_basis: pr.basis, included_membership_id: pr.included?.membership_id ?? null, included_period_start: pr.included?.period_start ? new Date(pr.included.period_start) : null });

async function goingPlan(ctx: PlanCtx, enrolmentId: string, reason: string, refundIn?: { outcome: RefundOutcome; cents?: number; note?: string }) {
  const { row: e, read } = await readRow(ctx.db, "enrolment", enrolmentId, "thing.person");
  const person = await personName(ctx.db, e.person_id);
  if (!["booked", "waitlisted"].includes(e.status)) throw new KumiError("error.not_on_roster", { person });
  const { row: p } = await readRow(ctx.db, "program", e.program_id, "thing.program");
  const paid = await paidFor(ctx.db, e.id);
  const rule = ruleRefund(p as any, paid, reason, await firstStart(ctx.db, e.program_id, e.session_id), ctx.now);
  const refund = staffRefund(rule, paid, refundIn);
  const freesPlace = e.status === "booked" || Boolean(await openOffer(ctx.db, e.id, ctx.now));   // a booked place, or one offered to them
  // An included session comes back when leaving in time (as money would), or when staff give a refund.
  const back = e.price_basis !== "included" ? null : refundIn ? refundIn.outcome !== "none" : ruleGivesBack(p as any, reason, await firstStart(ctx.db, e.program_id, e.session_id), ctx.now);
  // Paid with a pass: no money comes back, the use does (all of it back) or is spent (part or nothing), as passes.ts does.
  const byPass = refund.outcome !== "none" && paid > 0 && !(await ctx.db.selectFrom("payment").select("id").where("enrolment_id", "=", e.id).where("status", "=", "succeeded").where("method", "!=", "pass").executeTakeFirst());
  const refundText = back !== null ? both(back ? "refund.included_back" : "refund.included_used")
    : byPass ? both(refund.cents >= paid ? "refund.pass_back" : "refund.pass_spent") : refund.text;
  return { e, p, person, refund: { ...refund, text: refundText }, back: Boolean(back), read, offer: await offerText(ctx.db, e.program_id, freesPlace, ctx.now, e.session_id) };
}

export async function freePlace(ctx: Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0], programId: string, skip: string[] = [], sessionId: string | null = null) {
  // Read-only: a place given up isn't offered on (nobody could sign up for it); the waitlist keeps its order.
  if (await started(ctx.trx, programId, ctx.now, sessionId) || await isReadOnly(ctx.trx)) return null;
  const next = await nextWaitlisted(ctx.trx, programId, ctx.now, skip, sessionId);
  if (!next) return null;
  const offerId = uuidv7();
  const expires = offerDeadline(ctx.now, await clubTz(ctx.trx), await firstStart(ctx.trx, programId, sessionId));
  await ctx.insert("waitlist_offer", { id: offerId, enrolment_id: next.id, offered_at: ctx.now, expires_at: expires });
  await ctx.emit("waitlist.offered", { enrolment_id: next.id, offer_id: offerId });
  return offerId;
}

/** A place free to anyone (nobody on the waitlist took it): everyone watching the program (or that date) hears it once. */
export async function tellWatchers(ctx: ApplyContext, programId: string, sessionId: string | null = null): Promise<number> {
  if (await isReadOnly(ctx.trx)) return 0;
  const p = await ctx.trx.selectFrom("program").select(["name", "translations", "capacity", "status"]).where("id", "=", programId).executeTakeFirstOrThrow();
  if (p.status !== "published" || await started(ctx.trx, programId, ctx.now, sessionId) || (await takenCount(ctx.trx, programId, ctx.now, sessionId)) >= await placesOf(ctx.trx, programId, sessionId)) return 0;
  const watches = await ctx.trx.selectFrom("program_watch").select(["id", "person_id"]).where("program_id", "=", programId).where("told_at", "is", null).where("ended_at", "is", null)
    .where(sql<boolean>`session_id IS NOT DISTINCT FROM ${sessionId}`).orderBy("created_at").execute();
  if (!watches.length) return 0;
  for (const w of watches) await ctx.update("program_watch", w.id, { told_at: ctx.now });
  const start = await firstStart(ctx.trx, programId, sessionId);
  await ctx.emit("program.place_open", { program_id: programId, name: textOf(p.name, p.translations, "name"), starts_at: start?.toISOString() ?? null, people: watches.map((w) => w.person_id) });
  return watches.length;
}
/** A place came free: offered to the next on the waitlist, or, with nobody waiting, open to anyone (and
 *  whoever is watching hears it). */
export async function placeFreed(ctx: ApplyContext, programId: string, skip: string[] = [], sessionId: string | null = null): Promise<string | null> {
  const offer = await freePlace(ctx, programId, skip, sessionId);
  if (!offer) await tellWatchers(ctx, programId, sessionId);
  return offer;
}

/** Someone on the waitlist leaves while holding an offer: the offer is declined, and the place passes on. */
async function declineOffer(ctx: Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0], enrolmentId: string) {
  const offer = await openOffer(ctx.trx, enrolmentId, ctx.now);
  if (offer) await ctx.update("waitlist_offer", offer.id, { outcome: "declined" });
  return Boolean(offer);
}

/** A place given up before it was paid: what was still owed for it is called off (a card form already opened is
 *  left to settle; if it goes through, the money comes back). With several dates paid together, the others stay owed. */
async function dropUnpaid(ctx: ApplyContext, enrolmentId: string) {
  for (const pay of await ctx.trx.selectFrom("payment").select("id").where("enrolment_id", "=", enrolmentId).where("status", "=", "pending").where("provider_ref", "is", null).execute())
    await callOff(ctx, pay.id);
}

export const leaving = (refund: Refund, how: string, reason: string, ruleVersion: number, note?: string) => ({
  status: "cancelled", left_how: how, left_reason: reason, refund_outcome: refund.outcome, refund_cents: refund.cents,
  refund_rule_version: ruleVersion, refund_changed_by_staff: refund.changed, refund_note: note ?? null,
});

export const enrolmentLeave = defineAction({
  name: "enrolment.leave", version: 1,
  input: z.object({ enrolment_id: z.uuid() }),
  owners: (db, i) => placeOwners(db, i.enrolment_id),   // what was paid, and what would come back
  async plan(ctx, i) {
    const g = await goingPlan(ctx, i.enrolment_id, "late_cancel");
    return { title: both("action.enrolment.leave"), summary: join2(both("plan.enrolment.leave", { person: g.person, name: g.p.name, refund: g.refund.text }), g.offer), reads: [g.read],
      locationId: g.p.location_id, ownerIds: await withManagers(ctx.db, [g.e.person_id]), moneyCents: g.refund.cents, undo: g.refund.cents > 0 ? { kind: "none", note: both("reason.refund_sent") } : { kind: "compensating" }, details: { refund: g.refund, back: g.back } };
  },
  async apply(ctx, i, plan) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).executeTakeFirstOrThrow();
    const p = await ctx.trx.selectFrom("program").select("refund_rule_version").where("id", "=", e.program_id).executeTakeFirstOrThrow();
    const { refund, back } = plan.details as { refund: Refund; back: boolean };
    await ctx.update("enrolment", e.id, { ...leaving(refund, "left", "late_cancel", p.refund_rule_version), left_at: ctx.now, included_back: back });
    await dropUnpaid(ctx, e.id);
    const money = await startRefund(ctx, e.id, e.person_id, refund);
    await ctx.emit("enrolment.left", { enrolment_id: e.id, refund_outcome: refund.outcome, refund_cents: refund.cents, refund_desk: money.desk, refund_credit: money.credit, refund_pass: "pass" in money ? money.pass : 0 });
    if (e.status === "booked" || await declineOffer(ctx, e.id)) await placeFreed(ctx, e.program_id, [], e.session_id);
    return { refund_outcome: refund.outcome, refund_cents: refund.cents };
  },
});

/** Leaving a place as the person themselves would (enrolment.leave, the club's rule), for an account deleted again
 *  after a restore (privacy.ts): the refund the rule gives, the place offered on. What went back, and how much of it
 *  waits at the desk. */
/** A place left for an account deleted again after a restore (privacy.ts): no money moves (the person was refunded
 *  by the club's rule when they left it, before the restore), and the place is freed for the next on the waitlist. */
export async function leaveForErase(ctx: ApplyContext, enrolmentId: string): Promise<{ cents: number; desk: number }> {
  const g = await goingPlan(ctx, enrolmentId, "late_cancel", { outcome: "none" });
  const e = g.e, p = await ctx.trx.selectFrom("program").select("refund_rule_version").where("id", "=", e.program_id).executeTakeFirstOrThrow();
  await ctx.update("enrolment", e.id, { ...leaving(g.refund, "left", "late_cancel", p.refund_rule_version), left_at: ctx.now, included_back: g.back });
  await dropUnpaid(ctx, e.id);
  const money = await startRefund(ctx, e.id, e.person_id, g.refund);
  await ctx.emit("enrolment.left", { enrolment_id: e.id, refund_outcome: g.refund.outcome, refund_cents: g.refund.cents, refund_desk: money.desk, refund_credit: money.credit, refund_pass: "pass" in money ? money.pass : 0 });
  if (e.status === "booked" || await declineOffer(ctx, e.id)) await placeFreed(ctx, e.program_id, [], e.session_id);
  return { cents: g.refund.cents, desk: money.desk };
}

export const enrolmentRemove = defineAction({
  name: "enrolment.remove", version: 1,
  input: z.object({
    enrolment_id: z.uuid(), reason: z.enum(["late_cancel", "no_show", "found_sub", "club", "other"]),
    refund: z.optional(z.object({ outcome: z.enum(["none", "credit", "partial", "full"]), cents: z.optional(z.number().check(z.int(), z.minimum(0))), note: z.optional(z.string()) })),
  }),
  async plan(ctx, i) {
    const g = await goingPlan(ctx, i.enrolment_id, i.reason, i.refund);
    return { title: both("action.enrolment.remove"), summary: join2(both("plan.enrolment.remove", { person: g.person, name: g.p.name, reason: both(`reason.${i.reason}` as Key), refund: g.refund.text }), g.offer),
      reads: [g.read], locationId: g.p.location_id, moneyCents: g.refund.cents, secondPerson: g.refund.changed && g.refund.cents > TWO_PERSON_CENTS, undo: g.refund.cents > 0 ? { kind: "none", note: both("reason.refund_sent") } : { kind: "compensating" }, details: { refund: g.refund, back: g.back } };
  },
  async apply(ctx, i, plan) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).executeTakeFirstOrThrow();
    const p = await ctx.trx.selectFrom("program").select("refund_rule_version").where("id", "=", e.program_id).executeTakeFirstOrThrow();
    const { refund, back } = plan.details as { refund: Refund; back: boolean };
    await ctx.update("enrolment", e.id, { ...leaving(refund, i.reason === "no_show" ? "no_show" : "removed", i.reason, p.refund_rule_version, i.refund?.note), left_at: ctx.now, included_back: back });
    await dropUnpaid(ctx, e.id);
    const money = await startRefund(ctx, e.id, e.person_id, refund);
    await ctx.emit("enrolment.removed", { enrolment_id: e.id, reason: i.reason, refund_outcome: refund.outcome, refund_cents: refund.cents, refund_desk: money.desk, refund_credit: money.credit, refund_pass: "pass" in money ? money.pass : 0 });
    const offer = e.status === "booked" || await declineOffer(ctx, e.id) ? await placeFreed(ctx, e.program_id, [], e.session_id) : null;
    return { refund_outcome: refund.outcome, refund_cents: refund.cents, offer_id: offer };
  },
});

export const enrolmentTransfer = defineAction({
  name: "enrolment.transfer", version: 1,
  input: z.object({ enrolment_id: z.uuid(), to_person_id: z.uuid(), pay: z.enum(["sub_pays", "gift"]) }),
  owners: (db, i) => placeOwners(db, i.enrolment_id),
  async plan(ctx, i) {
    const { row: e, read } = await readRow(ctx.db, "enrolment", i.enrolment_id, "thing.person");
    const person = await personName(ctx.db, e.person_id), sub = await personName(ctx.db, i.to_person_id);
    if (e.status !== "booked") throw new KumiError("error.not_on_roster", { person });
    const { row: p } = await readRow(ctx.db, "program", e.program_id, "thing.program");
    if (await placeOf(ctx.db, e.program_id, i.to_person_id, e.session_id)) throw new KumiError("error.already_signed_up", { person: sub });
    // The sub pays their own price, as if they signed up: a member price, or one of their included sessions.
    const price = i.pay === "gift" ? null : await programPrice(ctx.db, e.program_id, i.to_person_id, ctx.now);
    const money = !price ? both("transfer.gift", { sub, person }) : both(price.cents > 0 ? "transfer.sub_pays" : "transfer.sub_free", { sub, person, price: priceWords(price) });
    return { title: both("action.enrolment.transfer"), summary: both("plan.enrolment.transfer", { person, name: textOf(p.name, p.translations, "name"), sub, money }), reads: [read], locationId: p.location_id, ownerIds: await withManagers(ctx.db, [e.person_id]),
      undo: { kind: "compensating" }, details: { price } };
  },
  async apply(ctx, i, plan) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).executeTakeFirstOrThrow();
    // One place change at a time per program, as join and comp take it: the sub may have been given a place meanwhile.
    const p = await ctx.trx.selectFrom("program").select(["price_cents", "refund_rule_version"]).where("id", "=", e.program_id).forUpdate().executeTakeFirstOrThrow();
    if (await placeOf(ctx.trx, e.program_id, i.to_person_id, e.session_id)) throw new KumiError("error.changed");
    const planned = (plan.details as { price: ProgramPrice | null }).price;
    const price = planned ? await lockedPrice(ctx, e.program_id, i.to_person_id, true) : null;
    if (planned && (price!.cents !== planned.cents || price!.basis !== planned.basis)) throw new KumiError("error.changed");   // a price or their membership changed meanwhile
    const newId = uuidv7();
    await ctx.insert("enrolment", { id: newId, program_id: e.program_id, session_id: e.session_id, person_id: i.to_person_id, status: "booked",
      ...(price ? priced(price) : { price_cents: e.price_cents }), paid_by: price ? "none" : "transfer" });
    // When the sub pays, the original player's refund is due (the money moves in the payments slice).
    const refund: Refund = i.pay === "gift" ? { outcome: "none", cents: 0, text: both("refund.nothing_paid"), changed: false } : { outcome: "full", cents: e.price_cents, text: both("refund.full", { amount: usd(e.price_cents) }), changed: false };
    await ctx.update("enrolment", e.id, { ...leaving(refund, "transferred", "found_sub", p.refund_rule_version), left_at: ctx.now, replaced_by: newId });
    if (i.pay === "sub_pays") {
      const pay = await requestPayment(ctx, newId, i.to_person_id, price!.cents);
      // Nothing for the sub to pay (an included session): the refund needn't wait for them.
      await startRefund(ctx, e.id, e.person_id, { ...refund, cents: await paidFor(ctx.trx, e.id) }, pay ? "waiting_for_sub" : "pending");
      await ctx.emit("enrolment.transferred", { from: e.id, to: newId, pay: i.pay });
      return { enrolment_id: newId, ...(pay ?? {}) };
    }
    await ctx.emit("enrolment.transferred", { from: e.id, to: newId, pay: i.pay });
    return { enrolment_id: newId };
  },
});

export const enrolmentComp = defineAction({
  name: "enrolment.comp", version: 1,
  input: z.object({ program_id: z.uuid(), person_id: z.uuid(), note: z.string().check(z.minLength(1)),
    session_id: z.optional(z.uuid().check(z.describe("The date, for a program signed up per date."))) }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    const date = await signUpDate(ctx.db, p, i.session_id, ctx.now), sid = date?.id ?? null;
    const person = await personName(ctx.db, i.person_id);
    // Someone with a place already (paid, or given one before) is told so: a second can't be given.
    if (await bookedPlace(ctx.db, i.program_id, i.person_id, sid)) throw new KumiError("error.already_signed_up", { person });
    // A place held by an open offer to this same person is theirs to be given.
    const waiting = await ctx.db.selectFrom("enrolment").select("id").where("program_id", "=", i.program_id).where("person_id", "=", i.person_id).where("status", "=", "waitlisted")
      .$if(Boolean(sid), (q) => q.where("session_id", "=", sid!)).executeTakeFirst();
    const held = waiting && await openOffer(ctx.db, waiting.id, ctx.now) ? 1 : 0;
    if ((await takenCount(ctx.db, i.program_id, ctx.now, sid)) - held >= await placesOf(ctx.db, i.program_id, sid)) throw new KumiError("error.program_full");
    const onDate = date ? both("plan.enrolment.on_date", { when: when(new Date(date.starts_at), await clubTz(ctx.db)) }) : { en: "", es: "" };
    return { title: both("action.enrolment.comp"), summary: join2(both("plan.enrolment.comp", { person, name: textOf(p.name, p.translations, "name") }), onDate), reads: [read], locationId: p.location_id, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    await ctx.trx.selectFrom("program").select("id").where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();
    const sid = i.session_id ?? null;
    if (await bookedPlace(ctx.trx, i.program_id, i.person_id, sid)) throw new KumiError("error.changed");
    // If they were waiting, their waitlist place becomes the free place, and an offer they held is taken.
    const waiting = await ctx.trx.selectFrom("enrolment").selectAll().where("program_id", "=", i.program_id).where("person_id", "=", i.person_id).where("status", "=", "waitlisted")
      .$if(Boolean(sid), (q) => q.where("session_id", "=", sid!)).executeTakeFirst();
    const offer = waiting ? await openOffer(ctx.trx, waiting.id, ctx.now) : undefined;
    if ((await takenCount(ctx.trx, i.program_id, ctx.now, sid)) - (offer ? 1 : 0) >= await placesOf(ctx.trx, i.program_id, sid)) throw new KumiError("error.changed");
    if (offer) await ctx.update("waitlist_offer", offer.id, { outcome: "taken" });
    if (waiting) { await ctx.update("enrolment", waiting.id, { status: "booked", waitlist_position: null, price_cents: 0, paid_by: "comp", comp_note: i.note }); return { enrolment_id: waiting.id }; }
    const id = uuidv7();
    await ctx.insert("enrolment", { id, program_id: i.program_id, session_id: sid, person_id: i.person_id, status: "booked", price_cents: 0, paid_by: "comp", comp_note: i.note });
    return { enrolment_id: id };
  },
});

export const enrolmentAcceptOffer = defineAction({
  name: "enrolment.accept_offer", version: 1,
  input: z.object({ enrolment_id: z.uuid() }),
  owners: (db, i) => placeOwners(db, i.enrolment_id),
  async plan(ctx, i) {
    const { row: e, read } = await readRow(ctx.db, "enrolment", i.enrolment_id, "thing.person");
    const offer = await ctx.db.selectFrom("waitlist_offer").selectAll().where("enrolment_id", "=", i.enrolment_id).where("outcome", "is", null).where("expires_at", ">", ctx.now).executeTakeFirst();
    if (e.status !== "waitlisted" || !offer) throw new KumiError("error.no_offer");
    const { row: p } = await readRow(ctx.db, "program", e.program_id, "thing.program");
    await requireWaiver(ctx, e.person_id);
    // Kept at the price it was put on the waitlist at, unless an included session is free now.
    const now = await programPrice(ctx.db, e.program_id, e.person_id, ctx.now);
    const price: ProgramPrice = now.basis === "included" ? now : { cents: e.price_cents, full: p.price_cents, basis: e.price_basis, included: null };
    return { title: both("action.enrolment.accept_offer"), summary: both("plan.enrolment.accept_offer", { person: await personName(ctx.db, e.person_id), name: textOf(p.name, p.translations, "name"), price: priceWords(price) }),
      reads: [read, { entity: "waitlist_offer", id: offer.id, version: offer.version }], locationId: p.location_id, ownerIds: await withManagers(ctx.db, [e.person_id]), moneyCents: price.cents, undo: { kind: "compensating" }, details: { offer_id: offer.id, price } };
  },
  async apply(ctx, i, plan) {
    const planned = (plan.details as { offer_id: string; price: ProgramPrice }).price;
    if (planned.basis === "included") {
      const e = await ctx.trx.selectFrom("enrolment").select(["program_id", "person_id"]).where("id", "=", i.enrolment_id).executeTakeFirstOrThrow();
      const now = await lockedPrice(ctx, e.program_id, e.person_id, true);
      if (now.basis !== "included") throw new KumiError("error.changed");
      await ctx.update("enrolment", i.enrolment_id, { ...priced(now), status: "booked", waitlist_position: null });
    } else await ctx.update("enrolment", i.enrolment_id, { status: "booked", waitlist_position: null });
    await ctx.update("waitlist_offer", (plan.details as { offer_id: string }).offer_id, { outcome: "taken" });
    await ctx.emit("enrolment.booked", { enrolment_id: i.enrolment_id });
    const e = await ctx.trx.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id").select(["enrolment.person_id", "enrolment.price_cents", "program.name"]).where("enrolment.id", "=", i.enrolment_id).executeTakeFirstOrThrow();
    return (await requestPayment(ctx, i.enrolment_id, e.person_id, e.price_cents)) ?? null;
  },
});

/** Offers past their deadline that nobody has taken, declined or expired yet. */
const dueOffers = (db: Db | Trx, now: Date) => db.selectFrom("waitlist_offer").where("outcome", "is", null).where("expires_at", "<=", now);

export const waitlistExpireOffers = defineAction({
  name: "waitlist.expire_offers", version: 1, system: true, internal: true,
  input: z.object({}),
  async plan(ctx) {
    const n = Number((await dueOffers(ctx.db, ctx.now).select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
    return { title: both("action.waitlist.expire_offers"), summary: both("plan.waitlist.expire_offers", { count: n }), reads: [], undo: { kind: "none", note: both("reason.no_way_back") } };
  },
  async apply(ctx) {
    // Claimed under lock, so an offer taken meanwhile, or a second worker, can't be expired twice.
    const due = await dueOffers(ctx.trx, ctx.now).select(["id", "enrolment_id"]).orderBy("expires_at").forUpdate().skipLocked().execute();
    // Each roster that lost an offer: a program's, or one date's when it's signed up per date.
    const missed: string[] = [], rosters = new Map<string, { programId: string; sessionId: string | null }>();
    for (const o of due) {
      await ctx.update("waitlist_offer", o.id, { outcome: "expired" });
      const e = await ctx.trx.selectFrom("enrolment").select(["id", "program_id", "session_id", "status"]).where("id", "=", o.enrolment_id).executeTakeFirstOrThrow();
      if (e.status !== "waitlisted") continue;
      await ctx.update("enrolment", e.id, { waitlist_position: await nextPosition(ctx.trx, e.program_id, e.session_id) });
      await ctx.emit("waitlist.offer_expired", { enrolment_id: e.id, offer_id: o.id });
      missed.push(e.id); rosters.set(`${e.program_id}|${e.session_id ?? ""}`, { programId: e.program_id, sessionId: e.session_id });
    }
    let offered = 0;
    for (const { programId, sessionId } of rosters.values()) {
      const places = await placesOf(ctx.trx, programId, sessionId);
      // Nobody else waiting: the place is open to anyone, rather than going straight back to who just missed it.
      while ((await takenCount(ctx.trx, programId, ctx.now, sessionId)) < places && await freePlace(ctx, programId, missed, sessionId)) offered++;
      await tellWatchers(ctx, programId, sessionId);   // a place still free once the waitlist has had its turn
    }
    return { expired: due.length, offered };
  },
});

/** The job: run every minute or so. Nothing due means no action run at all. */
export async function expireOffers(db: Db, now = new Date()) {
  const due = await dueOffers(db, now).select("id").limit(1).executeTakeFirst();
  if (!due) return { expired: 0, offered: 0 };
  return (await runAsSystem(db, "waitlist.expire_offers", {}, "job:offers", { now })).result as { expired: number; offered: number };
}

// ---- Money for rosters ----
export type ApplyContext = Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0];

/** What was actually paid for a place: payments that went through, less refunds on their way or sent. */
export async function paidFor(db: Db | Trx, enrolmentId: string): Promise<number> {
  // Money and pass uses: a place a promo code made free took nothing (promo_codes.ts), so nothing of it goes back.
  const paid = await db.selectFrom("payment").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", enrolmentId).where("status", "=", "succeeded").where("method", "!=", "promo").executeTakeFirst();
  const back = await db.selectFrom("refund").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", enrolmentId).where("status", "in", ["pending", "sent", "waiting_for_sub"]).executeTakeFirst();
  return Number(paid?.c ?? 0) - Number(back?.c ?? 0);
}

/** How much of a place's price is covered: what was paid (paidFor) and what promo codes took off, on payments that
 *  went through (a free one, all of it) or are still asked for (promised). What's owed is the price less this, so the
 *  desk can't take a discount again as money. */
export async function coveredFor(db: Db | Trx, enrolmentId: string): Promise<number> {
  const r = await db.selectFrom("payment").select(sql<string>`coalesce(sum(CASE WHEN method = 'promo' THEN amount_cents ELSE discount_cents END), 0)`.as("c"))
    .where("enrolment_id", "=", enrolmentId).where("status", "in", ["succeeded", "pending"]).where((w) => w.or([w("method", "=", "promo"), w("discount_cents", ">", 0)])).executeTakeFirst();
  return await paidFor(db, enrolmentId) + Number(r?.c ?? 0);
}
/** What was paid for a place in money, at the desk or by card: club credit alone doesn't hold a place past its time
 *  (a member who ticks "Use my credit" for part and leaves the card form would keep it for ever). */
export async function paidInMoney(db: Db | Trx, enrolmentId: string): Promise<number> {
  const r = await db.selectFrom("payment").select(["payment.amount_cents", backSql.as("back")]).where("enrolment_id", "=", enrolmentId).where("status", "=", "succeeded").where("method", "!=", "credit").execute();
  return r.reduce((n, p) => n + p.amount_cents - Number(p.back), 0);
}

/** Ask the provider for a payment. Nothing is charged until it confirms (payment.settle). */
/** A payment owed. Nothing goes to the provider here, inside the change: the card payment is opened when
 *  the person goes to pay (openPayment), so a network call never holds a lock and an unpaid place costs nothing. */
async function requestPayment(ctx: ApplyContext, enrolmentId: string, personId: string, cents: number) {
  if (cents <= 0) return null;
  const id = uuidv7();
  await ctx.insert("payment", { id, person_id: personId, amount_cents: cents, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", enrolment_id: enrolmentId });
  return { payment_id: id };
}
/** What a card payment asks for has changed (part paid at the desk, a new price): the ask is called off and a new
 *  one made for `cents` (nothing, when it's all paid), with a new id, so a new key at the provider. A payment's
 *  amount is never changed: a card form being opened at this moment may already have asked the provider for the
 *  old amount, and payment.open then finds its payment gone instead of recording one sum for a card charged
 *  another. Alone, not with other dates it was paid with. */
export async function askAgain(ctx: ApplyContext, paymentId: string, cents: number): Promise<string | null> {
  const old = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", paymentId).forUpdate().executeTakeFirstOrThrow();
  if (old.status !== "pending" || old.provider_ref) throw new KumiError("error.changed");
  await callOff(ctx, old.id);
  if (cents <= 0) {
    // All paid another way (at the desk, from credit): a promo code's use stays counted, on the newest payment that went through.
    if (old.promo_code_id) {
      const paid = await ctx.trx.selectFrom("payment").select("id").where((w) => old.enrolment_id ? w("enrolment_id", "=", old.enrolment_id) : w("booking_player_id", "=", old.booking_player_id))
        .where("status", "=", "succeeded").orderBy("created_at", "desc").executeTakeFirst();
      if (paid) {
        await ctx.update("payment", paid.id, { promo_code_id: old.promo_code_id, discount_cents: old.discount_cents });
        await ctx.trx.updateTable("promo_use").set({ payment_id: paid.id }).where("payment_id", "=", old.id).execute();
      }
    }
    return null;
  }
  const id = uuidv7();
  await ctx.insert("payment", { id, person_id: old.person_id, amount_cents: cents, method: old.method, provider: paymentProvider().name, provider_ref: null, status: "pending",
    enrolment_id: old.enrolment_id, booking_player_id: old.booking_player_id, membership_id: old.membership_id, membership_plan_id: old.membership_plan_id, save_card: old.save_card,
    for_period_no: old.for_period_no, family_declines: old.family_declines, parent_to_pay_at: old.parent_to_pay_at,
    // A promo code applied to it stays applied, and its use with it (promo_codes.ts): asked again, it still counts.
    ...(old.promo_code_id ? { promo_code_id: old.promo_code_id, discount_cents: old.discount_cents } : {}) });
  if (old.promo_code_id) await ctx.trx.updateTable("promo_use").set({ payment_id: id }).where("payment_id", "=", old.id).execute();
  return id;
}

// ---- Paid at the desk (cash, the club's card reader, another way) ----
/** A place paid at the desk: the staff sign the person up as usual, then record what they paid, never more than is
 *  owed on it (part now and the rest later). What's still asked by card in the app comes down to the rest, or is
 *  called off once it's all paid. Refunds of it go back at the desk (desk_pay.ts). */
export const enrolmentRecordPayment = defineAction({
  name: "enrolment.record_payment", version: 1,
  input: z.object({ enrolment_id: z.uuid(), ...deskPaid }),
  async plan(ctx, i) {
    const { row: e, read } = await readRow(ctx.db, "enrolment", i.enrolment_id, "thing.person");
    const person = await personName(ctx.db, e.person_id);
    if (e.status !== "booked") throw new KumiError(e.status === "waitlisted" ? "error.place_waiting_desk" : "error.not_on_roster", { person });
    const { row: p } = await readRow(ctx.db, "program", e.program_id, "thing.program");
    const owed = e.price_cents - await coveredFor(ctx.db, e.id);
    placeOwed(owed, i.cents);
    const rest = owed - i.cents;
    return { title: both("action.enrolment.record_payment"), reads: [read], locationId: p.location_id, ownerIds: await withManagers(ctx.db, [e.person_id]), moneyCents: i.cents, undo: { kind: "compensating" },
      summary: both("plan.enrolment.record_payment", { amount: usd(i.cents), how: paidHow(i.method), person, name: textOf(p.name, p.translations, "name"),
        rest: rest > 0 ? both("plan.enrolment.rest_owed", { amount: usd(rest) }) : { en: "", es: "" } }) };
  },
  async apply(ctx, i) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).forUpdate().executeTakeFirstOrThrow();
    if (e.status !== "booked") throw new KumiError("error.changed");
    const owed = e.price_cents - await coveredFor(ctx.trx, e.id);
    placeOwed(owed, i.cents);   // again under the lock: two desks at once can't both fit
    const payment = await recordAtDesk(ctx, { personId: e.person_id, cents: i.cents, method: i.method, note: i.note, revenue: "programs", memo: "program place", link: { enrolment_id: e.id } });
    if (e.paid_by === "none") await ctx.update("enrolment", e.id, { paid_by: "desk" });
    // What the app still asks for by card (one with no card form open yet): the rest, or nothing.
    const rest = owed - i.cents;
    for (const pay of await ctx.trx.selectFrom("payment").select("id").where("enrolment_id", "=", e.id).where("status", "=", "pending").where("provider_ref", "is", null).execute())
      await askAgain(ctx, pay.id, rest);
    if (rest === 0) await subPaid(ctx, e.id);
    return { payment_id: payment };
  },
});
/** Never more than is owed on a place: Kumi keeps no credit for later, so more has nowhere to go. */
function placeOwed(owed: number, cents: number) {
  if (owed <= 0) throw new KumiError("error.place_paid_up");
  if (cents > owed) throw new KumiError("error.more_than_owed_place", { owed: usd(owed), amount: usd(cents) });
}
/** A sub has paid for the place they took (by card, or all of it at the desk): the player they replaced gets the
 *  refund that was waiting for it. */
async function subPaid(ctx: ApplyContext, enrolmentId: string) {
  const from = await ctx.trx.selectFrom("enrolment").select("id").where("replaced_by", "=", enrolmentId).executeTakeFirst();
  if (from) for (const r of await ctx.trx.selectFrom("refund").select("id").where("enrolment_id", "=", from.id).where("status", "=", "waiting_for_sub").forUpdate().execute()) await refundDue(ctx, r.id);
}
/** Paid at the desk while a card form for the same place was open, and the card went through too: what's beyond
 *  the price goes back to that card. */
async function overPaid(ctx: ApplyContext, enrolmentId: string, paymentId: string) {
  const e = await ctx.trx.selectFrom("enrolment").select(["status", "price_cents"]).where("id", "=", enrolmentId).executeTakeFirstOrThrow();
  if (e.status === "cancelled") return;
  const pay = await ctx.trx.selectFrom("payment").select("amount_cents").where("id", "=", paymentId).executeTakeFirstOrThrow();
  const over = (await coveredFor(ctx.trx, enrolmentId)) - e.price_cents;
  if (over > 0) await refundTo(ctx, paymentId, Math.min(over, pay.amount_cents), { enrolmentId });
  // Paid in full (a card form opened before the place was asked again for less, say): nothing more is asked.
  if (over >= 0) await dropUnpaid(ctx, enrolmentId);
}

// ---- Card payments: opened when the person goes to pay, settled however the news arrives ----
export const paymentOpen = defineAction({
  name: "payment.open", version: 1, system: true, internal: true,
  input: z.object({ payment_id: z.uuid(), provider: z.enum(["test", "stripe"]), provider_ref: z.string().check(z.minLength(1)), provider_account: z.optional(z.string()),
    family_card_id: z.optional(z.uuid()),   // a kid's payment, charged to the family card
    paid_by: z.optional(z.uuid()),   // who opened the card form (a parent paying their junior's): a refund as credit goes to them
    amount_cents: z.optional(z.number().check(z.int())) }),   // what the provider was asked for: it has to be what these payments ask
  async plan(ctx, i) {
    const { row: pay } = await readRow(ctx.db, "payment", i.payment_id, "thing.payment");
    return { title: both("action.payment.open"), summary: both("plan.payment.open", { person: await personName(ctx.db, pay.person_id), amount: usd(pay.amount_cents) }), reads: [], undo: { kind: "none", note: both("reason.no_way_back") } };
  },
  async apply(ctx, i) {
    // Several paid together: all their rows locked first, in id order, as payment.settle does.
    const g = await ctx.trx.selectFrom("payment").select("group_id").where("id", "=", i.payment_id).executeTakeFirstOrThrow();
    if (g.group_id) await ctx.trx.selectFrom("payment").select("id").where("group_id", "=", g.group_id).orderBy("id").forUpdate().execute();
    const pay = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", i.payment_id).forUpdate().executeTakeFirstOrThrow();
    if (pay.provider_ref === i.provider_ref) return { already: true };   // two taps on Pay: the same intent
    if (pay.provider_ref || pay.status !== "pending") throw new KumiError("error.changed");
    // Several courts paid together: every payment in the group is this one card payment.
    const all = pay.group_id ? await ctx.trx.selectFrom("payment").select(["id", "provider_ref", "status", "enrolment_id"]).where("group_id", "=", pay.group_id).forUpdate().execute() : [pay];
    // Program dates: one left before paying has dropped out (its payment called off); the card pays the rest.
    const rows = all.some((r) => r.enrolment_id) ? all.filter((r) => r.status === "pending") : all;
    if (rows.some((r) => r.provider_ref || r.status !== "pending")) throw new KumiError("error.changed");
    // Asked for a sum these payments no longer come to (one called off, or asked again for less, meanwhile): not this intent.
    if (i.amount_cents !== undefined) {
      const sum = (await ctx.trx.selectFrom("payment").select("amount_cents").where("id", "in", rows.map((r) => r.id)).execute()).reduce((n, r) => n + r.amount_cents, 0);
      if (sum !== i.amount_cents) throw new KumiError("error.changed");
    }
    for (const r of rows) await ctx.update("payment", r.id, { provider: i.provider, provider_ref: i.provider_ref, provider_account: i.provider_account ?? null, ...(i.family_card_id ? { family_card_id: i.family_card_id } : {}), ...(i.paid_by ? { paid_by: i.paid_by } : {}) });
    return null;
  },
});

/** The card form for one of the person's own pending payments: the provider's intent, opened once and reused. */
export async function openPayment(db: Db, paymentId: string, personId: string): Promise<{ clientSecret: string; provider: "test" | "stripe"; account: string | null; paid?: boolean }> {
  await refuseWhenReadOnly(db);
  const pay = await db.selectFrom("payment").leftJoin("enrolment", "enrolment.id", "payment.enrolment_id").leftJoin("program", "program.id", "enrolment.program_id")
    .leftJoin("booking_player", "booking_player.id", "payment.booking_player_id").leftJoin("booking", "booking.id", "booking_player.booking_id")
    .leftJoin("membership", "membership.id", "payment.membership_id")
    .leftJoin("membership_plan", (j) => j.on(sql<boolean>`membership_plan.id = coalesce(payment.membership_plan_id, membership.plan_id)`))
    .select(["payment.id", "payment.person_id", "payment.amount_cents", "payment.status", "payment.provider_ref", "payment.provider_account", "payment.save_card", "payment.group_id", "program.name as what", "booking.code",
      "booking.status as booking_status", "membership_plan.name as plan", "membership.status as membership_status"]).where("payment.id", "=", paymentId).executeTakeFirst();
  // A parent pays for their junior's places (the payment stays the junior's, as the place is).
  if (!pay || (pay.person_id !== personId && !(await manages(db, personId, pay.person_id)))) throw new KumiError("error.not_found", { thing: both("thing.payment") }, 404);
  if (pay.status !== "pending") throw new KumiError("error.not_pending", {}, 409);
  if (pay.booking_status === "cancelled") throw new KumiError("error.booking_cancelled", {}, 409);
  if (pay.membership_status === "ended") throw new KumiError("error.membership_ended", {}, 409);
  const pv = paymentProvider();
  if (pay.provider_ref) {
    const it = await pv.getIntent(pay.provider_ref, pay.provider_account);
    // Gone through already, and not recorded here yet (the check after the card form, or the webhook, is on its way):
    // recorded now, and no card form, so a second tap on Pay can't pay twice.
    if (it.status === "succeeded") { await checkPayment(db, pay.id, "payments"); return { clientSecret: "", provider: pv.name, account: pay.provider_account, paid: true }; }
    return { clientSecret: it.clientSecret, provider: pv.name, account: pay.provider_account };
  }
  const { currency } = await db.selectFrom("club").select("currency").executeTakeFirstOrThrow();
  // Several courts paid together: one card payment for all of them (any one of them opens it).
  if (pay.group_id) {
    const all = await db.selectFrom("payment").leftJoin("booking_player", "booking_player.id", "payment.booking_player_id").leftJoin("booking", "booking.id", "booking_player.booking_id")
      .select(["payment.id", "payment.amount_cents", "payment.status", "payment.enrolment_id", "booking.code", "booking.status as booking_status"]).where("payment.group_id", "=", pay.group_id).orderBy("payment.id").execute();
    // Program dates: a date left before paying dropped out of the group (its payment called off), so the rest are paid.
    const group = all.some((g) => g.enrolment_id) ? all.filter((g) => g.status === "pending") : all;
    if (group.some((g) => g.booking_status === "cancelled")) throw new KumiError("error.booking_cancelled", {}, 409);
    if (!group.length || group.some((g) => g.status !== "pending")) throw new KumiError("error.not_pending", {}, 409);
    const description = group[0]!.enrolment_id ? `${pay.what ?? "Program"}: ${group.length} dates` : `Court bookings ${group.map((g) => g.code).join(", ")}`;
    const cents = group.reduce((n, g) => n + g.amount_cents, 0);
    const it = await pv.createIntent({ amountCents: cents, currency, description,
      idempotencyKey: group[0]!.enrolment_id ? `${pay.group_id}:${group.length}` : pay.group_id, metadata: { kumi_payment_id: group[0]!.id } });
    await opened(db, pay.id, it, cents, personId);
    return { clientSecret: it.clientSecret, provider: pv.name, account: it.account };
  }
  // "Pay my part" and memberships: the card is saved for a later charge (the deadline, the renewal), under a
  // customer for whoever pays (a parent paying for their junior: the parent, whose card it is).
  let customer: string | undefined;
  if (pay.save_card) {
    const person = await db.selectFrom("person").select(["email", "display_name"]).where("id", "=", personId).executeTakeFirstOrThrow();
    customer = (await pv.ensureCustomer({ key: personId, email: person.email, name: person.display_name })).id;
  }
  const it = await pv.createIntent({ amountCents: pay.amount_cents, currency, description: pay.what ?? (pay.code ? `Court booking ${pay.code}` : pay.plan ? `${pay.plan} membership` : "Club payment"), idempotencyKey: pay.id,
    metadata: { kumi_payment_id: pay.id }, customer, saveCard: pay.save_card });
  await opened(db, pay.id, it, pay.amount_cents, personId);
  return { clientSecret: it.clientSecret, provider: pv.name, account: it.account };
}
/** The intent made for a payment is its card payment now, if the payment still asks for what the intent does. If
 *  it changed meanwhile (paid at the desk, called off), the intent is called off at the provider and never shown. */
async function opened(db: Db, paymentId: string, it: { ref: string; account?: string | null }, cents: number, paidBy?: string) {
  try {
    await runAsSystem(db, "payment.open", { payment_id: paymentId, provider: paymentProvider().name, provider_ref: it.ref, ...(it.account ? { provider_account: it.account } : {}), amount_cents: cents, ...(paidBy ? { paid_by: paidBy } : {}) }, "payments");
  } catch (e) {
    if (!(e instanceof KumiError && e.code === "error.changed")) throw e;
    await paymentProvider().cancelIntent(it.ref, it.account ?? null).catch(() => undefined);   // nobody has its form: it can't be paid
    throw new KumiError("error.not_pending", {}, 409);
  }
}

/** Ask the provider how a payment stands and record it once it's settled. Safe to call any number of times:
 *  after the card form, from a webhook, and from the minute job that catches what both missed. */
export async function checkPayment(db: Db, paymentId: string, via = "payments", now?: Date, o: { recentOnly?: boolean } = {}): Promise<"pending" | "succeeded" | "failed" | null> {
  const pay = await db.selectFrom("payment").select(["id", "status", "provider_ref", "provider_account"]).where("id", "=", paymentId).executeTakeFirst();
  if (!pay) return null;
  if (pay.status === "succeeded" || !pay.provider_ref) return pay.status;
  // The member's app asks about one called off only for a few days after (the jobs and webhooks always may).
  if (pay.status === "failed" && o.recentOnly && !(await calledOffSince(db, pay.id, new Date((now ?? new Date()).getTime() - CALL_OFF_DAYS * 864e5)))) return "failed";
  const it = await paymentProvider().getIntent(pay.provider_ref, pay.provider_account);
  // Called off here with its card form open: it stays failed unless the card went through anyway (recorded, then
  // what it was for decides what goes back: payment.settle).
  if (pay.status === "failed" && it.status !== "succeeded") return "failed";
  if (it.status !== "pending") {
    try { await runAsSystem(db, "payment.settle", { payment_id: pay.id, outcome: it.status, ...(it.paymentMethod ? { saved_method: it.paymentMethod } : {}), ...(it.customer ? { saved_customer: it.customer } : {}) }, via, now ? { now } : {}); }
    catch (e) { if (!(e instanceof KumiError && e.code === "error.changed")) throw e; }   // settled at that moment by another of the three: the same answer
  }
  return it.status;
}

/** Give up on a payment nobody finished (a seat held too long, a deadline passed). One whose card form was
 *  opened is called off at the provider first, so it can't go through later unrecorded; if it already went
 *  through, it's settled as paid. Returns where it ended up. A payment with no card form opened is left
 *  to the caller to mark failed, inside its own change. */
export async function abandonPayment(db: Db, paymentId: string, via = "payments", now?: Date): Promise<"pending" | "succeeded" | "failed" | null> {
  const pay = await db.selectFrom("payment").select(["id", "status", "provider_ref", "provider_account"]).where("id", "=", paymentId).executeTakeFirst();
  if (!pay || pay.status !== "pending" || !pay.provider_ref) return pay?.status ?? null;
  const pv = paymentProvider();
  if ((await pv.getIntent(pay.provider_ref, pay.provider_account)).status === "pending") await pv.cancelIntent(pay.provider_ref, pay.provider_account);
  return checkPayment(db, pay.id, via, now);
}

/** The minute job: card forms opened in the last two days and not yet settled here. */
/** How long a payment called off with its card form open is still asked about. Its call-off (payment.call_off)
 *  never gives up, so by then Stripe has it. */
export const CALL_OFF_DAYS = 3;
/** Whether a payment was called off with its card form open since `since`: the outbox event that calls it off. */
async function calledOffSince(db: Db, paymentId: string, since: Date): Promise<boolean> {
  return Boolean(await db.selectFrom("event_outbox").select("id").where("topic", "=", "payment.call_off").where(sql<string>`payload->>'payment_id'`, "=", paymentId)
    .where("created_at", ">", since).executeTakeFirst());
}

export async function reconcilePayments(db: Db, now = new Date(), limit = 50, o: { all?: boolean } = {}) {
  // all: every pending one whatever its age (at start, before any job can let one go: a restore's copy can hold
  // payments made since as still pending).
  const pending = await db.selectFrom("payment").select("id").where("status", "=", "pending").where("provider", "=", paymentProvider().name)
    .where("provider_ref", "is not", null).$if(!o.all, (q) => q.where("created_at", ">", new Date(now.getTime() - 2 * 864e5))).orderBy("created_at").limit(limit).execute();
  // Called off with its card form open, and the call-off not at Stripe yet (it can't reach Stripe, say): paid
  // meanwhile with its webhook lost, it's still found, recorded and sent back.
  const calledOff = await db.selectFrom("payment").select("payment.id").where("payment.status", "=", "failed").where("payment.provider", "=", paymentProvider().name)
    .where("payment.provider_ref", "is not", null)
    .where((eb) => eb.exists(eb.selectFrom("event_outbox").select("event_outbox.id").where("event_outbox.topic", "=", "payment.call_off").where("event_outbox.delivered_at", "is", null)
      .where("event_outbox.created_at", ">", new Date(now.getTime() - CALL_OFF_DAYS * 864e5)).where(sql<boolean>`event_outbox.payload->>'payment_id' = payment.id::text`)))
    .orderBy("payment.created_at").limit(limit).execute();
  const rows = [...pending, ...calledOff];
  let settled = 0;
  for (const r of rows) {
    try { if ((await checkPayment(db, r.id, "job:payments")) !== "pending") settled++; }
    catch (e) { console.error(`payment ${r.id}:`, (e as Error).message); }   // tried again next minute
  }
  return { checked: rows.length, settled };
}

/** A membership payment left unfinished (the card form opened, or the bank's check started, and nobody came back)
 *  holds nothing: a membership starts only once it's paid. After a day it's called off at the provider, so it can't
 *  go through later unrecorded, and recorded as not paid; the member is told once, with where to try again.
 *  Places, bookings and a kid's charges have their own deadlines and aren't touched here. */
export const UNFINISHED_AFTER_MS = 24 * 3600_000;
export async function closeUnfinishedPayments(db: Db, now = new Date(), limit = 20) {
  const rows = await db.selectFrom("payment").select("id").where("status", "=", "pending").where("provider", "=", paymentProvider().name)
    .where("provider_ref", "is not", null).where("created_at", "<", new Date(now.getTime() - UNFINISHED_AFTER_MS))
    .where("enrolment_id", "is", null).where("booking_player_id", "is", null).where("parent_to_pay_at", "is", null).where("family_card_id", "is", null)
    .where((eb) => eb.or([eb("membership_plan_id", "is not", null), eb("membership_id", "is not", null)]))
    .orderBy("created_at").limit(limit).execute();
  let closed = 0, paid = 0;
  for (const r of rows) {
    try { const s = await abandonPayment(db, r.id, "job:payments", now); if (s === "failed") closed++; else if (s === "succeeded") paid++; }
    catch (e) { console.error(`payment ${r.id}:`, (e as Error).message); }   // tried again next time
  }
  return { checked: rows.length, closed, paid };
}

// ---- Places never paid for ----
/** How long a place taken but not paid for is held: a day, or until 2 hours before its first date if that's sooner
 *  (never less than an hour). The member is reminded once, halfway. Then the place goes to the waitlist. */
export const UNPAID_HOLD_HOURS = 24;
export function unpaidLapseAt(takenAt: Date, start: Date | null): Date {
  const day = takenAt.getTime() + UNPAID_HOLD_HOURS * 3600_000, floor = takenAt.getTime() + 3600_000;
  return new Date(start ? Math.max(floor, Math.min(day, start.getTime() - 2 * 3600_000)) : day);
}

export const enrolmentUnpaid = defineAction({
  name: "enrolment.unpaid", version: 1, system: true, internal: true,
  input: z.object({ enrolment_id: z.uuid(), step: z.enum(["remind", "lapse"]), until: z.optional(z.iso.datetime({ offset: true })) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "enrolment", i.enrolment_id);
    return { title: both("action.enrolment.unpaid"), summary: both(i.step === "remind" ? "plan.enrolment.unpaid_remind" : "plan.enrolment.unpaid_lapse"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).forUpdate().executeTakeFirstOrThrow();
    // Paid in part at the desk or by card, the place stays (the rest is owed); paid in part only from club credit,
    // it's reminded and let go like an unpaid one, and the credit goes back.
    if (e.status !== "booked" || await paidInMoney(ctx.trx, e.id) > 0) return { already: true };
    const owed = await ctx.trx.selectFrom("payment").select("id").where("enrolment_id", "=", e.id).where("status", "=", "pending").where("provider_ref", "is", null).executeTakeFirst();
    if (!owed) return { already: true };   // being paid right now, or nothing owed
    if (i.step === "remind") {
      if (e.pay_reminded_at) return { already: true };
      await ctx.update("enrolment", e.id, { pay_reminded_at: ctx.now });
      await ctx.emit("enrolment.unpaid_reminder", { enrolment_id: e.id, until: i.until ?? null });
      return { reminded: true };
    }
    const p = await ctx.trx.selectFrom("program").select("refund_rule_version").where("id", "=", e.program_id).executeTakeFirstOrThrow();
    let credit = 0;
    for (const c of await ctx.trx.selectFrom("payment").select("id").where("enrolment_id", "=", e.id).where("status", "=", "succeeded").where("method", "=", "credit").execute()) {
      const r = await refundTo(ctx, c.id, Number.MAX_SAFE_INTEGER, { enrolmentId: e.id });
      credit += r?.cents ?? 0;
    }
    const refund = credit > 0 ? { outcome: "credit" as const, cents: credit, text: both("refund.credit", { amount: usd(credit) }), changed: false }
      : { outcome: "none" as const, cents: 0, text: both("refund.nothing_paid"), changed: false };
    await ctx.update("enrolment", e.id, { ...leaving(refund, "removed", "other", p.refund_rule_version, "not paid in time"), left_at: ctx.now });
    await dropUnpaid(ctx, e.id);
    await ctx.emit("enrolment.lapsed", { enrolment_id: e.id, credit_cents: credit });
    await placeFreed(ctx, e.program_id, [], e.session_id);
    return { lapsed: true };
  },
});

/** The job: places taken and not paid for, reminded halfway and freed at the end of the hold. A card form opened
 *  and left is called off at the provider first (or found paid). */
export async function lapseUnpaidPlaces(db: Db, now = new Date(), limit = 50) {
  // Read-only: nobody can pay, so nobody's place runs out for not paying; the hold waits.
  if (await isReadOnly(db)) return { reminded: 0, lapsed: 0 };
  const rows = await db.selectFrom("enrolment").innerJoin("payment", "payment.enrolment_id", "enrolment.id")
    .select(["enrolment.id", "enrolment.program_id", "enrolment.session_id", "enrolment.pay_reminded_at", "payment.id as payment_id", "payment.provider_ref"])
    // When the place was taken, by the change's own clock.
    .select(sql<Date>`coalesce((SELECT coalesce(ar.applied_at, ar.created_at) FROM entity_change ec JOIN action_run ar ON ar.id = ec.action_run_id
      WHERE ec.entity = 'payment' AND ec.entity_id = payment.id::text AND ec.op = 'insert' LIMIT 1), payment.created_at)`.as("created_at"))
    .where("enrolment.status", "=", "booked").where("payment.status", "=", "pending").orderBy("payment.created_at").limit(limit).execute();
  let reminded = 0, lapsed = 0;
  for (const r of rows) {
    try {
      const start = await firstStart(db, r.program_id, r.session_id);
      if (start && start <= now) continue;   // it's begun: the desk sorts it out
      const until = unpaidLapseAt(new Date(r.created_at), start), half = new Date(r.created_at).getTime() + (until.getTime() - new Date(r.created_at).getTime()) / 2;
      if (now >= until) {
        if (r.provider_ref && (await abandonPayment(db, r.payment_id, "job:places", now)) !== "failed") continue;
        const x = await runAsSystem(db, "enrolment.unpaid", { enrolment_id: r.id, step: "lapse" }, "job:places", { now });
        if ((x.result as { lapsed?: boolean } | null)?.lapsed) lapsed++;
      } else if (!r.pay_reminded_at && now.getTime() >= half) {
        const x = await runAsSystem(db, "enrolment.unpaid", { enrolment_id: r.id, step: "remind", until: until.toISOString() }, "job:places", { now });
        if ((x.result as { reminded?: boolean } | null)?.reminded) reminded++;
      }
    } catch (e) { console.error(`unpaid place ${r.id}:`, (e as Error).message); }
  }
  return { reminded, lapsed };
}

/** Start a refund: club credit at once; a card refund through the outbox, after this change commits; and of money
 *  paid at the desk, waiting there to be handed back (desk_pay.ts), the card's first. What went back where. */
export async function startRefund(ctx: ApplyContext, enrolmentId: string, _personId: string, refund: Refund, status: "pending" | "waiting_for_sub" = "pending"): Promise<{ card: number; desk: number; credit: number; pass: number }> {
  const none = { card: 0, desk: 0, credit: 0, pass: 0 };
  if (refund.cents <= 0 || refund.outcome === "none") return none;
  const pays = await ctx.trx.selectFrom("payment").select(["id", "amount_cents", "provider"])
    .select((eb) => eb.selectFrom("refund").select(sql<string>`coalesce(sum(refund.amount_cents), 0)`.as("c")).whereRef("refund.payment_id", "=", "payment.id").where("refund.status", "!=", "failed").as("back"))
    .where("enrolment_id", "=", enrolmentId).where("status", "=", "succeeded").orderBy("created_at", "desc").execute();
  if (!pays.length) return none;
  // As club credit too, payment by payment through refundTo: a pass's use goes back to the pass (or is spent), a free
  // promo place gives nothing, and never more than is left of a payment, to whoever paid it (creditee).
  return refundAcross(ctx, pays.map((p) => ({ id: p.id, left: p.amount_cents - Number(p.back ?? 0), desk: p.provider === "none" })), refund.cents,
    { enrolmentId, status, ...(refund.outcome === "credit" ? { credit: true } : {}) });
}


/** Several courts paid together: the one card payment settles every payment in its group, in this one change.
 *  A court whose hold was lost meanwhile is refunded (and says so); the rest are booked, with one message. */
async function settleGroup(ctx: ApplyContext, pay: { id: string; group_id: string | null; provider_ref: string | null; person_id: string }, outcome: "succeeded" | "failed") {
  // Succeeded: every payment the card covered, even one marked failed when its booking was cancelled meanwhile
  // (the money arrived, so it's recorded, then refunded).
  const rows = await ctx.trx.selectFrom("payment").selectAll().where("group_id", "=", pay.group_id!).where(sql<boolean>`provider_ref IS NOT DISTINCT FROM ${pay.provider_ref}`)
    .$if(outcome === "succeeded", (q) => q.where("status", "!=", "succeeded")).$if(outcome === "failed", (q) => q.where("status", "=", "pending")).orderBy("id").forUpdate().execute();
  if (outcome === "failed") {
    for (const r of rows) await ctx.update("payment", r.id, { status: "failed" });
    await ctx.emit("payment.failed", { payment_id: pay.id });
    return { status: "failed" };
  }
  const booked: { booking_player_id: string; cents: number }[] = [], places: string[] = [];
  for (const r of rows) {
    await ctx.update("payment", r.id, { status: "succeeded" });
    // Several dates of a program paid together: each place is paid, with one message for them all (below).
    if (r.enrolment_id) {
      await post(ctx.trx, ctx.runId, "payment", "program payment", [
        { account: await account(ctx.trx, "provider_clearing"), cents: r.amount_cents }, { account: await account(ctx.trx, "revenue", { revenueType: "programs" }), cents: -r.amount_cents }]);
      const e = await ctx.trx.selectFrom("enrolment").select(["status"]).where("id", "=", r.enrolment_id).executeTakeFirstOrThrow();
      if (e.status === "cancelled") {
        // Left (or taken off) after the card form was opened: the money arrived, so it's recorded, then all of it goes back.
        await startRefund(ctx, r.enrolment_id, r.person_id, { outcome: "full", cents: r.amount_cents, text: { en: "", es: "" }, changed: false });
        continue;
      }
      await ctx.update("enrolment", r.enrolment_id, { paid_by: "card" });
      await overPaid(ctx, r.enrolment_id, r.id);
      places.push(r.enrolment_id);
      continue;
    }
    await post(ctx.trx, ctx.runId, "payment", "court booking payment", [
      { account: await account(ctx.trx, "provider_clearing"), cents: r.amount_cents }, { account: await account(ctx.trx, "revenue", { revenueType: "courts" }), cents: -r.amount_cents }]);
    if ((await afterBookingPayment(ctx, r, { quiet: true })) === "confirmed") booked.push({ booking_player_id: r.booking_player_id!, cents: r.amount_cents });
    await ctx.emit("payment.succeeded", { payment_id: r.id });
  }
  if (places.length) await ctx.emit("enrolment.dates_paid", { person_id: pay.person_id, enrolment_ids: places, cents: rows.filter((r) => places.includes(r.enrolment_id!)).reduce((n, r) => n + r.amount_cents, 0) });
  // What the message lists, worked out now: each court booked, and what they came to.
  const ids = booked.length ? (await ctx.trx.selectFrom("booking_player").select("booking_id").where("id", "in", booked.map((b) => b.booking_player_id)).execute()).map((b) => b.booking_id) : [];
  if (ids.length === 1) await ctx.emit("booking.confirmed", { booking_id: ids[0] });
  else if (ids.length > 1) await ctx.emit("booking.courts_confirmed", { person_id: pay.person_id, booking_ids: ids, cents: booked.reduce((n, b) => n + b.cents, 0) });
  if (rows[0]?.family_card_id) await familyCharged(ctx, rows);
  return { status: "succeeded", booked: ids.length };
}

export const paymentSettle = defineAction({
  name: "payment.settle", version: 1, system: true, internal: true,
  input: z.object({ payment_id: z.uuid(), outcome: z.enum(["succeeded", "failed"]), saved_customer: z.optional(z.string()), saved_method: z.optional(z.string()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "payment", i.payment_id);
    return { title: both("action.payment.settle"), summary: both(i.outcome === "succeeded" ? "plan.payment.succeeded" : "plan.payment.failed", { person: await personName(ctx.db, row.person_id), amount: usd(row.amount_cents) }), reads: [read], undo: { kind: "none", note: both("reason.refund_sent") } };
  },
  async apply(ctx, i) {
    // Locked: the card form's return, the webhook and the minute job can all settle it at once. The second waits
    // here, finds it settled, and does nothing (a repeated webhook is the same). Several paid together lock all
    // their rows first, in id order, so two settles through different rows of one card payment can't deadlock.
    const g = await ctx.trx.selectFrom("payment").select("group_id").where("id", "=", i.payment_id).executeTakeFirstOrThrow();
    if (g.group_id) await ctx.trx.selectFrom("payment").select("id").where("group_id", "=", g.group_id).orderBy("id").forUpdate().execute();
    const pay = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", i.payment_id).forUpdate().executeTakeFirstOrThrow();
    // Called off here (its booking cancelled, its date gone, a friend's share left to the organiser) while its card
    // form was open, and the card went through anyway: the money is recorded, then all of it goes back. Several
    // paid together: what each was for decides, as for any of them (settleGroup).
    const late = pay.status === "failed" && i.outcome === "succeeded" && Boolean(pay.provider_ref);
    if (pay.status !== "pending" && !late) return { already: pay.status };
    if (pay.group_id) return settleGroup(ctx, pay, i.outcome);
    if (late) {
      await ctx.update("payment", pay.id, { status: "succeeded" });
      const kind = await revenueType(ctx.trx, pay);
      await post(ctx.trx, ctx.runId, "payment", "payment called off, paid anyway", [
        { account: await account(ctx.trx, "provider_clearing"), cents: pay.amount_cents },
        { account: await account(ctx.trx, "revenue", { revenueType: kind }), cents: -pay.amount_cents },
      ]);
      await refundTo(ctx, pay.id, pay.amount_cents, { enrolmentId: pay.enrolment_id });
      return { status: "succeeded", refunded: pay.amount_cents };
    }
    if (i.outcome === "failed") {
      await ctx.update("payment", pay.id, { status: "failed", ...(pay.save_card && i.saved_method ? { saved_customer: i.saved_customer ?? null, saved_method: i.saved_method } : {}) });
      await ctx.emit("payment.failed", { payment_id: pay.id });
      return { status: "failed" };
    }
    return paidNow(ctx, pay, { from: "provider_clearing", customer: i.saved_customer ?? null, method: i.saved_method ?? null });
  },
});

/** A payment that has gone through: by card (the provider said so), or all of it from the member's club credit
 *  (credit.ts). In the books, from clearing or from the credit the club owed them, into what it's revenue for; then
 *  what it was for happens (a court held is booked, a membership starts, a place is paid). The payment is locked. */
export async function paidNow(ctx: ApplyContext, pay: Selectable<DB["payment"]>, o: { from: "provider_clearing" | "member_credit" | "pass" | "promo"; cents?: number; customer?: string | null; method?: string | null }) {
  {
    const i = { saved_customer: o.customer ?? undefined, saved_method: o.method ?? undefined };
    // A card kept for the deadline charge ("pay my part"): the provider's customer and card, never the card itself.
    await ctx.update("payment", pay.id, { status: "succeeded", ...(pay.save_card && i.saved_method ? { saved_customer: i.saved_customer ?? null, saved_method: i.saved_method } : {}),
      ...(o.from === "member_credit" ? { method: "credit", provider: "none" } : o.from === "pass" ? { method: "pass", provider: "none" } : o.from === "promo" ? { method: "promo", provider: "none" } : {}) });
    const kind = await revenueType(ctx.trx, pay);
    // Covered by a pass: its share of the pass's price moves from what the club owes on passes to revenue. Made
    // free by a promo code: nothing moves.
    if (o.from === "pass" && (o.cents ?? 0) > 0) await post(ctx.trx, ctx.runId, "pass_use", "pass use taken", [
      { account: await account(ctx.trx, "passes"), cents: o.cents! },
      { account: await account(ctx.trx, "revenue", { revenueType: kind }), cents: -o.cents! }]);
    if (o.from === "provider_clearing" || o.from === "member_credit") await post(ctx.trx, ctx.runId, "payment", `${{ courts: "court booking payment", lessons: "lesson payment", memberships: "membership payment", programs: "program payment", gift_cards: "gift card sold", passes: "pass sold" }[kind]}${o.from === "member_credit" ? " from club credit" : ""}`, [
      { account: o.from === "member_credit" ? await account(ctx.trx, "member_credit", { personId: pay.person_id }) : await account(ctx.trx, "provider_clearing"), cents: pay.amount_cents },
      { account: await account(ctx.trx, "revenue", { revenueType: kind }), cents: -pay.amount_cents },
    ]);
    if (pay.gift_card_id) await giftCardPaid(ctx, pay.gift_card_id);
    if (pay.pass_id) await passPaid(ctx, pay.pass_id);
    if (pay.booking_player_id) await afterBookingPayment(ctx, pay);
    if (pay.membership_plan_id || pay.membership_id) await afterMembershipPayment(ctx, pay, { customer: i.saved_customer ?? null, method: i.saved_method ?? null });
    if (pay.enrolment_id) {
      await ctx.update("enrolment", pay.enrolment_id, { paid_by: o.from === "pass" ? "pack" : "card" });
      // Given up (or the date cancelled) after the card form was opened: the money arrived, so it all goes back.
      const e = await ctx.trx.selectFrom("enrolment").select(["status", "person_id"]).where("id", "=", pay.enrolment_id).executeTakeFirstOrThrow();
      if (e.status === "cancelled" && !(await ctx.trx.selectFrom("enrolment").select("id").where("replaced_by", "is not", null).where("id", "=", pay.enrolment_id).executeTakeFirst()))
        await startRefund(ctx, pay.enrolment_id, pay.person_id, { outcome: "full", cents: pay.amount_cents, text: { en: "", es: "" }, changed: false });
      // A sub has paid: the player they replaced gets their refund now.
      await subPaid(ctx, pay.enrolment_id);
      await overPaid(ctx, pay.enrolment_id, pay.id);
    }
    await ctx.emit("payment.succeeded", { payment_id: pay.id });
    if (pay.family_card_id) await familyCharged(ctx, [pay]);
    return { status: "succeeded" };
  }
}

/** A refund that didn't go through (the provider said no, or couldn't be reached for an hour), sent again by the
 *  staff. The same refund, so the same key at the provider: if the first try did reach it, nothing goes twice. */
export const refundResend = defineAction({
  name: "refund.resend", version: 1,
  input: z.object({ refund_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "refund", i.refund_id);
    if (row.status !== "failed") throw new KumiError("error.refund_not_failed");
    const pay = await ctx.db.selectFrom("payment").select(["person_id", "amount_cents", "booking_player_id", "enrolment_id"]).where("id", "=", row.payment_id).executeTakeFirstOrThrow();
    await refundRoom(ctx.db, row.payment_id, pay.amount_cents, row.amount_cents);
    return { title: both("action.refund.resend"), summary: both("plan.refund.resend", { person: await personName(ctx.db, pay.person_id), amount: usd(row.amount_cents), what: await paymentWhat(ctx.db, pay) }),
      reads: [read], ownerIds: [pay.person_id], moneyCents: row.amount_cents, undo: { kind: "none", note: both("reason.refund_sent") } };
  },
  async apply(ctx, i) {
    const r = await ctx.trx.selectFrom("refund").selectAll().where("id", "=", i.refund_id).forUpdate().executeTakeFirstOrThrow();
    if (r.status !== "failed") throw new KumiError("error.changed");
    const pay = await ctx.trx.selectFrom("payment").select("amount_cents").where("id", "=", r.payment_id).forUpdate().executeTakeFirstOrThrow();
    await refundRoom(ctx.trx, r.payment_id, pay.amount_cents, r.amount_cents);   // again under the lock
    await ctx.update("refund", r.id, { status: "pending", failure: null });
    await ctx.emit("refund.requested", { refund_id: r.id });
    return null;
  },
});
/** Whether a payment still has room for this much more back (every refund but a failed one counts: desk_pay.ts). */
async function refundRoom(db: Db | Trx, paymentId: string, paid: number, cents: number) {
  const back = Number((await db.selectFrom("payment").select(backSql.as("c")).where("id", "=", paymentId).executeTakeFirstOrThrow()).c);
  if (back + cents > paid) throw new KumiError("error.refund_more_than_paid", { left: usd(paid - back) });
}

/** A kid's payment went on the family card: the parents hear what for and how much (worked out now). */
async function familyCharged(ctx: ApplyContext, rows: { person_id: string; amount_cents: number; booking_player_id: string | null; enrolment_id: string | null; family_card_id: string | null }[]) {
  const card = await ctx.trx.selectFrom("family_card").select("household_id").where("id", "=", rows[0]!.family_card_id!).executeTakeFirstOrThrow();
  const to = (await ctx.trx.selectFrom("household_member").select("person_id").where("household_id", "=", card.household_id).where("role", "=", "adult").where("removed_at", "is", null).execute()).map((r) => r.person_id);
  await ctx.emit("family.charged", { kid: rows[0]!.person_id, to, cents: rows.reduce((n, r) => n + r.amount_cents, 0), what: await paymentsWhat(ctx.trx, rows) });
}

export const refundSettle = defineAction({
  name: "refund.settle", version: 1, system: true, internal: true,
  input: z.object({ refund_id: z.uuid(), ok: z.boolean(), provider_ref: z.optional(z.string()), failure: z.optional(z.string()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "refund", i.refund_id);
    const pay = await ctx.db.selectFrom("payment").select("person_id").where("id", "=", row.payment_id).executeTakeFirstOrThrow();
    return { title: both("action.refund.settle"), summary: both(i.ok ? "plan.refund.sent" : "plan.refund.failed", { person: await personName(ctx.db, pay.person_id), amount: usd(row.amount_cents) }), reads: [read], undo: { kind: "none", note: both("reason.refund_sent") } };
  },
  async apply(ctx, i) {
    const r = await ctx.trx.selectFrom("refund").selectAll().where("id", "=", i.refund_id).executeTakeFirstOrThrow();
    if (r.status !== "pending") return { already: r.status };
    if (!i.ok) { await ctx.update("refund", r.id, { status: "failed", failure: i.failure ?? null }); await ctx.emit("refund.failed", { refund_id: r.id }); return { status: "failed" }; }
    await ctx.update("refund", r.id, { status: "sent", provider_ref: i.provider_ref ?? null });
    const paid = await ctx.trx.selectFrom("payment").select(["booking_player_id", "membership_plan_id", "membership_id", "enrolment_id", "person_id", "family_card_id", "gift_card_id", "pass_id"]).where("id", "=", r.payment_id).executeTakeFirstOrThrow();
    // Back to the family card: the parents hear it, as they heard the charge.
    if (paid.family_card_id) {
      const card = await ctx.trx.selectFrom("family_card").select("household_id").where("id", "=", paid.family_card_id).executeTakeFirstOrThrow();
      const to = (await ctx.trx.selectFrom("household_member").select("person_id").where("household_id", "=", card.household_id).where("role", "=", "adult").where("removed_at", "is", null).execute()).map((x) => x.person_id);
      await ctx.emit("family.refunded", { kid: paid.person_id, to, cents: r.amount_cents, what: await paymentWhat(ctx.trx, paid) });
    }
    await post(ctx.trx, ctx.runId, "refund", "refund to card", [
      { account: await account(ctx.trx, "revenue", { revenueType: await revenueType(ctx.trx, paid) }), cents: r.amount_cents },
      { account: await account(ctx.trx, "provider_clearing"), cents: -r.amount_cents },
    ]);
    return { status: "sent" };
  },
});
