// Linked kid accounts. A junior of 13 or more can have a login of their own, turned on by a parent. They
// book and join open matches, courts, programs and lessons like any member, and what they owe goes on the
// family card at once (a card a parent saved; the kid never sees a card form). The parents set the rules:
// each kind on or off, and a monthly limit. Anything switched off, or over the limit, becomes a request the
// parents say yes or no to; nothing is held while it waits, and a yes plans the kid's action afresh, so a
// court taken meanwhile is said rather than booked. A card that's declined or wants its owner to confirm
// means a parent pays in the app instead.
//
// The kid stays a junior: off the public page, level lists and leaderboards, and without friends unless a
// parent turns them on (then nobody can add them, and they can't take a place from someone's link).
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, money, pickLang, type Key, type Text } from "@kumi/i18n";
import { apply as applyRun, defineAction, dryPlan, plan as planRun, readRow, run, runAsSystem, setPlanGate, type Actor } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { textOf } from "./club_text.ts";
import { uuidv7 } from "./ids.ts";
import { atLocal, localParts } from "./clock.ts";
import { paymentProvider } from "./money.ts";
import { ADULT_AGE, householdOf, managersOf } from "./households.ts";
import { openMatchOf } from "./match_rules.ts";
import { fullCost } from "./assistant_spend.ts";
import { refuseWhenReadOnly } from "./read_only.ts";

