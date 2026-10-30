// Households and juniors, and the club's waiver. A junior (under 18) has no login and no contact details:
// a name and a birth year, in a parent's household. The household's adults (whoever made it, and other
// parents who accepted their invite) manage its juniors: they sign them up, book their lessons, pay, and get
// their messages. Kumi never collects anything from the child directly. A junior never shows on the public
// page, among friends or in open matches, and doesn't book courts.
//
// The waiver is one text, a new version each time the club changes it. An adult accepts the current
// version before their first booking or sign-up, and a parent accepts it for each junior.
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localParts } from "./clock.ts";

/** How long a link inviting another parent works. */
export const INVITE_DAYS = 7;
/** Juniors are under this age. With only a birth year, someone is a junior until the year they turn it. */
export const ADULT_AGE = 18;

const clubYear = async (db: Db | Trx, now: Date) => localParts(now, (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone).y;

/** The household a person is in now, and whether they're one of its adults or juniors. */
export async function householdOf(db: Db | Trx, personId: string) {
  return (await db.selectFrom("household_member").select(["id", "household_id", "role"]).where("person_id", "=", personId).where("removed_at", "is", null).executeTakeFirst()) ?? null;
}

/** The adults who manage a junior; none for anyone who isn't one. */
export async function managersOf(db: Db | Trx, personId: string): Promise<string[]> {
  const rows = await db.selectFrom("household_member as j").innerJoin("household_member as a", "a.household_id", "j.household_id").select("a.person_id")
    .where("j.person_id", "=", personId).where("j.role", "=", "junior").where("j.removed_at", "is", null).where("a.role", "=", "adult").where("a.removed_at", "is", null).orderBy("a.created_at").execute();
  return rows.map((r) => r.person_id);
}

/** Whether `adultId` manages `personId` (a junior in their household). */
export async function manages(db: Db | Trx, adultId: string | null, personId: string): Promise<boolean> {
  return Boolean(adultId) && (await managersOf(db, personId)).includes(adultId!);
}

/** The juniors an adult manages, by name. */
export async function juniorsOf(db: Db | Trx, adultId: string) {
  return db.selectFrom("household_member as a").innerJoin("household_member as j", "j.household_id", "a.household_id").innerJoin("person", "person.id", "j.person_id")
    .select(["person.id", "person.display_name", "person.birth_year"]).where("a.person_id", "=", adultId).where("a.role", "=", "adult").where("a.removed_at", "is", null)
    .where("j.role", "=", "junior").where("j.removed_at", "is", null).where("person.status", "=", "active").orderBy("j.created_at").execute();
}

/** Whose rows these are, for "own" grants: the people themselves and, for a junior, the adults managing them. */
export async function withManagers(db: Db | Trx, ids: (string | null | undefined)[]): Promise<string[]> {
  const out = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    out.add(id);
    for (const m of await managersOf(db, id)) out.add(m);
  }
  return [...out];
}

/** "Mia and Leo", in each language. */
export function nameList(names: string[]): Text {
  const f = (and: string) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
  return { en: f("and"), es: f("y") };
}
/** The household's juniors, said in a sentence: their names, or "your juniors" with none yet. */
async function juniorWords(db: Db | Trx, adultId: string): Promise<Text> {
  const names = (await juniorsOf(db, adultId)).map((j) => j.display_name);
  return names.length ? nameList(names) : both("plan.household.your_juniors");
}

/** Courts and open matches are for people with their own login: a junior plays in lessons and programs. */
export async function notJunior(db: Db | Trx, personId: string) {
  const p = await db.selectFrom("person").select(["junior", "display_name"]).where("id", "=", personId).executeTakeFirst();
  if (p?.junior) throw new KumiError("error.junior_no_courts", { name: p.display_name });
}

/** A household's adults, now (who hears about a change is worked out when it happens). */
async function adultsNow(db: Db | Trx, householdId: string): Promise<string[]> {
  return (await db.selectFrom("household_member").select("person_id").where("household_id", "=", householdId).where("role", "=", "adult").where("removed_at", "is", null).execute()).map((r) => r.person_id);
}

