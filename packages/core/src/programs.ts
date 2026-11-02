// Courts, programs, dates and rosters (data_model.md 7, action_catalogue.md section 4).
// The rule that matters most here: leaving and refunding are separate decisions (rule 9).
import * as z from "zod/mini";
import { sql, type ExpressionBuilder } from "kysely";
import { both, dateTime, money, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type PlanCtx } from "./actions.ts";
import type { DB, Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { account, paymentProvider, post } from "./money.ts";
import { isClubBlock } from "./playtomic.ts";
import { checkSessionCoach, coachBusy } from "./lessons.ts";
import { clashList, dateClashes, weekly } from "./program_clashes.ts";
import { afterBookingPayment } from "./booking_pay.ts";
import { afterMembershipPayment } from "./memberships.ts";
import { quietUntil } from "./messages.ts";
import { programPerks, programPrice, priceWords, type ProgramPrice } from "./program_prices.ts";
import { manages, requireWaiver, withManagers } from "./households.ts";
import { paymentsWhat, paymentWhat } from "./kids.ts";

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
/** Places taken: everyone booked, plus places held for someone on the waitlist by an open offer. */
export async function takenCount(db: Db | Trx, programId: string, now: Date): Promise<number> {
  const r = await db.selectFrom("enrolment").select((eb) => eb.fn.countAll<string>().as("n")).where("program_id", "=", programId)
    .where((eb) => eb.or([eb("status", "=", "booked"), eb.and([eb("status", "=", "waitlisted"), holdsOffer(eb, now)])])).executeTakeFirstOrThrow();
  return Number(r.n);
}
/** The next person to offer a place to: first on the waitlist who isn't already holding an offer. */
async function nextWaitlisted(db: Db | Trx, programId: string, now: Date, skip: string[] = []) {
  return db.selectFrom("enrolment").selectAll().where("program_id", "=", programId).where("status", "=", "waitlisted")
    .where((eb) => eb.not(holdsOffer(eb, now))).$if(skip.length > 0, (q) => q.where("id", "not in", skip)).orderBy("waitlist_position").limit(1).executeTakeFirst();
}
const openOffer = (db: Db | Trx, enrolmentId: string, now: Date) => db.selectFrom("waitlist_offer").selectAll()
  .where("enrolment_id", "=", enrolmentId).where("outcome", "is", null).where("expires_at", ">", now).executeTakeFirst();
/** No new offers once the event has started. */
export const started = async (db: Db | Trx, programId: string, now: Date) => { const s = await firstStart(db, programId); return s !== null && s <= now; };

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

async function offerText(db: Db | Trx, programId: string, freesPlace: boolean, now: Date): Promise<Text> {
  if (!freesPlace || await started(db, programId, now)) return { en: "", es: "" };
  const next = await nextWaitlisted(db, programId, now);
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
  }),
  async plan(ctx, i) {
    await readRow(ctx.db, "location", i.location_id, "thing.location");
    if (i.member_price_cents != null && i.member_price_cents > i.price_cents) throw new KumiError("error.member_price_higher");
    if (i.min_players != null && i.min_players > i.capacity) throw new KumiError("error.min_over_capacity", { capacity: i.capacity });
    // The format too, when there is one ("social, Americano"), so the preview says how the night is played.
    const kind = i.format ? both("plan.program.kind_format", { kind: both(`kind.${i.kind}` as Key), format: both(`format.${i.format}` as Key) }) : both(`kind.${i.kind}` as Key);
    let summary = both("plan.program.create", { name: i.name, kind, capacity: i.capacity, price: usd(i.price_cents) });
    if (i.member_price_cents != null) summary = join2(summary, both("plan.program.member_price", { amount: usd(i.member_price_cents) }));
    if (i.min_players != null) summary = join2(summary, both("plan.program.min_line", { min: i.min_players, hours: both("count.hours", { count: i.decide_hours ?? (await ctx.db.selectFrom("club").select("program_decide_hours").executeTakeFirstOrThrow()).program_decide_hours }) }));
    return { title: both("action.program.create"), summary, reads: [], locationId: i.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("program", { id, location_id: i.location_id, kind: i.kind, format: i.format ?? null, name: i.name, capacity: i.capacity, price_cents: i.price_cents, member_price_cents: i.member_price_cents ?? null,
      level_min: i.level_min ?? null, level_max: i.level_max ?? null, refund_window_hours: i.refund_window_hours ?? 24, refund_inside_window: i.refund_inside_window ?? "none", rated: i.rated ?? ratedByDefault(i.kind),
      min_players: i.min_players ?? null, decide_hours: i.decide_hours ?? null });
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
    let summary = join2(both("plan.program.publish", { name: row.name }), both("plan.program.publish_card", { kind: both(`kind.${row.kind}` as Key), price: usd(row.price_cents), capacity: row.capacity }));
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
    const summary = join2(both("plan.program.set_prices", { name: row.name, price: usd(i.price_cents) }), member);
    return { title: both("action.program.set_prices"), summary: taken ? join2(summary, both("plan.program.prices_kept", { count: taken })) : summary, reads: [read], locationId: row.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("program", i.program_id, { price_cents: i.price_cents, member_price_cents: i.member_price_cents }); return null; },
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
    let summary = dates.length === 1 ? both("plan.session.add", { name: p.name, when: when(dates[0]!.start, tz), courts: names })
      : both("plan.session.add_weekly", { name: p.name, count: dates.length, first: when(dates[0]!.start, tz), last: when(dates[dates.length - 1]!.start, tz), courts: names });
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
export const enrolmentJoin = defineAction({
  name: "enrolment.join", version: 1,
  input: z.object({ program_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    if (p.status !== "published") throw new KumiError("error.not_published");
    const person = await personName(ctx.db, i.person_id);
    const existing = await ctx.db.selectFrom("enrolment").select("id").where("program_id", "=", i.program_id).where("person_id", "=", i.person_id).where("status", "in", ["booked", "waitlisted"]).executeTakeFirst();
    if (existing) throw new KumiError("error.already_signed_up", { person });
    await requireWaiver(ctx, i.person_id);
    // A junior's parents sign them up: their rows are the parents' too.
    const owners = await withManagers(ctx.db, [i.person_id]);
    const full = (await takenCount(ctx.db, i.program_id, ctx.now)) >= p.capacity;
    // Their own price: a member price, or an included session (only for a real place, not the waitlist).
    const price = await programPrice(ctx.db, i.program_id, i.person_id, ctx.now, { included: !full });
    if (full) {
      const pos = Number((await ctx.db.selectFrom("enrolment").select((eb) => eb.fn.max("waitlist_position").as("m")).where("program_id", "=", i.program_id).where("status", "=", "waitlisted").executeTakeFirst())?.m ?? 0) + 1;
      return { title: both("action.enrolment.join"), summary: both("plan.enrolment.waitlist", { person, name: p.name, position: pos }), reads: [read], locationId: p.location_id, ownerIds: owners, undo: { kind: "compensating" }, details: { status: "waitlisted", position: pos, price } };
    }
    return { title: both("action.enrolment.join"), summary: both("plan.enrolment.join", { person, name: p.name, price: priceWords(price) }), reads: [read], locationId: p.location_id, ownerIds: owners, undo: { kind: "compensating" }, moneyCents: price.cents, details: { status: "booked", price } };
  },
  async apply(ctx, i, plan) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();   // one join at a time per program
    const planned = (plan.details as { status: string; position?: number; price: ProgramPrice });
    const nowFull = (await takenCount(ctx.trx, i.program_id, ctx.now)) >= p.capacity;
    if ((planned.status === "booked") === nowFull) throw new KumiError("error.changed");   // the last place went meanwhile, or one opened up
    const price = await lockedPrice(ctx, i.program_id, i.person_id, planned.status === "booked");
    if (price.cents !== planned.price.cents || price.basis !== planned.price.basis) throw new KumiError("error.changed");   // a price or their membership changed meanwhile
    const id = uuidv7();
    await ctx.insert("enrolment", { id, program_id: i.program_id, person_id: i.person_id, status: planned.status, waitlist_position: planned.position ?? null, ...priced(price) });
    await ctx.emit(planned.status === "booked" ? "enrolment.booked" : "enrolment.waitlisted", { enrolment_id: id });
    // Signed up (or on the waitlist) now: a watch on the program has done its job.
    for (const w of await ctx.trx.selectFrom("program_watch").select("id").where("program_id", "=", i.program_id).where("person_id", "=", i.person_id).where("told_at", "is", null).where("ended_at", "is", null).execute())
      await ctx.update("program_watch", w.id, { ended_at: ctx.now });
    const pay = planned.status === "booked" ? await requestPayment(ctx, id, i.person_id, price.cents) : null;
    return { enrolment_id: id, status: planned.status, ...(pay ?? {}) };
  },
});

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
  const refundText = back === null ? refund.text : both(back ? "refund.included_back" : "refund.included_used");
  return { e, p, person, refund: { ...refund, text: refundText }, back: Boolean(back), read, offer: await offerText(ctx.db, e.program_id, freesPlace, ctx.now) };
}

export async function freePlace(ctx: Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0], programId: string, skip: string[] = []) {
  if (await started(ctx.trx, programId, ctx.now)) return null;
  const next = await nextWaitlisted(ctx.trx, programId, ctx.now, skip);
  if (!next) return null;
  const offerId = uuidv7();
  const expires = offerDeadline(ctx.now, await clubTz(ctx.trx), await firstStart(ctx.trx, programId));
  await ctx.insert("waitlist_offer", { id: offerId, enrolment_id: next.id, offered_at: ctx.now, expires_at: expires });
  await ctx.emit("waitlist.offered", { enrolment_id: next.id, offer_id: offerId });
  return offerId;
}