/** A junior can have a login of their own from the year they turn this. */
export const KID_AGE = 13;
/** The monthly limit a kid starts with. */
export const KID_LIMIT_CENTS = 10_000;
export const KID_KINDS = ["open_matches", "courts", "programs", "lessons"] as const;
export type KidKind = typeof KID_KINDS[number];

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const when = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });
const join = (parts: Text[], sep = "; "): Text => ({ en: parts.map((p) => p.en).join(sep), es: parts.map((p) => p.es).join(sep) });
const clubTz = async (db: Db | Trx) => (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;

/** A kid's rules, if the person is a junior with a login of their own; null for anyone else. */
export async function kidOf(db: Db | Trx, personId: string | null | undefined) {
  if (!personId) return null;
  const p = await db.selectFrom("person").leftJoin("kid_rule", "kid_rule.person_id", "person.id")
    .select(["person.id", "person.display_name", "person.junior", "person.own_login", "person.birth_year", "kid_rule.open_matches", "kid_rule.courts", "kid_rule.programs", "kid_rule.lessons",
      "kid_rule.monthly_limit_cents", "kid_rule.friends", "kid_rule.texts", "kid_rule.version"]).where("person.id", "=", personId).executeTakeFirst();
  if (!p?.junior || !p.own_login) return null;
  return { id: p.id, display_name: p.display_name, birth_year: p.birth_year, open_matches: p.open_matches ?? true, courts: p.courts ?? true, programs: p.programs ?? true,
    lessons: p.lessons ?? true, monthly_limit_cents: p.monthly_limit_cents ?? KID_LIMIT_CENTS, friends: p.friends ?? false, texts: p.texts ?? false };
}
export type Kid = NonNullable<Awaited<ReturnType<typeof kidOf>>>;

/** Whether this person may have friends: anyone but a junior, and a kid whose parents turned it on. */
export async function friendsAllowed(db: Db | Trx, personId: string): Promise<boolean> {
  const p = await db.selectFrom("person").leftJoin("kid_rule", "kid_rule.person_id", "person.id").select(["person.junior", "person.own_login", "kid_rule.friends"]).where("person.id", "=", personId).executeTakeFirst();
  return Boolean(p) && (!p!.junior || Boolean(p!.own_login && p!.friends));
}
/** The same, as a condition on a query joined to `person`. */
export const friendsAllowedSql = sql<boolean>`(person.junior = false OR (person.own_login AND EXISTS (SELECT 1 FROM kid_rule WHERE kid_rule.person_id = person.id AND kid_rule.friends)))`;

/** Which of the kid's kinds an action is, or null for one the rules don't cover. */
async function kindOf(db: Db | Trx, name: string, input: any): Promise<KidKind | null> {
  switch (name) {
    case "booking.request": return input?.open ? "open_matches" : "courts";
    case "booking.request_courts": return "courts";
    case "booking.ask": case "booking.take_place": return "open_matches";
    case "booking.join": {
      const b = await db.selectFrom("booking").select("id").$if(Boolean(input?.invite_code), (q) => q.where("invite_code", "=", String(input.invite_code)))
        .$if(!input?.invite_code, (q) => q.where("id", "=", String(input?.booking_id ?? "00000000-0000-0000-0000-000000000000"))).executeTakeFirst();
      return b && await openMatchOf(db, b.id) ? "open_matches" : "courts";
    }
    case "lesson.request": return "lessons";
    case "enrolment.join": case "enrolment.join_dates": case "enrolment.accept_offer": return "programs";
  }
  return null;
}
/** Memberships are the parents' to look after. */
const PARENTS_ONLY = new Set(["membership.join", "membership.cancel", "membership.resume", "membership.add_person", "membership.remove_person"]);

/** What the kid has spent this month (the club's month, by when each payment was asked for): payments
 *  made, and ones on their way to the family card, less what's been refunded. A payment a parent was asked
 *  to pay counts once paid. */
export async function monthSpent(db: Db | Trx, kidId: string, now: Date, except: string[] = []): Promise<number> {
  const tz = await clubTz(db), lp = localParts(now, tz), from = atLocal(lp.y, lp.m, 1, 0, tz);
  // When the change that asked for it happened (its own clock), not the database's.
  const askedAt = sql<Date>`(SELECT coalesce(ar.applied_at, ar.created_at) FROM entity_change ec JOIN action_run ar ON ar.id = ec.action_run_id
    WHERE ec.entity = 'payment' AND ec.entity_id = payment.id::text AND ec.op = 'insert' LIMIT 1)`;
  const paid = await db.selectFrom("payment").select(sql<string>`coalesce(sum(amount_cents), 0)`.as("c")).where("person_id", "=", kidId).where(askedAt, ">=", from)
    .$if(except.length > 0, (q) => q.where("id", "not in", except))
    .where((eb) => eb.or([eb("status", "=", "succeeded"), eb.and([eb("status", "=", "pending"), eb("provider_ref", "is", null), eb("parent_to_pay_at", "is", null)])])).executeTakeFirstOrThrow();
  const back = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").select(sql<string>`coalesce(sum(refund.amount_cents), 0)`.as("c"))
    .where("payment.person_id", "=", kidId).where(askedAt, ">=", from).where("refund.status", "in", ["pending", "sent"]).executeTakeFirstOrThrow();
  return Number(paid.c) - Number(back.c);
}

/** Whether the kid's rules let this through on their own: null if so, else why not. */
export async function overRules(db: Db | Trx, kid: Kid, kind: KidKind, cents: number, now: Date, except: string[] = []): Promise<{ reason: "off" | "limit"; spent: number } | null> {
  if (!kid[kind]) return { reason: "off", spent: 0 };
  if (cents <= 0) return null;
  const spent = await monthSpent(db, kid.id, now, except);
  return spent + cents > kid.monthly_limit_cents ? { reason: "limit", spent } : null;
}

// A kid's action the rules don't allow becomes a request to the parents, planned instead of it.
setPlanGate(async (db, name, input, actor, p, now) => {
  if (!actor.personId || name.startsWith("kid.")) return null;
  const kid = await kidOf(db, actor.personId);
  if (!kid) return null;
  if (PARENTS_ONLY.has(name)) throw new KumiError("error.kid_parents_only");
  const kind = await kindOf(db, name, input);
  // A shared court counts in full: what the others don't pay goes on the family card at the deadline.
  if (!kind || !(await overRules(db, kid, kind, fullCost(name, input, p), now))) return null;
  return { name: "kid.ask_parent", input: { action: name, input } };
});

/** What a payment was for, in a few words: "Court 2, Sat, Oct 31, 9:00 AM", "a lesson with Kai Moreno, ...". */
export async function paymentWhat(db: Db | Trx, pay: { person_id: string; booking_player_id: string | null; enrolment_id: string | null }): Promise<Text> {
  if (pay.booking_player_id) {
    const b = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").innerJoin("court_time", "court_time.booking_id", "booking.id")
      .innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id").leftJoin("person as coach", "coach.id", "booking.coach_id")
      .select(["booking.kind", "booking.organiser_id", "court.name as court", "location.time_zone", "coach.display_name as coach", sql<Date>`lower(court_time.during)`.as("start")])
      .where("booking_player.id", "=", pay.booking_player_id).orderBy(sql`court_time.active`, "desc").executeTakeFirst();
    if (!b) return both("kid.what_other");
    const p = { court: b.court, when: when(new Date(b.start), b.time_zone), coach: b.coach ?? "" };
    return both(b.kind === "lesson" ? "kid.what_lesson" : b.organiser_id === pay.person_id ? "kid.what_court" : "kid.what_place", p);
  }
  if (pay.enrolment_id) {
    const e = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id").select(["program.name", "program.translations", "program.id", "enrolment.session_id"]).where("enrolment.id", "=", pay.enrolment_id).executeTakeFirst();
    if (!e) return both("kid.what_other");
    const s = await db.selectFrom("session").select((eb) => eb.fn.min("starts_at").as("s")).where("program_id", "=", e.id).where("status", "!=", "cancelled")
      .$if(Boolean(e.session_id), (q) => q.where("id", "=", e.session_id!)).executeTakeFirst();
    const name = textOf(e.name, e.translations, "name");
    return s?.s ? both("kid.what_program", { name, when: when(new Date(s.s as Date), await clubTz(db)) }) : both("kid.what_program_only", { name });
  }
  return both("kid.what_other");
}
/** The same for a payment and the others paid with it (several courts at once). */
export async function paymentsWhat(db: Db | Trx, rows: { person_id: string; booking_player_id: string | null; enrolment_id: string | null }[]): Promise<Text> {
  return join(await Promise.all(rows.map((r) => paymentWhat(db, r))));
}

// ---- The family card ----
/** The card in use for a person's household (a kid's, or a parent's own), if one is saved. */
export async function familyCardFor(db: Db | Trx, personId: string) {
  const hh = await householdOf(db, personId);
  if (!hh) return null;
  return (await db.selectFrom("family_card").innerJoin("person", "person.id", "family_card.saved_by").selectAll("family_card").select("person.display_name as saved_by_name")
    .where("family_card.household_id", "=", hh.household_id).where("family_card.status", "=", "saved").executeTakeFirst()) ?? null;
}

async function parentHousehold(db: Db | Trx, personId: string) {
  const hh = await householdOf(db, personId);
  if (!hh || hh.role !== "adult") throw new KumiError("error.household_not_parent");
  return hh;
}
async function adultsOf(db: Db | Trx, householdId: string): Promise<string[]> {
  return (await db.selectFrom("household_member").select("person_id").where("household_id", "=", householdId).where("role", "=", "adult").where("removed_at", "is", null).execute()).map((r) => r.person_id);
}

export const familyCardStart = defineAction({
  name: "family_card.start", version: 1, internal: true,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    await parentHousehold(ctx.db, i.person_id);
    return { title: both("action.family_card.start"), summary: both("plan.family_card.start"), reads: [], ownerIds: [i.person_id], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const hh = await parentHousehold(ctx.trx, i.person_id), id = uuidv7();
    await ctx.insert("family_card", { id, household_id: hh.household_id, saved_by: i.person_id, provider: paymentProvider().name });
    return { card_id: id };
  },
});

export const familyCardOpen = defineAction({
  name: "family_card.open", version: 1, system: true, internal: true,
  input: z.object({ card_id: z.uuid(), provider_ref: z.string().check(z.minLength(1)), saved_customer: z.string(), provider_account: z.optional(z.string()) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "family_card", i.card_id, "thing.family_card");
    return { title: both("action.family_card.open"), summary: both("action.family_card.open"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const c = await ctx.trx.selectFrom("family_card").select(["provider_ref", "status"]).where("id", "=", i.card_id).forUpdate().executeTakeFirstOrThrow();
    if (c.provider_ref === i.provider_ref) return { already: true };
    if (c.provider_ref || c.status !== "pending") throw new KumiError("error.changed");
    await ctx.update("family_card", i.card_id, { provider_ref: i.provider_ref, saved_customer: i.saved_customer, provider_account: i.provider_account ?? null });
    return null;
  },
});

export const familyCardSaved = defineAction({
  name: "family_card.saved", version: 1, system: true, internal: true,
  input: z.object({ card_id: z.uuid(), saved_method: z.string(), saved_customer: z.optional(z.string()) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "family_card", i.card_id, "thing.family_card");
    return { title: both("action.family_card.saved"), summary: both("action.family_card.saved"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const c = await ctx.trx.selectFrom("family_card").selectAll().where("id", "=", i.card_id).forUpdate().executeTakeFirstOrThrow();
    if (c.status !== "pending") return { already: c.status };
    // A new card replaces the one in use.
    for (const old of await ctx.trx.selectFrom("family_card").select("id").where("household_id", "=", c.household_id).where("status", "=", "saved").forUpdate().execute())
      await ctx.update("family_card", old.id, { status: "removed", removed_at: ctx.now });
    await ctx.update("family_card", c.id, { status: "saved", saved_method: i.saved_method, saved_at: ctx.now, ...(i.saved_customer ? { saved_customer: i.saved_customer } : {}) });
    return null;
  },
});

export const familyCardRemove = defineAction({
  name: "family_card.remove", version: 1,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const hh = await parentHousehold(ctx.db, i.person_id), card = await familyCardFor(ctx.db, i.person_id);
    if (!card) throw new KumiError("error.no_family_card");
    return { title: both("action.family_card.remove"), summary: both("plan.family_card.remove"), reads: [{ entity: "family_card", id: card.id, version: card.version }],
      ownerIds: await adultsOf(ctx.db, hh.household_id), undo: { kind: "none" }, details: { card_id: card.id } };
  },
  async apply(ctx, _i, plan) {
    await ctx.update("family_card", (plan.details as { card_id: string }).card_id, { status: "removed", removed_at: ctx.now });
    return null;
  },
});

/** The card form for a parent saving the family card: the provider's card setup, opened once and reused. */
export async function openFamilyCardSetup(db: Db, parent: Actor): Promise<{ cardId: string; clientSecret: string; provider: "test" | "stripe"; account: string | null }> {
  await refuseWhenReadOnly(db);
  const hh = await parentHousehold(db, parent.personId!), pv = paymentProvider();
  const open = await db.selectFrom("family_card").selectAll().where("household_id", "=", hh.household_id).where("saved_by", "=", parent.personId!).where("status", "=", "pending")
    .where("provider", "=", pv.name).orderBy("created_at", "desc").executeTakeFirst();
  if (open?.provider_ref) return { cardId: open.id, clientSecret: (await pv.getSetup(open.provider_ref, open.provider_account)).clientSecret, provider: pv.name, account: open.provider_account };
  const cardId = open?.id ?? ((await run(db, "family_card.start", { person_id: parent.personId }, parent, { internal: true })).result as { card_id: string }).card_id;
  const person = await db.selectFrom("person").select(["email", "display_name"]).where("id", "=", parent.personId!).executeTakeFirstOrThrow();
  const customer = await pv.ensureCustomer({ key: parent.personId!, email: person.email, name: person.display_name });
  const it = await pv.createSetup({ customer: customer.id, idempotencyKey: `family:${cardId}`, metadata: { kumi_family_card_id: cardId } });
  await runAsSystem(db, "family_card.open", { card_id: cardId, provider_ref: it.ref, saved_customer: customer.id, ...(it.account ? { provider_account: it.account } : {}) }, "payments");
  return { cardId, clientSecret: it.clientSecret, provider: pv.name, account: it.account };
}

/** Ask the provider whether the family card was saved, and record it once it is. Safe to call any number of times. */
export async function checkFamilyCard(db: Db, cardId: string, via = "payments", now?: Date): Promise<"pending" | "succeeded" | "failed" | null> {
  const c = await db.selectFrom("family_card").select(["id", "status", "provider_ref", "provider_account"]).where("id", "=", cardId).executeTakeFirst();
  if (!c) return null;
  if (c.status === "saved") return "succeeded";
  if (c.status !== "pending" || !c.provider_ref) return c.status === "removed" ? "failed" : "pending";
  const st = await paymentProvider().getSetup(c.provider_ref, c.provider_account);
  if (st.status === "succeeded" && st.paymentMethod)
    await runAsSystem(db, "family_card.saved", { card_id: c.id, saved_method: st.paymentMethod, ...(st.customer ? { saved_customer: st.customer } : {}) }, via, now ? { now } : {});
  return st.status;
}

/** The job: card setups opened in the last two days and not recorded here (a missed webhook). */
export async function tidyFamilyCards(db: Db, now = new Date()) {
  const rows = await db.selectFrom("family_card").select("id").where("status", "=", "pending").where("provider_ref", "is not", null).where("provider", "=", paymentProvider().name)
    .where("created_at", ">", new Date(now.getTime() - 2 * 864e5)).execute();
  let saved = 0;
  for (const r of rows) {
    try { if ((await checkFamilyCard(db, r.id, "job:family_cards", now)) === "succeeded") saved++; }
    catch (e) { console.error(`family card ${r.id}:`, (e as Error).message); }   // tried again next minute
  }
  return { saved };
}

// ---- Paying on the family card ----
/** What a kid's payment is, for the rules: a court, a place in a match, a lesson or a program. */
async function paymentKind(db: Db | Trx, pay: { booking_player_id: string | null; enrolment_id: string | null }): Promise<KidKind | null> {
  if (pay.enrolment_id) return "programs";
  if (!pay.booking_player_id) return null;
  const b = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").select(["booking.id", "booking.kind"]).where("booking_player.id", "=", pay.booking_player_id).executeTakeFirstOrThrow();
  if (b.kind === "lesson") return "lessons";
  return await openMatchOf(db, b.id) ? "open_matches" : "courts";
}

export type FamilyPay = { status: "paid" | "parent"; cents: number; why?: "no_card" | "declined" | "off" | "limit" };

/** Charge a kid's pending payment (and any paid with it) to the family card, off-session. Without a card,
 *  over the rules, or with a card that doesn't go through, a parent is asked to pay it in the app instead.
 *  `approved`: a parent said yes to it, so the rules don't stop it again. Null for anyone but a kid. */
export async function payWithFamilyCard(db: Db, paymentId: string, now = new Date(), o: { approved?: boolean } = {}): Promise<FamilyPay | null> {
  const pay = await db.selectFrom("payment").selectAll().where("id", "=", paymentId).executeTakeFirst();
  if (!pay || pay.status !== "pending" || pay.provider_ref) return null;
  await refuseWhenReadOnly(db);
  const kid = await kidOf(db, pay.person_id);
  if (!kid) return null;
  const group = pay.group_id ? await db.selectFrom("payment").selectAll().where("group_id", "=", pay.group_id).execute() : [pay];
  if (group.some((g) => g.status !== "pending" || g.provider_ref)) return null;
  const cents = group.reduce((n, g) => n + g.amount_cents, 0), card = await familyCardFor(db, kid.id);
  let why: FamilyPay["why"] | null = card?.saved_customer && card.saved_method ? null : "no_card", failure: string | null = null;
  if (!why && !o.approved) {
    const kind = await paymentKind(db, pay);
    why = kind ? (await overRules(db, kid, kind, cents, now, group.map((g) => g.id)))?.reason ?? null : "off";
  }
  if (!why) {
    const pv = paymentProvider(), { currency } = await db.selectFrom("club").select("currency").executeTakeFirstOrThrow();
    const what = await paymentsWhat(db, group);
    // One key per attempt: the same answer if this one is retried, a fresh one after a recorded decline.
    const c = await pv.chargeSaved({ customer: card!.saved_customer!, paymentMethod: card!.saved_method!, amountCents: cents, currency, description: `${kid.display_name}: ${what.en}`.slice(0, 200),
      idempotencyKey: `family:${pay.group_id ?? pay.id}:${card!.id}:${pay.family_declines}`, account: card!.provider_account });
    if (c.status === "succeeded") {
      await runAsSystem(db, "payment.open", { payment_id: pay.id, provider: pv.name, provider_ref: c.ref, family_card_id: card!.id, ...(card!.provider_account ? { provider_account: card!.provider_account } : {}) }, "family_card", { now });
      await runAsSystem(db, "payment.settle", { payment_id: pay.id, outcome: "succeeded", saved_customer: card!.saved_customer!, saved_method: card!.saved_method! }, "family_card", { now });
      return { status: "paid", cents };
    }
    // One that wants its owner to confirm is called off: a parent pays with the card form instead.
    if (c.ref && c.status === "pending") await pv.cancelIntent(c.ref, card!.provider_account).catch(() => {});
    why = "declined"; failure = c.failure ?? null;
  }
  await runAsSystem(db, "payment.parent_to_pay", { payment_id: pay.id, why: why!, ...(failure ? { failure } : {}) }, "family_card", { now });
  return { status: "parent", cents, why: why! };
}

export const paymentParentToPay = defineAction({
  name: "payment.parent_to_pay", version: 1, system: true, internal: true,
  input: z.object({ payment_id: z.uuid(), why: z.enum(["no_card", "declined", "off", "limit"]), failure: z.optional(z.string()) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "payment", i.payment_id, "thing.payment");
    return { title: both("action.payment.parent_to_pay"), summary: both("action.payment.parent_to_pay"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const pay = await ctx.trx.selectFrom("payment").selectAll().where("id", "=", i.payment_id).forUpdate().executeTakeFirstOrThrow();
    if (pay.status !== "pending") return { already: pay.status };
    const rows = pay.group_id ? await ctx.trx.selectFrom("payment").selectAll().where("group_id", "=", pay.group_id).forUpdate().execute() : [pay];
    for (const r of rows) await ctx.update("payment", r.id, { parent_to_pay_at: ctx.now, ...(i.why === "declined" ? { family_declines: r.family_declines + 1 } : {}) });
    // Worked out now: what it was for, how much, and who's asked.
    await ctx.emit("kid.pay_needed", { payment_id: pay.id, kid: pay.person_id, to: await managersOf(ctx.trx, pay.person_id), cents: rows.reduce((n, r) => n + r.amount_cents, 0),
      what: await paymentsWhat(ctx.trx, rows), why: i.why, failure: i.failure ?? null });
    return null;
  },
});

/** After a kid's action: whatever it left them owing goes on the family card now. Null when there's nothing
 *  (or the person isn't a kid). */
export async function payKidRun(db: Db, runId: string, personId: string | null, now = new Date(), o: { approved?: boolean } = {}): Promise<FamilyPay | null> {
  if (!(await kidOf(db, personId))) return null;
  const ids = (await db.selectFrom("entity_change").select("entity_id").where("action_run_id", "=", runId).where("entity", "=", "payment").where("op", "=", "insert").execute()).map((r) => r.entity_id);
  if (!ids.length) return null;
  const pays = await db.selectFrom("payment").select(["id", "group_id"]).where("id", "in", ids).where("person_id", "=", personId!).where("status", "=", "pending").where("provider_ref", "is", null).orderBy("id").execute();
  const seen = new Set<string>(), done: FamilyPay[] = [];
  for (const p of pays) {
    if (seen.has(p.group_id ?? p.id)) continue;
    seen.add(p.group_id ?? p.id);
    const r = await payWithFamilyCard(db, p.id, now, o);
    if (r) done.push(r);
  }
  if (!done.length) return null;
  const why = done.find((d) => d.why)?.why;
  return { status: done.some((d) => d.status === "parent") ? "parent" : "paid", cents: done.reduce((n, d) => n + d.cents, 0), ...(why ? { why } : {}) };
}

// ---- A login of their own, and the rules ----
const clubYear = async (db: Db | Trx, now: Date) => localParts(now, await clubTz(db)).y;
async function juniorRow(db: Db | Trx, personId: string) {
  const { row, read } = await readRow(db, "person", personId, "thing.person");
  if (!row.junior || row.status !== "active") throw new KumiError("error.not_a_junior", { name: row.display_name });
  return { row, read };
}
/** Only the parents managing a kid act for them (never the kid). */
async function parentsOf(db: Db | Trx, personId: string): Promise<string[]> {
  const m = await managersOf(db, personId);
  if (!m.length) throw new KumiError("error.not_a_junior", { name: "" });
  return m;
}
export const rulesText = (r: Record<KidKind, boolean> & { monthly_limit_cents: number; friends: boolean; texts?: boolean }): Text => {
  const on = KID_KINDS.filter((k) => r[k]).map((k) => both(`kid.kind.${k}` as Key)), off = KID_KINDS.filter((k) => !r[k]).map((k) => both(`kid.kind.${k}` as Key));
  const and = (xs: string[], word: string) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${word} ${xs[xs.length - 1]}`;
  const list = (xs: Text[]) => ({ en: and(xs.map((x) => x.en), "and"), es: and(xs.map((x) => x.es), "y") });
  return both(off.length ? "kid.rules_some" : "kid.rules_all", { on: on.length ? list(on) : both("kid.nothing"), off: list(off), limit: usd(r.monthly_limit_cents),
    friends: both(r.friends ? (r.texts ? "kid.friends_on_texts_on" : "kid.friends_on") : (r.texts ? "kid.friends_off_texts_on" : "kid.friends_off")) });
};

export const kidGiveLogin = defineAction({
  name: "kid.give_login", version: 1,
  input: z.object({ person_id: z.uuid(), email: z.email() }),
  async plan(ctx, i) {
    const { row, read } = await juniorRow(ctx.db, i.person_id);
    if (row.own_login) throw new KumiError("error.kid_has_login", { name: row.display_name });
    const age = row.birth_year ? (await clubYear(ctx.db, ctx.now)) - row.birth_year : 0;
    if (age < KID_AGE) throw new KumiError("error.kid_too_young", { name: row.display_name, year: (row.birth_year ?? 0) + KID_AGE });
    if (age >= ADULT_AGE) throw new KumiError("error.kid_now_adult", { name: row.display_name });
    const email = i.email.trim().toLowerCase();
    if (await ctx.db.selectFrom("person").select("id").where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).executeTakeFirst()
      || await ctx.db.selectFrom("auth_identity").select("id").where("kind", "=", "email").where((eb) => eb(eb.fn("lower", ["value"]), "=", email)).executeTakeFirst()) throw new KumiError("error.duplicate_email");
    const rules = await ctx.db.selectFrom("kid_rule").selectAll().where("person_id", "=", i.person_id).executeTakeFirst();
    return { title: both("action.kid.give_login"), summary: both("plan.kid.give_login", { name: row.display_name, email,
      rules: rulesText(rules ?? { open_matches: true, courts: true, programs: true, lessons: true, monthly_limit_cents: KID_LIMIT_CENTS, friends: false }) }),
      reads: [read], ownerIds: await parentsOf(ctx.db, i.person_id), undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const email = i.email.trim().toLowerCase();
    await ctx.update("person", i.person_id, { email, own_login: true });
    try { await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: i.person_id, kind: "email", value: email, verified_at: null }).execute(); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.duplicate_email"); throw e; }
    const member = await ctx.trx.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
    const had = await ctx.trx.selectFrom("person_role").select(["id", "active"]).where("person_id", "=", i.person_id).where("role_id", "=", member.id).executeTakeFirst();
    if (!had) await ctx.insert("person_role", { id: uuidv7(), person_id: i.person_id, role_id: member.id, location_id: null });
    else if (!had.active) await ctx.update("person_role", had.id, { active: true });
    // Rules from an earlier login stay as the parents left them.
    if (!(await ctx.trx.selectFrom("kid_rule").select("person_id").where("person_id", "=", i.person_id).executeTakeFirst()))
      await ctx.insert("kid_rule", { person_id: i.person_id, updated_by: ctx.actor.personId });
    await ctx.emit("kid.login_given", { person_id: i.person_id, by: ctx.actor.personId, email });
    return null;
  },
});

export const kidRemoveLogin = defineAction({
  name: "kid.remove_login", version: 1,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await juniorRow(ctx.db, i.person_id);
    if (!row.own_login) throw new KumiError("error.kid_no_login", { name: row.display_name });
    return { title: both("action.kid.remove_login"), summary: both("plan.kid.remove_login", { name: row.display_name }), reads: [read], ownerIds: await parentsOf(ctx.db, i.person_id), undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    await ctx.update("person", i.person_id, { email: null, phone: null, own_login: false });
    await ctx.trx.deleteFrom("auth_identity").where("person_id", "=", i.person_id).execute();
    await ctx.trx.updateTable("web_session").set({ revoked_at: ctx.now }).where("person_id", "=", i.person_id).where("revoked_at", "is", null).execute();
    for (const r of await ctx.trx.selectFrom("person_role").select("id").where("person_id", "=", i.person_id).where("active", "=", true).execute()) await ctx.update("person_role", r.id, { active: false });
    for (const r of await ctx.trx.selectFrom("kid_request").select("id").where("person_id", "=", i.person_id).where("status", "=", "asked").execute())
      await ctx.update("kid_request", r.id, { status: "withdrawn", decided_at: ctx.now });
    return null;
  },
});

const limitInput = z.number().check(z.int(), z.minimum(0), z.maximum(100_000));
export const kidSetRules = defineAction({
  name: "kid.set_rules", version: 1,
  input: z.object({ person_id: z.uuid(), open_matches: z.optional(z.boolean()), courts: z.optional(z.boolean()), programs: z.optional(z.boolean()), lessons: z.optional(z.boolean()),
    monthly_limit_cents: z.optional(limitInput), friends: z.optional(z.boolean()), texts: z.optional(z.boolean()) }),
  async plan(ctx, i) {
    const { row } = await juniorRow(ctx.db, i.person_id);
    const { row: rules, read } = await readRow(ctx.db, "kid_rule", i.person_id, "thing.kid_rule");
    const next = { open_matches: i.open_matches ?? rules.open_matches, courts: i.courts ?? rules.courts, programs: i.programs ?? rules.programs, lessons: i.lessons ?? rules.lessons,
      monthly_limit_cents: i.monthly_limit_cents ?? rules.monthly_limit_cents, friends: i.friends ?? rules.friends, texts: i.texts ?? rules.texts };
    return { title: both("action.kid.set_rules"), summary: both("plan.kid.set_rules", { name: row.display_name, rules: rulesText(next) }), reads: [read],
      ownerIds: await parentsOf(ctx.db, i.person_id), undo: { kind: "reversible" }, details: next };
  },
  async apply(ctx, i, plan) {
    await ctx.update("kid_rule", i.person_id, { ...(plan.details as object), updated_by: ctx.actor.personId, updated_at: ctx.now });
    return null;
  },
});

// ---- Asking a parent ----
const reasonText = async (db: Db | Trx, kid: Kid, kind: KidKind, reason: "off" | "limit", now: Date): Promise<Text> =>
  reason === "off" ? both("kid.why_off", { kind: both(`kid.kind.${kind}` as Key) }) : both("kid.why_limit", { limit: usd(kid.monthly_limit_cents), spent: usd(await monthSpent(db, kid.id, now)) });

export const kidAskParent = defineAction({
  name: "kid.ask_parent", version: 1, internal: true,
  input: z.object({ action: z.string().check(z.minLength(3), z.maxLength(60)), input: z.record(z.string(), z.unknown()) }),
  async plan(ctx, i) {
    const kid = await kidOf(ctx.db, ctx.actor.personId);
    if (!kid) throw new KumiError("error.not_a_kid");
    const kind = await kindOf(ctx.db, i.action, i.input);
    if (!kind) throw new KumiError("error.unknown_action", {}, 404);
    // What they're asking for, as the action itself would put it (and only what they could do themselves).
    const p = await dryPlan(ctx.db, i.action, i.input, ctx.actor, ctx.now), cents = fullCost(i.action, i.input, p);
    const reason = (await overRules(ctx.db, kid, kind, cents, ctx.now))?.reason ?? (kid[kind] ? "limit" : "off");
    if (await ctx.db.selectFrom("kid_request").select("id").where("person_id", "=", kid.id).where("status", "=", "asked").where("action", "=", i.action)
      .where(sql<boolean>`input = ${JSON.stringify(i.input)}::jsonb`).executeTakeFirst()) throw new KumiError("error.kid_already_asked");
    return { title: both("action.kid.ask_parent"), summary: both("plan.kid.ask_parent", { what: p.summary, why: await reasonText(ctx.db, kid, kind, reason, ctx.now) }),
      reads: [], ownerIds: [kid.id], undo: { kind: "reversible" }, details: { kind, reason, cents, what: p.summary } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { kind: KidKind; reason: "off" | "limit"; cents: number; what: Text };
    const kid = (await kidOf(ctx.trx, ctx.actor.personId))!, id = uuidv7();
    await ctx.insert("kid_request", { id, person_id: kid.id, action: i.action, input: JSON.stringify(i.input), kind: d.kind, reason: d.reason, cents: d.cents, what: JSON.stringify(d.what) });
    await ctx.emit("kid.asked", { request_id: id, kid: kid.id, to: await managersOf(ctx.trx, kid.id), what: d.what, cents: d.cents, why: await reasonText(ctx.trx, kid, d.kind, d.reason, ctx.now) });
    return { request_id: id, asked_parent: true };
  },
});

async function openRequest(db: Db | Trx, requestId: string) {
  const { row, read } = await readRow(db, "kid_request", requestId, "thing.kid_request");
  if (row.status !== "asked") throw new KumiError("error.kid_request_closed");
  const name = (await db.selectFrom("person").select("display_name").where("id", "=", row.person_id).executeTakeFirstOrThrow()).display_name;
  return { r: row, read, name };
}

export const kidWithdrawRequest = defineAction({
  name: "kid.withdraw_request", version: 1,
  input: z.object({ request_id: z.uuid() }),
  async plan(ctx, i) {
    const { r, read } = await openRequest(ctx.db, i.request_id);
    return { title: both("action.kid.withdraw_request"), summary: both("plan.kid.withdraw_request", { what: r.what as Text }), reads: [read], ownerIds: [r.person_id], undo: { kind: "none" } };
  },
  async apply(ctx, i) { await ctx.update("kid_request", i.request_id, { status: "withdrawn", decided_at: ctx.now }); return null; },
});

export const kidDeclineRequest = defineAction({
  name: "kid.decline_request", version: 1,
  input: z.object({ request_id: z.uuid() }),
  async plan(ctx, i) {
    const { r, read, name } = await openRequest(ctx.db, i.request_id);
    return { title: both("action.kid.decline_request"), summary: both("plan.kid.decline_request", { name, what: r.what as Text }), reads: [read], ownerIds: await parentsOf(ctx.db, r.person_id), undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const r = await ctx.trx.selectFrom("kid_request").selectAll().where("id", "=", i.request_id).executeTakeFirstOrThrow();
    await ctx.update("kid_request", r.id, { status: "declined", decided_by: ctx.actor.personId, decided_at: ctx.now });
    await ctx.emit("kid.answered", { request_id: r.id, kid: r.person_id, outcome: "declined", by: ctx.actor.personId, what: r.what, to: [] });
    return null;
  },
});

/** A parent's yes, recorded before the kid's action is run (approveKidRequest runs it). */
export const kidApproveRequest = defineAction({
  name: "kid.approve_request", version: 1, internal: true,
  input: z.object({ request_id: z.uuid() }),
  async plan(ctx, i) {
    const { r, read, name } = await openRequest(ctx.db, i.request_id);
    return { title: both("action.kid.approve_request"), summary: both(r.cents > 0 ? "plan.kid.approve_request" : "plan.kid.approve_request_free", { name, what: r.what as Text, amount: usd(r.cents) }),
      reads: [read], ownerIds: await parentsOf(ctx.db, r.person_id), undo: { kind: "none" } };
  },
  async apply(ctx, i) { await ctx.update("kid_request", i.request_id, { status: "approved", decided_by: ctx.actor.personId, decided_at: ctx.now }); return null; },
});

export const kidRequestResult = defineAction({
  name: "kid.request_result", version: 1, system: true, internal: true,
  input: z.object({ request_id: z.uuid(), outcome: z.enum(["done", "failed"]), run_id: z.optional(z.uuid()), error: z.optional(z.object({ en: z.string(), es: z.string() })) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "kid_request", i.request_id, "thing.kid_request");
    return { title: both("action.kid.request_result"), summary: both("action.kid.request_result"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const r = await ctx.trx.selectFrom("kid_request").selectAll().where("id", "=", i.request_id).forUpdate().executeTakeFirstOrThrow();
    if (r.status !== "approved") return { already: r.status };
    await ctx.update("kid_request", r.id, { status: i.outcome, run_id: i.run_id ?? null, error: i.error ? JSON.stringify(i.error) : null });
    // A yes that couldn't be done: the parents hear it too (the one who said yes is waiting for it).
    await ctx.emit("kid.answered", { request_id: r.id, kid: r.person_id, outcome: i.outcome, by: r.decided_by, what: r.what, error: i.error ?? null,
      to: i.outcome === "failed" ? await managersOf(ctx.trx, r.person_id) : [] });
    return null;
  },
});

/** A parent says yes: the kid's action is planned afresh, as the kid (their rules aside: that's what the yes
 *  is for), and applied; then what it costs goes on the family card. A court or place gone meanwhile, or a
 *  price gone up, is said to the kid and the parents rather than done. */
export async function approveKidRequest(db: Db, requestId: string, parent: Actor, now = new Date()) {
  await run(db, "kid.approve_request", { request_id: requestId }, parent, { now, internal: true });
  const r = await db.selectFrom("kid_request").selectAll().where("id", "=", requestId).executeTakeFirstOrThrow();
  const locale = (await db.selectFrom("person").select("locale").where("id", "=", r.person_id).executeTakeFirstOrThrow()).locale;
  const kid: Actor = { personId: r.person_id, via: `parent:${parent.personId}`, lang: pickLang(locale) };
  let runId: string;
  try {
    const p = await planRun(db, r.action, r.input, kid, { now, parentApproved: true });
    const cents = fullCost(r.action, r.input, p.plan);
    if (cents > r.cents) throw new KumiError("error.kid_price_changed", { amount: usd(cents) });
    if (p.status !== "planned") throw new KumiError("error.changed");
    runId = p.runId;
    await applyRun(db, p.runId, kid, { now });
  } catch (e) {
    if (!(e instanceof KumiError)) throw e;
    await runAsSystem(db, "kid.request_result", { request_id: requestId, outcome: "failed", error: e.text }, "kids", { now });
    return { outcome: "failed" as const, error: e.text };
  }
  const paid = await payKidRun(db, runId, r.person_id, now, { approved: true });
  await runAsSystem(db, "kid.request_result", { request_id: requestId, outcome: "done", run_id: runId }, "kids", { now });
  return { outcome: "done" as const, paid };
}
