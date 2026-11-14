// A member's card on file (Me, "Card on file"). Saved with a card setup at the provider (Stripe's SetupIntent), so
// adding it charges and holds nothing. It is the one card everything later goes on: what's still unpaid of a court
// at its deadline ("my part"), each later week of a weekly court, membership renewals, and (for a parent who saved
// it) the family card their kids pay with. Adding or replacing it moves all of those to it; removing it takes it
// off all of them, after a preview that says what relied on it. The card itself never reaches the club: only its
// brand, last four digits and expiry are kept, to show it.
//
// Cards saved before there was a card on file (paying "my part" with the box ticked, a membership, the family card)
// still count: the card shown is the one saved last, wherever it was saved, and replacing or removing it covers
// every place this person's cards are kept.
import * as z from "zod/mini";
import { both, dateTime, type Text } from "@kumi/i18n";
import { defineAction, runAsSystem, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { paymentProvider, type CardFacts } from "./money.ts";
import { refuseWhenReadOnly } from "./read_only.ts";
import { deadlineSql } from "./booking_pay.ts";
import { householdOf, nameList } from "./households.ts";
import { textOf } from "./club_text.ts";
import { brandName } from "./receipts.ts";
import { dayText } from "./memberships.ts";
import { localDate } from "./clock.ts";

const LIVE = ["upcoming", "active", "past_due"] as const;

/** A card saved somewhere for this person, newest first by when it was saved. */
type Saved = { method: string; customer: string | null; account: string | null; at: Date; from: "card" | "payment" | "membership" | "family"; facts: CardFacts | null };

/** The card this person has on file: the one saved last, wherever (null with none). Its brand, last four and expiry
 *  come from what was kept when it was added here, or else from the provider. */
export async function currentCard(db: Db | Trx, personId: string): Promise<(CardFacts & { from: Saved["from"] }) | null> {
  const s = await newestSaved(db, personId);
  if (!s) return null;
  const facts = s.facts ?? await paymentProvider().methodOf?.(s.method, s.account).catch(() => null) ?? null;
  return facts ? { ...facts, from: s.from } : { brand: "card", last4: "", expMonth: null, expYear: null, from: s.from };
}

async function newestSaved(db: Db | Trx, personId: string): Promise<Saved | null> {
  const found: Saved[] = [];
  const c = await db.selectFrom("person_card").selectAll().where("person_id", "=", personId).where("status", "=", "saved").executeTakeFirst();
  if (c?.saved_method) found.push({ method: c.saved_method, customer: c.saved_customer, account: c.provider_account, at: c.saved_at ?? c.created_at, from: "card",
    facts: c.last4 ? { brand: c.brand ?? "card", last4: c.last4, expMonth: c.exp_month, expYear: c.exp_year } : null });
  const p = await db.selectFrom("payment").select(["saved_method", "saved_customer", "provider_account", "created_at"]).where("person_id", "=", personId).where("status", "=", "succeeded")
    .where("saved_method", "is not", null).orderBy("created_at", "desc").limit(1).executeTakeFirst();
  if (p?.saved_method) found.push({ method: p.saved_method, customer: p.saved_customer, account: p.provider_account, at: p.created_at, from: "payment", facts: null });
  const m = await db.selectFrom("membership").select(["saved_method", "saved_customer", "provider_account", "created_at"]).where("person_id", "=", personId).where("status", "in", LIVE)
    .where("saved_method", "is not", null).executeTakeFirst();
  if (m?.saved_method) found.push({ method: m.saved_method, customer: m.saved_customer, account: m.provider_account, at: m.created_at, from: "membership", facts: null });
  const f = await db.selectFrom("family_card").select(["saved_method", "saved_customer", "provider_account", "saved_at", "created_at"]).where("saved_by", "=", personId).where("status", "=", "saved")
    .where("saved_method", "is not", null).executeTakeFirst();
  if (f?.saved_method) found.push({ method: f.saved_method, customer: f.saved_customer, account: f.provider_account, at: f.saved_at ?? f.created_at, from: "family", facts: null });
  found.sort((a, b) => b.at.getTime() - a.at.getTime());
  // The same card saved in two places: the facts kept here, whichever was saved last.
  const top = found[0];
  if (top && !top.facts) top.facts = found.find((x) => x.method === top.method && x.facts)?.facts ?? null;
  return top ?? null;
}

/** What relies on this person's saved cards now: a membership that renews from one, the family card their kids pay
 *  with, courts whose unpaid shares go on one at the deadline, and weekly courts whose later weeks do. */
export async function cardUses(db: Db | Trx, personId: string, now: Date) {
  const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
  const m = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership.id", "membership.status", "membership.source", "membership.cancel_at_period_end", "membership.current_period_end", "membership.started_at", "membership.saved_method",
      "membership_plan.name", "membership_plan.translations"])
    .where("membership.person_id", "=", personId).where("membership.status", "in", LIVE).where("membership.source", "=", "app").executeTakeFirst();
  const membership = m && m.saved_method && !m.cancel_at_period_end
    ? { id: m.id, status: m.status, name: textOf(m.name, m.translations, "name"), on: m.status === "upcoming" ? m.started_at : m.current_period_end } : null;
  const hh = await householdOf(db, personId);
  const family = hh?.role === "adult" ? await db.selectFrom("family_card").select("id").where("saved_by", "=", personId).where("status", "=", "saved").executeTakeFirst() : undefined;
  const kids = family ? (await db.selectFrom("household_member").innerJoin("person", "person.id", "household_member.person_id").select("person.display_name")
    .where("household_member.household_id", "=", hh!.household_id).where("household_member.role", "=", "junior").where("household_member.removed_at", "is", null)
    .where("person.own_login", "=", true).where("person.status", "=", "active").orderBy("household_member.created_at").execute()).map((k) => k.display_name) : [];
  // Courts I organised and pay my part of, not settled yet: what's unpaid at the deadline goes on my saved card.
  const deadlines = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").leftJoin("open_match", "open_match.booking_id", "booking.id")
    .leftJoin("booking_policy", "booking_policy.id", "booking.policy_id")
    .select(["booking.id", deadlineSql.as("at")])
    .where("booking.organiser_id", "=", personId).where("booking.status", "=", "confirmed").where("booking.pay_mode", "=", "split").where("booking.settled_at", "is", null)
    .where("court_time.active", "=", true).where(deadlineSql, ">", now)
    .where((eb) => eb.exists(eb.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id")
      .whereRef("booking_player.booking_id", "=", "booking.id").where("payment.person_id", "=", personId).where("payment.status", "=", "succeeded").where("payment.saved_method", "is not", null)))
    .execute();
  deadlines.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const weekly = await db.selectFrom("booking_series").select("booking_series.id").where("organiser_id", "=", personId).where("pay", "=", "card").where("ended_at", "is", null)
    .where((eb) => eb.exists(eb.selectFrom("booking_series_week").select("booking_series_week.id").whereRef("booking_series_week.series_id", "=", "booking_series.id")
      .where("booking_series_week.booking_id", "is", null).where("booking_series_week.missed", "is", null))).execute();
  return { tz, membership, kids: family ? kids : null, deadlines: deadlines.map((d) => ({ booking_id: d.id, at: new Date(d.at) })), weekly: weekly.length };
}