/** The household for an adult, made now if they haven't one. */
async function ensureHousehold(ctx: ApplyCtx, adultId: string): Promise<string> {
  await ctx.trx.selectFrom("person").select("id").where("id", "=", adultId).forUpdate().execute();   // one household per adult, even with two taps
  const hh = await householdOf(ctx.trx, adultId);
  if (hh) { if (hh.role !== "adult") throw new KumiError("error.household_not_parent"); return hh.household_id; }
  const id = uuidv7();
  await ctx.insert("household", { id, created_by: adultId });
  await ctx.insert("household_member", { id: uuidv7(), household_id: id, person_id: adultId, role: "adult", added_by: adultId });
  return id;
}

async function adultRow(ctx: PlanCtx, personId: string) {
  const { row } = await readRow(ctx.db, "person", personId, "thing.person");
  if (row.junior) throw new KumiError("error.not_an_adult");
  const hh = await householdOf(ctx.db, personId);
  return { person: row, hh };
}

export const householdAddJunior = defineAction({
  name: "household.add_junior", version: 1,
  input: z.object({ person_id: z.uuid(), display_name: z.string().check(z.trim(), z.minLength(1), z.maxLength(80)), birth_year: z.number().check(z.int()) }),
  async plan(ctx, i) {
    const { hh } = await adultRow(ctx, i.person_id);
    if (hh && hh.role !== "adult") throw new KumiError("error.household_not_parent");
    const year = await clubYear(ctx.db, ctx.now);
    if (i.birth_year > year || i.birth_year < year - ADULT_AGE) throw new KumiError("error.junior_age", { from: year - ADULT_AGE, to: year });
    return { title: both("action.household.add_junior"), summary: both("plan.household.add_junior", { name: i.display_name, year: i.birth_year }), reads: [], ownerIds: [i.person_id],
      undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const householdId = await ensureHousehold(ctx, i.person_id);
    const adult = await ctx.trx.selectFrom("person").select("locale").where("id", "=", i.person_id).executeTakeFirstOrThrow();
    const id = uuidv7();
    // Their messages go to the household's adults, each in their own language; this is only a fallback.
    await ctx.insert("person", { id, display_name: i.display_name, birth_year: i.birth_year, locale: adult.locale, created_via: "household", junior: true });
    await ctx.insert("household_member", { id: uuidv7(), household_id: householdId, person_id: id, role: "junior", added_by: ctx.actor.personId ?? i.person_id });
    const by = ctx.actor.personId ?? i.person_id;
    await ctx.emit("household.junior_added", { junior_id: id, by, to: (await adultsNow(ctx.trx, householdId)).filter((a) => a !== by) });
    return { person_id: id, household_id: householdId };
  },
});

export const householdRemoveJunior = defineAction({
  name: "household.remove_junior", version: 1,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    if (!row.junior || row.status !== "active") throw new KumiError("error.not_a_junior", { name: row.display_name });
    const places = await ctx.db.selectFrom("enrolment").select("id").where("person_id", "=", i.person_id).where("status", "in", ["booked", "waitlisted"]).executeTakeFirst()
      ?? await ctx.db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").innerJoin("court_time", "court_time.booking_id", "booking.id").select("booking_player.id")
        .where("booking_player.person_id", "=", i.person_id).where("booking_player.removed_at", "is", null).where("booking.status", "in", ["held", "confirmed"]).where("court_time.active", "=", true)
        .where(sql<boolean>`upper(court_time.during) > ${ctx.now}`).executeTakeFirst();
    if (places) throw new KumiError("error.junior_has_places", { name: row.display_name });
    return { title: both("action.household.remove_junior"), summary: both("plan.household.remove_junior", { name: row.display_name }), reads: [read], ownerIds: await withManagers(ctx.db, [i.person_id]),
      undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const hh = await householdOf(ctx.trx, i.person_id);
    if (hh) await ctx.update("household_member", hh.id, { removed_at: ctx.now });
    await ctx.update("person", i.person_id, { status: "archived" });
    return null;
  },
});

export const householdInvite = defineAction({
  name: "household.invite", version: 1,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const { hh } = await adultRow(ctx, i.person_id);
    if (hh && hh.role !== "adult") throw new KumiError("error.household_not_parent");
    return { title: both("action.household.invite"), summary: both("plan.household.invite", { juniors: await juniorWords(ctx.db, i.person_id), days: both("count.days", { count: INVITE_DAYS }) }), reads: [], ownerIds: [i.person_id],
      undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const householdId = await ensureHousehold(ctx, i.person_id);
    const id = uuidv7(), code = randomBytes(9).toString("base64url");
    await ctx.insert("household_invite", { id, household_id: householdId, code, invited_by: i.person_id, expires_at: new Date(ctx.now.getTime() + INVITE_DAYS * 86400_000) });
    return { invite_id: id, code };
  },
});

export const householdWithdrawInvite = defineAction({
  name: "household.withdraw_invite", version: 1,
  input: z.object({ invite_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "household_invite", i.invite_id, "thing.household_invite");
    if (row.status !== "open") throw new KumiError("error.household_invite_closed");
    const adults = await ctx.db.selectFrom("household_member").select("person_id").where("household_id", "=", row.household_id).where("role", "=", "adult").where("removed_at", "is", null).execute();
    return { title: both("action.household.withdraw_invite"), summary: both("plan.household.withdraw_invite"), reads: [read], ownerIds: adults.map((a) => a.person_id), undo: { kind: "none" } };
  },
  async apply(ctx, i) { await ctx.update("household_invite", i.invite_id, { status: "withdrawn", decided_at: ctx.now }); return null; },
});

/** An invite as its link shows it: who sent it, the juniors it's for, and whether it can still be accepted. */
export async function inviteByCode(db: Db | Trx, code: string, now: Date) {
  const inv = await db.selectFrom("household_invite").innerJoin("person", "person.id", "household_invite.invited_by")
    .select(["household_invite.id", "household_invite.household_id", "household_invite.status", "household_invite.expires_at", "household_invite.invited_by", "household_invite.version", "person.display_name as from"])
    .where("household_invite.code", "=", code).executeTakeFirst();
  if (!inv) return null;
  const juniors = (await juniorsOf(db, inv.invited_by)).map((j) => j.display_name);
  return { ...inv, juniors, open: inv.status === "open" && inv.expires_at > now };
}

export const householdAcceptInvite = defineAction({
  name: "household.accept_invite", version: 1,
  input: z.object({ person_id: z.uuid(), code: z.string().check(z.minLength(8), z.maxLength(40)) }),
  async plan(ctx, i) {
    const inv = await inviteByCode(ctx.db, i.code, ctx.now);
    if (!inv || !inv.open) throw new KumiError("error.household_invite_closed");
    const { hh } = await adultRow(ctx, i.person_id);
    if (hh?.household_id === inv.household_id) throw new KumiError("error.household_already");
    // A household of their own with nobody else in it is left behind; one with others in it isn't.
    if (hh && Number((await ctx.db.selectFrom("household_member").select(sql<string>`count(*)`.as("n")).where("household_id", "=", hh.household_id).where("removed_at", "is", null)
      .where("person_id", "!=", i.person_id).executeTakeFirstOrThrow()).n)) throw new KumiError("error.household_other");
    return { title: both("action.household.accept_invite"), summary: both("plan.household.accept_invite", { name: inv.from, juniors: inv.juniors.length ? nameList(inv.juniors) : both("plan.household.their_juniors") }),
      reads: [{ entity: "household_invite", id: inv.id, version: inv.version }], ownerIds: [i.person_id], undo: { kind: "compensating" }, details: { invite_id: inv.id, household_id: inv.household_id } };
  },
  async apply(ctx, i, plan) {
    const { invite_id, household_id } = plan.details as { invite_id: string; household_id: string };
    await ctx.trx.selectFrom("person").select("id").where("id", "=", i.person_id).forUpdate().execute();
    const old = await householdOf(ctx.trx, i.person_id);
    if (old) await ctx.update("household_member", old.id, { removed_at: ctx.now });
    await ctx.insert("household_member", { id: uuidv7(), household_id, person_id: i.person_id, role: "adult", added_by: i.person_id });
    await ctx.update("household_invite", invite_id, { status: "accepted", accepted_by: i.person_id, decided_at: ctx.now });
    await ctx.emit("household.joined", { person_id: i.person_id, to: (await adultsNow(ctx.trx, household_id)).filter((a) => a !== i.person_id) });
    return { household_id };
  },
});

export const householdLeave = defineAction({
  name: "household.leave", version: 1,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const hh = await householdOf(ctx.db, i.person_id);
    if (!hh || hh.role === "junior") throw new KumiError("error.not_in_household");
    const rows = await ctx.db.selectFrom("household_member").select(["person_id", "role"]).where("household_id", "=", hh.household_id).where("removed_at", "is", null).execute();
    if (hh.role === "adult" && rows.filter((r) => r.role === "adult").length <= 1 && rows.some((r) => r.role === "junior")) throw new KumiError("error.household_last_adult");
    return { title: both("action.household.leave"), summary: both("plan.household.leave", { juniors: await juniorWords(ctx.db, i.person_id) }), reads: [],
      ownerIds: [i.person_id], undo: { kind: "compensating" }, details: { member_id: hh.id, household_id: hh.household_id } };
  },
  async apply(ctx, i, plan) {
    const { member_id, household_id } = plan.details as { member_id: string; household_id: string };
    await ctx.update("household_member", member_id, { removed_at: ctx.now });
    await ctx.emit("household.left", { person_id: i.person_id, to: await adultsNow(ctx.trx, household_id) });
    return null;
  },
});