/** A place free to anyone (nobody on the waitlist took it): everyone watching the program hears it once. */
export async function tellWatchers(ctx: ApplyContext, programId: string): Promise<number> {
  const p = await ctx.trx.selectFrom("program").select(["name", "capacity", "status"]).where("id", "=", programId).executeTakeFirstOrThrow();
  if (p.status !== "published" || await started(ctx.trx, programId, ctx.now) || (await takenCount(ctx.trx, programId, ctx.now)) >= p.capacity) return 0;
  const watches = await ctx.trx.selectFrom("program_watch").select(["id", "person_id"]).where("program_id", "=", programId).where("told_at", "is", null).where("ended_at", "is", null).orderBy("created_at").execute();
  if (!watches.length) return 0;
  for (const w of watches) await ctx.update("program_watch", w.id, { told_at: ctx.now });
  const start = await firstStart(ctx.trx, programId);
  await ctx.emit("program.place_open", { program_id: programId, name: p.name, starts_at: start?.toISOString() ?? null, people: watches.map((w) => w.person_id) });
  return watches.length;
}
/** A place came free: offered to the next on the waitlist, or, with nobody waiting, open to anyone (and
 *  whoever is watching hears it). */
export async function placeFreed(ctx: ApplyContext, programId: string, skip: string[] = []): Promise<string | null> {
  const offer = await freePlace(ctx, programId, skip);
  if (!offer) await tellWatchers(ctx, programId);
  return offer;
}