/** The card form for a card on file: the provider's card setup, opened once and reused until it's saved. */
export async function openCardOnFile(db: Db, personId: string): Promise<{ cardId: string; clientSecret: string; provider: "test" | "stripe"; account: string | null }> {
  await refuseWhenReadOnly(db);
  if (await db.selectFrom("person").select("id").where("id", "=", personId).where("junior", "=", true).executeTakeFirst()) throw new KumiError("error.card_kid");
  const pv = paymentProvider();
  const open = await db.selectFrom("person_card").selectAll().where("person_id", "=", personId).where("status", "=", "pending").where("provider", "=", pv.name)
    .where("provider_ref", "is not", null).orderBy("created_at", "desc").executeTakeFirst();
  if (open?.provider_ref) return { cardId: open.id, clientSecret: (await pv.getSetup(open.provider_ref, open.provider_account)).clientSecret, provider: pv.name, account: open.provider_account };
  const person = await db.selectFrom("person").select(["email", "display_name"]).where("id", "=", personId).executeTakeFirstOrThrow();
  const customer = await pv.ensureCustomer({ key: personId, email: person.email, name: person.display_name });
  const cardId = uuidv7();
  const it = await pv.createSetup({ customer: customer.id, idempotencyKey: `card:${cardId}`, metadata: { kumi_card_id: cardId } });
  await runAsSystem(db, "card.open", { card_id: cardId, person_id: personId, provider_ref: it.ref, saved_customer: customer.id, ...(it.account ? { provider_account: it.account } : {}) }, "payments");
  return { cardId, clientSecret: it.clientSecret, provider: pv.name, account: it.account };
}

