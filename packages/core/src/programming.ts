// Programming over time (action_catalogue.md series.edit; v1 "a minimum to run with an auto-cancel notice",
// "tell me when a spot opens"). A program is one roster over its dates, so editing a series means its dates:
// this one, this and the following ones, or all still to come. Dates that have started stay as they were.
// A minimum is decided once, a set time before the first date; staff hear first if it's short.
// A program signed up per date (programs.ts perDate) is a roster per date instead: its places, its minimum (decided
// before each date) and the people a change reaches are that date's.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, dateTime, money, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type PlanCtx, type Read } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { textOf } from "./club_text.ts";
import { uuidv7 } from "./ids.ts";
import { paymentProvider } from "./money.ts";
import { localDate, onDate } from "./clock.ts";
import { coachBusy, isCoach } from "./lessons.ts";
import { withManagers } from "./households.ts";
import { clashList, dateClashes } from "./program_clashes.ts";
import { clubTz, firstStart, freePlace, join2, leaving, paidFor, perDate, placesOf, signUpDate, startRefund, started, takenCount, tellWatchers, type ApplyContext, type Refund } from "./programs.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const when = (at: Date, tz: string): Text => ({ en: dateTime(at, "en", tz), es: dateTime(at, "es", tz) });
const joinAll = (parts: Text[]): Text => parts.reduce((a, b) => join2(a, b), { en: "", es: "" });
const scope = z.enum(["this", "following", "all"]);
type Scope = z.infer<typeof scope>;

/** The dates a change covers: the one chosen, it and the later ones, or every date still to come. */
async function scopeDates(db: Db | Trx, programId: string, chosen: { id: string; starts_at: Date }, s: Scope, now: Date) {
  if (s === "this") return [chosen];
  return db.selectFrom("session").select(["id", "starts_at"]).where("program_id", "=", programId).where("status", "!=", "cancelled").where("starts_at", ">", now)
    .$if(s === "following", (q) => q.where("starts_at", ">=", chosen.starts_at)).orderBy("starts_at").execute();
}

/** The chosen date and its program, refused if it can't be changed any more. */
async function chosenDate(ctx: PlanCtx, sessionId: string) {
  const { row: s, read } = await readRow(ctx.db, "session", sessionId, "thing.session");
  const { row: p, read: pRead } = await readRow(ctx.db, "program", s.program_id, "thing.program");
  if (p.status === "cancelled") throw new KumiError("error.program_cancelled", { name: textOf(p.name, p.translations, "name") });
  if (s.status === "cancelled") throw new KumiError("error.date_cancelled");
  if (new Date(s.starts_at) <= ctx.now) throw new KumiError("error.date_started");
  return { s, p, read, pRead };
}

/** Each date as it is now: when, courts and coach. */
async function datesNow(db: Db | Trx, ids: string[]) {
  const rows = await db.selectFrom("session").selectAll().where("id", "in", ids).orderBy("starts_at").execute();
  const courts = await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").select(["court_time.session_id", "court.id", "court.name"])
    .where("court_time.session_id", "in", ids).where("court_time.active", "=", true).orderBy("court.name").execute();
  return rows.map((r) => { const mine = courts.filter((c) => c.session_id === r.id); return { ...r, court_ids: mine.map((c) => c.id), courts: mine.map((c) => c.name) }; });
}