/** Someone on the waitlist leaves while holding an offer: the offer is declined, and the place passes on. */
async function declineOffer(ctx: Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0], enrolmentId: string) {
  const offer = await openOffer(ctx.trx, enrolmentId, ctx.now);
  if (offer) await ctx.update("waitlist_offer", offer.id, { outcome: "declined" });
  return Boolean(offer);
}

export const leaving = (refund: Refund, how: string, reason: string, ruleVersion: number, note?: string) => ({
  status: "cancelled", left_how: how, left_reason: reason, refund_outcome: refund.outcome, refund_cents: refund.cents,
  refund_rule_version: ruleVersion, refund_changed_by_staff: refund.changed, refund_note: note ?? null,
});

export const enrolmentLeave = defineAction({
  name: "enrolment.leave", version: 1,
  input: z.object({ enrolment_id: z.uuid() }),
  async plan(ctx, i) {
    const g = await goingPlan(ctx, i.enrolment_id, "late_cancel");
    return { title: both("action.enrolment.leave"), summary: join2(both("plan.enrolment.leave", { person: g.person, name: g.p.name, refund: g.refund.text }), g.offer), reads: [g.read],
      locationId: g.p.location_id, ownerIds: await withManagers(ctx.db, [g.e.person_id]), moneyCents: g.refund.cents, undo: g.refund.cents > 0 ? { kind: "none", note: both("undo.none", { reason: both("reason.refund_sent") }) } : { kind: "compensating" }, details: { refund: g.refund, back: g.back } };
  },
  async apply(ctx, i, plan) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).executeTakeFirstOrThrow();
    const p = await ctx.trx.selectFrom("program").select("refund_rule_version").where("id", "=", e.program_id).executeTakeFirstOrThrow();
    const { refund, back } = plan.details as { refund: Refund; back: boolean };
    await ctx.update("enrolment", e.id, { ...leaving(refund, "left", "late_cancel", p.refund_rule_version), left_at: ctx.now, included_back: back });
    await ctx.emit("enrolment.left", { enrolment_id: e.id, refund_outcome: refund.outcome, refund_cents: refund.cents });
    await startRefund(ctx, e.id, e.person_id, refund);
    if (e.status === "booked" || await declineOffer(ctx, e.id)) await placeFreed(ctx, e.program_id);
    return { refund_outcome: refund.outcome, refund_cents: refund.cents };
  },
});

