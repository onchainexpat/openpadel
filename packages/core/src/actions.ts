// The action contract (action_catalogue.md): every write is planned, permission-checked,
// shown, applied once, recorded in the change log, announced through the outbox, and undoable
// in the way its plan said.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, en, es, money, type Key, type Lang, type Params, type Text, formatLocale } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import type { Charge } from "./charge.ts";
import { plainIssues } from "./plain_issues.ts";
import { checkAgentSpend, checkAssistantSpend } from "./assistant_spend.ts";
import { uuidv7 } from "./ids.ts";
import { CHAT_ACTIONS, clubAgentOf, CREDIT_MONEY, decide, DESK_MONEY, holdsRole, roleKeysOf, type Decision } from "./permissions.ts";
import { readOnlyGate } from "./read_only.ts";
import { hasSecondFactor, secondStepForChanges } from "./second_step.ts";

/** How the person proved who they are: the strong-sign-in rule reads it. */
/** "two_factor": an emailed code and then an authenticator or recovery code. */
export type AuthMethod = "email_code" | "phone_code" | "passkey" | "two_factor" | "oauth" | "system";
export interface Actor { personId: string | null; agentId?: string | null; via: string; lang: Lang; auth?: AuthMethod; /** The assistant connection acting (the MCP door), whose weekly cap applies. */ grantId?: string | null;
  /** That connection is held to a member's reach until it's allowed again (assistant_reach.ts). */ memberOnly?: boolean }
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
  /** A picture of what the change makes (a data: URL of a PNG drawn on the server, the club's logo on its colour), for
   *  the preview only: never stored with the run. */
  image?: string;
  /** What a member's change charges, line by line (charge.ts): the members' app shows it before the yes. */
  charge?: Charge;
  /** The preview row by row, for a change that does several things at once (a block that moves bookings): each row a
   *  label ("Moves", "Money") and what happens. The staff app shows them in place of the summary, which still says it all
   *  for the command line and assistants. */
  rows?: { label: Text; text: Text }[];
}
export interface PlanCtx { db: Db | Trx; actor: Actor; now: Date }
/** Whose a change is and where, before its preview (ActionDef.owners). `locationId` left out: the row it names isn't
 *  there (or the preview chooses the place, a lesson's court), so only whose it is is judged first, and where after. */
export interface Owners { ownerIds: string[]; locationId?: string | null }
export interface ApplyCtx extends PlanCtx {
  trx: Trx;
  runId: string;
  /** Who said yes, when it waited for approval (the run's actor is who asked). */
  approvedBy?: string | null;
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
  /** What its undo's preview says, from what the change wrote (its entity_change rows), where that says more than
   *  "Undo: " and its title: what goes back, and to what. */
  undoSummary?: (changes: { entity: string; op: string; before: unknown; after: unknown }[]) => Promise<Text | null> | Text | null;
  /** What it changes belongs to no location unless the plan names one (a membership): a role kept to one location
   *  may do it too (permissions.ts, Subject.clubWide). */
  clubWide?: boolean;
  /** The whole club's, never a location's (a message to everyone, the club's facts, a person's data): a role kept to
   *  one location is refused it, in these words (permissions.ts, Subject.wholeClub), and the staff app hides it. */
  wholeClub?: Key;
  /** Input it uses once and never keeps (a reason someone typed): left out of the stored input when the change is
   *  refused, taken out once it's applied, and out of a preview nobody confirmed once it expires (forgetStaleInputs). */
  forget?: string[];
  /** Input only the preview reads (a gift card's code): never stored, not even with the preview, so apply works
   *  from what the preview found (its details) and never sees it. */
  planOnly?: string[];
  /** What the preview's details carry only for apply (a key the plugin keeps, sealed): taken out of the stored preview
   *  once it's applied, never stored with a refused one, and taken out of a preview nobody confirmed once it expires. */
  forgetDetails?: string[];
  /** Only this person may do it (their own credit, their own code): anyone else is refused before the preview is
   *  built, and the refusal is logged like any other (without what only the preview reads). */
  selfOnly?: (db: Db | Trx, input: any) => Promise<string | null>;
  /** Whose the change is, known from the input alone (a player and the parents who manage them, a booking's organiser),
   *  the same people its preview names in ownerIds: someone it isn't theirs is refused before the preview is built, so
   *  what the preview would have said ("already brought", "already cancelled", what a refund comes to) never reaches
   *  them, and it's asked again at the yes (of those both it and the preview named), so a parent who has left the
   *  family since can't confirm what they previewed. A list: the change belongs to no location. With a location
   *  (`Owners`): the one its preview names, so a role kept to one location is judged there before the preview as after. */
  owners?: (db: Db | Trx, input: any) => Promise<string[] | Owners>;
  input: S;
  plan(ctx: PlanCtx, input: z.infer<S>): Promise<Plan>;
  apply(ctx: ApplyCtx, input: z.infer<S>, plan: Plan): Promise<unknown>;
  /** Once the change is saved: work that mustn't hold the transaction open (a call to an outside service) but
   *  that the person still waits for. What it returns is what the caller gets; it writes only through actions. */
  after?(db: Db, input: z.infer<S>, result: unknown, ctx: { actor: Actor; now: Date }): Promise<unknown>;
}