/** A junior who has turned 18 (by birth year) gets a login of their own: an email to sign in with. They
 *  become an adult account and stay in the household, without managing its juniors. */
export const householdGiveLogin = defineAction({
  name: "household.give_login", version: 1,
  input: z.object({ person_id: z.uuid(), email: z.email() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    if (!row.junior) throw new KumiError("error.not_a_junior", { name: row.display_name });
    if (row.birth_year && (await clubYear(ctx.db, ctx.now)) - row.birth_year < ADULT_AGE) throw new KumiError("error.junior_too_young", { name: row.display_name, year: row.birth_year + ADULT_AGE });
    const email = i.email.trim().toLowerCase();
    if (await ctx.db.selectFrom("person").select("id").where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).executeTakeFirst()) throw new KumiError("error.duplicate_email");
    return { title: both("action.household.give_login"), summary: both("plan.household.give_login", { name: row.display_name, email }), reads: [read], ownerIds: await withManagers(ctx.db, [i.person_id]),
      undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const email = i.email.trim().toLowerCase();
    await ctx.update("person", i.person_id, { email, junior: false });
    try { await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: i.person_id, kind: "email", value: email, verified_at: null }).execute(); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.duplicate_email"); throw e; }
    const member = await ctx.trx.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
    await ctx.insert("person_role", { id: uuidv7(), person_id: i.person_id, role_id: member.id, location_id: null });
    const hh = await householdOf(ctx.trx, i.person_id);
    // Still in the family (a family plan can still cover them), but not one of the parents managing the juniors.
    if (hh) await ctx.update("household_member", hh.id, { role: "member" });
    await ctx.emit("household.login_given", { person_id: i.person_id });
    return null;
  },
});

