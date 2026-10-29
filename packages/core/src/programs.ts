// Courts, programs, dates and rosters (data_model.md 7, action_catalogue.md section 4).
// The rule that matters most here: leaving and refunding are separate decisions (rule 9).
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, dateTime, money, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { account, paymentProvider, post } from "./money.ts";

export const OFFER_HOURS = 2;
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
async function bookedCount(db: Db | Trx, programId: string): Promise<number> {
  const r = await db.selectFrom("enrolment").select((eb) => eb.fn.countAll<string>().as("n")).where("program_id", "=", programId).where("status", "=", "booked").executeTakeFirstOrThrow();
  return Number(r.n);
}
async function nextWaitlisted(db: Db | Trx, programId: string) {
  return db.selectFrom("enrolment").selectAll().where("program_id", "=", programId).where("status", "=", "waitlisted").orderBy("waitlist_position").limit(1).executeTakeFirst();
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

async function offerText(db: Db | Trx, programId: string, freesPlace: boolean): Promise<Text> {
  if (!freesPlace) return { en: "", es: "" };
  const next = await nextWaitlisted(db, programId);
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

export const programCreate = defineAction({
  name: "program.create", version: 1,
  input: z.object({
    location_id: z.uuid(), kind: z.enum(["clinic", "course", "league", "tournament", "social"]), format: z.optional(z.enum(["americano", "mexicano", "king_of_court"])),
    name: z.string().check(z.minLength(1)), capacity: z.number().check(z.int(), z.minimum(1)), price_cents: z.number().check(z.int(), z.minimum(0)),
    level_min: z.optional(z.number()), level_max: z.optional(z.number()),
    refund_window_hours: z.optional(z.number().check(z.int(), z.minimum(0))), refund_inside_window: z.optional(z.enum(["none", "credit", "full"])),
  }),
  async plan(ctx, i) {
    await readRow(ctx.db, "location", i.location_id, "thing.location");
    return { title: both("action.program.create"), summary: both("plan.program.create", { name: i.name, kind: both(`kind.${i.kind}` as Key), capacity: i.capacity, price: usd(i.price_cents) }), reads: [], locationId: i.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("program", { id, location_id: i.location_id, kind: i.kind, format: i.format ?? null, name: i.name, capacity: i.capacity, price_cents: i.price_cents,
      level_min: i.level_min ?? null, level_max: i.level_max ?? null, refund_window_hours: i.refund_window_hours ?? 24, refund_inside_window: i.refund_inside_window ?? "none" });
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

export const sessionAdd = defineAction({
  name: "session.add", version: 1,
  input: z.object({ program_id: z.uuid(), starts_at: z.iso.datetime({ offset: true }), ends_at: z.iso.datetime({ offset: true }), court_ids: z.array(z.uuid()).check(z.minLength(1)) }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    const courts = await ctx.db.selectFrom("court").select(["id", "name", "location_id"]).where("id", "in", i.court_ids).where("archived_at", "is", null).execute();
    if (courts.length !== new Set(i.court_ids).size || courts.some((c) => c.location_id !== p.location_id)) throw new KumiError("error.not_found", { thing: both("thing.court") }, 404);
    const clash = await ctx.db.selectFrom("court_time").select("id").where("court_id", "in", i.court_ids).where("active", "=", true)
      .where(sql<boolean>`during && tstzrange(${new Date(i.starts_at)}, ${new Date(i.ends_at)})`).executeTakeFirst();
    if (clash) throw new KumiError("error.court_taken");
    const names = courts.map((c) => c.name).join(", ");
    return { title: both("action.session.add"), summary: both("plan.session.add", { name: p.name, when: when(new Date(i.starts_at), await clubTz(ctx.db)), courts: names }), reads: [read], locationId: p.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    // Lock the courts first, in court-id order (spikes/booking_race.md), then take the time.
    for (const id of [...i.court_ids].sort()) await ctx.trx.selectFrom("court").select("id").where("id", "=", id).forUpdate().execute();
    const sessionId = uuidv7();
    await ctx.insert("session", { id: sessionId, program_id: i.program_id, starts_at: new Date(i.starts_at), ends_at: new Date(i.ends_at) });
    try {
      for (const court of i.court_ids) await ctx.insert("court_time", { id: uuidv7(), court_id: court, during: sql`tstzrange(${new Date(i.starts_at)}, ${new Date(i.ends_at)})`, kind: "session", session_id: sessionId });
    } catch (e: any) { if (e?.code === "23P01") throw new KumiError("error.court_taken"); throw e; }
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
    const full = (await bookedCount(ctx.db, i.program_id)) >= p.capacity;
    if (full) {
      const pos = Number((await ctx.db.selectFrom("enrolment").select((eb) => eb.fn.max("waitlist_position").as("m")).where("program_id", "=", i.program_id).where("status", "=", "waitlisted").executeTakeFirst())?.m ?? 0) + 1;
      return { title: both("action.enrolment.join"), summary: both("plan.enrolment.waitlist", { person, name: p.name, position: pos }), reads: [read], locationId: p.location_id, ownerIds: [i.person_id], undo: { kind: "compensating" }, details: { status: "waitlisted", position: pos } };
    }
    return { title: both("action.enrolment.join"), summary: both("plan.enrolment.join", { person, name: p.name, price: priceText(p.price_cents) }), reads: [read], locationId: p.location_id, ownerIds: [i.person_id], undo: { kind: "compensating" }, moneyCents: p.price_cents, details: { status: "booked" } };
  },
  async apply(ctx, i, plan) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();   // one join at a time per program
    const planned = (plan.details as { status: string; position?: number });
    const nowFull = (await bookedCount(ctx.trx, i.program_id)) >= p.capacity;
    if ((planned.status === "booked") === nowFull) throw new KumiError("error.changed");   // the last place went meanwhile, or one opened up
    const id = uuidv7();
    await ctx.insert("enrolment", { id, program_id: i.program_id, person_id: i.person_id, status: planned.status, waitlist_position: planned.position ?? null, price_cents: p.price_cents });
    await ctx.emit(planned.status === "booked" ? "enrolment.booked" : "enrolment.waitlisted", { enrolment_id: id });
    const pay = planned.status === "booked" ? await requestPayment(ctx, id, i.person_id, p.price_cents, p.name) : null;
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
  return { e, p, person, refund, read, offer: await offerText(ctx.db, e.program_id, e.status === "booked") };
}

async function freePlace(ctx: Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0], programId: string) {
  const next = await nextWaitlisted(ctx.trx, programId);
  if (!next) return null;
  const offerId = uuidv7();
  await ctx.insert("waitlist_offer", { id: offerId, enrolment_id: next.id, offered_at: ctx.now, expires_at: new Date(ctx.now.getTime() + OFFER_HOURS * 3600_000) });
  await ctx.emit("waitlist.offered", { enrolment_id: next.id, offer_id: offerId });
  return offerId;
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
    if (e.status === "booked") await freePlace(ctx, e.program_id);
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
    const offer = e.status === "booked" ? await freePlace(ctx, e.program_id) : null;
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
      const pay = await requestPayment(ctx, newId, i.to_person_id, p.price_cents, sub.name);
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
    if ((await bookedCount(ctx.db, i.program_id)) >= p.capacity) throw new KumiError("error.program_full");
    return { title: both("action.enrolment.comp"), summary: both("plan.enrolment.comp", { person, name: p.name }), reads: [read], locationId: p.location_id, undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();
    if ((await bookedCount(ctx.trx, i.program_id)) >= p.capacity) throw new KumiError("error.changed");
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
    return (await requestPayment(ctx, i.enrolment_id, e.person_id, e.price_cents, e.name)) ?? null;
  },
});

// ---- Money for rosters ----
type ApplyContext = Parameters<NonNullable<Parameters<typeof defineAction>[0]["apply"]>>[0];

/** What was actually paid for a place: payments that went through, less refunds on their way or sent. */
export async function paidFor(db: Db | Trx, enrolmentId: string): Promise<number> {
  const paid = await db.selectFrom("payment").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", enrolmentId).where("status", "=", "succeeded").executeTakeFirst();
  const back = await db.selectFrom("refund").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", enrolmentId).where("status", "in", ["pending", "sent", "waiting_for_sub"]).executeTakeFirst();
  return Number(paid?.c ?? 0) - Number(back?.c ?? 0);
}

/** Ask the provider for a payment. Nothing is charged until it confirms (payment.settle). */
async function requestPayment(ctx: ApplyContext, enrolmentId: string, personId: string, cents: number, what: string) {
  if (cents <= 0) return null;
  const pv = paymentProvider();
  const intent = await pv.createIntent({ amountCents: cents, description: what, idempotencyKey: enrolmentId });
  const id = uuidv7();
  await ctx.insert("payment", { id, person_id: personId, amount_cents: cents, method: "card", provider: pv.name, provider_ref: intent.ref, status: "pending", enrolment_id: enrolmentId });
  return { payment_id: id, client_secret: intent.clientSecret };
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

export const paymentSettle = defineAction({
  name: "payment.settle", version: 1, system: true, internal: true,
  input: z.object({ payment_id: z.uuid(), outcome: z.enum(["succeeded", "failed"]) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "payment", i.payment_id);
    return { title: both("action.payment.settle"), summary: both(i.outcome === "succeeded" ? "plan.payment.succeeded" : "plan.payment.failed", { person: await personName(ctx.db, row.person_id), amount: usd(row.amount_cents) }), reads: [read], undo: { kind: "none", note: both("reason.refund_sent") } };
  },
  async apply(ctx, i) {
    const pay = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", i.payment_id).executeTakeFirstOrThrow();
    if (pay.status !== "pending") return { already: pay.status };   // a repeated webhook does nothing
    await ctx.update("payment", pay.id, { status: i.outcome });
    if (i.outcome === "failed") { await ctx.emit("payment.failed", { payment_id: pay.id }); return { status: "failed" }; }
    await post(ctx.trx, ctx.runId, "payment", "program payment", [
      { account: await account(ctx.trx, "provider_clearing"), cents: pay.amount_cents },
      { account: await account(ctx.trx, "revenue", { revenueType: "programs" }), cents: -pay.amount_cents },
    ]);
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
    await post(ctx.trx, ctx.runId, "refund", "refund to card", [
      { account: await account(ctx.trx, "revenue", { revenueType: "programs" }), cents: r.amount_cents },
      { account: await account(ctx.trx, "provider_clearing"), cents: -r.amount_cents },
    ]);
    return { status: "sent" };
  },
});
