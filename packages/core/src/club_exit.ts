// A club can always leave (hosted.md, item 2): the host's read-only switch for an account that isn't paid
// (read_only.ts says what still works), and the owner's "Download everything", a sealed file that a fresh
// self-hosted install restores (apps/server/src/export.ts makes and opens it).
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";

/** The club's Kumi now runs elsewhere: this server sends members nothing more (the senders check, messages.ts,
 *  texts.ts, push.ts) and takes nothing new (read_only.ts), and both apps say where it went. Turned on before the
 *  export, it means only one server ever talks to members: what was still waiting travels in the file and the new
 *  server sends it (export.ts holds nothing then). The owner says so in the staff app; the host, `kumi moved`. */
const movedInput = z.object({ on: z.boolean(), to: z.optional(z.url({ protocol: /^https?$/ })) });
const movedPlan = (i: z.infer<typeof movedInput>) => ({ title: both("action.club.moved"),
  summary: i.on ? both(i.to ? "plan.club.moved_on_to" : "plan.club.moved_on", { to: i.to ?? "" }) : both("plan.club.moved_off"), reads: [],
  undo: { kind: "none" as const, note: both("reason.moved_switch") } });
async function setMoved(ctx: { update: (e: "club", id: string, v: Record<string, unknown>) => Promise<unknown>; now: Date }, i: z.infer<typeof movedInput>) {
  await ctx.update("club", "singleton", { moved_at: i.on ? ctx.now : null, moved_to: i.on ? i.to ?? null : null });
  return null;
}
export const clubMoved = defineAction({
  name: "club.moved", version: 1, strongAuth: true, input: movedInput,
  async plan(ctx, i) {
    if (!(await isOwner(ctx.db, ctx.actor.personId))) throw new KumiError("error.export_owner_only", {}, 403);
    return movedPlan(i);
  },
  apply: (ctx, i) => setMoved(ctx, i),
});
export const clubMovedHost = defineAction({
  name: "club.moved_host", version: 1, system: true, internal: true, input: movedInput,
  async plan(_ctx, i) { return movedPlan(i); },
  apply: (ctx, i) => setMoved(ctx, i),
});
/** Where the club went, if it has: this server then sends members nothing. */
export async function movedAway(db: Db | Trx): Promise<{ at: Date; to: string | null } | null> {
  const c = await db.selectFrom("club").select(["moved_at", "moved_to"]).executeTakeFirst();
  return c?.moved_at ? { at: c.moved_at, to: c.moved_to } : null;
}

/** Minutes the owner has to make the file once they've confirmed, as for a person's own data. */
export const CLUB_EXPORT_MINUTES = 15;

/** The host turns read-only on or off (`kumi read-only on|off`); nobody in the club can. */
export const clubReadOnly = defineAction({
  name: "club.read_only", version: 1, system: true, internal: true,
  input: z.object({ on: z.boolean() }),
  async plan(_ctx, i) {
    return { title: both("action.club.read_only"), summary: both(i.on ? "plan.club.read_only_on" : "plan.club.read_only_off"), reads: [], undo: { kind: "none", note: both("reason.read_only_host") } };
  },
  async apply(ctx, i) {
    const c = await ctx.trx.selectFrom("club").select("read_only_since").forUpdate().executeTakeFirstOrThrow();
    if (Boolean(c.read_only_since) === i.on) return { changed: false, since: c.read_only_since };
    await ctx.update("club", "singleton", { read_only_since: i.on ? ctx.now : null });
    await ctx.emit(i.on ? "club.read_only_on" : "club.read_only_off", { at: ctx.now.toISOString() });
    return { changed: true, since: i.on ? ctx.now : null };
  },
});

async function isOwner(db: Db | Trx, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  return Boolean(await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.id")
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).where("role.key", "=", "owner").executeTakeFirst());
}

/** The owner's download of everything: recorded here; the file is made once, right after (exportClubRun). */
export const clubExport = defineAction({
  name: "club.export", version: 1, strongAuth: true,
  input: z.object({}),
  async plan(ctx) {
    // The owner's alone, not something a manager can ask for: the file holds every member's details.
    if (!(await isOwner(ctx.db, ctx.actor.personId))) throw new KumiError("error.export_owner_only", {}, 403);
    return { title: both("action.club.export"), summary: both("plan.club.export"), reads: [], undo: { kind: "none", note: both("reason.export_final") } };
  },
  async apply(ctx) {
    await ctx.emit("club.exported", { by: ctx.actor.personId, at: ctx.now.toISOString() });
    return { make: `/staff/export/${ctx.runId}` };
  },
});

/** The export the owner just confirmed: theirs, applied, recent, and still an owner's. */
export async function exportClubRun(db: Db, runId: string, actorId: string, now: Date): Promise<void> {
  const run = await db.selectFrom("action_run").select(["action", "status", "actor_person_id", "applied_at"]).where("id", "=", runId).executeTakeFirst();
  if (!run || run.action !== "club.export" || run.status !== "applied" || run.actor_person_id !== actorId || !run.applied_at
    || now.getTime() - run.applied_at.getTime() > CLUB_EXPORT_MINUTES * 60_000) throw new KumiError("error.club_export_gone", {}, 404);
  if (!(await isOwner(db, actorId))) throw new KumiError("error.export_owner_only", {}, 403);
}

/** The last time someone downloaded everything (club.export, from the audit log), and who. */
export async function lastClubExport(db: Db | Trx): Promise<{ at: Date; by: string } | null> {
  const r = await db.selectFrom("action_run").leftJoin("person", "person.id", "action_run.actor_person_id").select(["action_run.applied_at", "person.display_name"])
    .where("action_run.action", "=", "club.export").where("action_run.status", "=", "applied").orderBy("action_run.applied_at", "desc").limit(1).executeTakeFirst();
  return r?.applied_at ? { at: r.applied_at, by: r.display_name ?? "" } : null;
}