/** Tables actions may write, how to find a row, and how undo retires a row it inserted. */
const ENTITIES = {
  club: { table: "club", key: "singleton", retire: null },
  location: { table: "location", key: "id", retire: { archived_at: "now" } },
  person: { table: "person", key: "id", retire: { status: "archived" } },
  person_role: { table: "person_role", key: "id", retire: { active: false } },
  role: { table: "role", key: "id", retire: { active: false } },
  role_grant: { table: "role_grant", key: "id", retire: { active: false } },
  staff_factor: { table: "staff_factor", key: "person_id", retire: { removed_at: "now" } },
  staff_member: { table: "staff_member", key: "id", retire: { active: false } },
  passkey: { table: "passkey", key: "credential_id", retire: { revoked_at: "now" } },
  court: { table: "court", key: "id", retire: { archived_at: "now" } },
  program: { table: "program", key: "id", retire: { status: "cancelled" } },
  session: { table: "session", key: "id", retire: { status: "cancelled" } },
  court_time: { table: "court_time", key: "id", retire: { active: false } },
  mirror_booking: { table: "mirror_booking", key: "ref", retire: null },
  playtomic_booking: { table: "playtomic_booking", key: "booking_id", retire: null },
  enrolment: { table: "enrolment", key: "id", retire: { status: "cancelled" } },
  waitlist_offer: { table: "waitlist_offer", key: "id", retire: { outcome: "expired" } },
  program_watch: { table: "program_watch", key: "id", retire: { ended_at: "now" } },
  play_alert: { table: "play_alert", key: "id", retire: { ended_at: "now" } },
  payment: { table: "payment", key: "id", retire: null },
  refund: { table: "refund", key: "id", retire: null },
  draw: { table: "draw", key: "session_id", retire: { status: "void" } },
  game: { table: "game", key: "id", retire: { status: "void" } },
  competition: { table: "competition", key: "program_id", retire: { status: "void" } },
  pair_entry: { table: "pair_entry", key: "id", retire: { status: "withdrawn" } },
  fixture: { table: "fixture", key: "id", retire: { status: "void" } },
  rating: { table: "rating", key: "person_id", retire: null },
  opening_hours: { table: "opening_hours", key: "id", retire: { opens: null, closes: null } },
  hours_exception: { table: "hours_exception", key: "id", retire: { active: false } },
  court_hours: { table: "court_hours", key: "id", retire: { active: false } },
  court_block: { table: "court_block", key: "id", retire: { active: false } },
  block_series: { table: "block_series", key: "id", retire: { active: false } },
  booking_series: { table: "booking_series", key: "id", retire: { ended_at: "now" } },
  booking_series_week: { table: "booking_series_week", key: "id", retire: null },
  booking: { table: "booking", key: "id", retire: { status: "cancelled" } },
  booking_player: { table: "booking_player", key: "id", retire: { removed_at: "now" } },
  price_rule: { table: "price_rule", key: "id", retire: { active: false } },
  booking_policy: { table: "booking_policy", key: "id", retire: { active: false } },
  membership_plan: { table: "membership_plan", key: "id", retire: { active: false } },
  membership: { table: "membership", key: "id", retire: { status: "ended" } },
  membership_member: { table: "membership_member", key: "id", retire: { ends_at: "now" } },
  open_match: { table: "open_match", key: "booking_id", retire: null },
  join_request: { table: "join_request", key: "id", retire: { status: "withdrawn" } },
  friend: { table: "friend", key: "id", retire: { removed_at: "now" } },
  place_offer: { table: "place_offer", key: "id", retire: { status: "withdrawn" } },
  level_review: { table: "level_review", key: "id", retire: null },
  coach: { table: "coach", key: "person_id", retire: { active: false } },
  coach_hours: { table: "coach_hours", key: "id", retire: { active: false } },
  coach_time_off: { table: "coach_time_off", key: "id", retire: { active: false } },
  household: { table: "household", key: "id", retire: null },
  household_member: { table: "household_member", key: "id", retire: { removed_at: "now" } },
  household_invite: { table: "household_invite", key: "id", retire: { status: "withdrawn" } },
  waiver: { table: "waiver", key: "id", retire: { active: false } },
  waiver_acceptance: { table: "waiver_acceptance", key: "id", retire: null },
  kid_rule: { table: "kid_rule", key: "person_id", retire: null },
  family_card: { table: "family_card", key: "id", retire: { status: "removed" } },
  person_card: { table: "person_card", key: "id", retire: { status: "removed" } },
  kid_request: { table: "kid_request", key: "id", retire: { status: "withdrawn" } },
  attendance: { table: "attendance", key: "id", retire: null },
  club_fact: { table: "club_fact", key: "id", retire: { active: false } },
  question: { table: "question", key: "id", retire: { status: "closed" } },
  question_message: { table: "question_message", key: "id", retire: null },
  tag: { table: "tag", key: "id", retire: { active: false } },
  person_tag: { table: "person_tag", key: "id", retire: { removed_at: "now" } },
  segment: { table: "segment", key: "id", retire: { active: false } },
  message_template: { table: "message_template", key: "id", retire: { active: false } },
  broadcast: { table: "broadcast", key: "id", retire: { status: "cancelled" } },
  staff_alert: { table: "staff_alert", key: "id", retire: null },
  oauth_grant: { table: "oauth_grant", key: "id", retire: { revoked_at: "now" } },
  agent: { table: "agent", key: "id", retire: { revoked_at: "now" } },
  webhook_subscription: { table: "webhook_subscription", key: "id", retire: { active: false } },
  plugin: { table: "plugin", key: "id", retire: { status: "removed" } },
  plugin_card: { table: "plugin_card", key: "id", retire: { cleared_at: "now" } },
  texting_registration: { table: "texting_registration", key: "id", retire: null },
  support_grant: { table: "support_grant", key: "id", retire: { ended_at: "now" } },
  email_suppression: { table: "email_suppression", key: "address", retire: { cleared_at: "now" } },
  vault_item: { table: "vault_item", key: "id", retire: { active: false } },
  chat_message: { table: "chat_message", key: "id", retire: null },
  chat_stop: { table: "chat_stop", key: "id", retire: { ended_at: "now" } },
  chat_report: { table: "chat_report", key: "id", retire: null },
  payment_found: { table: "payment_found", key: "id", retire: null },
  credit_payout: { table: "credit_payout", key: "id", retire: null },
  brought_credit: { table: "brought_credit", key: "id", retire: null },
  brought_identity: { table: "brought_identity", key: "key_hash", retire: null },
  move_in: { table: "move_in", key: "singleton", retire: null },
  playtomic_upload: { table: "playtomic_upload", key: "id", retire: null },
  move_upload: { table: "move_upload", key: "id", retire: null },
  gift_card: { table: "gift_card", key: "id", retire: null },
  pass_product: { table: "pass_product", key: "id", retire: { on_sale: false } },
  pass: { table: "pass", key: "id", retire: null },
  pass_use: { table: "pass_use", key: "id", retire: null },
  promo_code: { table: "promo_code", key: "id", retire: { active: false } },
  promo_use: { table: "promo_use", key: "id", retire: null },
} as const;
export type Entity = keyof typeof ENTITIES;
/** Columns that are keys to something (a club news email's unsubscribe link, an authenticator's secret):
 *  never copied into the change log. */
const KEYS_NOT_KEPT: Partial<Record<Entity, string[]>> = { person: ["news_token"], staff_factor: ["secret"], chat_message: ["body"], chat_report: ["reason"], chat_stop: ["reason"],
  gift_card: ["code_hash", "code_sealed"],
  // A club agent's new token waiting to be shown once, and a webhook's signing secret (agents.ts, webhooks.ts).
  agent: ["token_once"], webhook_subscription: ["secret_sealed"],
  // A plugin's own secret and its token on the way to it (plugins.ts): never in the change log.
  plugin: ["secret_sealed", "registration_sealed"],
  // An upload of the club's export (brought_in.ts): its hash and row count are logged, never the people in it.
  playtomic_upload: ["rows", "problems", "wallet_columns"],
  // A file from CourtReserve or Playbypoint (move_files.ts): the same.
  move_upload: ["rows", "problems"] };
const unkept = (entity: Entity, row: unknown) => {
  const drop = KEYS_NOT_KEPT[entity];
  if (!drop || !row || typeof row !== "object") return row;
  const copy = { ...(row as Record<string, unknown>) };
  for (const k of drop) delete copy[k];
  return copy;
};