export const enrolmentRemove = defineAction({
  name: "enrolment.remove", version: 1,
  input: z.object({
    enrolment_id: z.uuid(), reason: z.enum(["late_cancel", "no_show", "found_sub", "club", "other"]),
    refund: z.optional(z.object({ outcome: z.enum(["none", "credit", "partial", "full"]), cents: z.optional(z.number().check(z.int(), z.minimum(0))), note: z.optional(z.string()) })),
  }),
  async plan(ctx, i) {
    const g = await goingPlan(ctx, i.enrolment_id, i.reason, i.refund);
    return { title: both("action.enrolment.remove"), summary: join2(both("plan.enrolment.remove", { person: g.person, name: g.p.name, reason: both(`reason.${i.reason}` as Key), refund: g.refund.text }), g.offer),
      reads: [g.read], locationId: g.p.location_id, moneyCents: g.refund.cents, secondPerson: g.refund.changed && g.refund.cents > TWO_PERSON_CENTS, undo: g.refund.cents > 0 ? { kind: "none", note: both("undo.none", { reason: both("reason.refund_sent") }) } : { kind: "compensating" }, details: { refund: g.refund, back: g.back } };
  },
  async apply(ctx, i, plan) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).executeTakeFirstOrThrow();
    const p = await ctx.trx.selectFrom("program").select("refund_rule_version").where("id", "=", e.program_id).executeTakeFirstOrThrow();
    const { refund, back } = plan.details as { refund: Refund; back: boolean };
    await ctx.update("enrolment", e.id, { ...leaving(refund, i.reason === "no_show" ? "no_show" : "removed", i.reason, p.refund_rule_version, i.refund?.note), left_at: ctx.now, included_back: back });
    await ctx.emit("enrolment.removed", { enrolment_id: e.id, reason: i.reason, refund_outcome: refund.outcome, refund_cents: refund.cents });
    await startRefund(ctx, e.id, e.person_id, refund);
    const offer = e.status === "booked" || await declineOffer(ctx, e.id) ? await placeFreed(ctx, e.program_id) : null;
    return { refund_outcome: refund.outcome, refund_cents: refund.cents, offer_id: offer };
  },
});

