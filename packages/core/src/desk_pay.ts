// Money taken at the desk (cash, the club's own card reader, or another way) for a court booking, a membership or
// a program place, and what goes back of it. Kumi keeps no credit or wallet, so the desk records at most what's
// owed. Money paid at the desk goes back at the desk, never to a card: a refund of it waits as "to give back at
// the desk" until someone there hands it over (refund.give_back), and only then leaves the cash drawer in the books.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, money, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate, localParts } from "./clock.ts";
import { account, post } from "./money.ts";
import { paymentWhat } from "./kids.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
export const DESK_METHODS = ["cash", "terminal", "other"] as const;
export type DeskMethod = (typeof DESK_METHODS)[number];
/** What every "paid at the desk" action takes, beside what it's for. */
export const deskPaid = {
  cents: z.number().check(z.int(), z.minimum(1)), method: z.enum(DESK_METHODS), note: z.optional(z.string().check(z.maxLength(200))),
};
/** "in cash", "on the club's card reader", "another way". */
export const paidHow = (method: string): Text => both(`paid_by.${method}` as Key);

/** Where money paid at the desk sits in the books: the cash drawer, or (the club's card reader, another way) clearing. */
const deskAccount = (trx: Trx, method: string) => account(trx, method === "cash" ? "cash_drawer" : "provider_clearing");

/** Which revenue a payment is: courts, lessons, memberships or programs. */
export async function revenueType(db: Db | Trx, p: { booking_player_id: string | null; membership_plan_id: string | null; membership_id: string | null }) {
  if (p.booking_player_id) return await bookingRevenue(db, p.booking_player_id);
  return p.membership_plan_id || p.membership_id ? "memberships" as const : "programs" as const;
}
/** A booking's revenue: a lesson's apart from courts, so the club sees what its coaching brings in. */
export async function bookingRevenue(db: Db | Trx, bookingPlayerId: string): Promise<"courts" | "lessons"> {
  const b = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").select("booking.kind").where("booking_player.id", "=", bookingPlayerId).executeTakeFirst();
  return b?.kind === "lesson" ? "lessons" : "courts";
}

/** Money paid at the desk: a payment that went through with no provider, into the cash drawer (or clearing) and
 *  out of what it's revenue for. Whoever records it has checked it's no more than is owed, under a lock. */
export async function recordAtDesk(ctx: ApplyCtx, o: { personId: string; cents: number; method: DeskMethod; note?: string; revenue: string; memo: string;
  link: { booking_player_id: string } | { membership_id: string } | { enrolment_id: string } }): Promise<string> {
  const id = uuidv7();
  await ctx.insert("payment", { id, person_id: o.personId, amount_cents: o.cents, method: o.method, provider: "none", provider_ref: null, status: "succeeded", ...o.link });
  await post(ctx.trx, ctx.runId, "payment", `${o.memo} paid at the desk (${o.method})${o.note ? `: ${o.note}` : ""}`, [
    { account: await deskAccount(ctx.trx, o.method), cents: o.cents },
    { account: await account(ctx.trx, "revenue", { revenueType: o.revenue }), cents: -o.cents }]);
  return id;
}

/** Give `cents` of one payment back: to the card it came from (the outbox sends it once this change is saved), or,
 *  paid at the desk, waiting at the desk for someone there to hand it over. `waiting_for_sub`: a place passed to a
 *  sub, given back once they pay. `enrolmentId` for a program place's. */
export async function refundTo(ctx: ApplyCtx, paymentId: string, cents: number, o: { enrolmentId?: string | null; status?: "pending" | "waiting_for_sub" } = {}) {
  if (cents <= 0) return null;
  const pay = await ctx.trx.selectFrom("payment").select("provider").where("id", "=", paymentId).executeTakeFirstOrThrow();
  const id = uuidv7(), desk = pay.provider === "none", status = o.status ?? "pending";
  await ctx.insert("refund", { id, payment_id: paymentId, enrolment_id: o.enrolmentId ?? null, amount_cents: cents, destination: desk ? "desk" : "card", status });
  if (!desk && status === "pending") await ctx.emit("refund.requested", { refund_id: id });
  return { id, desk };
}
/** A refund that was waiting for a sub to pay is due now: a card's goes to the provider, the desk's waits there. */
export async function refundDue(ctx: ApplyCtx, refundId: string) {
  const r = await ctx.trx.selectFrom("refund").select("destination").where("id", "=", refundId).executeTakeFirstOrThrow();
  await ctx.update("refund", refundId, { status: "pending" });
  if (r.destination === "card") await ctx.emit("refund.requested", { refund_id: refundId });
}