const registry = new Map<string, ActionDef<any>>();
export function defineAction<S extends z.ZodMiniObject>(def: ActionDef<S>): ActionDef<S> {
  if (registry.has(def.name)) throw new Error(`action ${def.name} defined twice`);
  registry.set(def.name, def);
  return def;
}
export function actions(): ActionDef<any>[] { return [...registry.values()]; }
/** What actions forget, out of every run that will never be applied now: refused or failed, or a preview that expired
 *  unconfirmed (an ask still waiting for a yes keeps it until it's answered or expires). */
export async function forgetStaleInputs(db: Db | Trx, now = new Date()): Promise<number> {
  let n = 0;
  for (const def of registry.values()) for (const key of def.forget ?? []) {
    const r = await sql`UPDATE action_run SET input = input - ${key} WHERE action = ${def.name} AND input ? ${key}
      AND status <> 'applied' AND (status NOT IN ('planned', 'awaiting_approval') OR plan_expires_at < ${now})`.execute(db);
    n += Number(r.numAffectedRows ?? 0);
  }
  for (const def of registry.values()) for (const key of def.forgetDetails ?? []) {
    const r = await sql`UPDATE action_run SET plan = plan #- ${`{details,${key}}`}::text[] WHERE action = ${def.name} AND plan->'details' ? ${key}
      AND (status NOT IN ('planned', 'awaiting_approval') OR plan_expires_at < ${now})`.execute(db);
    n += Number(r.numAffectedRows ?? 0);
  }
  return n;
}
export function getAction(name: string): ActionDef<any> {
  const def = registry.get(name);
  if (!def) throw new KumiError("error.unknown_action", {}, 404);
  return def;
}

export const PLAN_MINUTES = 15;
const APPROVAL_DAYS = 7;
const keyOf = (e: Entity, id: string) => `${e}:${id}`;
/** Why an ask ended without a yes, for whoever looks at it later (the Changes page, a late approve). */
export const ASK_ENDED = new Set(["error.ask_settled", "error.ask_out_of_date", "error.declined"]);
/** After a change: asks still waiting that read anything it changed are out of date (they'd be refused at the yes:
 *  "error.changed"), so they say so now. One query on what this change touched. */
async function outdateAsks(trx: Trx, runId: string, by: string | null, now: Date) {
  const touched = await trx.selectFrom("entity_change").select(["entity", "entity_id"]).distinct().where("action_run_id", "=", runId).execute();
  if (!touched.length) return;
  const keys = touched.map((t) => `${t.entity}:${t.entity_id}`);
  await sql`UPDATE action_run SET status = 'failed', ended_at = ${now}, error = ${JSON.stringify({ code: "error.ask_out_of_date", params: { by, run: runId } })}::jsonb
    WHERE status = 'awaiting_approval' AND id <> ${runId} AND read_versions ?| ${keys}::text[]`.execute(trx);
}

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
  if (!parsed.success) throw new KumiError("error.invalid_input", { details: plainIssues(parsed.error.issues, raw) }, 400);
  return parsed.data;
}

/** The preview as it's stored: without its picture (Plan.image), which is for the person looking at it now. */
const planJson = (p: Partial<Plan>) => JSON.stringify({ ...p, image: undefined });
/** The preview without the details only apply reads (forgetDetails). */
const planForgotten = (def: ActionDef<any>, p: Partial<Plan>) => def.forgetDetails?.length && p.details && typeof p.details === "object"
  ? { ...p, details: without(p.details, def.forgetDetails) } : p;
/** The input as it's kept: without what the action forgets. */
const kept = (def: ActionDef<any>, input: unknown) => without(stored(def, input), def.forget);
/** The input as it's stored with a preview: without what only the preview reads (planOnly). */
const stored = (def: ActionDef<any>, input: unknown) => without(input, def.planOnly);
const without = (input: unknown, keys: string[] | undefined) =>
  keys?.length && input && typeof input === "object" ? Object.fromEntries(Object.entries(input).filter(([k]) => !keys.includes(k))) : input;

async function refuse(db: Db, def: ActionDef<any>, input: unknown, actor: Actor, plan: Plan | null, d: Decision): Promise<never> {
  // Every "no" is logged (permissions.md), with the support access it was tried under (and nothing the action forgets).
  await db.insertInto("action_run").values({ support_grant_id: d.support ?? null,
    id: uuidv7(), action: def.name, action_version: def.version, actor_person_id: actor.personId, agent_id: actor.agentId ?? null,
    via: actor.via, location_id: plan?.locationId ?? null, input: JSON.stringify(kept(def, input)), plan: planJson(planForgotten(def, plan ?? {})), status: "failed",
    undo_kind: "none", read_versions: JSON.stringify({}), plan_expires_at: new Date(), error: JSON.stringify({ code: "error.forbidden_reason", reason: d.reason }),
  }).execute();
  throw new KumiError("error.forbidden_reason", { reason: both(d.reason ?? "reason.no_role") }, 403);
}

/** Never through an assistant (permissions.md: an agent can't raise its own limits): what it may spend, the
 *  account's own safety (deleting it, changing how the person signs in), and the person's own say: accepting
 *  a waiver, moving their own level (or claiming one from another app, or taking that away), downloading their data, the family card and saved cards. A parent's say over
 *  their children is theirs too: who signs in as a junior, a junior's rules and limits, a charge past them, and
 *  who else is in the family (an invite is a second parent). These are done in the club's app. So is anything
 *  that needs a strong sign-in (strongAuth), money changing hands at the desk (DESK_MONEY: only the person
 *  holding it says so), and saying yes to texts or club news (APP_ONLY_YES): an assistant may still turn them off. */
export const APP_ONLY = new Set(["assistant.set_cap", "privacy.erase", "privacy.export", "person.factor_add", "person.factor_codes", "person.factor_remove",
  "person.passkey_add", "person.passkey_remove", "waiver.accept", "level.self_adjust", "level.claim", "level.remove_import", "family_card.start", "family_card.remove", "family_card.open",
  "family_card.saved", "card.open", "card.saved", "card.remove", "membership.card_open", "membership.card_saved", "kid.give_login", "kid.remove_login", "kid.set_rules", "kid.approve_request",
  "household.invite", "household.accept_invite", "household.give_login", "household.leave", "household.remove_junior", ...DESK_MONEY, ...CHAT_ACTIONS, ...CREDIT_MONEY, "payment.use_credit", "gift_card.redeem", "payment.use_pass", "pass_product.set", "promo_code.set",
  // Taking a tournament or league result back undoes later matches too: staff in the app only.
  "fixture.reopen",
  // A members' list: its preview says who of them is already here, which through an assistant would tell whose an
  // email is (shortened everywhere else) one guess at a time. The app, or `openpadel import members` on the server.
  "person.import",
  // Moving in from Playtomic (brought_in.ts): credit members are owed and memberships, in bulk, from the club's own
  // export or Playtomic itself, and saying Playtomic's wallets are at zero. Rows an assistant typed could make credit
  // from nothing: the app, or `openpadel playtomic` on the server, which read the file or Playtomic themselves.
  "playtomic.upload", "credit.bring_in", "membership.bring_in", "credit.brought_zeroing", "credit.brought_zeroed",
  // Moving in from CourtReserve or Playbypoint (move_files.ts): the same, from the files the club exports there. The
  // app, or `openpadel move-in courtreserve|playbypoint` on the server, which reads the files itself.
  "move.upload", "move.members", "move.memberships", "move.credit", "move.bookings", "move.programs"]);