export const enrolmentTransfer = defineAction({
  name: "enrolment.transfer", version: 1,
  input: z.object({ enrolment_id: z.uuid(), to_person_id: z.uuid(), pay: z.enum(["sub_pays", "gift"]) }),
  async plan(ctx, i) {
    const { row: e, read } = await readRow(ctx.db, "enrolment", i.enrolment_id, "thing.person");
    const person = await personName(ctx.db, e.person_id), sub = await personName(ctx.db, i.to_person_id);
    if (e.status !== "booked") throw new KumiError("error.not_on_roster", { person });
    const { row: p } = await readRow(ctx.db, "program", e.program_id, "thing.program");
    const dup = await ctx.db.selectFrom("enrolment").select("id").where("program_id", "=", e.program_id).where("person_id", "=", i.to_person_id).where("status", "in", ["booked", "waitlisted"]).executeTakeFirst();
    if (dup) throw new KumiError("error.already_signed_up", { person: sub });
    // The sub pays their own price, as if they signed up: a member price, or one of their included sessions.
    const price = i.pay === "gift" ? null : await programPrice(ctx.db, e.program_id, i.to_person_id, ctx.now);
    const money = !price ? both("transfer.gift", { sub, person }) : both(price.cents > 0 ? "transfer.sub_pays" : "transfer.sub_free", { sub, person, price: priceWords(price) });
    return { title: both("action.enrolment.transfer"), summary: both("plan.enrolment.transfer", { person, name: p.name, sub, money }), reads: [read], locationId: p.location_id, ownerIds: await withManagers(ctx.db, [e.person_id]),
      undo: { kind: "compensating" }, details: { price } };
  },
  async apply(ctx, i, plan) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).executeTakeFirstOrThrow();
    const p = await ctx.trx.selectFrom("program").select(["price_cents", "refund_rule_version"]).where("id", "=", e.program_id).executeTakeFirstOrThrow();
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
  input: z.object({ program_id: z.uuid(), person_id: z.uuid(), note: z.string().check(z.minLength(1)) }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    const person = await personName(ctx.db, i.person_id);
    // A place held by an open offer to this same person is theirs to be given.
    const waiting = await ctx.db.selectFrom("enrolment").select("id").where("program_id", "=", i.program_id).where("person_id", "=", i.person_id).where("status", "=", "waitlisted").executeTakeFirst();
    const held = waiting && await openOffer(ctx.db, waiting.id, ctx.now) ? 1 : 0;
    if ((await takenCount(ctx.db, i.program_id, ctx.now)) - held >= p.capacity) throw new KumiError("error.program_full");
    return { title: both("action.enrolment.comp"), summary: both("plan.enrolment.comp", { person, name: p.name }), reads: [read], locationId: p.location_id, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();
    // If they were waiting, their waitlist place becomes the free place, and an offer they held is taken.
    const waiting = await ctx.trx.selectFrom("enrolment").selectAll().where("program_id", "=", i.program_id).where("person_id", "=", i.person_id).where("status", "=", "waitlisted").executeTakeFirst();
    const offer = waiting ? await openOffer(ctx.trx, waiting.id, ctx.now) : undefined;
    if ((await takenCount(ctx.trx, i.program_id, ctx.now)) - (offer ? 1 : 0) >= p.capacity) throw new KumiError("error.changed");
    if (offer) await ctx.update("waitlist_offer", offer.id, { outcome: "taken" });
    if (waiting) { await ctx.update("enrolment", waiting.id, { status: "booked", waitlist_position: null, price_cents: 0, paid_by: "comp", comp_note: i.note }); return { enrolment_id: waiting.id }; }
    const id = uuidv7();
    await ctx.insert("enrolment", { id, program_id: i.program_id, person_id: i.person_id, status: "booked", price_cents: 0, paid_by: "comp", comp_note: i.note });
    return { enrolment_id: id };
  },
});

