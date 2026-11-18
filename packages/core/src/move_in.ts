// The guided move-in (docs/setup/moving-in.md): five steps that tie together what openPadel already does to bring a
// club over from Playtomic, Playbypoint, CourtReserve or spreadsheets. 1 Connect the old system, 2 Review what comes across,
// 3 a practice run while players stay on the old system, 4 the switch-over, 5 wrap up. Each step's real work stays in
// its own actions (person.import, playtomic.upload, credit.bring_in, membership.bring_in, the Playtomic page's links
// and take-overs); what lives here is where the club is: its source, its step, when it plans to switch, the items
// staff say are done that openPadel can't see (anything in the old system or on the club's own website), and when the
// owner called the move finished. That's club data, so it changes only through these actions. Nothing here writes to
// the old system, sends anyone anything or moves money.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, type Plan } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { PLAYTOMIC } from "./playtomic.ts";

export const MOVE_STEPS = ["connect", "review", "practice", "switch", "wrap_up"] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];
export const MOVE_SOURCES = ["playtomic", "playbypoint", "courtreserve", "spreadsheet"] as const;
export type MoveSource = (typeof MOVE_SOURCES)[number];
type Who = "you" | "both";

/** The items staff tick themselves, by step: what happens in the old system or out in the world, which openPadel
 *  can't see. What it can see (bookings taken over, wallets at zero, members booking here, practice mode off, the
 *  Playtomic keys gone) is read live by the server (/staff/move-in/steps) and never ticked. */
export const MOVE_CHECKS = {
  close_bookings: { step: "switch", who: "you", from: ["playtomic", "playbypoint", "courtreserve", "spreadsheet"] },
  renewals_stopped: { step: "switch", who: "you", from: ["playtomic", "playbypoint", "courtreserve", "spreadsheet"] },
  programs_left: { step: "switch", who: "you", from: ["playtomic", "playbypoint", "courtreserve", "spreadsheet"] },
  announced: { step: "switch", who: "you", from: ["playtomic", "playbypoint", "courtreserve", "spreadsheet"] },
  history_downloaded: { step: "wrap_up", who: "you", from: ["playtomic", "playbypoint", "courtreserve", "spreadsheet"] },
  plan_cancelled: { step: "wrap_up", who: "you", from: ["playtomic", "playbypoint", "courtreserve", "spreadsheet"] },
  link_website: { step: "wrap_up", who: "both", from: ["playtomic", "playbypoint", "courtreserve", "spreadsheet"] },
  link_google: { step: "wrap_up", who: "you", from: ["playtomic", "playbypoint", "courtreserve", "spreadsheet"] },
  link_social: { step: "wrap_up", who: "you", from: ["playtomic", "playbypoint", "courtreserve", "spreadsheet"] },
} satisfies Record<string, { step: MoveStep; who: Who; from: MoveSource[] }>;
export type MoveCheck = keyof typeof MOVE_CHECKS;
export const MOVE_CHECK_KEYS = Object.keys(MOVE_CHECKS) as [MoveCheck, ...MoveCheck[]];
type Ticked = Record<string, { at: string; by: string | null }>;

