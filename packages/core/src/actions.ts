// The action contract (action_catalogue.md): every write is planned, permission-checked,
// shown, applied once, recorded in the change log, announced through the outbox, and undoable
// in the way its plan said.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, type Key, type Lang, type Params, type Text } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { decide, type Decision } from "./permissions.ts";

/** How the person proved who they are: the strong-sign-in rule reads it. */
export type AuthMethod = "email_code" | "passkey" | "oauth" | "system";
export interface Actor { personId: string | null; agentId?: string | null; via: string; lang: Lang; auth?: AuthMethod }
export type UndoKind = "reversible" | "compensating" | "none";
export interface Read { entity: Entity; id: string; version: number }
export interface Plan {
  title: Text;
  summary: Text;
  reads: Read[];
  undo: { kind: UndoKind; note?: Text; minutes?: number };
  locationId?: string | null;
  ownerIds?: string[];           // whose rows this touches, for "own" grants
  /** Money rules (permissions.md step 5): a second, different person must approve. */
  secondPerson?: boolean;
  moneyCents?: number;
  tells?: Text[];
  details?: unknown;
}
export interface PlanCtx { db: Db | Trx; actor: Actor; now: Date }
export interface ApplyCtx extends PlanCtx {
  trx: Trx;
  runId: string;
  insert<E extends Entity>(entity: E, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  update<E extends Entity>(entity: E, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  emit(topic: string, payload: unknown): Promise<void>;
}
export interface ActionDef<S extends z.ZodMiniObject = z.ZodMiniObject> {
  name: string;
  version: number;
  /** Kumi itself may run it with no person (setup, scheduled jobs). Nobody else gets this path. */
  system?: boolean;
  /** Only Kumi's own code calls it (after a check it did itself); never offered to the API or MCP. */
  internal?: boolean;
  /** Once the person has a passkey, this needs a passkey sign-in, not an emailed code. */
  strongAuth?: boolean;
  input: S;
  plan(ctx: PlanCtx, input: z.infer<S>): Promise<Plan>;
  apply(ctx: ApplyCtx, input: z.infer<S>, plan: Plan): Promise<unknown>;
}

/** Tables actions may write, how to find a row, and how undo retires a row it inserted. */
const ENTITIES = {
  club: { table: "club", key: "singleton", retire: null },
  location: { table: "location", key: "id", retire: { archived_at: "now" } },
  person: { table: "person", key: "id", retire: { status: "archived" } },
  person_role: { table: "person_role", key: "id", retire: { active: false } },
  role_grant: { table: "role_grant", key: "id", retire: null },
  staff_member: { table: "staff_member", key: "id", retire: { active: false } },
  passkey: { table: "passkey", key: "credential_id", retire: { revoked_at: "now" } },
  court: { table: "court", key: "id", retire: { archived_at: "now" } },
  program: { table: "program", key: "id", retire: { status: "cancelled" } },
  session: { table: "session", key: "id", retire: { status: "cancelled" } },
  court_time: { table: "court_time", key: "id", retire: { active: false } },
  mirror_booking: { table: "mirror_booking", key: "ref", retire: null },
  enrolment: { table: "enrolment", key: "id", retire: { status: "cancelled" } },
  waitlist_offer: { table: "waitlist_offer", key: "id", retire: { outcome: "expired" } },
  payment: { table: "payment", key: "id", retire: null },
  refund: { table: "refund", key: "id", retire: null },
  draw: { table: "draw", key: "session_id", retire: { status: "void" } },
  game: { table: "game", key: "id", retire: { status: "void" } },
  rating: { table: "rating", key: "person_id", retire: null },
} as const;
export type Entity = keyof typeof ENTITIES;

const registry = new Map<string, ActionDef<any>>();
export function defineAction<S extends z.ZodMiniObject>(def: ActionDef<S>): ActionDef<S> {
  if (registry.has(def.name)) throw new Error(`action ${def.name} defined twice`);
  registry.set(def.name, def);
  return def;
}
export function actions(): ActionDef<any>[] { return [...registry.values()]; }
export function getAction(name: string): ActionDef<any> {
  const def = registry.get(name);
  if (!def) throw new KumiError("error.unknown_action", {}, 404);
  return def;
}

export const PLAN_MINUTES = 15;
const APPROVAL_DAYS = 7;
const keyOf = (e: Entity, id: string) => `${e}:${id}`;

async function currentVersion(db: Db | Trx, entity: Entity, id: string): Promise<number | null> {
  const { table, key } = ENTITIES[entity];
  const r = await sql<{ version: number }>`SELECT version FROM ${sql.table(table)} WHERE ${sql.ref(key)} = ${key === "singleton" ? true : id}`.execute(db);
  return r.rows[0]?.version ?? null;
}

/** Reads a row the plan depends on, and remembers its version for the apply check. */
export async function readRow(db: Db | Trx, entity: Entity, id: string, thing: Key = "thing.change"): Promise<{ row: Record<string, any>; read: Read }> {
  const { table, key } = ENTITIES[entity];
  const r = await sql<Record<string, any>>`SELECT * FROM ${sql.table(table)} WHERE ${sql.ref(key)} = ${key === "singleton" ? true : id}`.execute(db);
  const row = r.rows[0];
  if (!row) throw new KumiError("error.not_found", { thing: both(thing) }, 404);
  return { row, read: { entity, id, version: row.version } };
}

function validate<S extends z.ZodMiniObject>(def: ActionDef<S>, raw: unknown): z.infer<S> {
  const parsed = z.safeParse(def.input, raw);
  if (!parsed.success) throw new KumiError("error.invalid_input", { details: z.prettifyError(parsed.error) }, 400);
  return parsed.data;
}

async function refuse(db: Db, def: ActionDef<any>, input: unknown, actor: Actor, plan: Plan | null, d: Decision): Promise<never> {
  // Every "no" is logged (permissions.md).
  await db.insertInto("action_run").values({
    id: uuidv7(), action: def.name, action_version: def.version, actor_person_id: actor.personId, agent_id: actor.agentId ?? null,
    via: actor.via, location_id: plan?.locationId ?? null, input: JSON.stringify(input), plan: JSON.stringify(plan ?? {}), status: "failed",
    undo_kind: "none", read_versions: JSON.stringify({}), plan_expires_at: new Date(), error: JSON.stringify({ code: "error.forbidden_reason", reason: d.reason }),
  }).execute();
  throw new KumiError("error.forbidden_reason", { reason: both(d.reason ?? "reason.no_role") }, 403);
}

/** Staff two-step sign-in, the simple way: a person with a passkey makes sensitive changes with it. */
async function requireStrongAuth(db: Db | Trx, def: ActionDef<any>, actor: Actor): Promise<void> {
  if (!def.strongAuth || !actor.personId || actor.auth === "passkey" || actor.auth === "system") return;
  const has = await db.selectFrom("passkey").select("credential_id").where("person_id", "=", actor.personId).where("revoked_at", "is", null).executeTakeFirst();
  if (has) throw new KumiError("error.need_passkey", {}, 403);
}

export interface Planned { runId: string; status: "planned" | "awaiting_approval"; plan: Plan; expiresAt: Date }

/** Step one: validate, check permission, build the preview, and store it. Nothing changes yet. */
export async function plan(db: Db, name: string, raw: unknown, actor: Actor, opts: { now?: Date; internal?: boolean } = {}): Promise<Planned> {
  const def = getAction(name);
  if (def.internal && !opts.internal) throw new KumiError("error.unknown_action", {}, 404);
  await requireStrongAuth(db, def, actor);
  const input = validate(def, raw);
  const now = opts.now ?? new Date();
  const p = await def.plan({ db, actor, now }, input);
  const d = await decide(db, name, { personId: actor.personId, agentId: actor.agentId ?? null, locationId: p.locationId ?? null, ownerIds: p.ownerIds ?? [], at: now });
  if (d.mode === "no") return refuse(db, def, input, actor, p, d);
  const status = d.mode === "ask" || p.secondPerson ? "awaiting_approval" : "planned";
  const expiresAt = new Date(now.getTime() + (status === "planned" ? PLAN_MINUTES * 60_000 : APPROVAL_DAYS * 864e5));
  const runId = uuidv7(now.getTime());
  await db.insertInto("action_run").values({
    id: runId, action: name, action_version: def.version, actor_person_id: actor.personId, agent_id: actor.agentId ?? null, via: actor.via,
    location_id: p.locationId ?? null, input: JSON.stringify(input), plan: JSON.stringify(p), status, undo_kind: p.undo.kind,
    undo_note: p.undo.note ? JSON.stringify(p.undo.note) : null, read_versions: JSON.stringify(Object.fromEntries(p.reads.map((r) => [keyOf(r.entity, r.id), r.version]))),
    plan_expires_at: expiresAt, money_cents: String(p.moneyCents ?? 0), undo_of: (input as any)?.run_id && name === "action.undo" ? (input as any).run_id : null,
  }).execute();
  return { runId, status, plan: p, expiresAt };
}

/** Step two: apply a stored plan, once. Fails if anything it read has changed since. */
export async function apply(db: Db, runId: string, actor: Actor, opts: { idempotencyKey?: string; now?: Date; approvedBy?: string; system?: boolean } = {}): Promise<unknown> {
  const now = opts.now ?? new Date();
  if (opts.idempotencyKey) {
    const prior = await db.selectFrom("action_run").select(["result", "status"]).where("idempotency_key", "=", opts.idempotencyKey).executeTakeFirst();
    if (prior?.status === "applied") return prior.result;
  }
  try {
    return await db.transaction().execute(async (trx) => {
      const run = await trx.selectFrom("action_run").selectAll().where("id", "=", runId).forUpdate().executeTakeFirst();
      if (!run) throw new KumiError("error.not_found", { thing: both("thing.change") }, 404);
      const approving = Boolean(opts.approvedBy);
      if (!approving && run.status !== "planned") throw new KumiError("error.not_planned", { status: run.status });
      if (approving && run.status !== "awaiting_approval") throw new KumiError("error.not_planned", { status: run.status });
      if (!approving && !opts.system && run.actor_person_id !== actor.personId) throw new KumiError("error.plan_not_yours", {}, 403);
      if (run.plan_expires_at.getTime() < now.getTime()) {
        await trx.updateTable("action_run").set({ status: "expired" }).where("id", "=", runId).execute();
        throw new KumiError("error.plan_expired");
      }
      const def = getAction(run.action);
      const p = run.plan as Plan;
      if (!approving && !opts.system) await requireStrongAuth(trx, def, actor);
      if (opts.system && !def.system) throw new KumiError("error.forbidden_reason", { reason: both("reason.no_role") }, 403);
      if (!approving && !opts.system) {   // permissions may have changed since the preview
        const d = await decide(trx, run.action, { personId: actor.personId, agentId: actor.agentId ?? null, locationId: run.location_id, ownerIds: p.ownerIds ?? [], at: now });
        if (d.mode !== "allow") throw new KumiError("error.forbidden_reason", { reason: both(d.reason ?? "reason.no_role") }, 403);
      }
      for (const [k, v] of Object.entries(run.read_versions as Record<string, number>)) {
        const [entity, ...rest] = k.split(":");
        if ((await currentVersion(trx, entity as Entity, rest.join(":"))) !== v) throw new KumiError("error.changed");
      }
      const runActor: Actor = { personId: run.actor_person_id, agentId: run.agent_id, via: run.via, lang: actor.lang };
      const ctx = applyCtx(trx, runActor, now, runId);
      const result = (await def.apply(ctx, run.input, p)) ?? null;
      await trx.updateTable("action_run").set({
        status: "applied", applied_at: now, result: JSON.stringify(result), idempotency_key: opts.idempotencyKey ?? null,
        approved_by: opts.approvedBy ?? null, undo_until: p.undo.minutes ? new Date(now.getTime() + p.undo.minutes * 60_000) : null,
      }).where("id", "=", runId).execute();
      return result;
    });
  } catch (e) {
    if (e instanceof KumiError && ["error.changed", "error.forbidden_reason"].includes(e.code)) {
      await db.updateTable("action_run").set({ status: "failed", error: JSON.stringify({ code: e.code, params: e.params }) }).where("id", "=", runId).where("status", "in", ["planned", "awaiting_approval"]).execute();
    }
    throw e;
  }
}

/** An "ask" waits for someone allowed to do it, who isn't the person who asked. */
export async function approve(db: Db, runId: string, approver: Actor, opts: { now?: Date } = {}): Promise<unknown> {
  const now = opts.now ?? new Date();
  const run = await db.selectFrom("action_run").selectAll().where("id", "=", runId).executeTakeFirst();
  if (!run) throw new KumiError("error.not_found", { thing: both("thing.change") }, 404);
  if (run.actor_person_id === approver.personId) throw new KumiError("error.own_approval", {}, 403);
  const p = run.plan as Plan;
  const d = await decide(db, run.action, { personId: approver.personId, locationId: run.location_id, ownerIds: p.ownerIds ?? [], at: now });
  if (d.mode !== "allow") throw new KumiError("error.forbidden_reason", { reason: both(d.reason ?? "reason.no_role") }, 403);
  return apply(db, runId, approver, { now, approvedBy: approver.personId! });
}

function applyCtx(trx: Trx, actor: Actor, now: Date, runId: string): ApplyCtx {
  const record = (entity: Entity, id: string, op: "insert" | "update", before: unknown, after: unknown) =>
    trx.insertInto("entity_change").values({ action_run_id: runId, entity, entity_id: id, op, before: before === null ? null : JSON.stringify(before), after: JSON.stringify(after) }).execute();
  return {
    db: trx, trx, actor, now, runId,
    async insert(entity, row) {
      const { table, key } = ENTITIES[entity];
      const r = await (trx as any).insertInto(table).values(row).returningAll().executeTakeFirstOrThrow();
      await record(entity, String(r[key]), "insert", null, r);
      return r;
    },
    async update(entity, id, patch) {
      const { table, key } = ENTITIES[entity];
      const keyValue = key === "singleton" ? true : id;
      const before = await (trx as any).selectFrom(table).selectAll().where(key, "=", keyValue).forUpdate().executeTakeFirstOrThrow();
      const after = await (trx as any).updateTable(table).set({ ...patch, version: before.version + 1 }).where(key, "=", keyValue).returningAll().executeTakeFirstOrThrow();
      await record(entity, String(id), "update", before, after);
      return after;
    },
    async emit(topic, payload) {
      await trx.insertInto("event_outbox").values({ action_run_id: runId, topic, payload: JSON.stringify(payload) }).execute();
    },
  };
}

/** Kumi itself runs a system action: still planned, recorded and applied, with no person. */
export async function runAsSystem(db: Db, name: string, raw: unknown, via: string, opts: { now?: Date } = {}) {
  const def = getAction(name);
  if (!def.system) throw new KumiError("error.forbidden_reason", { reason: both("reason.no_role") }, 403);
  const input = validate(def, raw);
  const now = opts.now ?? new Date();
  const actor: Actor = { personId: null, via, lang: "en" };
  const p = await def.plan({ db, actor, now }, input);
  const runId = uuidv7(now.getTime());
  await db.insertInto("action_run").values({
    id: runId, action: name, action_version: def.version, actor_person_id: null, agent_id: null, via, location_id: p.locationId ?? null,
    input: JSON.stringify(input), plan: JSON.stringify(p), status: "planned", undo_kind: p.undo.kind, undo_note: p.undo.note ? JSON.stringify(p.undo.note) : null,
    read_versions: JSON.stringify(Object.fromEntries(p.reads.map((r) => [keyOf(r.entity, r.id), r.version]))), plan_expires_at: new Date(now.getTime() + PLAN_MINUTES * 60_000),
  }).execute();
  return { runId, plan: p, result: await apply(db, runId, actor, { now, system: true }) };
}

/** Plan and apply in one go, for callers that already showed the preview elsewhere (tests, setup). */
export async function run(db: Db, name: string, raw: unknown, actor: Actor, opts: { now?: Date; idempotencyKey?: string; internal?: boolean } = {}) {
  const p = await plan(db, name, raw, actor, opts);
  if (p.status === "awaiting_approval") return { ...p, result: null };
  return { ...p, result: await apply(db, p.runId, actor, opts) };
}

// ---- Undo: a new action run that reads the original's change log and puts it back. ----
const UNDO_FIELDS_SKIP = new Set(["version"]);

export const undoAction = defineAction({
  name: "action.undo",
  version: 1,
  input: z.object({ run_id: z.uuid() }),
  async plan(ctx, input) {
    const original = await ctx.db.selectFrom("action_run").selectAll().where("id", "=", input.run_id).executeTakeFirst();
    if (!original) throw new KumiError("error.not_found", { thing: both("thing.change") }, 404);
    if (original.status !== "applied") throw new KumiError("error.not_planned", { status: original.status });
    const op = original.plan as Plan;
    if (original.undo_kind === "none") throw new KumiError("error.cannot_undo", { reason: op.undo.note ?? both("reason.undo_final") });
    if (original.undo_until && original.undo_until.getTime() < ctx.now.getTime()) throw new KumiError("error.undo_expired");
    // Undo needs the same permission as the original action, for the same rows.
    const d = await decide(ctx.db, original.action, { personId: ctx.actor.personId, agentId: ctx.actor.agentId ?? null, locationId: original.location_id, ownerIds: op.ownerIds ?? [], at: ctx.now });
    if (d.mode === "no") throw new KumiError("error.forbidden_reason", { reason: both(d.reason ?? "reason.no_role") }, 403);
    const changes = await ctx.db.selectFrom("entity_change").selectAll().where("action_run_id", "=", input.run_id).orderBy("id", "desc").execute();
    const reads: Read[] = [];
    for (const c of changes) {
      const after = c.after as Record<string, any>;
      const v = await currentVersion(ctx.db, c.entity as Entity, c.entity_id);
      if (v === null || v !== after.version) throw new KumiError("error.undo_changed");
      reads.push({ entity: c.entity as Entity, id: c.entity_id, version: v });
    }
    return {
      title: both("action.action.undo"),
      summary: both("plan.undo", { title: op.title }),
      reads, locationId: original.location_id, ownerIds: op.ownerIds ?? [],
      undo: { kind: "none", note: both("reason.undo_final") },
      details: { undoes: input.run_id, changes: changes.length },
    };
  },
  async apply(ctx, input) {
    const changes = await ctx.trx.selectFrom("entity_change").selectAll().where("action_run_id", "=", input.run_id).orderBy("id", "desc").execute();
    for (const c of changes) {
      const entity = c.entity as Entity;
      if (c.op === "update") {
        const before = c.before as Record<string, unknown>;
        await ctx.update(entity, c.entity_id, Object.fromEntries(Object.entries(before).filter(([k]) => !UNDO_FIELDS_SKIP.has(k) && k !== ENTITIES[entity].key)));
      } else {
        const retire = ENTITIES[entity].retire;
        if (!retire) throw new KumiError("error.cannot_undo", { reason: both("reason.cannot_retire") });
        await ctx.update(entity, c.entity_id, Object.fromEntries(Object.entries(retire).map(([k, v]) => [k, v === "now" ? ctx.now : v])));
      }
    }
    await ctx.trx.updateTable("action_run").set({ status: "undone" }).where("id", "=", input.run_id).execute();
    await ctx.emit("action.undone", { run_id: input.run_id });
    return { undone: input.run_id };
  },
});

export function text(key: Key, params: Params = {}): Text { return both(key, params); }