export const enrolmentAcceptOffer = defineAction({
  name: "enrolment.accept_offer", version: 1,
  input: z.object({ enrolment_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: e, read } = await readRow(ctx.db, "enrolment", i.enrolment_id, "thing.person");
    const offer = await ctx.db.selectFrom("waitlist_offer").selectAll().where("enrolment_id", "=", i.enrolment_id).where("outcome", "is", null).where("expires_at", ">", ctx.now).executeTakeFirst();
    if (e.status !== "waitlisted" || !offer) throw new KumiError("error.no_offer");
    const { row: p } = await readRow(ctx.db, "program", e.program_id, "thing.program");
    await requireWaiver(ctx, e.person_id);
    // Kept at the price it was put on the waitlist at, unless an included session is free now.
    const now = await programPrice(ctx.db, e.program_id, e.person_id, ctx.now);
    const price: ProgramPrice = now.basis === "included" ? now : { cents: e.price_cents, full: p.price_cents, basis: e.price_basis, included: null };
    return { title: both("action.enrolment.accept_offer"), summary: both("plan.enrolment.accept_offer", { person: await personName(ctx.db, e.person_id), name: p.name, price: priceWords(price) }),
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
    return { title: both("action.waitlist.expire_offers"), summary: both("plan.waitlist.expire_offers", { count: n }), reads: [], undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx) {
    // Claimed under lock, so an offer taken meanwhile, or a second worker, can't be expired twice.
    const due = await dueOffers(ctx.trx, ctx.now).select(["id", "enrolment_id"]).orderBy("expires_at").forUpdate().skipLocked().execute();
    const missed: string[] = [], programs = new Set<string>();
    for (const o of due) {
      await ctx.update("waitlist_offer", o.id, { outcome: "expired" });
      const e = await ctx.trx.selectFrom("enrolment").select(["id", "program_id", "status"]).where("id", "=", o.enrolment_id).executeTakeFirstOrThrow();
      if (e.status !== "waitlisted") continue;
      const last = await ctx.trx.selectFrom("enrolment").select((eb) => eb.fn.max("waitlist_position").as("m")).where("program_id", "=", e.program_id).where("status", "=", "waitlisted").executeTakeFirst();
      await ctx.update("enrolment", e.id, { waitlist_position: Number(last?.m ?? 0) + 1 });
      await ctx.emit("waitlist.offer_expired", { enrolment_id: e.id, offer_id: o.id });
      missed.push(e.id); programs.add(e.program_id);
    }
    let offered = 0;
    for (const programId of programs) {
      const { capacity } = await ctx.trx.selectFrom("program").select("capacity").where("id", "=", programId).executeTakeFirstOrThrow();
      // Nobody else waiting: the place is open to anyone, rather than going straight back to who just missed it.
      while ((await takenCount(ctx.trx, programId, ctx.now)) < capacity && await freePlace(ctx, programId, missed)) offered++;
      await tellWatchers(ctx, programId);   // a place still free once the waitlist has had its turn
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
  const paid = await db.selectFrom("payment").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", enrolmentId).where("status", "=", "succeeded").executeTakeFirst();
  const back = await db.selectFrom("refund").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", enrolmentId).where("status", "in", ["pending", "sent", "waiting_for_sub"]).executeTakeFirst();
  return Number(paid?.c ?? 0) - Number(back?.c ?? 0);
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

// ---- Card payments: opened when the person goes to pay, settled however the news arrives ----
export const paymentOpen = defineAction({
  name: "payment.open", version: 1, system: true, internal: true,
  input: z.object({ payment_id: z.uuid(), provider: z.enum(["test", "stripe"]), provider_ref: z.string().check(z.minLength(1)), provider_account: z.optional(z.string()),
    family_card_id: z.optional(z.uuid()) }),   // a kid's payment, charged to the family card
  async plan(ctx, i) {
    const { row: pay } = await readRow(ctx.db, "payment", i.payment_id, "thing.payment");
    return { title: both("action.payment.open"), summary: both("plan.payment.open", { person: await personName(ctx.db, pay.person_id), amount: usd(pay.amount_cents) }), reads: [], undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    const pay = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", i.payment_id).forUpdate().executeTakeFirstOrThrow();
    if (pay.provider_ref === i.provider_ref) return { already: true };   // two taps on Pay: the same intent
    if (pay.provider_ref || pay.status !== "pending") throw new KumiError("error.changed");
    // Several courts paid together: every payment in the group is this one card payment.
    const rows = pay.group_id ? await ctx.trx.selectFrom("payment").select(["id", "provider_ref", "status"]).where("group_id", "=", pay.group_id).forUpdate().execute() : [pay];
    if (rows.some((r) => r.provider_ref || r.status !== "pending")) throw new KumiError("error.changed");
    for (const r of rows) await ctx.update("payment", r.id, { provider: i.provider, provider_ref: i.provider_ref, provider_account: i.provider_account ?? null, ...(i.family_card_id ? { family_card_id: i.family_card_id } : {}) });
    return null;
  },
});

/** The card form for one of the person's own pending payments: the provider's intent, opened once and reused. */
export async function openPayment(db: Db, paymentId: string, personId: string): Promise<{ clientSecret: string; provider: "test" | "stripe"; account: string | null }> {
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
  if (pay.provider_ref) return { clientSecret: (await pv.getIntent(pay.provider_ref, pay.provider_account)).clientSecret, provider: pv.name, account: pay.provider_account };
  const { currency } = await db.selectFrom("club").select("currency").executeTakeFirstOrThrow();
  // Several courts paid together: one card payment for all of them (any one of them opens it).
  if (pay.group_id) {
    const group = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").innerJoin("booking", "booking.id", "booking_player.booking_id")
      .select(["payment.id", "payment.amount_cents", "payment.status", "booking.code", "booking.status as booking_status"]).where("payment.group_id", "=", pay.group_id).orderBy("payment.id").execute();
    if (group.some((g) => g.booking_status === "cancelled")) throw new KumiError("error.booking_cancelled", {}, 409);
    if (group.some((g) => g.status !== "pending")) throw new KumiError("error.not_pending", {}, 409);
    const it = await pv.createIntent({ amountCents: group.reduce((n, g) => n + g.amount_cents, 0), currency, description: `Court bookings ${group.map((g) => g.code).join(", ")}`,
      idempotencyKey: pay.group_id, metadata: { kumi_payment_id: group[0]!.id } });
    await runAsSystem(db, "payment.open", { payment_id: pay.id, provider: pv.name, provider_ref: it.ref, ...(it.account ? { provider_account: it.account } : {}) }, "payments");
    return { clientSecret: it.clientSecret, provider: pv.name, account: it.account };
  }
  // "Pay my part" and memberships: the card is saved for a later charge (the deadline, the renewal), under a
  // customer for whoever pays (a parent paying for their junior: the parent, whose card it is).
  let customer: string | undefined;
  if (pay.save_card) {
    const person = await db.selectFrom("person").select(["email", "display_name"]).where("id", "=", personId).executeTakeFirstOrThrow();
    customer = (await pv.ensureCustomer({ key: personId, email: person.email, name: person.display_name })).id;
  }
  const it = await pv.createIntent({ amountCents: pay.amount_cents, currency, description: pay.what ?? (pay.code ? `Court booking ${pay.code}` : pay.plan ? `${pay.plan} membership` : "Kumi"), idempotencyKey: pay.id,
    metadata: { kumi_payment_id: pay.id }, customer, saveCard: pay.save_card });
  await runAsSystem(db, "payment.open", { payment_id: pay.id, provider: pv.name, provider_ref: it.ref, ...(it.account ? { provider_account: it.account } : {}) }, "payments");
  return { clientSecret: it.clientSecret, provider: pv.name, account: it.account };
}

/** Ask the provider how a payment stands and record it once it's settled. Safe to call any number of times:
 *  after the card form, from a webhook, and from the minute job that catches what both missed. */
export async function checkPayment(db: Db, paymentId: string, via = "payments", now?: Date): Promise<"pending" | "succeeded" | "failed" | null> {
  const pay = await db.selectFrom("payment").select(["id", "status", "provider_ref", "provider_account"]).where("id", "=", paymentId).executeTakeFirst();
  if (!pay) return null;
  if (pay.status !== "pending" || !pay.provider_ref) return pay.status;
  const it = await paymentProvider().getIntent(pay.provider_ref, pay.provider_account);
  if (it.status !== "pending") await runAsSystem(db, "payment.settle", { payment_id: pay.id, outcome: it.status, ...(it.paymentMethod ? { saved_method: it.paymentMethod } : {}), ...(it.customer ? { saved_customer: it.customer } : {}) }, via, now ? { now } : {});
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
export async function reconcilePayments(db: Db, now = new Date(), limit = 50) {
  const rows = await db.selectFrom("payment").select("id").where("status", "=", "pending").where("provider", "=", paymentProvider().name)
    .where("provider_ref", "is not", null).where("created_at", ">", new Date(now.getTime() - 2 * 864e5)).orderBy("created_at").limit(limit).execute();
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

/** Start a refund: club credit at once; a card refund through the outbox, after this change commits. */
export async function startRefund(ctx: ApplyContext, enrolmentId: string, personId: string, refund: Refund, status: "pending" | "waiting_for_sub" = "pending") {
  if (refund.cents <= 0 || refund.outcome === "none") return;
  const pay = await ctx.trx.selectFrom("payment").selectAll().where("enrolment_id", "=", enrolmentId).where("status", "=", "succeeded").orderBy("created_at", "desc").executeTakeFirst();
  if (!pay) return;
  const id = uuidv7();
  if (refund.outcome === "credit") {
    await ctx.insert("refund", { id, payment_id: pay.id, enrolment_id: enrolmentId, amount_cents: refund.cents, destination: "credit", status: "sent" });
    await post(ctx.trx, ctx.runId, "credit_grant", "refund as club credit", [
      { account: await account(ctx.trx, "revenue", { revenueType: "programs" }), cents: refund.cents },
      { account: await account(ctx.trx, "member_credit", { personId }), cents: -refund.cents },
    ]);
    return;
  }
  await ctx.insert("refund", { id, payment_id: pay.id, enrolment_id: enrolmentId, amount_cents: refund.cents, destination: "card", status });
  if (status === "pending") await ctx.emit("refund.requested", { refund_id: id });
}

/** Which revenue a payment is: courts, lessons, memberships or programs. */
async function revenueType(db: Db | Trx, p: { booking_player_id: string | null; membership_plan_id: string | null; membership_id: string | null }) {
  if (p.booking_player_id) return await bookingRevenue(db, p.booking_player_id);
  return p.membership_plan_id || p.membership_id ? "memberships" as const : "programs" as const;
}
/** A booking's revenue: a lesson's apart from courts, so the club sees what its coaching brings in. */
export async function bookingRevenue(db: Db | Trx, bookingPlayerId: string): Promise<"courts" | "lessons"> {
  const b = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").select("booking.kind").where("booking_player.id", "=", bookingPlayerId).executeTakeFirst();
  return b?.kind === "lesson" ? "lessons" : "courts";
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
  const booked: { booking_player_id: string; cents: number }[] = [];
  for (const r of rows) {
    await ctx.update("payment", r.id, { status: "succeeded" });
    await post(ctx.trx, ctx.runId, "payment", "court booking payment", [
      { account: await account(ctx.trx, "provider_clearing"), cents: r.amount_cents }, { account: await account(ctx.trx, "revenue", { revenueType: "courts" }), cents: -r.amount_cents }]);
    if ((await afterBookingPayment(ctx, r, { quiet: true })) === "confirmed") booked.push({ booking_player_id: r.booking_player_id!, cents: r.amount_cents });
    await ctx.emit("payment.succeeded", { payment_id: r.id });
  }
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
    const pay = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", i.payment_id).executeTakeFirstOrThrow();
    if (pay.status !== "pending") return { already: pay.status };   // a repeated webhook does nothing
    if (pay.group_id) return settleGroup(ctx, pay, i.outcome);
    // A card kept for the deadline charge ("pay my part"): the provider's customer and card, never the card itself.
    await ctx.update("payment", pay.id, { status: i.outcome, ...(pay.save_card && i.saved_method ? { saved_customer: i.saved_customer ?? null, saved_method: i.saved_method } : {}) });
    if (i.outcome === "failed") { await ctx.emit("payment.failed", { payment_id: pay.id }); return { status: "failed" }; }
    const kind = await revenueType(ctx.trx, pay);
    await post(ctx.trx, ctx.runId, "payment", { courts: "court booking payment", lessons: "lesson payment", memberships: "membership payment", programs: "program payment" }[kind], [
      { account: await account(ctx.trx, "provider_clearing"), cents: pay.amount_cents },
      { account: await account(ctx.trx, "revenue", { revenueType: kind }), cents: -pay.amount_cents },
    ]);
    if (pay.booking_player_id) await afterBookingPayment(ctx, pay);
    if (pay.membership_plan_id || pay.membership_id) await afterMembershipPayment(ctx, pay, { customer: i.saved_customer ?? null, method: i.saved_method ?? null });
    if (pay.enrolment_id) {
      await ctx.update("enrolment", pay.enrolment_id, { paid_by: "card" });
      // A sub has paid: the player they replaced gets their refund now.
      const from = await ctx.trx.selectFrom("enrolment").select("id").where("replaced_by", "=", pay.enrolment_id).executeTakeFirst();
      if (from) for (const r of await ctx.trx.selectFrom("refund").select("id").where("enrolment_id", "=", from.id).where("status", "=", "waiting_for_sub").execute()) {
        await ctx.update("refund", r.id, { status: "pending" });
        await ctx.emit("refund.requested", { refund_id: r.id });
      }
    }
    await ctx.emit("payment.succeeded", { payment_id: pay.id });
    if (pay.family_card_id) await familyCharged(ctx, [pay]);
    return { status: "succeeded" };
  },
});

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
    const paid = await ctx.trx.selectFrom("payment").select(["booking_player_id", "membership_plan_id", "membership_id", "enrolment_id", "person_id", "family_card_id"]).where("id", "=", r.payment_id).executeTakeFirstOrThrow();
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