/** The old system's name in a sentence: "Playtomic", "Playbypoint", "the old system" for spreadsheets. */
export const fromName = (s: MoveSource | null): Text => both(`move.from_${s ?? "spreadsheet"}` as Key);
const stepName = (s: MoveStep): Text => both(`move.step_${s}` as Key);
const checkText = (k: MoveCheck, from: MoveSource | null): Text => both(`move.check_${k}` as Key, { from: fromName(from) });
const join = (parts: Text[]): Text => ({ en: parts.map((p) => p.en).join(" "), es: parts.map((p) => p.es).join(" ") });
const whenText = (d: Date, tz: string): Text => {
  const f = (l: string) => new Intl.DateTimeFormat(l, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
  return { en: f("en-US"), es: f("es-US") };
};

async function state(db: Db | Trx) {
  const { row, read } = await readRow(db, "move_in", "singleton");
  return { row: row as { source: MoveSource | null; step: MoveStep; switch_at: Date | null; checks: Ticked; finished_at: Date | null }, read };
}
/** The items for this source and step that nobody has said are done. */
const open = (row: { source: MoveSource | null; checks: Ticked }, step: MoveStep) =>
  MOVE_CHECK_KEYS.filter((k) => MOVE_CHECKS[k].step === step && (MOVE_CHECKS[k].from as readonly string[]).includes(row.source ?? "spreadsheet") && !row.checks[k]);

/** Where the club is coming from. Only which guide and words the steps show: nothing is read or changed elsewhere. */
export const moveSource = defineAction({
  name: "move.source", version: 1, clubWide: true,
  input: z.object({ source: z.enum(MOVE_SOURCES) }),
  async plan(ctx, i): Promise<Plan> {
    const { row, read } = await state(ctx.db);
    if (row.source === i.source) throw new KumiError("error.nothing_changed", {}, 400);
    return { title: both("action.move.source"), summary: both("plan.move.source", { from: fromName(i.source) }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("move_in", "singleton", { source: i.source }); return null; },
});

/** Go to a step of the move-in, forward or back. Going on leaves nothing undone behind: the preview says what's still
 *  open, and the staff decide. Going back to any step opens a finished move again. */
export const moveStep = defineAction({
  name: "move.step", version: 1, clubWide: true,
  input: z.object({ step: z.enum(MOVE_STEPS) }),
  async plan(ctx, i): Promise<Plan> {
    const { row, read } = await state(ctx.db);
    if (row.step === i.step && !row.finished_at) throw new KumiError("error.nothing_changed", {}, 400);
    if (i.step !== "connect" && !row.source) throw new KumiError("error.move_no_source", {}, 400);
    const n = MOVE_STEPS.indexOf(i.step) + 1;
    const parts: Text[] = [both("plan.move.step", { n, step: stepName(i.step) })];
    // Going on past the switch-over with items there still open: said, not refused.
    const before = MOVE_STEPS.slice(0, MOVE_STEPS.indexOf(i.step)) as MoveStep[];
    const left = before.flatMap((s) => open(row, s));
    if (left.length) parts.push(both("count.move_left_behind", { count: left.length }));
    if (i.step === "switch" && !row.switch_at) parts.push(both("plan.move.no_switch_time"));
    if (row.finished_at) parts.push(both("plan.move.reopen"));
    return { title: both("action.move.step"), summary: join(parts), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("move_in", "singleton", { step: i.step, finished_at: null }); return null; },
});

/** When the club plans to switch over (null: not chosen). A plan for the staff: nothing happens by itself then. */
export const moveSwitchAt = defineAction({
  name: "move.switch_at", version: 1, clubWide: true,
  input: z.object({ at: z.nullable(z.iso.datetime({ offset: true })) }),
  async plan(ctx, i): Promise<Plan> {
    const { row, read } = await state(ctx.db);
    const at = i.at ? new Date(i.at) : null;
    if ((row.switch_at?.getTime() ?? null) === (at?.getTime() ?? null)) throw new KumiError("error.nothing_changed", {}, 400);
    const tz = (await ctx.db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
    const summary = at ? join([both("plan.move.switch_at", { when: whenText(at, tz) }), ...(at < ctx.now ? [both("plan.move.switch_past")] : [])]) : both("plan.move.switch_at_clear");
    return { title: both("action.move.switch_at"), summary, reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("move_in", "singleton", { switch_at: i.at ? new Date(i.at) : null }); return null; },
});

/** Say an item of the switch-over or the wrap up is done (or not done after all). */
export const moveCheck = defineAction({
  name: "move.check", version: 1, clubWide: true,
  input: z.object({ item: z.enum(MOVE_CHECK_KEYS), done: z.boolean() }),
  async plan(ctx, i): Promise<Plan> {
    const { row, read } = await state(ctx.db);
    if (Boolean(row.checks[i.item]) === i.done) throw new KumiError("error.nothing_changed", {}, 400);
    return { title: both("action.move.check"), summary: both(i.done ? "plan.move.check_done" : "plan.move.check_undone", { item: checkText(i.item, row.source) }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const { row } = await state(ctx.trx);
    const checks: Ticked = { ...row.checks };
    if (i.done) checks[i.item] = { at: ctx.now.toISOString(), by: ctx.actor.personId ?? null };
    else delete checks[i.item];
    await ctx.update("move_in", "singleton", { checks: JSON.stringify(checks) });
    return null;
  },
});

/** The owner calls the move finished (a manager asks): the guide shows it done. The archive and everything brought
 *  over stay as they are; going back to a step opens it again. */
export const moveFinish = defineAction({
  name: "move.finish", version: 1, clubWide: true,
  input: z.object({}),
  async plan(ctx): Promise<Plan> {
    const { row, read } = await state(ctx.db);
    if (row.finished_at) throw new KumiError("error.already_done");
    if (row.step !== "wrap_up") throw new KumiError("error.move_not_wrap_up", {}, 400);
    const left = open(row, "wrap_up");
    return { title: both("action.move.finish"), summary: join([both("plan.move.finish"), ...(left.length ? [both("count.move_still_open", { count: left.length })] : [])]),
      reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx) { await ctx.update("move_in", "singleton", { finished_at: ctx.now }); return null; },
});

/** Where the move is, for the guide: its state and every tickable item for its source, done or not. */
export async function moveState(db: Db | Trx) {
  const { row } = await state(db);
  const from = row.source ?? "spreadsheet";
  const ids = [...new Set(Object.values(row.checks).map((c) => c.by).filter((x): x is string => Boolean(x)))];
  const names = new Map(ids.length ? (await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", ids).execute()).map((p) => [p.id, p.display_name]) : []);
  return { source: row.source, step: row.step, switch_at: row.switch_at, finished_at: row.finished_at,
    checks: MOVE_CHECK_KEYS.filter((k) => (MOVE_CHECKS[k].from as readonly string[]).includes(from)).map((k) => {
      const c = row.checks[k];
      return { key: k, step: MOVE_CHECKS[k].step, who: MOVE_CHECKS[k].who, done: Boolean(c), at: c?.at ?? null, by: c?.by ? names.get(c.by) ?? null : null, text: checkText(k, row.source) };
    }) };
}

/** Playtomic's upcoming bookings on linked courts beside how openPadel has them: held (or covered) so nothing else
 *  takes the court, or taken over as the club's own. The practice run's bookings row. */
export async function upcomingCompared(db: Db | Trx, now: Date) {
  const r = await db.selectFrom("playtomic_booking").leftJoin("mirror_booking", (j) => j.on(sql<boolean>`mirror_booking.ref = playtomic_booking.booking_id || ':' || playtomic_booking.resource_id`))
    .select([sql<string>`count(*)`.as("theirs"),
      sql<string>`count(*) FILTER (WHERE mirror_booking.status IN ('held', 'covered') OR playtomic_booking.taken_over_booking_id IS NOT NULL)`.as("ours"),
      sql<string>`count(*) FILTER (WHERE playtomic_booking.taken_over_booking_id IS NOT NULL)`.as("taken")])
    .where("playtomic_booking.canceled", "=", false).where("playtomic_booking.court_id", "is not", null).where("playtomic_booking.starts_at", ">", now).executeTakeFirstOrThrow();
  const last = await db.selectFrom("playtomic_booking").select(sql<Date | null>`max(starts_at)`.as("at")).where("canceled", "=", false).where("taken_over_booking_id", "is", null).executeTakeFirst();
  return { theirs: Number(r.theirs), ours: Number(r.ours), taken: Number(r.taken), last_left: last?.at && new Date(last.at) > now ? last.at : null };
}

/** People who came over (a members' import, or linked to a Playtomic player) and how many of them have signed in. */
export async function broughtPeople(db: Db | Trx) {
  const r = await db.selectFrom("person").select([sql<string>`count(*)`.as("n"),
    sql<string>`count(*) FILTER (WHERE EXISTS (SELECT 1 FROM web_session s WHERE s.person_id = person.id))`.as("signed_in")])
    .where("redacted_at", "is", null).where("junior", "=", false)
    .where((eb) => eb.or([eb("created_via", "=", "import"),
      eb.exists(eb.selectFrom("external_ref").select("external_ref.entity_id").where("external_ref.system", "=", PLAYTOMIC).where("external_ref.entity", "=", "person").where(sql<boolean>`external_ref.entity_id = person.id::text`))]))
    .executeTakeFirstOrThrow();
  return { people: Number(r.n), signed_in: Number(r.signed_in) };
}