/** Ask the provider whether the card was saved, and record it once it is. Safe to call any number of times: after
 *  the card form, from the webhook, and from the job that catches what both missed. */
export async function checkCardOnFile(db: Db, cardId: string, via = "payments", now?: Date): Promise<"pending" | "succeeded" | "failed" | null> {
  const c = await db.selectFrom("person_card").select(["id", "status", "provider_ref", "provider_account"]).where("id", "=", cardId).executeTakeFirst();
  if (!c) return null;
  if (c.status === "saved") return "succeeded";
  if (c.status !== "pending" || !c.provider_ref) return c.status === "removed" ? "failed" : "pending";
  const pv = paymentProvider(), st = await pv.getSetup(c.provider_ref, c.provider_account);
  if (st.status === "succeeded" && st.paymentMethod) {
    const f = await pv.methodOf?.(st.paymentMethod, c.provider_account).catch(() => null) ?? null;
    await runAsSystem(db, "card.saved", { card_id: c.id, saved_method: st.paymentMethod, ...(st.customer ? { saved_customer: st.customer } : {}),
      ...(f ? { brand: f.brand.slice(0, 20), last4: f.last4, ...(f.expMonth ? { exp_month: f.expMonth } : {}), ...(f.expYear ? { exp_year: f.expYear } : {}) } : {}) }, via, now ? { now } : {});
  }
  return st.status;
}