/** Spread `cents` back over payments, a card's first (it goes back by itself), then what was paid at the desk;
 *  never more back from one than is left of it. What went where. */
export async function refundAcross(ctx: ApplyCtx, pays: { id: string; left: number; desk: boolean }[], cents: number, o: { enrolmentId?: string | null; status?: "pending" | "waiting_for_sub" } = {}) {
  let rest = cents;
  const out = { card: 0, desk: 0 };
  for (const p of [...pays.filter((x) => !x.desk), ...pays.filter((x) => x.desk)]) {
    const c = Math.min(rest, p.left);
    if (c <= 0) continue;
    await refundTo(ctx, p.id, c, o);
    out[p.desk ? "desk" : "card"] += c;
    rest -= c;
  }
  return out;
}

/** What's waiting at the desk to be given back to someone (or to anyone, without a person). */
export async function toGiveBack(db: Db | Trx, personId?: string) {
  return db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("person", "person.id", "payment.person_id")
    .select(["refund.id", "refund.amount_cents", "refund.created_at", "payment.method", "payment.person_id", "person.display_name"])
    .where("refund.destination", "=", "desk").where("refund.status", "=", "pending").$if(Boolean(personId), (q) => q.where("payment.person_id", "=", personId!))
    .orderBy("refund.created_at").execute();
}

/** Someone at the desk hands back what was waiting there for a person: the refund is sent, and the money leaves the
 *  cash drawer (or clearing) in the books. Its receipt follows, as for a card's. */
export const refundGiveBack = defineAction({
  name: "refund.give_back", version: 1,
  input: z.object({ refund_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: r, read } = await readRow(ctx.db, "refund", i.refund_id);
    if (r.destination !== "desk" || r.status !== "pending") throw new KumiError("error.not_to_give_back");
    const pay = await ctx.db.selectFrom("payment").innerJoin("person", "person.id", "payment.person_id")
      .select(["payment.person_id", "payment.method", "payment.booking_player_id", "payment.enrolment_id", "payment.membership_id", "payment.membership_plan_id", "person.display_name"])
      .where("payment.id", "=", r.payment_id).executeTakeFirstOrThrow();
    return { title: both("action.refund.give_back"), summary: both("plan.refund.give_back", { amount: usd(r.amount_cents), name: pay.display_name, how: paidHow(pay.method), what: await paymentWhat(ctx.db, pay) }),
      reads: [read], ownerIds: [pay.person_id], moneyCents: r.amount_cents, undo: { kind: "none", note: both("undo.none", { reason: both("reason.refund_sent") }) } };
  },
  async apply(ctx, i) {
    const r = await ctx.trx.selectFrom("refund").selectAll().where("id", "=", i.refund_id).forUpdate().executeTakeFirstOrThrow();
    if (r.destination !== "desk" || r.status !== "pending") throw new KumiError("error.changed");   // handed over at another desk meanwhile
    const pay = await ctx.trx.selectFrom("payment").select(["method", "booking_player_id", "membership_id", "membership_plan_id"]).where("id", "=", r.payment_id).executeTakeFirstOrThrow();
    await ctx.update("refund", r.id, { status: "sent" });
    await post(ctx.trx, ctx.runId, "refund", `given back at the desk (${pay.method})`, [
      { account: await account(ctx.trx, "revenue", { revenueType: await revenueType(ctx.trx, pay) }), cents: r.amount_cents },
      { account: await deskAccount(ctx.trx, pay.method), cents: -r.amount_cents }]);
    return null;
  },
});