// ---- The club's waiver ----
export async function currentWaiver(db: Db | Trx) {
  return (await db.selectFrom("waiver").select(["id", "version_no", "body", "created_at"]).where("active", "=", true).executeTakeFirst()) ?? null;
}
/** When the person accepted the current waiver, and who for them; null when there's no waiver. */
export async function waiverStatus(db: Db | Trx, personId: string) {
  const w = await currentWaiver(db);
  if (!w) return null;
  const a = await db.selectFrom("waiver_acceptance").innerJoin("person", "person.id", "waiver_acceptance.accepted_by").select(["waiver_acceptance.accepted_at", "person.display_name as accepted_by"])
    .where("waiver_id", "=", w.id).where("waiver_acceptance.person_id", "=", personId).executeTakeFirst();
  return { version_no: w.version_no, accepted_at: a?.accepted_at ?? null, accepted_by: a?.accepted_by ?? null };
}
/** Before a booking or sign-up: the person (or, for a junior, a parent) has to have accepted the current
 *  waiver. Staff at the desk aren't stopped: the person page shows who hasn't. */
export async function requireWaiver(ctx: PlanCtx, personId: string) {
  const st = await waiverStatus(ctx.db, personId);
  if (!st || st.accepted_at) return;
  const self = ctx.actor.personId === personId, parent = !self && await manages(ctx.db, ctx.actor.personId, personId);
  if (!self && !parent) return;
  if (self) throw new KumiError("error.waiver_needed");
  const name = (await ctx.db.selectFrom("person").select("display_name").where("id", "=", personId).executeTakeFirstOrThrow()).display_name;
  throw new KumiError("error.waiver_needed_junior", { name });
}