/** The job: card setups opened in the last two days and not recorded here (a missed webhook). */
export async function tidyCardsOnFile(db: Db, now = new Date()) {
  const rows = await db.selectFrom("person_card").select("id").where("status", "=", "pending").where("provider_ref", "is not", null).where("provider", "=", paymentProvider().name)
    .where("created_at", ">", new Date(now.getTime() - 2 * 864e5)).execute();
  let saved = 0;
  for (const r of rows) {
    try { if ((await checkCardOnFile(db, r.id, "job:cards", now)) === "succeeded") saved++; }
    catch (e) { console.error(`kumi: a card on file couldn't be checked: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { saved };
}

export const cardOpen = defineAction({
  name: "card.open", version: 1, system: true, internal: true,
  input: z.object({ card_id: z.uuid(), person_id: z.uuid(), provider_ref: z.string().check(z.minLength(1)), saved_customer: z.string(), provider_account: z.optional(z.string()) }),
  async plan() {
    return { title: both("action.card.open"), summary: both("action.card.open"), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    await ctx.insert("person_card", { id: i.card_id, person_id: i.person_id, provider: paymentProvider().name, provider_ref: i.provider_ref, provider_account: i.provider_account ?? null, saved_customer: i.saved_customer });
    return { card_id: i.card_id };
  },
});

/** Every place this person's cards are kept, to move to a new card or take off: their live membership's, the family
 *  card they saved, and the cards saved with their payments (and with their kids' payments on that family card). */
async function savedPlaces(ctx: ApplyCtx, personId: string) {
  const memberships = await ctx.trx.selectFrom("membership").select(["id", "saved_method", "status"]).where("person_id", "=", personId).where("status", "in", LIVE).where("saved_method", "is not", null).forUpdate().execute();
  const families = await ctx.trx.selectFrom("family_card").select(["id", "saved_method"]).where("saved_by", "=", personId).where("status", "=", "saved").forUpdate().execute();
  const payments = await ctx.trx.selectFrom("payment").select(["id", "saved_method", "provider_account"]).where("saved_method", "is not", null)
    .where((eb) => eb.or([eb("person_id", "=", personId), ...(families.length ? [eb("family_card_id", "in", families.map((f) => f.id))] : [])])).forUpdate().execute();
  const cards = await ctx.trx.selectFrom("person_card").select(["id", "saved_method"]).where("person_id", "=", personId).where("status", "=", "saved").forUpdate().execute();
  return { memberships, families, payments, cards };
}

export const cardSaved = defineAction({
  name: "card.saved", version: 1, system: true, internal: true,
  input: z.object({ card_id: z.uuid(), saved_method: z.string(), saved_customer: z.optional(z.string()),
    brand: z.optional(z.string().check(z.maxLength(20))), last4: z.optional(z.string().check(z.regex(/^\d{4}$/))),
    exp_month: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(12))), exp_year: z.optional(z.number().check(z.int(), z.minimum(2000), z.maximum(2200))) }),
  async plan(ctx, i) {
    const c = await ctx.db.selectFrom("person_card").select(["id", "version"]).where("id", "=", i.card_id).executeTakeFirstOrThrow();
    return { title: both("action.card.saved"), summary: both("action.card.saved"), reads: [{ entity: "person_card", id: c.id, version: c.version }], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const c = await ctx.trx.selectFrom("person_card").selectAll().where("id", "=", i.card_id).forUpdate().executeTakeFirstOrThrow();
    if (c.status !== "pending") return { already: c.status };
    const customer = i.saved_customer ?? c.saved_customer;
    const places = await savedPlaces(ctx, c.person_id);
    // The card on file before this one is replaced by it.
    for (const old of places.cards) await ctx.update("person_card", old.id, { status: "removed", removed_at: ctx.now });
    await ctx.update("person_card", c.id, { status: "saved", saved_method: i.saved_method, saved_customer: customer, saved_at: ctx.now,
      brand: i.brand ?? null, last4: i.last4 ?? null, exp_month: i.exp_month ?? null, exp_year: i.exp_year ?? null });
    // Everything that would have gone on a card of theirs goes on this one now. A payment's own account stays as it
    // was (its refunds go back where it was paid); only the card a later charge uses moves, and only on the same account.
    const card = { saved_customer: customer, saved_method: i.saved_method };
    for (const m of places.memberships) await ctx.update("membership", m.id, { ...card, provider_account: c.provider_account });
    // A membership joined in the app that has no card to renew from (paid another way) renews from this one now. One
    // carried over from Playtomic keeps its own step (adding a card there is saying to keep it, brought_in.ts).
    for (const m of await ctx.trx.selectFrom("membership").select("id").where("person_id", "=", c.person_id).where("status", "in", ["active", "past_due"]).where("source", "=", "app")
      .where("saved_method", "is", null).where("brought_from", "is", null).forUpdate().execute()) await ctx.update("membership", m.id, { ...card, provider_account: c.provider_account });
    for (const f of places.families) await ctx.update("family_card", f.id, { ...card, provider_account: c.provider_account });
    const moved = places.payments.filter((p) => (p.provider_account ?? null) === (c.provider_account ?? null));
    for (const p of moved) if (p.saved_method !== i.saved_method) await ctx.update("payment", p.id, card);
    // A card still kept with a payment on another account (the club moved Stripe accounts) is left as it is.
    const kept = new Set(places.payments.filter((p) => !moved.includes(p)).map((p) => p.saved_method));
    const replaced = [...new Set([...places.cards, ...places.memberships, ...places.families, ...moved].map((x) => x.saved_method).filter((x): x is string => Boolean(x) && x !== i.saved_method && !kept.has(x)))];
    // The cards it replaced are taken off at the provider, so nothing can charge them for the club again.
    await detachAll(replaced, c.provider_account);
    return { card_id: c.id, replaced: replaced.length };
  },
});

async function detachAll(methods: string[], account: string | null) {
  const pv = paymentProvider();
  for (const m of methods) {
    try { await pv.detachMethod?.(m, account); }
    catch (e) { console.error(`kumi: a replaced card couldn't be taken off at the provider: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

const day = (d: Date, tz: string): Text => dayText(localDate(d, tz));
const at = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });
const joinText = (parts: Text[]): Text => ({ en: parts.map((p) => p.en).join(" "), es: parts.map((p) => p.es).join(" ") });

/** The card on file as a sentence: "the Visa card ending 4242", or "your saved card" when its details aren't known. */
export function cardWords(c: { brand: string; last4: string } | null): Text {
  return c?.last4 ? both("plan.card.this_card", { brand: brandName(c.brand), last4: c.last4 }) : both("plan.card.saved_card");
}

export const cardRemove = defineAction({
  name: "card.remove", version: 1,
  input: z.object({ person_id: z.uuid() }),
  owners: async (_db, i) => [i.person_id],
  async plan(ctx, i) {
    const card = await currentCard(ctx.db, i.person_id);
    if (!card) throw new KumiError("error.no_card_on_file");
    const uses = await cardUses(ctx.db, i.person_id, ctx.now);
    // A place joined before its plan starts is held by its card: without one it would be let go. Replace it instead.
    if (uses.membership?.status === "upcoming") throw new KumiError("error.card_holds_place", { name: uses.membership.name, date: day(uses.membership.on!, uses.tz) });
    const parts: Text[] = [both("plan.card.remove", { card: cardWords(card) })];
    if (uses.deadlines.length) parts.push(both("plan.card.remove_deadlines", { count: uses.deadlines.length, time: at(uses.deadlines[0]!.at, uses.tz) }));
    if (uses.weekly) parts.push(both("plan.card.remove_weekly", { count: uses.weekly }));
    if (uses.kids?.length) parts.push(both("plan.card.remove_kids", { names: nameList(uses.kids) }));
    else if (uses.kids) parts.push(both("plan.card.remove_family"));
    if (uses.membership?.on) parts.push(both("plan.card.remove_membership", { name: uses.membership.name, date: day(uses.membership.on, uses.tz) }));
    if (parts.length === 1) parts.push(both("plan.card.remove_nothing"));
    return { title: both("action.card.remove"), summary: joinText(parts), reads: [], ownerIds: [i.person_id], undo: { kind: "none" },
      details: { relied: uses.deadlines.length + uses.weekly + (uses.kids ? 1 : 0) + (uses.membership ? 1 : 0) } };
  },
  async apply(ctx, i) {
    const places = await savedPlaces(ctx, i.person_id);
    if (places.memberships.some((m) => m.status === "upcoming")) throw new KumiError("error.changed");
    const gone = { saved_customer: null, saved_method: null };
    for (const c of places.cards) await ctx.update("person_card", c.id, { status: "removed", removed_at: ctx.now, ...gone });
    for (const m of places.memberships) await ctx.update("membership", m.id, gone);
    for (const f of places.families) await ctx.update("family_card", f.id, { status: "removed", removed_at: ctx.now, ...gone });
    for (const p of places.payments) await ctx.update("payment", p.id, gone);
    const methods = [...new Set([...places.cards, ...places.memberships, ...places.families, ...places.payments].map((x) => x.saved_method).filter((x): x is string => Boolean(x)))];
    const account = (await ctx.trx.selectFrom("person_card").select("provider_account").where("person_id", "=", i.person_id).orderBy("created_at", "desc").executeTakeFirst())?.provider_account ?? null;
    await detachAll(methods, account);
    return { removed: methods.length };
  },
});
