// Leaving: the day this club's Kumi ends, set by whoever runs its server (`kumi leaving on`), for a club moving off
// its host or shutting its own server down. The owner is told at once, in their language, to download everything
// before then (Settings, Download everything): the file's passphrase is shown only to whoever downloads it, and
// nobody else keeps it. A week before and a day before they're reminded, each said once for that date, whatever
// state the club is in: read-only lets these actions through (read_only.ts), and the monthly cap doesn't hold
// staff messages (usage.ts). The owner and managers see the date at the top of the staff app.
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction, runAsSystem } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { localDate } from "./clock.ts";
import { dayText } from "./memberships.ts";
import { quietUntil } from "./messages.ts";
import { lastClubExport } from "./club_exit.ts";

/** The reminders, by how many days before the date each is due. */
export const LEAVING_REMINDERS = { week: 7, day: 1 } as const;
type Kind = "set" | "week" | "day";

const date = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
const dayNo = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
/** Whole days from the club's date `today` to `on` (0: it's today). */
export const daysUntil = (today: string, on: string) => dayNo(on) - dayNo(today);
const realDate = (d: string) => !Number.isNaN(dayNo(d)) && new Date(dayNo(d) * 86_400_000).toISOString().slice(0, 10) === d;

/** The reminders an email sent `left` days ahead already says: none at more than a week, the week's one within a
 *  week, both on the last day. */
const coveredAt = (left: number): Kind[] => (left <= LEAVING_REMINDERS.day ? ["week", "day"] : left <= LEAVING_REMINDERS.week ? ["week"] : []);

async function note(trx: Trx, on: string, kinds: Kind[], at: Date, covered: boolean): Promise<Kind[]> {
  if (!kinds.length) return [];
  const r = await trx.insertInto("leaving_notice").values(kinds.map((kind) => ({ leaving_on: on, kind, said_at: at, covered })))
    .onConflict((oc) => oc.columns(["leaving_on", "kind"]).doNothing()).returning("kind").execute();
  return r.map((x) => x.kind);
}

/** Whoever runs the club's server sets the day its Kumi ends, moves it, or takes it away (`kumi leaving`).
 *  kept_days: how long a copy of the club's data is kept after that day (null: not said). tell: false when the
 *  date comes from somewhere else (an export put into this server), so nobody is told about it. */
export const clubLeaving = defineAction({
  name: "club.leaving", version: 1, system: true, internal: true,
  input: z.object({ on: z.nullable(date), kept_days: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(3650)))), tell: z.optional(z.boolean()),
    // The domain the club's email comes from, so the owners' emails say what becomes of it: the host's (it stays with
    // the host) or the club's own (it moves to the club's own email account). Left out: as it was.
    email_domain: z.optional(z.nullable(z.string().check(z.regex(/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)))), email_domain_host: z.optional(z.boolean()) }),
  async plan(ctx, i) {
    if (i.on === null) return { title: both("action.club.leaving"), summary: both("plan.club.leaving_off"), reads: [], undo: { kind: "none", note: both("reason.leaving_host") } };
    const c = await ctx.db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow();
    if (!realDate(i.on)) throw new KumiError("error.invalid_input", { details: i.on });
    if (daysUntil(localDate(ctx.now, c.time_zone), i.on) < 0) throw new KumiError("error.leaving_past");
    return { title: both("action.club.leaving"), summary: both("plan.club.leaving_on", { date: dayText(i.on) }), reads: [], undo: { kind: "none", note: both("reason.leaving_host") } };
  },
  async apply(ctx, i) {
    const c = await ctx.trx.selectFrom("club").select(["leaving_on", "leaving_kept_days", "leaving_email_domain", "leaving_email_domain_host", "time_zone"]).forUpdate().executeTakeFirstOrThrow();
    const kept = i.kept_days === undefined ? c.leaving_kept_days : i.kept_days;
    const domain = i.on === null ? null : i.email_domain === undefined ? c.leaving_email_domain : i.email_domain;
    const host = domain === null ? false : i.email_domain_host ?? (i.email_domain === undefined ? c.leaving_email_domain_host : false);
    const sameMail = domain === c.leaving_email_domain && host === c.leaving_email_domain_host;
    if (c.leaving_on === i.on && (i.on === null || kept === c.leaving_kept_days)) {
      // Only what's said about the club's email changed: kept for the reminders, nobody told again now.
      if (i.on !== null && !sameMail) await ctx.update("club", "singleton", { leaving_email_domain: domain, leaving_email_domain_host: host });
      return { changed: false, on: i.on };
    }
    await ctx.update("club", "singleton", { leaving_on: i.on, leaving_kept_days: i.on === null ? null : kept, leaving_email_domain: domain, leaving_email_domain_host: host });
    const tell = i.tell !== false;
    if (i.on === null) {
      await ctx.emit("club.leaving_off", { was: c.leaving_on, tell });
      return { changed: true, on: null };
    }
    // The first email says what the reminders would, when there's a week or less to go.
    if (tell) {
      await ctx.trx.insertInto("leaving_notice").values({ leaving_on: i.on, kind: "set", said_at: ctx.now, covered: false })
        .onConflict((oc) => oc.columns(["leaving_on", "kind"]).doUpdateSet({ said_at: ctx.now })).execute();
      await note(ctx.trx, i.on, coveredAt(daysUntil(localDate(ctx.now, c.time_zone), i.on)), ctx.now, true);
    }
    await ctx.emit("club.leaving_set", { on: i.on, was: c.leaving_on, kept_days: kept, tell });
    return { changed: true, on: i.on };
  },
});