export const APP_ONLY_YES = new Set(["consent.texts", "consent.club_news", "consent.whatsapp"]);
/** Whether an action is the app's alone, never an assistant's: with `input`, for this input. */
export function appOnly(def: ActionDef<any>, input?: unknown): boolean {
  return APP_ONLY.has(def.name) || Boolean(def.strongAuth) || (APP_ONLY_YES.has(def.name) && (input as { granted?: unknown } | undefined)?.granted === true);
}

/** What the permission check needs to know about how it was asked: through an assistant, and for an action that
 *  needs a strong sign-in (support access reaches neither). */
const how = (def: ActionDef<any>, actor: Actor) => ({ assistant: actor.auth === "oauth" || Boolean(actor.grantId), strongAuth: Boolean(def.strongAuth), clubWide: Boolean(def.clubWide), wholeClub: def.wholeClub, memberOnly: Boolean(actor.memberOnly) });

/** Sensitive changes: made signed in with a passkey, or with two steps, by anyone who has either and by the roles the
 *  club's rule names (second_step.ts), whether or not the club asks a second step at sign-in. Someone with none yet
 *  hears so (error.second_step_to_change), and the apps offer to set one up there and then. */
async function requireStrongAuth(db: Db | Trx, def: ActionDef<any>, actor: Actor, input: unknown): Promise<void> {
  if (actor.auth === "oauth" && appOnly(def, input)) throw new KumiError("error.assistant_in_app", {}, 403);
  if (!def.strongAuth || !actor.personId || actor.auth === "passkey" || actor.auth === "two_factor" || actor.auth === "system") return;
  // Any other way in (an emailed or texted code, anything new) is one step.
  if (!(await secondStepForChanges(db, actor.personId))) return;
  throw new KumiError((await hasSecondFactor(db, actor.personId)) ? "error.need_passkey" : "error.second_step_to_change", {}, 403);
}

/** An undo is judged as the change it undoes: that change's permission, strong sign-in and app-only rules, with that
 *  change's input. Otherwise anyone who may undo could reverse what only the owner, or only the app, may do (a
 *  manager's assistant putting back the cap the owner lowered). Null for every other action. */
async function judgedAs(db: Db | Trx, def: ActionDef<any>, input: unknown): Promise<{ def: ActionDef<any>; input: unknown } | null> {
  if (def.name !== "action.undo") return null;
  const id = (input as { run_id?: unknown } | null)?.run_id;
  if (typeof id !== "string") return null;
  const original = await db.selectFrom("action_run").select(["action", "input"]).where("id", "=", id).executeTakeFirst();
  return original ? { def: getAction(original.action), input: original.input } : null;
}

/** Confirming or approving an undo: the person must be allowed the change it undoes outright, with its strong
 *  sign-in and outside an assistant if it's the app's alone. */
async function allowedAsJudged(db: Db | Trx, def: ActionDef<any>, input: unknown, actor: Actor, locationId: string | null, ownerIds: string[], at: Date): Promise<void> {
  const judged = await judgedAs(db, def, input);
  if (!judged) return;
  await requireStrongAuth(db, judged.def, actor, judged.input);
  const d = await decide(db, judged.def.name, { personId: actor.personId, agentId: actor.agentId ?? null, locationId, ownerIds, at, ...how(judged.def, actor) });
  if (d.mode !== "allow") throw new KumiError("error.forbidden_reason", { reason: both(d.reason ?? "reason.no_role") }, 403);
}

/** Whether the person may also do another action here, judged as that action's own check judges it, assistant and
 *  app-only rules included: a change that does two things at once (a court booked with places marked paid at the desk
 *  takes desk money too, booking.record_payment) asks both. Kumi's own jobs (no person) always may. */
export async function mayAlso(db: Db | Trx, actor: Actor, name: string, o: { locationId: string | null; ownerIds?: string[]; at: Date }): Promise<boolean> {
  if (!actor.personId) return true;
  const def = getAction(name);
  if ((actor.auth === "oauth" || Boolean(actor.grantId)) && appOnly(def)) return false;
  return (await decide(db, name, { personId: actor.personId, agentId: actor.agentId ?? null, locationId: o.locationId, ownerIds: o.ownerIds ?? [], at: o.at, ...how(def, actor) })).mode === "allow";
}

export interface Planned { runId: string; status: "planned" | "awaiting_approval" | "would_ask"; plan: Plan; expiresAt: Date;
  /** How many different people's yes it waits for: 2 under the club's second-yes rule (secondYesNeeded), else 1. */
  yesesNeeded: number }
export interface PlanOpts { now?: Date; internal?: boolean; /** A parent approved it: a kid's rules don't stop it again. */ parentApproved?: boolean;
  /** The staff app's first look: a change that needs someone else's yes is shown, not yet asked for, until the person
   *  says to ask (status "would_ask", nothing stored or sent). */
  holdAsk?: boolean }

/** A last look before a plan is stored, for what the action itself can't know: a kid's own rules (kids.ts).
 *  It can hand back another action to plan instead (asking a parent). */
type PlanGate = (db: Db, name: string, input: unknown, actor: Actor, plan: Plan, now: Date) => Promise<{ name: string; input: unknown } | null>;
let planGate: PlanGate | null = null;
export function setPlanGate(gate: PlanGate): void { planGate = gate; }

/** Whose a change is, as the action says from its input alone (ActionDef.owners): a list belongs to no location. */
async function ownersOf(db: Db | Trx, def: ActionDef<any>, input: unknown): Promise<Owners | null> {
  if (!def.owners) return null;
  const o = await def.owners(db, input);
  return Array.isArray(o) ? { ownerIds: o, locationId: null } : o;
}
/** Asked before the preview is built, for an action that knows whose it is from its input: the same question the
 *  preview's own check asks, of the same people and location. A location the input can't tell is left to that check
 *  (judged here as if it were theirs), so nobody is refused here who'd be let through there. */
