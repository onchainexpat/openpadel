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
import { afterBookingPayment } from "./booking_pay.ts";
import { afterMembershipPayment } from "./memberships.ts";
import { quietUntil } from "./messages.ts";

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
const priceText = (cents: number): Text => (cents > 0 ? both("price.amount", { amount: usd(cents) }) : both("price.free"));

async function personName(db: Db | Trx, id: string): Promise<string> {
  return (await readRow(db, "person", id, "thing.person")).row.display_name;
}
async function clubTz(db: Db | Trx): Promise<string> { return (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone; }
async function firstStart(db: Db | Trx, programId: string, sessionId?: string | null): Promise<Date | null> {
  const r = await db.selectFrom("session").select((eb) => eb.fn.min("starts_at").as("s")).where("program_id", "=", programId).where("status", "!=", "cancelled")
    .$if(Boolean(sessionId), (q) => q.where("id", "=", sessionId!)).executeTakeFirst();
  return (r?.s as Date | null) ?? null;
}
/** An offer from the waitlist that hasn't been taken, declined or run out holds its place. */
const holdsOffer = (eb: ExpressionBuilder<DB, "enrolment">, now: Date) => eb.exists(eb.selectFrom("waitlist_offer").select("waitlist_offer.id")
  .whereRef("waitlist_offer.enrolment_id", "=", "enrolment.id").where("waitlist_offer.outcome", "is", null).where("waitlist_offer.expires_at", ">", now));
/** Places taken: everyone booked, plus places held for someone on the waitlist by an open offer. */
async function takenCount(db: Db | Trx, programId: string, now: Date): Promise<number> {
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
const started = async (db: Db | Trx, programId: string, now: Date) => { const s = await firstStart(db, programId); return s !== null && s <= now; };

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
const join2 = (a: Text, b: Text): Text => ({ en: a.en + b.en, es: a.es + b.es });

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

export const programCreate = defineAction({
  name: "program.create", version: 1,
  input: z.object({
    location_id: z.uuid(), kind: z.enum(["clinic", "course", "league", "tournament", "social"]), format: z.optional(z.enum(["americano", "mexicano", "king_of_court"])),
    name: z.string().check(z.minLength(1)), capacity: z.number().check(z.int(), z.minimum(1)), price_cents: z.number().check(z.int(), z.minimum(0)),
    level_min: z.optional(z.number()), level_max: z.optional(z.number()),
    refund_window_hours: z.optional(z.number().check(z.int(), z.minimum(0))), refund_inside_window: z.optional(z.enum(["none", "credit", "full"])),
    rated: z.optional(z.boolean().check(z.describe("Whether results change levels. Friendlies never do."))),
  }),
  async plan(ctx, i) {
    await readRow(ctx.db, "location", i.location_id, "thing.location");
    return { title: both("action.program.create"), summary: both("plan.program.create", { name: i.name, kind: both(`kind.${i.kind}` as Key), capacity: i.capacity, price: usd(i.price_cents) }), reads: [], locationId: i.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("program", { id, location_id: i.location_id, kind: i.kind, format: i.format ?? null, name: i.name, capacity: i.capacity, price_cents: i.price_cents,
      level_min: i.level_min ?? null, level_max: i.level_max ?? null, refund_window_hours: i.refund_window_hours ?? 24, refund_inside_window: i.refund_inside_window ?? "none", rated: i.rated ?? false });
    return { program_id: id };
  },
});

export const programPublish = defineAction({
  name: "program.publish", version: 1,
  input: z.object({ program_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    return { title: both("action.program.publish"), summary: both("plan.program.publish", { name: row.name }), reads: [read], locationId: row.location_id, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) { await ctx.update("program", i.program_id, { status: "published" }); await ctx.emit("program.published", { program_id: i.program_id }); return null; },
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
  input: z.object({ program_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }), ends_at: z.iso.datetime({ offset: true }), court_ids: z.array(z.uuid()).check(z.minLength(1)) }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    const courts = await ctx.db.selectFrom("court").select(["id", "name", "location_id"]).where("id", "in", i.court_ids).where("archived_at", "is", null).execute();
    if (courts.length !== new Set(i.court_ids).size || courts.some((c) => c.location_id !== p.location_id)) throw new KumiError("error.not_found", { thing: both("thing.court") }, 404);
    if ((await courtTimeUnder(ctx.db, i)).some((c) => !c.absorb)) throw new KumiError("error.court_taken");
    const names = courts.map((c) => c.name).join(", ");
    return { title: both("action.session.add"), summary: both("plan.session.add", { name: p.name, when: when(new Date(i.starts_at), await clubTz(ctx.db)), courts: names }), reads: [read], locationId: p.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    // Lock the courts first, in court-id order (spikes/booking_race.md), then take the time.
    for (const id of [...i.court_ids].sort()) await ctx.trx.selectFrom("court").select("id").where("id", "=", id).forUpdate().execute();
    const under = await courtTimeUnder(ctx.trx, i);
    if (under.some((c) => !c.absorb)) throw new KumiError("error.court_taken");
    // The club already blocked these courts in Playtomic for this event: the event takes over the hold.
    for (const c of under) await ctx.update("court_time", c.id, { active: false });
    const sessionId = uuidv7(), held = new Map<string, string>();
    await ctx.insert("session", { id: sessionId, program_id: i.program_id, starts_at: new Date(i.starts_at), ends_at: new Date(i.ends_at) });
    try {
      for (const court of i.court_ids) {
        const id = uuidv7(); held.set(court, id);
        await ctx.insert("court_time", { id, court_id: court, during: sql`tstzrange(${new Date(i.starts_at)}, ${new Date(i.ends_at)})`, kind: "session", session_id: sessionId });
      }
    } catch (e: any) { if (e?.code === "23P01") throw new KumiError("error.court_taken"); throw e; }
    for (const c of under) await ctx.update("mirror_booking", c.ref!, { status: "covered", court_time_id: null, clash_id: held.get(c.court_id)! });
    return { session_id: sessionId };
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
    const full = (await takenCount(ctx.db, i.program_id, ctx.now)) >= p.capacity;
    if (full) {
      const pos = Number((await ctx.db.selectFrom("enrolment").select((eb) => eb.fn.max("waitlist_position").as("m")).where("program_id", "=", i.program_id).where("status", "=", "waitlisted").executeTakeFirst())?.m ?? 0) + 1;
      return { title: both("action.enrolment.join"), summary: both("plan.enrolment.waitlist", { person, name: p.name, position: pos }), reads: [read], locationId: p.location_id, ownerIds: [i.person_id], undo: { kind: "compensating" }, details: { status: "waitlisted", position: pos } };
    }
    return { title: both("action.enrolment.join"), summary: both("plan.enrolment.join", { person, name: p.name, price: priceText(p.price_cents) }), reads: [read], locationId: p.location_id, ownerIds: [i.person_id], undo: { kind: "compensating" }, moneyCents: p.price_cents, details: { status: "booked" } };
  },
  async apply(ctx, i, plan) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();   // one join at a time per program
    const planned = (plan.details as { status: string; position?: number });
    const nowFull = (await takenCount(ctx.trx, i.program_id, ctx.now)) >= p.capacity;
    if ((planned.status === "booked") === nowFull) throw new KumiError("error.changed");   // the last place went meanwhile, or one opened up
    const id = uuidv7();
    await ctx.insert("enrolment", { id, program_id: i.program_id, person_id: i.person_id, status: planned.status, waitlist_position: planned.position ?? null, price_cents: p.price_cents });
    await ctx.emit(planned.status === "booked" ? "enrolment.booked" : "enrolment.waitlisted", { enrolment_id: id });
    const pay = planned.status === "booked" ? await requestPayment(ctx, id, i.person_id, p.price_cents) : null;
    return { enrolment_id: id, status: planned.status, ...(pay ?? {}) };
  },
});

async function goingPlan(ctx: PlanCtx, enrolmentId: string, reason: string, refundIn?: { outcome: RefundOutcome; cents?: number; note?: string }) {
  const { row: e, read } = await readRow(ctx.db, "enrolment", enrolmentId, "thing.person");
  const person = await personName(ctx.db, e.person_id);
  if (!["booked", "waitlisted"].includes(e.status)) throw new KumiError("error.not_on_roster", { person });
  const { row: p } = await readRow(ctx.db, "program", e.program_id, "thing.program");
  const paid = await paidFor(ctx.db, e.id);
  const rule = ruleRefund(p as any, paid, reason, await firstStart(ctx.db, e.program_id, e.session_id), ctx.now);
  const refund = staffRefund(rule, paid, refundIn);
  const freesPlace = e.status === "booked" || Boolean(await openOffer(ctx.db, e.id, ctx.now));   // a booked place, or one offered to them
  return { e, p, person, refund, read, offer: await offerText(ctx.db, e.program_id, freesPlace, ctx.now) };
}

async function freePlace(ctx: Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0], programId: string, skip: string[] = []) {
  if (await started(ctx.trx, programId, ctx.now)) return null;
  const next = await nextWaitlisted(ctx.trx, programId, ctx.now, skip);
  if (!next) return null;
  const offerId = uuidv7();
  const expires = offerDeadline(ctx.now, await clubTz(ctx.trx), await firstStart(ctx.trx, programId));
  await ctx.insert("waitlist_offer", { id: offerId, enrolment_id: next.id, offered_at: ctx.now, expires_at: expires });
  await ctx.emit("waitlist.offered", { enrolment_id: next.id, offer_id: offerId });
  return offerId;
}

/** Someone on the waitlist leaves while holding an offer: the offer is declined, and the place passes on. */
async function declineOffer(ctx: Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0], enrolmentId: string) {
  const offer = await openOffer(ctx.trx, enrolmentId, ctx.now);
  if (offer) await ctx.update("waitlist_offer", offer.id, { outcome: "declined" });
  return Boolean(offer);
}

const leaving = (refund: Refund, how: string, reason: string, ruleVersion: number, note?: string) => ({
  status: "cancelled", left_how: how, left_reason: reason, refund_outcome: refund.outcome, refund_cents: refund.cents,
  refund_rule_version: ruleVersion, refund_changed_by_staff: refund.changed, refund_note: note ?? null,
});

export const enrolmentLeave = defineAction({
  name: "enrolment.leave", version: 1,
  input: z.object({ enrolment_id: z.uuid() }),
  async plan(ctx, i) {
    const g = await goingPlan(ctx, i.enrolment_id, "late_cancel");
    return { title: both("action.enrolment.leave"), summary: join2(both("plan.enrolment.leave", { person: g.person, name: g.p.name, refund: g.refund.text }), g.offer), reads: [g.read],
      locationId: g.p.location_id, ownerIds: [g.e.person_id], moneyCents: g.refund.cents, undo: g.refund.cents > 0 ? { kind: "none", note: both("undo.none", { reason: both("reason.refund_sent") }) } : { kind: "compensating" }, details: { refund: g.refund } };
  },
  async apply(ctx, i, plan) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).executeTakeFirstOrThrow();
    const p = await ctx.trx.selectFrom("program").select("refund_rule_version").where("id", "=", e.program_id).executeTakeFirstOrThrow();
    const refund = (plan.details as { refund: Refund }).refund;
    await ctx.update("enrolment", e.id, { ...leaving(refund, "left", "late_cancel", p.refund_rule_version), left_at: ctx.now });
    await ctx.emit("enrolment.left", { enrolment_id: e.id, refund_outcome: refund.outcome, refund_cents: refund.cents });
    await startRefund(ctx, e.id, e.person_id, refund);
    if (e.status === "booked" || await declineOffer(ctx, e.id)) await freePlace(ctx, e.program_id);
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
      reads: [g.read], locationId: g.p.location_id, moneyCents: g.refund.cents, secondPerson: g.refund.changed && g.refund.cents > TWO_PERSON_CENTS, undo: g.refund.cents > 0 ? { kind: "none", note: both("undo.none", { reason: both("reason.refund_sent") }) } : { kind: "compensating" }, details: { refund: g.refund } };
  },
  async apply(ctx, i, plan) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).executeTakeFirstOrThrow();
    const p = await ctx.trx.selectFrom("program").select("refund_rule_version").where("id", "=", e.program_id).executeTakeFirstOrThrow();
    const refund = (plan.details as { refund: Refund }).refund;
    await ctx.update("enrolment", e.id, { ...leaving(refund, i.reason === "no_show" ? "no_show" : "removed", i.reason, p.refund_rule_version, i.refund?.note), left_at: ctx.now });
    await ctx.emit("enrolment.removed", { enrolment_id: e.id, reason: i.reason, refund_outcome: refund.outcome, refund_cents: refund.cents });
    await startRefund(ctx, e.id, e.person_id, refund);
    const offer = e.status === "booked" || await declineOffer(ctx, e.id) ? await freePlace(ctx, e.program_id) : null;
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
    const money = i.pay === "gift" ? both("transfer.gift", { sub, person }) : both("transfer.sub_pays", { sub, person, amount: usd(e.price_cents) });
    return { title: both("action.enrolment.transfer"), summary: both("plan.enrolment.transfer", { person, name: p.name, sub, money }), reads: [read], locationId: p.location_id, ownerIds: [e.person_id], undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const e = await ctx.trx.selectFrom("enrolment").selectAll().where("id", "=", i.enrolment_id).executeTakeFirstOrThrow();
    const p = await ctx.trx.selectFrom("program").select(["price_cents", "refund_rule_version"]).where("id", "=", e.program_id).executeTakeFirstOrThrow();
    const newId = uuidv7();
    await ctx.insert("enrolment", { id: newId, program_id: e.program_id, session_id: e.session_id, person_id: i.to_person_id, status: "booked", price_cents: i.pay === "gift" ? e.price_cents : p.price_cents, paid_by: i.pay === "gift" ? "transfer" : "none" });
    // When the sub pays, the original player's refund is due (the money moves in the payments slice).
    const refund: Refund = i.pay === "gift" ? { outcome: "none", cents: 0, text: both("refund.nothing_paid"), changed: false } : { outcome: "full", cents: e.price_cents, text: both("refund.full", { amount: usd(e.price_cents) }), changed: false };
    await ctx.update("enrolment", e.id, { ...leaving(refund, "transferred", "found_sub", p.refund_rule_version), left_at: ctx.now, replaced_by: newId });
    if (i.pay === "sub_pays") {
      await startRefund(ctx, e.id, e.person_id, { ...refund, cents: await paidFor(ctx.trx, e.id) }, "waiting_for_sub");
      const sub = await ctx.trx.selectFrom("program").select("name").where("id", "=", e.program_id).executeTakeFirstOrThrow();
      const pay = await requestPayment(ctx, newId, i.to_person_id, p.price_cents);
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
    if ((await takenCount(ctx.db, i.program_id, ctx.now)) >= p.capacity) throw new KumiError("error.program_full");
    return { title: both("action.enrolment.comp"), summary: both("plan.enrolment.comp", { person, name: p.name }), reads: [read], locationId: p.location_id, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();
    if ((await takenCount(ctx.trx, i.program_id, ctx.now)) >= p.capacity) throw new KumiError("error.changed");
    // If they were waiting, their waitlist place becomes the free place.
    const waiting = await ctx.trx.selectFrom("enrolment").selectAll().where("program_id", "=", i.program_id).where("person_id", "=", i.person_id).where("status", "=", "waitlisted").executeTakeFirst();
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
    return { title: both("action.enrolment.accept_offer"), summary: both("plan.enrolment.accept_offer", { person: await personName(ctx.db, e.person_id), name: p.name, price: priceText(e.price_cents) }),
      reads: [read, { entity: "waitlist_offer", id: offer.id, version: offer.version }], locationId: p.location_id, ownerIds: [e.person_id], moneyCents: e.price_cents, undo: { kind: "compensating" }, details: { offer_id: offer.id } };
  },
  async apply(ctx, i, plan) {
    await ctx.update("enrolment", i.enrolment_id, { status: "booked", waitlist_position: null });
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
type ApplyContext = Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0];

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
  input: z.object({ payment_id: z.uuid(), provider: z.enum(["test", "stripe"]), provider_ref: z.string().check(z.minLength(1)), provider_account: z.optional(z.string()) }),
  async plan(ctx, i) {
    const { row: pay } = await readRow(ctx.db, "payment", i.payment_id, "thing.payment");
    return { title: both("action.payment.open"), summary: both("plan.payment.open", { person: await personName(ctx.db, pay.person_id), amount: usd(pay.amount_cents) }), reads: [], undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    const pay = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", i.payment_id).forUpdate().executeTakeFirstOrThrow();
    if (pay.provider_ref === i.provider_ref) return { already: true };   // two taps on Pay: the same intent
    if (pay.provider_ref || pay.status !== "pending") throw new KumiError("error.changed");
    await ctx.update("payment", pay.id, { provider: i.provider, provider_ref: i.provider_ref, provider_account: i.provider_account ?? null });
    return null;
  },
});

/** The card form for one of the person's own pending payments: the provider's intent, opened once and reused. */
export async function openPayment(db: Db, paymentId: string, personId: string): Promise<{ clientSecret: string; provider: "test" | "stripe"; account: string | null }> {
  const pay = await db.selectFrom("payment").leftJoin("enrolment", "enrolment.id", "payment.enrolment_id").leftJoin("program", "program.id", "enrolment.program_id")
    .leftJoin("booking_player", "booking_player.id", "payment.booking_player_id").leftJoin("booking", "booking.id", "booking_player.booking_id")
    .leftJoin("membership", "membership.id", "payment.membership_id")
    .leftJoin("membership_plan", (j) => j.on(sql<boolean>`membership_plan.id = coalesce(payment.membership_plan_id, membership.plan_id)`))
    .select(["payment.id", "payment.person_id", "payment.amount_cents", "payment.status", "payment.provider_ref", "payment.provider_account", "payment.save_card", "program.name as what", "booking.code",
      "booking.status as booking_status", "membership_plan.name as plan", "membership.status as membership_status"]).where("payment.id", "=", paymentId).executeTakeFirst();
  if (!pay || pay.person_id !== personId) throw new KumiError("error.not_found", { thing: both("thing.payment") }, 404);
  if (pay.status !== "pending") throw new KumiError("error.not_pending", {}, 409);
  if (pay.booking_status === "cancelled") throw new KumiError("error.booking_cancelled", {}, 409);
  if (pay.membership_status === "ended") throw new KumiError("error.membership_ended", {}, 409);
  const pv = paymentProvider();
  if (pay.provider_ref) return { clientSecret: (await pv.getIntent(pay.provider_ref, pay.provider_account)).clientSecret, provider: pv.name, account: pay.provider_account };
  const { currency } = await db.selectFrom("club").select("currency").executeTakeFirstOrThrow();
  // "Pay my part" and memberships: the card is saved for a later charge (the deadline, the renewal), under a customer for them.
  let customer: string | undefined;
  if (pay.save_card) {
    const person = await db.selectFrom("person").select(["email", "display_name"]).where("id", "=", pay.person_id).executeTakeFirstOrThrow();
    customer = (await pv.ensureCustomer({ key: pay.person_id, email: person.email, name: person.display_name })).id;
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

/** Start a refund: club credit at once; a card refund through the outbox, after this change commits. */
async function startRefund(ctx: ApplyContext, enrolmentId: string, personId: string, refund: Refund, status: "pending" | "waiting_for_sub" = "pending") {
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

/** Which revenue a payment is: courts, memberships or programs. */
function revenueType(p: { booking_player_id: string | null; membership_plan_id: string | null; membership_id: string | null }) {
  return p.booking_player_id ? "courts" as const : p.membership_plan_id || p.membership_id ? "memberships" as const : "programs" as const;
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
    // A card kept for the deadline charge ("pay my part"): the provider's customer and card, never the card itself.
    await ctx.update("payment", pay.id, { status: i.outcome, ...(pay.save_card && i.saved_method ? { saved_customer: i.saved_customer ?? null, saved_method: i.saved_method } : {}) });
    if (i.outcome === "failed") { await ctx.emit("payment.failed", { payment_id: pay.id }); return { status: "failed" }; }
    const kind = revenueType(pay);
    await post(ctx.trx, ctx.runId, "payment", { courts: "court booking payment", memberships: "membership payment", programs: "program payment" }[kind], [
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
    return { status: "succeeded" };
  },
});

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
    const paid = await ctx.trx.selectFrom("payment").select(["booking_player_id", "membership_plan_id", "membership_id"]).where("id", "=", r.payment_id).executeTakeFirstOrThrow();
    await post(ctx.trx, ctx.runId, "refund", "refund to card", [
      { account: await account(ctx.trx, "revenue", { revenueType: revenueType(paid) }), cents: r.amount_cents },
      { account: await account(ctx.trx, "provider_clearing"), cents: -r.amount_cents },
    ]);
    return { status: "sent" };
  },
});
