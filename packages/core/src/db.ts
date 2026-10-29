import { Kysely, PostgresDialect, sql, type Generated, type Transaction } from "kysely";
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";

type Json = unknown;
export interface ClubTable { singleton: Generated<boolean>; name: string; legal_name: string | null; brand_colour: Generated<string>; brand_font: string | null; time_zone: string; languages: Generated<string[]>; default_language: Generated<string>; currency: Generated<string>; version: Generated<number> }
export interface LocationTable { id: string; name: string; time_zone: string; address: string | null; opened_on: string | null; archived_at: Date | null; version: Generated<number> }
export interface PersonTable { id: string; given_name: string | null; family_name: string | null; display_name: string; email: string | null; phone: string | null; birth_year: number | null; locale: Generated<string>; status: Generated<string>; created_via: string; trust_level: Generated<number>; redacted_at: Date | null; created_at: Generated<Date>; version: Generated<number> }
export interface AuthIdentityTable { id: string; person_id: string; kind: "email" | "phone"; value: string; verified_at: Date | null; created_at: Generated<Date> }
export interface AuthChallengeTable { id: string; kind: "email_code" | "phone_code"; target: string; code_hash: string; attempts: Generated<number>; expires_at: Date; consumed_at: Date | null; created_at: Generated<Date> }
export interface WebSessionTable { token_hash: string; person_id: string; created_at: Generated<Date>; expires_at: Date; last_seen_at: Date | null; user_agent: string | null; revoked_at: Date | null }
export interface RoleTable { id: string; key: string; system: Generated<boolean>; version: Generated<number> }
export interface RoleGrantTable { id: string; role_id: string; pattern: string; mode: "allow" | "ask" | "no"; rows_scope: Generated<"any" | "own">; time_scope: Generated<"any_time" | "on_shift">; field_mask: Json | null; version: Generated<number> }
export interface PersonRoleTable { id: string; person_id: string; role_id: string; location_id: string | null; active: Generated<boolean>; version: Generated<number> }
export interface StaffMemberTable { id: string; person_id: string; title: string | null; active: Generated<boolean>; version: Generated<number> }
export interface StaffShiftTable { id: string; staff_member_id: string; location_id: string; during: string }
export interface AgentTable { id: string; kind: string; capped_role_id: string | null; acts_for_person_id: string | null; version: Generated<number> }
export interface ActionRunTable {
  id: string; action: string; action_version: number; actor_person_id: string | null; agent_id: string | null; via: string;
  location_id: string | null; input: Json; plan: Json; status: "planned" | "awaiting_approval" | "applied" | "failed" | "expired" | "undone";
  undo_kind: "reversible" | "compensating" | "none"; undo_note: Json | null; undo_of: string | null; undo_until: Date | null; parent_id: string | null;
  read_versions: Json; plan_expires_at: Date; money_cents: Generated<string>; idempotency_key: string | null; ai_cost_cents: Generated<number>;
  result: Json | null; error: Json | null; approved_by: string | null; created_at: Generated<Date>; applied_at: Date | null;
}
export interface EntityChangeTable { id: Generated<string>; action_run_id: string; entity: string; entity_id: string; op: "insert" | "update"; before: Json | null; after: Json; at: Generated<Date> }
export interface EventOutboxTable { id: Generated<string>; action_run_id: string | null; topic: string; payload: Json; created_at: Generated<Date>; delivered_at: Date | null; attempts: Generated<number> }
export interface ChannelConsentTable { id: string; person_id: string; channel: string; purpose: string; granted: boolean; source: string; form_version: string | null; evidence: Json | null; at: Generated<Date> }

export interface DB {
  club: ClubTable; location: LocationTable; person: PersonTable; auth_identity: AuthIdentityTable; auth_challenge: AuthChallengeTable;
  web_session: WebSessionTable; role: RoleTable; role_grant: RoleGrantTable; person_role: PersonRoleTable; staff_member: StaffMemberTable;
  staff_shift: StaffShiftTable; agent: AgentTable; action_run: ActionRunTable; entity_change: EntityChangeTable; event_outbox: EventOutboxTable;
  channel_consent: ChannelConsentTable;
}
export type Db = Kysely<DB>;
export type Trx = Transaction<DB>;

export function connect(url = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/kumi"): Db {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 10 }) }) });
}

const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

/** Plain SQL migrations, each applied once, in file order, inside its own transaction. */
export async function migrate(db: Db, dir: URL = MIGRATIONS): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.execute(db);
  const done = new Set((await sql<{ name: string }>`SELECT name FROM schema_migration`.execute(db)).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()) {
    if (done.has(file)) continue;
    await db.transaction().execute(async (trx) => {
      await sql.raw(readFileSync(new URL(file, dir), "utf8")).execute(trx);
      await sql`INSERT INTO schema_migration (name) VALUES (${file})`.execute(trx);
    });
    applied.push(file);
  }
  return applied;
}