/** A reminder that's due (remindLeaving), said once for the date. The last one also counts for the week's. */
export const clubLeavingRemind = defineAction({
  name: "club.leaving_remind", version: 1, system: true, internal: true,
  input: z.object({ on: date, kind: z.enum(["week", "day"]) }),
  async plan(_ctx, i) {
    return { title: both("action.club.leaving_remind"), summary: both(`plan.club.leaving_remind_${i.kind}`, { date: dayText(i.on) }), reads: [], undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    const c = await ctx.trx.selectFrom("club").select(["leaving_on", "leaving_kept_days"]).forUpdate().executeTakeFirstOrThrow();
    if (c.leaving_on !== i.on) return { said: false };
    if (!(await note(ctx.trx, i.on, [i.kind], ctx.now, false)).length) return { said: false };
    if (i.kind === "day") await note(ctx.trx, i.on, ["week"], ctx.now, true);
    await ctx.emit("club.leaving_reminder", { on: i.on, kind: i.kind, kept_days: c.leaving_kept_days });
    return { said: true };
  },
});

/** The job: the reminder that's due now, if any. Only in the club's daytime (outside quiet hours), since staff
 *  messages go out at once; a server that was off when the week's one was due sends the last one alone. */
export async function remindLeaving(db: Db, now = new Date()): Promise<"week" | "day" | null> {
  const c = await db.selectFrom("club").select(["leaving_on", "time_zone"]).executeTakeFirst();
  if (!c?.leaving_on || quietUntil(now, c.time_zone)) return null;
  const left = daysUntil(localDate(now, c.time_zone), c.leaving_on);
  const kind = left < 0 ? null : left <= LEAVING_REMINDERS.day ? "day" : left <= LEAVING_REMINDERS.week ? "week" : null;
  if (!kind) return null;
  if (await db.selectFrom("leaving_notice").select("kind").where("leaving_on", "=", c.leaving_on).where("kind", "=", kind).executeTakeFirst()) return null;
  const r = await runAsSystem(db, "club.leaving_remind", { on: c.leaving_on, kind }, "leaving", { now });
  return (r.result as { said: boolean }).said ? kind : null;
}

/** For `kumi leaving status` and the host: the date, the notices for it, and the last download of everything. */
export async function leavingStatus(db: Db | Trx, now = new Date()) {
  const c = await db.selectFrom("club").select(["leaving_on", "leaving_kept_days", "time_zone"]).executeTakeFirstOrThrow();
  const lastExport = await lastClubExport(db);
  if (!c.leaving_on) return { on: null, kept_days: null, days_left: null, notices: [], last_export: lastExport };
  const rows = await db.selectFrom("leaving_notice").select(["kind", "said_at", "covered"]).where("leaving_on", "=", c.leaving_on).execute();
  const notices = (["set", "week", "day"] as const).map((kind) => {
    const r = rows.find((x) => x.kind === kind);
    return { kind, said_at: r?.said_at ?? null, covered: r?.covered ?? false };
  });
  return { on: c.leaving_on, kept_days: c.leaving_kept_days, days_left: daysUntil(localDate(now, c.time_zone), c.leaving_on), notices, last_export: lastExport };
}

/** The date for the top of the staff app: the owner's and managers' to see. */
export async function leavingOn(db: Db | Trx): Promise<string | null> {
  return (await db.selectFrom("club").select("leaving_on").executeTakeFirst())?.leaving_on ?? null;
}