async function ownersFirst(db: Db | Trx, def: ActionDef<any>, input: unknown, actor: Actor, now: Date): Promise<Decision | null> {
  const o = await ownersOf(db, def, input);
  if (!o) return null;
  return decide(db, def.name, { personId: actor.personId, agentId: actor.agentId ?? null, locationId: o.locationId ?? null, ownerIds: o.ownerIds, at: now, ...how(def, actor),
    ...(o.locationId === undefined ? { clubWide: true } : {}) });
}

/** Asked before the preview is built, for an action that can't tell whose it is from its input (no `owners`): whether
 *  the person could be let do it anywhere at all, on any rows of theirs or anyone's, as generously as the preview's own
 *  check could ever answer (their own rows, any location, any shift). Someone it can never be is refused here, so a
 *  preview's words ("only $X is owed", "paid up", a refund's amount, a place's note) never reach a person with no
 *  grant for the action. Anyone the later check would let through is let through here. */
async function mayEver(db: Db | Trx, def: ActionDef<any>, actor: Actor, now: Date): Promise<Decision | null> {
  if (def.owners || !actor.personId) return null;
  // The person's own roles and support access only: an assistant's cap can only lower that, and is asked after.
  return decide(db, def.name, { personId: actor.personId, agentId: null, locationId: null, ownerIds: [actor.personId], at: now, ...how(def, actor), clubWide: true });
}

/** Validate, build the preview and check permission, storing nothing: what an action would do, for a
 *  plan that wraps another (a kid asking a parent shows what they're asking for). */
export async function dryPlan(db: Db | Trx, name: string, raw: unknown, actor: Actor, now: Date): Promise<Plan> {
  const def = getAction(name);
  if (def.system || def.internal) throw new KumiError("error.unknown_action", {}, 404);
  const input = validate(def, raw);
  const first = await ownersFirst(db, def, input, actor, now);
  if (first?.mode === "no") throw new KumiError("error.forbidden_reason", { reason: both(first.reason ?? "reason.no_role") }, 403);
  const ever = await mayEver(db, def, actor, now);
  if (ever?.mode === "no") throw new KumiError("error.forbidden_reason", { reason: both(ever.reason ?? "reason.no_role") }, 403);
  const p = await def.plan({ db, actor, now }, input);
  const d = await decide(db, name, { personId: actor.personId, agentId: actor.agentId ?? null, locationId: p.locationId ?? null, ownerIds: p.ownerIds ?? [], at: now, ...how(def, actor) });
  if (d.mode === "no") throw new KumiError("error.forbidden_reason", { reason: both(d.reason ?? "reason.no_role") }, 403);
  return p;
}

/** The club's second-yes rule (role.second_yes, roles.ts): whether a change waits for two different people's yes,
 *  neither of them the person who asked. A change the club names (an undo as the change it undoes), or one that charges
 *  or refunds more than the club's amount. It's a rule for staff work: a member's own changes (someone holding no staff
 *  role) never wait for staff under it. Kumi's own agents count as staff. */
export async function secondYesNeeded(db: Db | Trx, name: string, judgedName: string | null, actor: Actor, p: Plan): Promise<boolean> {
  const club = await db.selectFrom("club").select(["second_yes_actions", "second_yes_over_cents"]).executeTakeFirst();
  if (!club) return false;
  const named = club.second_yes_actions.includes(name) || (judgedName !== null && club.second_yes_actions.includes(judgedName));
  const over = club.second_yes_over_cents !== null && (p.moneyCents ?? 0) > club.second_yes_over_cents;
  if (!named && !over) return false;
  if (!actor.personId) return true;
  return (await roleKeysOf(db, actor)).some((k) => k !== "member");
}