// ---- The desk's day (Reports): what was paid at the desk and what was handed back there, on the club's clock ----
/** One line of the desk's day: money taken at the desk, or handed back there, with when, how and who did it. */
export type DeskLine = { at: Date; date: string; time: string; kind: "in" | "back"; method: DeskMethod; cents: number; person_id: string; person: string; what: Text; by: string | null };
/** One day's totals: what came in at the desk by how it was paid, what was given back there, and the drawer (the
 *  cash taken, less the cash given back). */
export type DeskDay = { date: string; in: Record<DeskMethod, number>; back: Record<DeskMethod, number>; drawer: number };

const asMethod = (m: string): DeskMethod => (DESK_METHODS as readonly string[]).includes(m) ? m as DeskMethod : "other";
const byMethod = (): Record<DeskMethod, number> => ({ cash: 0, terminal: 0, other: 0 });

/** Every line of the desk's days from `from` to `to` (the club's dates, both included), oldest first. A line is when
 *  the change was made (a payment recorded, a refund handed over) and by whom. `what` (what it was for) costs a read
 *  a line, so the day totals leave it out. */
export async function deskLines(db: Db | Trx, from: string, to: string, o: { what?: boolean } = {}): Promise<DeskLine[]> {
  const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
  const onDays = sql<boolean>`(action_run.applied_at AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date`;
  const cols = ["payment.person_id", "person.display_name as person", "by.display_name as by", "action_run.applied_at as at", "payment.method",
    "payment.booking_player_id", "payment.enrolment_id", "payment.membership_id", "payment.membership_plan_id"] as const;
  // Paid at the desk: the change that recorded each payment.
  const ins = await db.selectFrom("payment")
    .innerJoin("entity_change", (j) => j.on(sql<boolean>`entity_change.entity = 'payment' AND entity_change.op = 'insert' AND entity_change.entity_id = payment.id::text`))
    .innerJoin("action_run", "action_run.id", "entity_change.action_run_id").innerJoin("person", "person.id", "payment.person_id").leftJoin("person as by", "by.id", "action_run.actor_person_id")
    .select([...cols, "payment.amount_cents as cents"]).where("payment.provider", "=", "none").where("payment.status", "=", "succeeded").where(onDays).execute();
  // Handed back at the desk: the change that marked each refund given back.
  const backs = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id")
    .innerJoin("entity_change", (j) => j.on(sql<boolean>`entity_change.entity = 'refund' AND entity_change.op = 'update' AND entity_change.entity_id = refund.id::text AND entity_change.after->>'status' = 'sent'`))
    .innerJoin("action_run", "action_run.id", "entity_change.action_run_id").innerJoin("person", "person.id", "payment.person_id").leftJoin("person as by", "by.id", "action_run.actor_person_id")
    .select([...cols, "refund.amount_cents as cents"]).where("refund.destination", "=", "desk").where("refund.status", "=", "sent").where("action_run.action", "=", "refund.give_back").where(onDays).execute();
  const lines: DeskLine[] = [];
  for (const [kind, rows] of [["in", ins], ["back", backs]] as const) for (const r of rows) {
    const at = r.at!, p = localParts(at, tz);
    lines.push({ at, date: localDate(at, tz), time: `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`, kind, method: asMethod(r.method), cents: r.cents,
      person_id: r.person_id, person: r.person, by: r.by, what: o.what ? await paymentWhat(db, r) : { en: "", es: "" } });
  }
  return lines.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The desk's totals for each day from `from` to `to` that had any money taken or given back there, oldest first. */
export async function deskDays(db: Db | Trx, from: string, to: string): Promise<DeskDay[]> {
  const days = new Map<string, DeskDay>();
  for (const l of await deskLines(db, from, to)) {
    const d = days.get(l.date) ?? { date: l.date, in: byMethod(), back: byMethod(), drawer: 0 };
    d[l.kind][l.method] += l.cents;
    if (l.method === "cash") d.drawer += l.kind === "in" ? l.cents : -l.cents;
    days.set(l.date, d);
  }
  return [...days.values()];
}