async function names(db: Db | Trx, ids: string[]) {
  return new Map((ids.length ? await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", ids).execute() : []).map((p) => [p.id, p.display_name as string]));
}

/** Who has a place (booked), and how many are waiting, for a plan to say. */
async function rosterOf(db: Db | Trx, programId: string, sessionIds: string[] | null = null) {
  const rows = await db.selectFrom("enrolment").innerJoin("person", "person.id", "enrolment.person_id").select(["enrolment.id", "enrolment.person_id", "enrolment.status", "enrolment.price_basis", "person.display_name"])
    .where("enrolment.program_id", "=", programId).where("enrolment.status", "in", ["booked", "waitlisted"])
    .$if(sessionIds !== null, (q) => q.where("enrolment.session_id", "in", sessionIds!.length ? sessionIds! : ["00000000-0000-0000-0000-000000000000"])).orderBy("enrolment.created_at").execute();
  return { booked: rows.filter((r) => r.status === "booked"), waiting: rows.filter((r) => r.status === "waitlisted") };
}
function rosterLine(r: Awaited<ReturnType<typeof rosterOf>>): Text {
  if (!r.booked.length) return both("plan.series.nobody");
  const names = [...new Set(r.booked.map((b) => b.display_name))];
  return both(r.waiting.length ? "plan.series.people_waiting" : "plan.series.people", { names: names.join(", "), count: names.length, waiting: r.waiting.length });
}

// ---- Editing dates ----
const hhmm = z.string().check(z.regex(/^([01]\d|2[0-3]):[0-5]\d$/));
export const seriesEdit = defineAction({
  name: "series.edit", version: 1,
  input: z.object({
    session_id: z.uuid(), scope,
    starts_at: z.optional(z.iso.datetime({ offset: true }).check(z.describe("A new date and time for this one date (scope this)."))),
    start_time: z.optional(hhmm.check(z.describe("Each date keeps its day and starts at this club time, such as 19:00."))),
    minutes: z.optional(z.number().check(z.int(), z.minimum(15), z.maximum(720), z.describe("How long each date runs."))),
    court_ids: z.optional(z.array(z.uuid()).check(z.minLength(1))),
    coach_id: z.optional(z.nullable(z.uuid().check(z.describe("Who runs them; null for nobody named.")))),
    capacity: z.optional(z.number().check(z.int(), z.minimum(1), z.describe("Places in the program, for all its dates. Signed up per date: the places on each date chosen (this, following, all)."))),
  }),
  async plan(ctx, i) {
    const { s, p, read, pRead } = await chosenDate(ctx, i.session_id);
    if (i.starts_at && i.scope !== "this") throw new KumiError("error.new_date_one_only");
    if (i.starts_at && i.start_time) throw new KumiError("error.new_date_one_only");
    const moves = Boolean(i.starts_at || i.start_time || i.minutes || i.court_ids || i.coach_id !== undefined);
    if (!moves && i.capacity === undefined) throw new KumiError("error.nothing_changed");
    const tz = await clubTz(ctx.db), chosen = await scopeDates(ctx.db, p.id, { id: s.id, starts_at: new Date(s.starts_at) }, i.scope, ctx.now);
    const before = await datesNow(ctx.db, chosen.map((d) => d.id));
    if (i.court_ids) {
      const courts = await ctx.db.selectFrom("court").select(["id", "location_id"]).where("id", "in", i.court_ids).where("archived_at", "is", null).execute();
      if (courts.length !== new Set(i.court_ids).size || courts.some((c) => c.location_id !== p.location_id)) throw new KumiError("error.not_found", { thing: both("thing.court") }, 404);
    }
    if (i.coach_id && !(await isCoach(ctx.db, i.coach_id))) throw new KumiError("error.not_a_coach", { name: (await names(ctx.db, [i.coach_id])).get(i.coach_id) ?? "" });
    const courtNames = new Map((await ctx.db.selectFrom("court").select(["id", "name"]).where("location_id", "=", p.location_id).execute()).map((c) => [c.id, c.name as string]));
    // Each date as it would be.
    const after = before.map((d) => {
      const start = i.starts_at ? new Date(i.starts_at) : i.start_time ? onDate(localDate(new Date(d.starts_at), tz), i.start_time, tz) : new Date(d.starts_at);
      const length = i.minutes ? i.minutes * 60_000 : new Date(d.ends_at).getTime() - new Date(d.starts_at).getTime();
      const courtIds = i.court_ids ? [...i.court_ids].sort((a, b) => (courtNames.get(a) ?? "").localeCompare(courtNames.get(b) ?? "")) : d.court_ids;
      return { id: d.id, version: d.version, start, end: new Date(start.getTime() + length), court_ids: courtIds, coach_id: i.coach_id !== undefined ? i.coach_id : d.coach_id };
    });
    for (const a of after) if (a.start <= ctx.now) throw new KumiError("error.date_in_past");
    const changed = after.filter((a, k) => { const b = before[k]!; return a.start.getTime() !== new Date(b.starts_at).getTime() || a.end.getTime() !== new Date(b.ends_at).getTime()
      || a.court_ids.join() !== b.court_ids.join() || a.coach_id !== b.coach_id; });
    // What's in the way of the dates as they'd be (their own court time and coach don't count).
    const clashes = changed.length ? await dateClashes(ctx.db, { programId: p.id, locationId: p.location_id, levelMin: p.level_min, levelMax: p.level_max, now: ctx.now, tz,
      slots: changed.map((a) => ({ start: a.start, end: a.end, courtIds: a.court_ids, coachId: a.coach_id })), skipSessions: before.map((b) => b.id) }) : [];
    const blocks = clashes.filter((c) => c.blocks), warnings = clashes.filter((c) => !c.blocks);
    if (blocks.length) throw new KumiError("error.dates_clash", { list: clashList(blocks) });
    const byDate = perDate(p), roster = await rosterOf(ctx.db, p.id, byDate ? changed.map((c) => c.id) : null);
    if (i.capacity !== undefined && !byDate) {
      const holding = await takenCount(ctx.db, p.id, ctx.now);
      if (i.capacity < holding) throw new KumiError("error.capacity_below", { count: holding });
    }
    // Per date: each date chosen gets that many places, and none can go below the places it has taken.
    const placesChange = i.capacity !== undefined && byDate ? await Promise.all(before.map(async (b) => ({ id: b.id, start: new Date(b.starts_at), was: await placesOf(ctx.db, p.id, b.id), taken: await takenCount(ctx.db, p.id, ctx.now, b.id) }))) : [];
    for (const d of placesChange) if (i.capacity! < d.taken) throw new KumiError("error.capacity_below_date", { when: when(d.start, tz), count: d.taken });
    const coaches = await names(ctx.db, [...new Set(after.map((a) => a.coach_id).filter((x): x is string => Boolean(x)))]);
    const describe = (start: Date, end: Date, courtIds: string[], coachId: string | null): Text => both(coachId ? "plan.series.as_coach" : "plan.series.as", {
      when: when(start, tz), minutes: Math.round((end.getTime() - start.getTime()) / 60_000), courts: courtIds.map((c) => courtNames.get(c) ?? "").join(", "), coach: coachId ? coaches.get(coachId) ?? "" : "" });
    // A line per date changed: what it was, and what it will be (and the reverse, should it be undone).
    const lines = changed.map((a) => { const b = before.find((x) => x.id === a.id)!; return both("plan.series.date", { was: when(new Date(b.starts_at), tz), now: describe(a.start, a.end, a.court_ids, a.coach_id) }); });
    const back = changed.map((a) => { const b = before.find((x) => x.id === a.id)!; return both("plan.series.back", { now: describe(new Date(b.starts_at), new Date(b.ends_at), b.court_ids, b.coach_id) }); });
    let summary = both(`plan.series.edit_${i.scope}` as Key, { name: textOf(p.name, p.translations, "name"), count: changed.length });
    if (moves && !changed.length) summary = both("plan.series.no_date_change", { name: textOf(p.name, p.translations, "name") });
    summary = join2(summary, joinAll(lines));
    const placesMoved = placesChange.filter((d) => d.was !== i.capacity);
    if (byDate && placesMoved.length) summary = join2(summary, both("plan.series.capacity_dates", { count: placesMoved.length, to: i.capacity! }));
    else if (!byDate && i.capacity !== undefined && i.capacity !== p.capacity) summary = join2(summary, both("plan.series.capacity", { from: p.capacity, to: i.capacity }));
    if (changed.length) summary = join2(summary, rosterLine(roster));
    if (warnings.length) summary = join2(summary, both("plan.dates_warnings", { list: clashList(warnings) }));
    if (!changed.length && (byDate ? !placesMoved.length : i.capacity === undefined || i.capacity === p.capacity)) throw new KumiError("error.nothing_changed");
    const reads: Read[] = [read, pRead, ...before.filter((b) => b.id !== s.id).map((b) => ({ entity: "session" as const, id: b.id, version: b.version }))];
    return { title: both("action.series.edit"), summary, reads, locationId: p.location_id, undo: { kind: "compensating" },
      details: { program_id: p.id, name: textOf(p.name, p.translations, "name"), places_dates: placesChange.map((d) => d.id), changed: changed.map((a) => ({ id: a.id, start: a.start.toISOString(), end: a.end.toISOString(), court_ids: a.court_ids, coach_id: a.coach_id })),
        lines: joinAll(lines), back: joinAll(back), people: [...new Set(roster.booked.map((b) => b.person_id))], first_before: before[0] ? new Date(before[0].starts_at).toISOString() : null } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { program_id: string; name: string | Text; changed: { id: string; start: string; end: string; court_ids: string[]; coach_id: string | null }[]; lines: Text; back: Text; people: string[] };
    // The coach first, then the courts in id order (spikes/booking_race.md), as when a date is added.
    const coaches = [...new Set(d.changed.map((c) => c.coach_id).filter((x): x is string => Boolean(x)))].sort();
    for (const c of coaches) await ctx.trx.selectFrom("person").select("id").where("id", "=", c).forUpdate().execute();
    for (const c of [...new Set(d.changed.flatMap((x) => x.court_ids))].sort()) await ctx.trx.selectFrom("court").select("id").where("id", "=", c).forUpdate().execute();
    const ids = d.changed.map((c) => c.id);
    for (const c of d.changed) {
      // Booked meanwhile (a lesson, or another date): look again.
      if (c.coach_id && (await coachBusy(ctx.trx, c.coach_id, new Date(c.start), new Date(c.end), ctx.now)).some((x) => x.kind === "lesson" || !ids.includes(x.id))) throw new KumiError("error.changed");
      // The date's court time moves with it: the old let go, the new taken (the database refuses a clash).
      for (const t of await ctx.trx.selectFrom("court_time").select("id").where("session_id", "=", c.id).where("active", "=", true).execute()) await ctx.update("court_time", t.id, { active: false });
      try {
        for (const court of c.court_ids) await ctx.insert("court_time", { id: uuidv7(), court_id: court, during: sql`tstzrange(${new Date(c.start)}, ${new Date(c.end)})`, kind: "session", session_id: c.id });
      } catch (e: any) { if (e?.code === "23P01") throw new KumiError("error.court_taken"); throw e; }
      await ctx.update("session", c.id, { starts_at: new Date(c.start), ends_at: new Date(c.end), coach_id: c.coach_id });
    }
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", d.program_id).forUpdate().executeTakeFirstOrThrow();
    // A first date that moved is decided again (its minimum), unless it's been decided already. Per date: each date moved.
    const first = await firstStart(ctx.trx, p.id), was = (plan.details as { first_before: string | null }).first_before;
    if (!perDate(p) && !p.min_decided_at && p.min_heads_up_at && first && was && first.getTime() !== new Date(was).getTime()) await ctx.update("program", p.id, { min_heads_up_at: null });
    if (perDate(p)) for (const c of d.changed) {
      const s = await ctx.trx.selectFrom("session").select(["min_decided_at", "min_heads_up_at"]).where("id", "=", c.id).executeTakeFirstOrThrow();
      if (!s.min_decided_at && s.min_heads_up_at) await ctx.update("session", c.id, { min_heads_up_at: null });
    }
    const placesDates = (plan.details as { places_dates?: string[] }).places_dates ?? [];
    if (perDate(p) && i.capacity !== undefined) for (const sid of placesDates) {
      await ctx.update("session", sid, { capacity_override: i.capacity === p.capacity ? null : i.capacity });
      // More places on that date: its waitlist is offered them first; any still free, whoever is watching it hears.
      while ((await takenCount(ctx.trx, p.id, ctx.now, sid)) < i.capacity && await freePlace(ctx, p.id, [], sid)) { /* one offer per free place */ }
      await tellWatchers(ctx, p.id, sid);
    }
    if (!perDate(p) && i.capacity !== undefined && i.capacity !== p.capacity) {
      await ctx.update("program", p.id, { capacity: i.capacity });
      // More places: the waitlist is offered them first; any still free, whoever is watching hears.
      while ((await takenCount(ctx.trx, p.id, ctx.now)) < i.capacity && await freePlace(ctx, p.id)) { /* one offer per free place */ }
      await tellWatchers(ctx, p.id);
    }
    if (d.changed.length) await ctx.emit("dates.changed", { program_id: p.id, name: d.name, lines: d.lines, people: d.people });
    return { changed: d.changed.length };
  },
});

// ---- Cancelling dates ----
type Choice = "rule" | "full" | "none";
interface Going { enrolment_id: string; person_id: string; status: string; paid: number; cents: number; rule: number; outcome: Refund["outcome"]; back: boolean; reprice: number | null; leaves?: boolean }

/** What cancelling these dates means for each person. A program left with no dates at all is cancelled,
 *  and everyone gets back what they paid. Some dates of a course paid once: each person gets back those
 *  dates' share of what they paid (the rule), or staff choose all of it or nothing. */
async function cancelling(db: Db | Trx, programId: string, sessionIds: string[], choice: Choice) {
  const live = await db.selectFrom("session").select("id").where("program_id", "=", programId).where("status", "!=", "cancelled").execute();
  const entire = live.every((l) => sessionIds.includes(l.id));
  const program = await db.selectFrom("program").select("sign_up").where("id", "=", programId).executeTakeFirstOrThrow();
  if (perDate(program)) {
    // Signed up per date: only the people on these dates are touched, and each date was bought on its own, so the rule
    // gives back all of what was paid for it (and an included session) unless staff choose otherwise.
    const rows = await db.selectFrom("enrolment").select(["id", "person_id", "status", "price_basis"]).where("program_id", "=", programId).where("status", "in", ["booked", "waitlisted"])
      .where("session_id", "in", sessionIds.length ? sessionIds : ["00000000-0000-0000-0000-000000000000"]).execute();
    const people: Going[] = [];
    for (const e of rows) {
      const paid = e.status === "booked" ? await paidFor(db, e.id) : 0;
      const cents = choice === "none" ? 0 : paid;
      people.push({ enrolment_id: e.id, person_id: e.person_id, status: e.status, paid, cents, rule: paid, outcome: cents <= 0 ? "none" : "full",
        back: e.price_basis === "included" && choice !== "none", reprice: null, leaves: true });
    }
    return { entire, people, total: people.reduce((n, x) => n + x.cents, 0) };
  }
  const rows = await db.selectFrom("enrolment").select(["id", "person_id", "status", "price_basis", "price_cents"]).where("program_id", "=", programId).where("status", "in", ["booked", "waitlisted"]).execute();
  const people: Going[] = [];
  for (const e of rows) {
    if (e.status !== "booked") { if (entire) people.push({ enrolment_id: e.id, person_id: e.person_id, status: e.status, paid: 0, cents: 0, rule: 0, outcome: "none", back: false, reprice: null }); continue; }
    const paid = await paidFor(db, e.id);
    const rule = entire ? paid : Math.round(paid * sessionIds.length / Math.max(1, live.length));
    const cents = choice === "full" ? paid : choice === "none" ? 0 : rule;
    // A place not paid for yet: its price comes down to the dates left, as a payment's share would come back.
    const reprice = !entire && paid === 0 && e.price_cents > 0 ? Math.round(e.price_cents * (live.length - sessionIds.length) / Math.max(1, live.length)) : null;
    people.push({ enrolment_id: e.id, person_id: e.person_id, status: e.status, paid, cents, rule, outcome: cents <= 0 ? "none" : cents >= paid ? "full" : "partial",
      back: entire && e.price_basis === "included" && choice !== "none", reprice });
  }
  return { entire, people, total: people.reduce((n, x) => n + x.cents, 0) };
}

/** Cancel dates (and the program, if none are left): court time let go, refunds started, everyone told. */
async function cancelDates(ctx: ApplyContext, programId: string, sessionIds: string[], c: Awaited<ReturnType<typeof cancelling>>, reason: "club" | "below_minimum", note: string | null) {
  const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", programId).forUpdate().executeTakeFirstOrThrow();
  const dates = await ctx.trx.selectFrom("session").select(["id", "starts_at"]).where("id", "in", sessionIds).orderBy("starts_at").execute();
  for (const s of dates) {
    await ctx.update("session", s.id, { status: "cancelled" });
    for (const t of await ctx.trx.selectFrom("court_time").select("id").where("session_id", "=", s.id).where("active", "=", true).execute()) await ctx.update("court_time", t.id, { active: false });
  }
  const desk: Record<string, number> = {};   // what goes back at the desk, for each place
  for (const g of c.people) {
    const refund: Refund = { outcome: g.outcome, cents: g.cents, text: { en: "", es: "" }, changed: g.cents !== g.rule };
    if (g.cents > 0) desk[g.enrolment_id] = (await startRefund(ctx, g.enrolment_id, g.person_id, refund)).desk;
    if (g.reprice !== null) {
      await ctx.update("enrolment", g.enrolment_id, { price_cents: g.reprice });
      // What's still owed for it: the new price. One a card form already opened is called off, and a new one asked.
      for (const pay of await ctx.trx.selectFrom("payment").select(["id", "provider_ref"]).where("enrolment_id", "=", g.enrolment_id).where("status", "=", "pending").execute()) {
        if (!pay.provider_ref) { await ctx.update("payment", pay.id, { amount_cents: g.reprice }); continue; }
        await ctx.update("payment", pay.id, { status: "failed" });
        if (g.reprice > 0) await ctx.insert("payment", { id: uuidv7(), person_id: g.person_id, amount_cents: g.reprice, method: "card", provider: paymentProvider().name, provider_ref: null, status: "pending", enrolment_id: g.enrolment_id });
      }
    }
    if (!c.entire && !g.leaves) continue;
    await ctx.update("enrolment", g.enrolment_id, { ...leaving(refund, "removed", "club", p.refund_rule_version, note ?? undefined), left_at: ctx.now, included_back: g.back });
    for (const o of await ctx.trx.selectFrom("waitlist_offer").select("id").where("enrolment_id", "=", g.enrolment_id).where("outcome", "is", null).execute()) await ctx.update("waitlist_offer", o.id, { outcome: "expired" });
    // A place on a cancelled date that wasn't paid for yet can't be paid any more.
    if (g.leaves && !c.entire) for (const pay of await ctx.trx.selectFrom("payment").select("id").where("enrolment_id", "=", g.enrolment_id).where("status", "=", "pending").where("provider_ref", "is", null).execute())
      await ctx.update("payment", pay.id, { status: "failed" });
  }
  // Per date: nobody needs telling when a place opens on a cancelled date.
  if (perDate(p)) for (const w of await ctx.trx.selectFrom("program_watch").select("id").where("session_id", "in", sessionIds.length ? sessionIds : ["00000000-0000-0000-0000-000000000000"]).where("told_at", "is", null).where("ended_at", "is", null).execute())
    await ctx.update("program_watch", w.id, { ended_at: ctx.now });
  if (c.entire) {
    // Places not paid for yet can't be paid any more; nobody needs telling when one opens.
    for (const pay of await ctx.trx.selectFrom("payment").innerJoin("enrolment", "enrolment.id", "payment.enrolment_id").select("payment.id")
      .where("enrolment.program_id", "=", programId).where("payment.status", "=", "pending").execute()) await ctx.update("payment", pay.id, { status: "failed" });
    for (const w of await ctx.trx.selectFrom("program_watch").select("id").where("program_id", "=", programId).where("told_at", "is", null).where("ended_at", "is", null).execute())
      await ctx.update("program_watch", w.id, { ended_at: ctx.now });
    await ctx.update("program", programId, { status: "cancelled", cancelled_at: ctx.now, cancel_reason: reason, ...(reason === "below_minimum" ? { min_decided_at: ctx.now } : {}) });
  }
  await ctx.emit("dates.cancelled", { program_id: programId, name: textOf(p.name, p.translations, "name"), starts: dates.map((d) => new Date(d.starts_at).toISOString()), entire: c.entire, reason,
    people: c.people.map((g) => ({ person_id: g.person_id, status: g.status, cents: g.cents, paid: g.paid, desk: desk[g.enrolment_id] ?? 0 })) });
}

/** The plan for cancelling: dates, what comes back to whom, and who's told. */
async function cancelPlan(ctx: PlanCtx, p: Record<string, any>, sessionIds: string[], choice: Choice, note: string | undefined, head: Text) {
  const tz = await clubTz(ctx.db), c = await cancelling(ctx.db, p.id, sessionIds, choice);
  // A refund other than the rule needs a reason, as anywhere a refund is changed.
  if (c.people.some((g) => g.cents !== g.rule) && !note?.trim()) throw new KumiError("error.refund_note_needed", {}, 400);
  const dates = await ctx.db.selectFrom("session").select("starts_at").where("id", "in", sessionIds.length ? sessionIds : ["00000000-0000-0000-0000-000000000000"]).orderBy("starts_at").execute();
  let summary = join2(head, joinAll(dates.map((d) => both("plan.series.cancel_date", { when: when(new Date(d.starts_at), tz) }))));
  const paying = c.people.filter((g) => g.cents > 0);
  summary = join2(summary, paying.length ? both("plan.series.refunds", { count: paying.length, amount: usd(c.total) })
    : c.people.some((g) => g.paid > 0) ? both("plan.series.no_refunds") : both("plan.series.nothing_paid"));
  const repriced = c.people.filter((g) => g.reprice !== null).length;
  if (repriced) summary = join2(summary, both("plan.series.unpaid_repriced", { count: repriced }));
  const booked = c.people.filter((g) => g.status === "booked").length, waiting = c.people.filter((g) => g.status === "waitlisted").length;
  summary = join2(summary, booked || waiting ? both("plan.series.told", { count: booked + waiting }) : both("plan.series.nobody"));
  const reads: Read[] = [{ entity: "program", id: p.id, version: p.version }];
  return { c, summary, reads, undo: c.entire || c.total > 0 ? { kind: "none" as const, note: both("undo.none", { reason: both(c.total > 0 ? "reason.refund_sent" : "reason.program_cancelled") }) } : { kind: "compensating" as const } };
}

const refundChoice = z.optional(z.enum(["rule", "full", "none"]).check(z.describe("rule: what was paid for these dates (all of it when nothing is left); full: everything paid; none: nothing. Other than the rule needs a note.")));
export const seriesCancel = defineAction({
  name: "series.cancel", version: 1,
  input: z.object({ session_id: z.uuid(), scope, refund: refundChoice, note: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const { s, p } = await chosenDate(ctx, i.session_id);
    const dates = await scopeDates(ctx.db, p.id, { id: s.id, starts_at: new Date(s.starts_at) }, i.scope, ctx.now);
    const ids = dates.map((d) => d.id), c0 = await cancelling(ctx.db, p.id, ids, "rule");
    const head = both(c0.entire ? "plan.series.cancel_program" : `plan.series.cancel_${i.scope}` as Key, { name: textOf(p.name, p.translations, "name"), count: ids.length });
    const x = await cancelPlan(ctx, p, ids, i.refund ?? "rule", i.note, head);
    return { title: both("action.series.cancel"), summary: x.summary, reads: x.reads, locationId: p.location_id, moneyCents: x.c.total, undo: x.undo, details: { ids, c: x.c } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { ids: string[]; c: Awaited<ReturnType<typeof cancelling>> };
    const p = await ctx.trx.selectFrom("session").select("program_id").where("id", "=", i.session_id).executeTakeFirstOrThrow();
    await cancelDates(ctx, p.program_id, d.ids, d.c, "club", i.note ?? null);
    return { cancelled: d.ids.length, program_cancelled: d.c.entire };
  },
});

/** The whole program: its dates still to come (and the program, when none have run). */
export const programCancel = defineAction({
  name: "program.cancel", version: 1,
  input: z.object({ program_id: z.uuid(), refund: refundChoice, note: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const { row: p } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    if (p.status === "cancelled") throw new KumiError("error.program_cancelled", { name: textOf(p.name, p.translations, "name") });
    const ran = await ctx.db.selectFrom("session").select("id").where("program_id", "=", p.id).where("status", "!=", "cancelled").where("starts_at", "<=", ctx.now).executeTakeFirst();
    const ids = (await ctx.db.selectFrom("session").select("id").where("program_id", "=", p.id).where("status", "!=", "cancelled").where("starts_at", ">", ctx.now).execute()).map((x) => x.id);
    if (ran && !ids.length) throw new KumiError("error.program_ran");
    const head = both(ran ? "plan.series.cancel_rest" : "plan.series.cancel_program", { name: textOf(p.name, p.translations, "name"), count: ids.length });
    const x = await cancelPlan(ctx, p, ids, i.refund ?? "rule", i.note, head);
    return { title: both("action.program.cancel"), summary: x.summary, reads: x.reads, locationId: p.location_id, moneyCents: x.c.total, undo: x.undo, details: { ids, c: x.c } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { ids: string[]; c: Awaited<ReturnType<typeof cancelling>> };
    await cancelDates(ctx, i.program_id, d.ids, d.c, "club", i.note ?? null);
    return { cancelled: d.ids.length, program_cancelled: d.c.entire };
  },
});

// ---- A minimum to run ----
async function decideHours(db: Db | Trx, p: { decide_hours: number | null }) {
  return p.decide_hours ?? (await db.selectFrom("club").select("program_decide_hours").executeTakeFirstOrThrow()).program_decide_hours;
}

export const programSetMinimum = defineAction({
  name: "program.set_minimum", version: 1,
  input: z.object({ program_id: z.uuid(), min_players: z.nullable(z.number().check(z.int(), z.minimum(1))),
    decide_hours: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(336), z.describe("Hours before the first date it's decided. Null: the club's default.")))) }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    if (p.status === "cancelled") throw new KumiError("error.program_cancelled", { name: textOf(p.name, p.translations, "name") });
    if (i.min_players !== null && i.min_players > p.capacity) throw new KumiError("error.min_over_capacity", { capacity: p.capacity });
    const hours = await decideHours(ctx.db, { decide_hours: i.decide_hours === undefined ? p.decide_hours : i.decide_hours });
    const summary = i.min_players === null ? both("plan.program.no_minimum", { name: textOf(p.name, p.translations, "name") }) : both(perDate(p) ? "plan.program.minimum_date" : "plan.program.minimum", { name: textOf(p.name, p.translations, "name"), min: i.min_players, hours: both("count.hours", { count: hours }) });
    return { title: both("action.program.set_minimum"), summary, reads: [read], locationId: p.location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).executeTakeFirstOrThrow();
    const patch: Record<string, unknown> = { min_players: i.min_players, ...(i.decide_hours !== undefined ? { decide_hours: i.decide_hours } : {}) };
    // Not decided yet: the new minimum is looked at afresh (a heads-up about the old one no longer counts).
    if (!p.min_decided_at) patch.min_heads_up_at = null;
    await ctx.update("program", i.program_id, patch);
    // Per date: each date not decided yet is looked at afresh too.
    if (perDate(p)) for (const s of await ctx.trx.selectFrom("session").select("id").where("program_id", "=", p.id).where("min_decided_at", "is", null).where("min_heads_up_at", "is not", null).execute())
      await ctx.update("session", s.id, { min_heads_up_at: null });
    return null;
  },
});

/** At the decision time: short of the minimum, the program is cancelled and everyone paid back; otherwise it runs.
 *  Signed up per date: one date is decided, and only it is cancelled when it's short. */
export const programDecide = defineAction({
  name: "program.decide", version: 1, system: true, internal: true,
  input: z.object({ program_id: z.uuid(), session_id: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    return { title: both("action.program.decide"), summary: both("plan.program.decide", { name: textOf(row.name, row.translations, "name") }), reads: [read], undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();
    if (p.status !== "published" || p.min_players === null) return { already: true };
    if (perDate(p)) {
      const s = await ctx.trx.selectFrom("session").selectAll().where("id", "=", i.session_id ?? "00000000-0000-0000-0000-000000000000").where("program_id", "=", p.id).executeTakeFirst();
      if (!s || s.min_decided_at || s.status === "cancelled") return { already: true };
      const booked = await bookedOn(ctx.trx, p.id, s.id);
      await ctx.update("session", s.id, { min_decided_at: ctx.now });
      if (booked >= p.min_players) return { runs: true, booked };
      await cancelDates(ctx, p.id, [s.id], await cancelling(ctx.trx, p.id, [s.id], "rule"), "below_minimum", null);
      await ctx.emit("program.min_cancelled", { program_id: p.id, name: textOf(p.name, p.translations, "name"), starts_at: new Date(s.starts_at).toISOString(), booked, min: p.min_players });
      return { runs: false, booked };
    }
    if (p.min_decided_at) return { already: true };
    const booked = await bookedOn(ctx.trx, p.id, null);
    if (booked >= p.min_players) { await ctx.update("program", p.id, { min_decided_at: ctx.now }); return { runs: true, booked }; }
    const start = await firstStart(ctx.trx, p.id);
    const ids = (await ctx.trx.selectFrom("session").select("id").where("program_id", "=", p.id).where("status", "!=", "cancelled").execute()).map((s) => s.id);
    await cancelDates(ctx, p.id, ids, await cancelling(ctx.trx, p.id, ids, "rule"), "below_minimum", null);
    await ctx.emit("program.min_cancelled", { program_id: p.id, name: textOf(p.name, p.translations, "name"), starts_at: start?.toISOString() ?? null, booked, min: p.min_players });
    return { runs: false, booked };
  },
});

/** How many have a place: in the program, or on one date of it. */
async function bookedOn(db: Db | Trx, programId: string, sessionId: string | null) {
  return Number((await db.selectFrom("enrolment").select((eb) => eb.fn.countAll<string>().as("n")).where("program_id", "=", programId).where("status", "=", "booked")
    .$if(Boolean(sessionId), (q) => q.where("session_id", "=", sessionId!)).executeTakeFirstOrThrow()).n);
}

/** Before the decision: staff hear once that it's short, and by how many, so they can push it. */
export const programMinHeadsUp = defineAction({
  name: "program.min_heads_up", version: 1, system: true, internal: true,
  input: z.object({ program_id: z.uuid(), session_id: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    return { title: both("action.program.min_heads_up"), summary: both("plan.program.min_heads_up", { name: textOf(row.name, row.translations, "name") }), reads: [read], undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    const p = await ctx.trx.selectFrom("program").selectAll().where("id", "=", i.program_id).forUpdate().executeTakeFirstOrThrow();
    if (p.min_players === null) return { already: true };
    let start: Date | null, sid: string | null = null;
    if (perDate(p)) {
      const s = await ctx.trx.selectFrom("session").selectAll().where("id", "=", i.session_id ?? "00000000-0000-0000-0000-000000000000").where("program_id", "=", p.id).executeTakeFirst();
      if (!s || s.min_heads_up_at || s.min_decided_at || s.status === "cancelled") return { already: true };
      await ctx.update("session", s.id, { min_heads_up_at: ctx.now });
      start = new Date(s.starts_at); sid = s.id;
    } else {
      if (p.min_heads_up_at || p.min_decided_at) return { already: true };
      await ctx.update("program", p.id, { min_heads_up_at: ctx.now });
      start = await firstStart(ctx.trx, p.id);
    }
    const booked = await bookedOn(ctx.trx, p.id, sid);
    if (booked >= p.min_players) return { short: false };
    const decideAt = start ? new Date(start.getTime() - (await decideHours(ctx.trx, p)) * 3600_000) : null;
    await ctx.emit("program.min_short", { program_id: p.id, name: textOf(p.name, p.translations, "name"), starts_at: start?.toISOString() ?? null, decide_at: decideAt?.toISOString() ?? null, booked, min: p.min_players });
    return { short: true, missing: p.min_players - booked };
  },
});

/** The job: programs with a minimum, heads-up first, then the decision (for one signed up per date, each date in
 *  turn). Nothing due means no action run. */
export async function decidePrograms(db: Db, now = new Date()) {
  const club = await db.selectFrom("club").select(["program_decide_hours", "program_heads_up_hours"]).executeTakeFirstOrThrow();
  const rows = await db.selectFrom("program").select(["id", "min_players", "decide_hours", "min_heads_up_at"])
    .select((eb) => [
      eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").where("session.status", "!=", "cancelled").as("first_start"),
      eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.program_id", "=", "program.id").where("enrolment.status", "=", "booked").as("booked"),
    ]).where("status", "=", "published").where("min_players", "is not", null).where("min_decided_at", "is", null).where("sign_up", "=", "whole_program").execute();
  // Each date of a program signed up per date, not decided yet, with its own count.
  const dates = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id")
    .select(["session.id as session_id", "session.starts_at as first_start", "session.min_heads_up_at", "program.id", "program.min_players", "program.decide_hours"])
    .select((eb) => eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.session_id", "=", "session.id").where("enrolment.status", "=", "booked").as("booked"))
    .where("program.status", "=", "published").where("program.min_players", "is not", null).where("program.sign_up", "=", "per_session")
    .where("session.status", "!=", "cancelled").where("session.min_decided_at", "is", null).where("session.starts_at", ">", now).execute();
  let cancelled = 0, ran = 0, warned = 0;
  for (const r of [...rows.map((x) => ({ ...x, session_id: null as string | null })), ...dates]) {
    if (!r.first_start || new Date(r.first_start as any) <= now) continue;
    const decideAt = new Date(new Date(r.first_start as any).getTime() - (r.decide_hours ?? club.program_decide_hours) * 3600_000);
    const input = { program_id: r.id, ...(r.session_id ? { session_id: r.session_id } : {}) };
    if (now >= decideAt) {
      const x = (await runAsSystem(db, "program.decide", input, "job:minimum", { now })).result as { runs?: boolean };
      if (x.runs === false) cancelled++; else if (x.runs) ran++;
    } else if (club.program_heads_up_hours > 0 && !r.min_heads_up_at && Number(r.booked ?? 0) < r.min_players! && now.getTime() >= decideAt.getTime() - club.program_heads_up_hours * 3600_000) {
      const x = (await runAsSystem(db, "program.min_heads_up", input, "job:minimum", { now })).result as { short?: boolean };
      if (x.short) warned++;
    }
  }
  return { cancelled, ran, warned };
}

// ---- Tell me when a place opens ----
export const programWatch = defineAction({
  name: "program.watch", version: 1,
  input: z.object({ program_id: z.uuid(), person_id: z.uuid(), session_id: z.optional(z.uuid().check(z.describe("The date, for a program signed up per date."))) }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "program", i.program_id, "thing.program");
    if (p.status !== "published") throw new KumiError("error.not_published");
    const date = await signUpDate(ctx.db, p, i.session_id, ctx.now), sid = date?.id ?? null;
    if (await started(ctx.db, p.id, ctx.now, sid)) throw new KumiError("error.date_started");
    const person = (await names(ctx.db, [i.person_id])).get(i.person_id) ?? "";
    if (await ctx.db.selectFrom("enrolment").select("id").where("program_id", "=", p.id).where("person_id", "=", i.person_id).where("status", "in", ["booked", "waitlisted"])
      .$if(Boolean(sid), (q) => q.where("session_id", "=", sid!)).executeTakeFirst())
      throw new KumiError("error.already_signed_up", { person });
    if ((await takenCount(ctx.db, p.id, ctx.now, sid)) < await placesOf(ctx.db, p.id, sid)) throw new KumiError("error.places_open");
    if (await ctx.db.selectFrom("program_watch").select("id").where("program_id", "=", p.id).where("person_id", "=", i.person_id).where("told_at", "is", null).where("ended_at", "is", null)
      .where(sql<boolean>`session_id IS NOT DISTINCT FROM ${sid}`).executeTakeFirst())
      throw new KumiError("error.already_watching");
    const onDate = date ? both("plan.enrolment.on_date", { when: when(new Date(date.starts_at), await clubTz(ctx.db)) }) : { en: "", es: "" };
    return { title: both("action.program.watch"), summary: join2(both("plan.program.watch", { person, name: textOf(p.name, p.translations, "name") }), onDate), reads: [read], locationId: p.location_id,
      ownerIds: await withManagers(ctx.db, [i.person_id]), undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    try { await ctx.insert("program_watch", { id, program_id: i.program_id, person_id: i.person_id, session_id: i.session_id ?? null }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.already_watching"); throw e; }
    return { watch_id: id };
  },
});

export const programUnwatch = defineAction({
  name: "program.unwatch", version: 1,
  input: z.object({ watch_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: w, read } = await readRow(ctx.db, "program_watch", i.watch_id, "thing.program");
    if (w.told_at || w.ended_at) throw new KumiError("error.not_watching");
    const { row: p } = await readRow(ctx.db, "program", w.program_id, "thing.program");
    return { title: both("action.program.unwatch"), summary: both("plan.program.unwatch", { person: (await names(ctx.db, [w.person_id])).get(w.person_id) ?? "", name: textOf(p.name, p.translations, "name") }), reads: [read],
      locationId: p.location_id, ownerIds: await withManagers(ctx.db, [w.person_id]), undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("program_watch", i.watch_id, { ended_at: ctx.now }); return null; },
});