/** Step one: validate, check permission, build the preview, and store it. Nothing changes yet. */
export async function plan(db: Db, name: string, raw: unknown, actor: Actor, opts: PlanOpts = {}): Promise<Planned> {
  const def = getAction(name);
  if (def.internal && !opts.internal) throw new KumiError("error.unknown_action", {}, 404);
  await readOnlyGate(db, name);   // a club its host has made read-only (read_only.ts)
  await requireStrongAuth(db, def, actor, raw);
  const input = validate(def, raw);
  const judged = await judgedAs(db, def, input);
  if (judged) await requireStrongAuth(db, judged.def, actor, judged.input);
  // Undoing the owner's own setting for how staff sign in (club.ts) is the owner's too, never something to ask for.
  if (judged?.def.name === "club.update" && (judged.input as Record<string, unknown> | null)?.second_step_sign_in !== undefined && actor.personId
    && !(await holdsRole(db, actor, ["owner"]))) throw new KumiError("error.owner_only_setting", { field: both("field.second_step_sign_in") }, 403);
  const now = opts.now ?? new Date();
  if (def.selfOnly) {
    const self = await def.selfOnly(db, input);
    if (self && actor.personId !== self) return refuse(db, def, input, actor, null, { mode: "no", reason: "reason.self_only" });
  }
  const first = await ownersFirst(db, def, input, actor, now);
  if (first?.mode === "no") return refuse(db, def, input, actor, null, first);
  const ever = await mayEver(db, def, actor, now);
  if (ever?.mode === "no") return refuse(db, def, input, actor, null, ever);
  const p = await def.plan({ db, actor, now }, input);
  const d = await decide(db, name, { personId: actor.personId, agentId: actor.agentId ?? null, locationId: p.locationId ?? null, ownerIds: p.ownerIds ?? [], at: now, ...how(def, actor) });
  if (d.mode === "no") return refuse(db, def, input, actor, p, d);
  if (planGate && !opts.parentApproved) {
    const instead = await planGate(db, name, input, actor, p, now);
    if (instead) return plan(db, instead.name, instead.input, actor, { now, internal: true });
  }
  // A club agent can't plan past the weekly limit the club set for it (assistant_spend.ts, checkAgentSpend).
  if (actor.agentId) await checkAgentSpend(db, actor.agentId, p, now);
  // An assistant can't plan past the weekly cap its person set for it (assistant_spend.ts).
  else if (actor.grantId && actor.personId) {
    const counted = await checkAssistantSpend(db, actor.grantId, name, input, p, actor.personId, now);
    // A shared court counts in full until the others pay: the preview says so.
    if (counted > (p.moneyCents ?? 0)) {
      const note = both("plan.assistant.counts_until_paid", { amount: { en: money(counted, "en"), es: money(counted, "es") } });
      p.summary = { en: `${p.summary.en} ${note.en}`, es: `${p.summary.es} ${note.es}` };
    }
  }
  const yesesNeeded = (await secondYesNeeded(db, name, judged?.def.name ?? null, actor, p)) ? 2 : 1;
  const status: Planned["status"] = d.mode === "ask" || p.secondPerson || yesesNeeded > 1 ? "awaiting_approval" : "planned";
  const expiresAt = new Date(now.getTime() + (status === "planned" ? PLAN_MINUTES * 60_000 : APPROVAL_DAYS * 864e5));
  const runId = uuidv7(now.getTime());
  const row = {
    id: runId, action: name, action_version: def.version, actor_person_id: actor.personId, agent_id: actor.agentId ?? null, via: actor.via,
    location_id: p.locationId ?? null, input: JSON.stringify(stored(def, input)), plan: planJson(p), status, undo_kind: p.undo.kind,
    undo_note: p.undo.note ? JSON.stringify(p.undo.note) : null, read_versions: JSON.stringify(Object.fromEntries(p.reads.map((r) => [keyOf(r.entity, r.id), r.version]))),
    plan_expires_at: expiresAt, money_cents: String(p.moneyCents ?? 0), undo_of: (input as any)?.run_id && name === "action.undo" ? (input as any).run_id : null,
    oauth_grant_id: actor.grantId ?? null, support_grant_id: d.support ?? null, yeses_needed: yesesNeeded,
  };
  if (status === "planned") { await db.insertInto("action_run").values(row).execute(); return { runId, status, plan: p, expiresAt, yesesNeeded }; }
  if (opts.holdAsk) return { runId: "", status: "would_ask", plan: p, expiresAt, yesesNeeded };
  await db.transaction().execute(async (trx) => {
    // The same change asked for again while the first ask still waits, by anyone, isn't asked twice: everyone who can
    // say yes would be told again, and two yeses would do it twice. One ask of each action at a time gets this far.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`ask:${name}`}))`.execute(trx);
    const waiting = await trx.selectFrom("action_run").select("created_at").where("action", "=", name).where("status", "=", "awaiting_approval")
      .where("plan_expires_at", ">", now).where(sql<boolean>`input = ${JSON.stringify(stored(def, input))}::jsonb`).orderBy("created_at").executeTakeFirst();
    if (waiting) {
      const tz = (await trx.selectFrom("club").select("time_zone").executeTakeFirst())?.time_zone ?? "UTC";
      const at = (l: string) => new Intl.DateTimeFormat(l, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(waiting.created_at);
      throw new KumiError("error.ask_waiting", { when: { en: at(formatLocale("en")), es: at(formatLocale("es")) } }, 409);
    }
    await trx.insertInto("action_run").values(row).execute();
    // Whoever can say yes hears it's waiting (messages.ts), once for this ask.
    await trx.insertInto("event_outbox").values({ action_run_id: runId, topic: "approval.waiting", payload: JSON.stringify({ run_id: runId }) }).execute();
  });
  return { runId, status, plan: p, expiresAt, yesesNeeded };
}

/** Step two: apply a stored plan, once. Fails if anything it read has changed since. */
export async function apply(db: Db, runId: string, actor: Actor, opts: { idempotencyKey?: string; now?: Date; approvedBy?: string; system?: boolean } = {}): Promise<unknown> {
  const now = opts.now ?? new Date();
  if (opts.idempotencyKey) {
    const prior = await db.selectFrom("action_run").select(["result", "status", "actor_person_id"]).where("idempotency_key", "=", opts.idempotencyKey).executeTakeFirst();
    // An earlier answer is given again only to whoever made the change: a key (or a run id) someone else holds
    // tells them nothing of it.
    if (prior?.status === "applied" && !opts.system && !opts.approvedBy && prior.actor_person_id !== actor.personId) throw new KumiError("error.plan_not_yours", {}, 403);
    if (prior?.status === "applied") return prior.result;
  }
  let after: (() => Promise<unknown>) | null = null;
  try {
    // Once more if Postgres broke a deadlock by ending this change (two changes taking the same rows in another
    // order): nothing of it was kept, and a call to a provider inside a change carries a key that gives the same
    // answer again.
    const result = await onceMoreOnDeadlock(() => db.transaction().execute(async (trx) => {
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
      if (approving) {
        // Each yes is kept on the change, in order, under this lock: two people saying yes at once are counted one
        // after the other, and the same person twice counts once (approve never lets the asker's count at all). Short
        // of the yeses it needs (the club's second-yes rule), it keeps waiting with this one recorded.
        const yeses = [...((run.yeses as Yes[] | null) ?? [])];
        if (!yeses.some((y) => y.by === opts.approvedBy)) yeses.push({ by: opts.approvedBy!, at: now.toISOString() });
        await trx.updateTable("action_run").set({ yeses: JSON.stringify(yeses) }).where("id", "=", runId).execute();
        if (yeses.length < run.yeses_needed) return { yes_waiting: { yeses: yeses.length, needed: run.yeses_needed } } satisfies YesWaiting;
      }
      await readOnlyGate(trx, run.action);   // a preview made before the club went read-only
      if (!approving && !opts.system) await requireStrongAuth(trx, def, actor, run.input);
      if (opts.system && !def.system) throw new KumiError("error.forbidden_reason", { reason: both("reason.no_role") }, 403);
      if (!approving && !opts.system) {   // permissions may have changed since the preview, and whose it is (owners)
        // Whose it is now that it was at the preview too: a parent who has left the family since isn't, and a first look
        // wider than the preview's own (a junior's parents for a court) never lets in anyone the preview didn't name.
        const whose = await ownersOf(trx, def, run.input), stored = p.ownerIds ?? [];
        const ownerIds = whose ? whose.ownerIds.filter((id) => stored.includes(id)) : stored;
        const d = await decide(trx, run.action, { personId: actor.personId, agentId: actor.agentId ?? null, locationId: run.location_id, ownerIds, at: now, ...how(def, actor) });
        if (d.mode !== "allow") throw new KumiError("error.forbidden_reason", { reason: both(d.reason ?? "reason.no_role") }, 403);
        await allowedAsJudged(trx, def, run.input, actor, run.location_id, ownerIds, now);
      }
      // Checked again as it happens, with the connection locked, so two confirms at once can't both fit.
      // A preview an assistant made dies with it: once it's disconnected, nobody can apply it.
      if (run.oauth_grant_id) {
        const g = await trx.selectFrom("oauth_grant").select("revoked_at").where("id", "=", run.oauth_grant_id).forUpdate().executeTakeFirst();
        if (!g || g.revoked_at) throw new KumiError("error.assistant_disconnected", {}, 403);
      }
      if (run.agent_id) {
        // A club agent's limit, likewise with the agent locked; one taken back since can't have its change made.
        await trx.selectFrom("agent").select("id").where("id", "=", run.agent_id).forUpdate().executeTakeFirst();
        await checkAgentSpend(trx, run.agent_id, p, now, runId);
      } else if (run.oauth_grant_id && run.actor_person_id) {
        await checkAssistantSpend(trx, run.oauth_grant_id, run.action, run.input, p, run.actor_person_id, now, runId);
      }
      for (const [k, v] of Object.entries(run.read_versions as Record<string, number>)) {
        const [entity, ...rest] = k.split(":");
        if ((await currentVersion(trx, entity as Entity, rest.join(":"))) !== v) throw new KumiError("error.changed");
      }
      const runActor: Actor = { personId: run.actor_person_id, agentId: run.agent_id, via: run.via, lang: actor.lang, grantId: run.oauth_grant_id };
      const ctx = applyCtx(trx, runActor, now, runId, opts.approvedBy ?? null);
      const result = (await def.apply(ctx, run.input, p)) ?? null;
      await trx.updateTable("action_run").set({
        status: "applied", applied_at: now, result: JSON.stringify(result), idempotency_key: opts.idempotencyKey ?? null,
        ...(def.forget?.length ? { input: JSON.stringify(kept(def, run.input)) } : {}),
        ...(def.forgetDetails?.length ? { plan: planJson(planForgotten(def, p)) } : {}),
        approved_by: opts.approvedBy ?? null, undo_until: p.undo.minutes ? new Date(now.getTime() + p.undo.minutes * 60_000) : null,
      }).where("id", "=", runId).execute();
      // An ask still waiting that read something this change has just changed can never be done as it was asked: it's
      // marked out of date, with a reason staff read, instead of waiting for a yes that would be refused.
      await outdateAsks(trx, runId, runActor.personId ?? null, now);
      if (def.after) after = () => def.after!(db, run.input, result, { actor: runActor, now });
      return result;
    }));
    return after ? await (after as () => Promise<unknown>)() : result;
  } catch (e) {
    if (e instanceof KumiError && ["error.changed", "error.forbidden_reason"].includes(e.code)) {
      await db.updateTable("action_run").set({ status: "failed", error: JSON.stringify({ code: e.code, params: e.params }) }).where("id", "=", runId).where("status", "in", ["planned", "awaiting_approval"]).execute();
    }
    throw e;
  }
}

type AskedRun = { id: string; action: string; input: unknown; plan: unknown; location_id: string | null; actor_person_id: string | null; yeses?: unknown };
/** A yes given to an ask: who and when (action_run.yeses). */
export interface Yes { by: string; at: string }
/** What approve gives back when the change still waits for another yes (the club's second-yes rule). */
export interface YesWaiting { yes_waiting: { yeses: number; needed: number } }
export const isYesWaiting = (r: unknown): r is YesWaiting => Boolean(r && typeof r === "object" && "yes_waiting" in r);
/** Whether this person already said yes to an ask. */
export const saidYes = (run: { yeses?: unknown }, personId: string | null) => Boolean(personId) && ((run.yeses as Yes[] | undefined) ?? []).some((y) => y.by === personId);

/** Whether this person could say yes to an ask (or no): allowed the change outright, not the person who asked, and
 *  not someone who already said yes to it. An undo is judged as the change it undoes. The strong sign-in is checked
 *  when they say yes, not here. */
export async function mayAnswer(db: Db | Trx, run: AskedRun, personId: string | null, at: Date): Promise<boolean> {
  if (!personId || run.actor_person_id === personId || saidYes(run, personId)) return false;
  // A club agent never says yes to anything: asks are for people (agents.ts).
  if (await clubAgentOf(db, personId)) return false;
  const p = run.plan as Plan, def = getAction(run.action), s = { personId, agentId: null, locationId: run.location_id, ownerIds: p.ownerIds ?? [], at };
  if ((await decide(db, run.action, { ...s, assistant: false, strongAuth: Boolean(def.strongAuth), clubWide: Boolean(def.clubWide) })).mode !== "allow") return false;
  const judged = await judgedAs(db, def, run.input);
  return !judged || (await decide(db, judged.def.name, { ...s, assistant: false, strongAuth: Boolean(judged.def.strongAuth), clubWide: Boolean(judged.def.clubWide) })).mode === "allow";
}

/** Everyone on the staff who could say yes to this ask now (mayAnswer): not its asker, not anyone who already said yes. */
export async function answerers(db: Db | Trx, run: AskedRun, at: Date): Promise<string[]> {
  const staff = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.person_id")
    .where("role.key", "!=", "member").where("person_role.active", "=", true).where("role.active", "=", true).distinct().execute();
  const out: string[] = [];
  for (const s of staff) if (await mayAnswer(db, run, s.person_id, at)) out.push(s.person_id);
  return out;
}
/** Whether an ask that waits for more yeses can still get them: those given, and everyone left who could give one. */
export async function yesesReachable(db: Db | Trx, run: AskedRun & { yeses_needed: number }, at: Date): Promise<boolean> {
  const given = ((run.yeses as Yes[] | undefined) ?? []).length;
  if (given + 1 > run.yeses_needed) return true;
  return given + (await answerers(db, run, at)).length >= run.yeses_needed;
}

/** An "ask" waits for someone allowed to do it, who isn't the person who asked: one yes, or two different people's under
 *  the club's second-yes rule (YesWaiting after the first). Saying yes again gives the same answer, not a second yes. */
export async function approve(db: Db, runId: string, approver: Actor, opts: { now?: Date } = {}): Promise<unknown> {
  const now = opts.now ?? new Date();
  const run = await db.selectFrom("action_run").selectAll().where("id", "=", runId).executeTakeFirst();
  if (!run) throw new KumiError("error.not_found", { thing: both("thing.change") }, 404);
  if (approver.personId && saidYes(run, approver.personId)) {
    if (run.status === "applied") return run.result;
    if (run.status === "awaiting_approval") return { yes_waiting: { yeses: (run.yeses as Yes[]).length, needed: run.yeses_needed } } satisfies YesWaiting;
  }
  // An ask that ended (done meanwhile, out of date, someone said no) says why, not just that it's "failed".
  const ended = run.status === "failed" ? (run.error as { code?: string; params?: Record<string, unknown> } | null) : null;
  if (ended?.code && ASK_ENDED.has(ended.code)) throw new KumiError(ended.code as Key, ended.params as any);
  if (run.actor_person_id === approver.personId) throw new KumiError("error.own_approval", {}, 403);
  const p = run.plan as Plan, def = getAction(run.action);
  // Saying yes to a change that needs a strong sign-in needs one too: the approver is the one making it happen.
  await requireStrongAuth(db, def, approver, run.input);
  const d = await decide(db, run.action, { personId: approver.personId, agentId: approver.agentId ?? null, locationId: run.location_id, ownerIds: p.ownerIds ?? [], at: now, ...how(def, approver) });
  if (d.mode !== "allow") throw new KumiError("error.forbidden_reason", { reason: both(d.reason ?? "reason.no_role") }, 403);
  await allowedAsJudged(db, def, run.input, approver, run.location_id, p.ownerIds ?? [], now);
  const result = await apply(db, runId, approver, { now, approvedBy: approver.personId! });
  if (isYesWaiting(result)) return result;
  // The person who asked hears it's done.
  await db.insertInto("event_outbox").values({ action_run_id: runId, topic: "approval.approved", payload: JSON.stringify({ run_id: runId, by: approver.personId }) }).execute();
  return result;
}

/** Saying no to an ask: by someone who could have said yes. Nothing changes; the ask is kept in the change log as a
 *  change that didn't happen, with who said no and why, and the person who asked hears. */
export async function decline(db: Db, runId: string, decliner: Actor, opts: { now?: Date; reason?: string | null } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const run = await db.selectFrom("action_run").selectAll().where("id", "=", runId).executeTakeFirst();
  if (!run) throw new KumiError("error.not_found", { thing: both("thing.change") }, 404);
  if (run.actor_person_id === decliner.personId) throw new KumiError("error.own_approval", {}, 403);
  if (run.status !== "awaiting_approval") throw new KumiError("error.not_planned", { status: run.status });
  if (decliner.auth === "oauth" || decliner.grantId) throw new KumiError("error.assistant_in_app", {}, 403);
  if (!(await mayAnswer(db, run, decliner.personId, now))) throw new KumiError("error.forbidden_reason", { reason: both("reason.no_role") }, 403);
  const reason = opts.reason?.trim().slice(0, 300) || null;
  await db.transaction().execute(async (trx) => {
    const r = await trx.updateTable("action_run").set({ status: "failed", ended_at: now, error: JSON.stringify({ code: "error.declined", params: { by: decliner.personId, reason } }) })
      .where("id", "=", runId).where("status", "=", "awaiting_approval").executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw new KumiError("error.not_planned", { status: "failed" });
    await trx.insertInto("event_outbox").values({ action_run_id: runId, topic: "approval.declined", payload: JSON.stringify({ run_id: runId, by: decliner.personId, reason }) }).execute();
  });
}

function applyCtx(trx: Trx, actor: Actor, now: Date, runId: string, approvedBy: string | null = null): ApplyCtx {
  const record = (entity: Entity, id: string, op: "insert" | "update", before: unknown, after: unknown) =>
    trx.insertInto("entity_change").values({ action_run_id: runId, entity, entity_id: id, op, before: before === null ? null : JSON.stringify(unkept(entity, before)), after: JSON.stringify(unkept(entity, after)) }).execute();
  return {
    db: trx, trx, actor, now, runId, approvedBy,
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

const onceMoreOnDeadlock = <R>(f: () => Promise<R>): Promise<R> => f().catch((e) => { if ((e as { code?: string })?.code === "40P01") return f(); throw e; });

/** Kumi itself runs a system action: still planned, recorded and applied, with no person. */
export async function runAsSystem(db: Db, name: string, raw: unknown, via: string, opts: { now?: Date } = {}) {
  const def = getAction(name);
  if (!def.system) throw new KumiError("error.forbidden_reason", { reason: both("reason.no_role") }, 403);
  await readOnlyGate(db, name);
  const input = validate(def, raw);
  const now = opts.now ?? new Date();
  const actor: Actor = { personId: null, via, lang: "en" };
  const p = await def.plan({ db, actor, now }, input);
  const runId = uuidv7(now.getTime());
  await db.insertInto("action_run").values({
    id: runId, action: name, action_version: def.version, actor_person_id: null, agent_id: null, via, location_id: p.locationId ?? null,
    input: JSON.stringify(input), plan: planJson(p), status: "planned", undo_kind: p.undo.kind, undo_note: p.undo.note ? JSON.stringify(p.undo.note) : null,
    read_versions: JSON.stringify(Object.fromEntries(p.reads.map((r) => [keyOf(r.entity, r.id), r.version]))), plan_expires_at: new Date(now.getTime() + PLAN_MINUTES * 60_000),
  }).execute();
  return { runId, plan: p, result: await apply(db, runId, actor, { now, system: true }) };
}

/** Plan and apply in one go, for callers that already showed the preview elsewhere (tests, setup). */
export async function run(db: Db, name: string, raw: unknown, actor: Actor, opts: PlanOpts & { idempotencyKey?: string } = {}) {
  const p = await plan(db, name, raw, actor, opts);
  if (p.status === "awaiting_approval") return { ...p, result: null };
  return { ...p, result: await apply(db, p.runId, actor, opts) };
}

// ---- Undo: a new action run that reads the original's change log and puts it back. ----
/** Why a change can't be undone, from its undo note. A note is a reason ("the refund has gone out"). A change made
 *  before 7 Nov 2026 may keep the whole sentence ("Can't be undone: the refund has gone out."), which would read
 *  twice inside the refusal, so that sentence is cut back to its reason. */
export function undoReason(note: Text): Text {
  const bare = (s: string, tpl: string) => {
    const [pre = "", post = ""] = tpl.split("{reason}");
    return s.startsWith(pre) && s.endsWith(post) && s.length > pre.length + post.length ? s.slice(pre.length, s.length - post.length) : s;
  };
  return { en: bare(note.en, en["undo.none"] as string), es: bare(note.es, es["undo.none"] as string) };
}
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
    if (original.undo_kind === "none") throw new KumiError("error.cannot_undo", { reason: op.undo.note ? undoReason(op.undo.note) : both(original.action === "action.undo" ? "reason.undo_final" : "reason.no_way_back") });
    if (original.undo_until && original.undo_until.getTime() < ctx.now.getTime()) throw new KumiError("error.undo_expired");
    // Undo needs the same permission as the original action, for the same rows: where that's an "ask", the undo
    // waits for someone allowed it outright (approve), as the change itself would have.
    const d = await decide(ctx.db, original.action, { personId: ctx.actor.personId, agentId: ctx.actor.agentId ?? null, locationId: original.location_id, ownerIds: op.ownerIds ?? [], at: ctx.now, ...how(getAction(original.action), ctx.actor) });
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
      summary: (await getAction(original.action).undoSummary?.(changes)) ?? both("plan.undo", { title: op.title }),
      reads, locationId: original.location_id, ownerIds: op.ownerIds ?? [],
      undo: { kind: "none", note: both("reason.undo_final") },
      details: { undoes: input.run_id, changes: changes.length },
      secondPerson: d.mode === "ask",
    };
  },
  async apply(ctx, input) {
    const changes = await ctx.trx.selectFrom("entity_change").selectAll().where("action_run_id", "=", input.run_id).orderBy("id", "desc").execute();
    try {
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
    } catch (e: any) {
      // Putting court time back where something else now stands (a moved date's old courts were taken since).
      if (e?.code === "23P01") throw new KumiError("error.cannot_undo", { reason: both("reason.court_taken_since") });
      throw e;
    }
    await ctx.trx.updateTable("action_run").set({ status: "undone" }).where("id", "=", input.run_id).execute();
    await ctx.emit("action.undone", { run_id: input.run_id });
    return { undone: input.run_id };
  },
});

export function text(key: Key, params: Params = {}): Text { return both(key, params); }