export const waiverSet = defineAction({
  name: "waiver.set", version: 1,
  input: z.object({ body: z.string().check(z.trim(), z.minLength(20), z.maxLength(20_000)) }),
  async plan(ctx) {
    const cur = await currentWaiver(ctx.db);
    const next = Number((await ctx.db.selectFrom("waiver").select(sql<string>`coalesce(max(version_no), 0)`.as("n")).executeTakeFirstOrThrow()).n) + 1;
    return { title: both("action.waiver.set"), summary: both(cur ? "plan.waiver.change" : "plan.waiver.set", { version: next }), reads: cur ? [(await readRow(ctx.db, "waiver", cur.id)).read] : [],
      undo: { kind: "compensating" }, details: { version_no: next } };
  },
  async apply(ctx, i, plan) {
    const cur = await currentWaiver(ctx.trx);
    if (cur) await ctx.update("waiver", cur.id, { active: false });
    const id = uuidv7();
    try { await ctx.insert("waiver", { id, version_no: (plan.details as { version_no: number }).version_no, body: i.body, created_by: ctx.actor.personId }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
    return { waiver_id: id };
  },
});

export const waiverClear = defineAction({
  name: "waiver.clear", version: 1,
  input: z.object({}),
  async plan(ctx) {
    const cur = await currentWaiver(ctx.db);
    if (!cur) throw new KumiError("error.no_waiver");
    return { title: both("action.waiver.clear"), summary: both("plan.waiver.clear"), reads: [(await readRow(ctx.db, "waiver", cur.id)).read], undo: { kind: "reversible" }, details: { waiver_id: cur.id } };
  },
  async apply(ctx, _i, plan) { await ctx.update("waiver", (plan.details as { waiver_id: string }).waiver_id, { active: false }); return null; },
});

export const waiverAccept = defineAction({
  name: "waiver.accept", version: 1,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const st = await waiverStatus(ctx.db, i.person_id);
    if (!st) throw new KumiError("error.no_waiver");
    const { row } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    if (st.accepted_at) throw new KumiError("error.waiver_accepted", { name: row.display_name });
    // Only the person, or a parent for their junior: nobody accepts it on someone else's behalf.
    const self = ctx.actor.personId === i.person_id;
    if (!self && !(await manages(ctx.db, ctx.actor.personId, i.person_id))) throw new KumiError("error.waiver_own");
    return { title: both("action.waiver.accept"), summary: both(self ? "plan.waiver.accept" : "plan.waiver.accept_junior", { version: st.version_no, name: row.display_name }),
      reads: [], ownerIds: await withManagers(ctx.db, [i.person_id]), undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const w = await currentWaiver(ctx.trx);
    if (!w) throw new KumiError("error.changed");
    try { await ctx.insert("waiver_acceptance", { id: uuidv7(), waiver_id: w.id, person_id: i.person_id, accepted_by: ctx.actor.personId, accepted_at: ctx.now }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
    return { version_no: w.version_no };
  },
});
