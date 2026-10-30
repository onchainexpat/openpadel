import { Kysely, PostgresDialect, sql, type Generated, type Transaction } from "kysely";
import pg from "pg";
// A club date ("2026-12-25") stays a string: as a JavaScript Date it would be midnight in the server's
// time zone, which isn't the club's, and could print as the day before.
pg.types.setTypeParser(1082, (v: string) => v);
import { readdirSync, readFileSync } from "node:fs";

type Json = unknown;
export interface ClubTable { singleton: Generated<boolean>; name: string; legal_name: string | null; brand_colour: Generated<string>; brand_font: string | null; time_zone: string; languages: Generated<string[]>; default_language: Generated<string>; currency: Generated<string>; stripe_account_id: string | null; stripe_charges_enabled: Generated<boolean>; stripe_details_submitted: Generated<boolean>; sign_up_open: Generated<boolean>; court_bookings: Generated<boolean>; tax_rate_bp: Generated<number>; version: Generated<number> }
export interface LocationTable { id: string; name: string; time_zone: string; address: string | null; opened_on: string | null; archived_at: Date | null; version: Generated<number> }
export interface PersonTable { id: string; given_name: string | null; family_name: string | null; display_name: string; email: string | null; phone: string | null; birth_year: number | null; locale: Generated<string>; status: Generated<string>; created_via: string; trust_level: Generated<number>; redacted_at: Date | null; created_at: Generated<Date>; version: Generated<number> }
export interface AuthIdentityTable { id: string; person_id: string; kind: "email" | "phone"; value: string; verified_at: Date | null; created_at: Generated<Date> }
export interface AuthChallengeTable { id: string; kind: "email_code" | "phone_code" | "passkey_add" | "passkey_sign_in" | "sign_up"; person_id: string | null; target: string; code_hash: string; attempts: Generated<number>; expires_at: Date; consumed_at: Date | null; created_at: Generated<Date> }
export interface WebSessionTable { token_hash: string; person_id: string; created_at: Generated<Date>; expires_at: Date; last_seen_at: Date | null; user_agent: string | null; revoked_at: Date | null; method: Generated<"email_code" | "passkey"> }
export interface PasskeyTable { credential_id: string; person_id: string; public_key: Buffer; counter: string; transports: string[] | null; name: string | null; created_at: Generated<Date>; last_used_at: Date | null; revoked_at: Date | null; version: Generated<number> }
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
export interface OutboundMessageTable { id: string; event_id: string | null; person_id: string; kind: string; channel: "inbox" | "email" | "push" | "sms" | "whatsapp"; purpose: "account" | "invites" | "club_news" | "staff"; essential: boolean; lang: string; subject: string; body: string; link: string | null; status: "waiting" | "sent" | "failed" | "dropped"; send_after: Date; stale_at: Date | null; attempts: Generated<number>; failure: string | null; created_at: Generated<Date>; sent_at: Date | null; read_at: Date | null }
export interface PriceRuleTable { id: string; location_id: string; name: string; court_ids: string[] | null; weekdays: number[] | null; starts: string | null; ends: string | null; valid_from: string | null; valid_to: string | null; cents_per_hour: number; plan_ids: string[] | null; priority: Generated<number>; active: Generated<boolean>; version: Generated<number> }
export interface BookingPolicyTable { id: string; version_no: number; days_ahead: Generated<number>; max_active: Generated<number>; free_cancel_hours: Generated<number>; late_refund_percent: Generated<number>; split_deadline_hours: Generated<number>; lengths: Generated<number[]>; active: Generated<boolean>; created_at: Generated<Date>; version: Generated<number> }
export interface MembershipPlanTable { id: string; name: string; description: string | null; price_cents: number; period: "month" | "year"; days_ahead: number | null; join_in_app: Generated<boolean>; sort: Generated<number>; active: Generated<boolean>; version: Generated<number> }
export interface MembershipTable { id: string; person_id: string; plan_id: string; status: "active" | "past_due" | "ended"; source: "app" | "desk" | "import"; started_at: Generated<Date>; current_period_end: Date | null; cancel_at_period_end: Generated<boolean>; ended_at: Date | null; note: string | null; provider_ref: string | null; price_cents: number | null; period: "month" | "year" | null; saved_customer: string | null; saved_method: string | null; provider_account: string | null; failed_attempts: Generated<number>; next_attempt_at: Date | null; end_reason: string | null; version: Generated<number> }
export interface MessageTopicTable { topic: string; since: Generated<Date> }
export interface ChannelConsentTable { id: string; person_id: string; channel: string; purpose: string; granted: boolean; source: string; form_version: string | null; evidence: Json | null; at: Generated<Date> }

export interface OAuthClientTable { client_id: string; kind: "registered" | "published"; name: string | null; redirect_uris: string[]; auth_method: Generated<string>; secret_hash: string | null; metadata: Json | null; created_at: Generated<Date> }
export interface OAuthGrantTable { id: string; person_id: string; client_id: string; scopes: string[]; weekly_cap_cents: Generated<number>; created_at: Generated<Date>; revoked_at: Date | null }
export interface OAuthCodeTable { code_hash: string; grant_id: string; redirect_uri: string; code_challenge: string; resource: string; expires_at: Date; consumed_at: Date | null }
export interface OAuthTokenTable { token_hash: string; kind: "access" | "refresh"; grant_id: string; family: string; resource: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null; created_at: Generated<Date> }

export interface CourtTable { id: string; location_id: string; name: string; kind: Generated<string>; sport: Generated<string>; bookable: Generated<boolean>; sort: Generated<number>; archived_at: Date | null; version: Generated<number> }
export interface ProgramTable { id: string; location_id: string; kind: string; rated: Generated<boolean>; format: string | null; name: string; level_min: string | null; level_max: string | null; capacity: number; price_cents: Generated<number>; sign_up: Generated<string>; refund_window_hours: Generated<number>; refund_inside_window: Generated<"none" | "credit" | "full">; refund_rule_version: Generated<number>; visibility: Generated<string>; status: Generated<"draft" | "published" | "cancelled">; version: Generated<number> }
export interface SessionTable { id: string; program_id: string; starts_at: Date; ends_at: Date; status: Generated<string>; capacity_override: number | null; version: Generated<number> }
export interface CourtTimeTable { id: string; court_id: string; during: string; kind: string; session_id: string | null; booking_id: string | null; block_id: string | null; active: Generated<boolean>; hold_until: Date | null; version: Generated<number> }
export interface OpeningHoursTable { id: string; location_id: string; weekday: number; opens: string | null; closes: string | null; version: Generated<number> }
export interface HoursExceptionTable { id: string; location_id: string; on_date: string; opens: string | null; closes: string | null; note: string | null; active: Generated<boolean>; version: Generated<number> }
export interface CourtBlockTable { id: string; reason: string; note: string | null; active: Generated<boolean>; created_at: Generated<Date>; version: Generated<number> }
export interface BookingTable { id: string; code: string; location_id: string; kind: Generated<string>; organiser_id: string | null; status: "held" | "confirmed" | "cancelled" | "completed"; source: "app" | "desk" | "agent" | "import"; price_cents: Generated<number>; quote: Json | null; note: string | null; created_at: Generated<Date>; cancelled_at: Date | null; cancel_reason: string | null; policy_id: string | null; tax_cents: Generated<number>; pay_mode: Generated<"whole" | "split">; players: Generated<number>; invite_code: string | null; settled_at: Date | null; balance_cents: Generated<number>; reminded_at: Date | null; version: Generated<number> }
export interface BookingPlayerTable { id: string; booking_id: string; person_id: string | null; guest_name: string | null; share_cents: Generated<number>; checked_in_at: Date | null; no_show: Generated<boolean>; removed_at: Date | null; version: Generated<number> }
export interface EnrolmentTable { id: string; program_id: string; session_id: string | null; person_id: string; status: "booked" | "waitlisted" | "cancelled" | "attended" | "no_show"; waitlist_position: number | null; price_cents: Generated<number>; paid_by: Generated<string>; comp_note: string | null; left_at: Date | null; left_how: string | null; left_reason: string | null; refund_outcome: string | null; refund_cents: number | null; refund_rule_version: number | null; refund_changed_by_staff: Generated<boolean>; refund_note: string | null; replaced_by: string | null; created_at: Generated<Date>; version: Generated<number> }
export interface WaitlistOfferTable { id: string; enrolment_id: string; offered_at: Date; expires_at: Date; outcome: string | null; version: Generated<number> }

export interface LedgerAccountTable { id: string; kind: string; person_id: string | null; revenue_type: string | null }
export interface LedgerTxnTable { id: string; kind: string; action_run_id: string; at: Generated<Date>; memo: string | null }
export interface LedgerEntryTable { id: Generated<string>; txn_id: string; account_id: string; amount_cents: string }
export interface PaymentTable { id: string; person_id: string; amount_cents: number; method: string; provider: string; provider_ref: string | null; provider_account: string | null; status: "pending" | "succeeded" | "failed"; enrolment_id: string | null; booking_player_id: string | null; save_card: Generated<boolean>; saved_customer: string | null; saved_method: string | null; membership_plan_id: string | null; membership_id: string | null; created_at: Generated<Date>; version: Generated<number> }
export interface RefundTable { id: string; payment_id: string; enrolment_id: string | null; amount_cents: number; destination: "card" | "credit"; status: "waiting_for_sub" | "pending" | "sent" | "failed"; provider_ref: string | null; failure: string | null; created_at: Generated<Date>; version: Generated<number> }
export interface MemberCreditBalanceView { person_id: string; cents: string }

export interface RatingTable { person_id: string; sport: Generated<string>; mu: number | null; sigma: number | null; level: string; rated_games: Generated<number>; provisional: Generated<boolean>; floor: string | null; floor_set_by: string | null; floor_reason: string | null; self_adjust_used: Generated<string>; version: Generated<number> }
export interface DrawTable { session_id: string; format: string; points_per_game: Generated<number>; rounds: number; seed: string; status: Generated<string>; version: Generated<number> }
export interface GameTable { id: string; session_id: string | null; round: number | null; court_id: string | null; format: Generated<string>; rated: Generated<boolean>; status: Generated<string>; predicted_a: string | null; played_at: Date | null; entered_by: string | null; editable_until: Date | null; version: Generated<number> }
export interface GameSideTable { game_id: string; side: "a" | "b"; person_id: string }
export interface GameSetTable { game_id: string; set_no: number; a: number; b: number }

export interface RatingEventTable { id: string; person_id: string; sport: Generated<string>; game_id: string | null; kind: string; mu_before: number | null; sigma_before: number | null; level_before: string | null; mu_after: number; sigma_after: number; level_after: string; share: number | null; factors: Generated<unknown>; explanation: unknown; action_run_id: string; model_version: string; at: Generated<Date> }

export interface ExternalRefTable { entity: string; entity_id: string; system: string; external_id: string }
export interface MirrorBookingTable { ref: string; system: Generated<string>; court_id: string; during: string; booking_type: string; status: "held" | "covered" | "conflict" | "gone"; court_time_id: string | null; clash_id: string | null; first_seen_at: Generated<Date>; version: Generated<number> }
export interface ConnectorStatusTable { system: string; last_sync_at: Date | null; last_ok_at: Date | null; last_error: string | null; fetched: number | null; unmapped: Generated<unknown>; courts: Generated<unknown> }

export interface DB {
  club: ClubTable; location: LocationTable; person: PersonTable; auth_identity: AuthIdentityTable; auth_challenge: AuthChallengeTable;
  web_session: WebSessionTable; passkey: PasskeyTable; external_ref: ExternalRefTable; mirror_booking: MirrorBookingTable; connector_status: ConnectorStatusTable; rating_event: RatingEventTable; rating: RatingTable; draw: DrawTable; game: GameTable; game_side: GameSideTable; game_set: GameSetTable; ledger_account: LedgerAccountTable; ledger_txn: LedgerTxnTable; ledger_entry: LedgerEntryTable; payment: PaymentTable; refund: RefundTable; member_credit_balance: MemberCreditBalanceView; court: CourtTable; program: ProgramTable; session: SessionTable; court_time: CourtTimeTable; enrolment: EnrolmentTable; waitlist_offer: WaitlistOfferTable; role: RoleTable; role_grant: RoleGrantTable; person_role: PersonRoleTable; staff_member: StaffMemberTable;
  staff_shift: StaffShiftTable; agent: AgentTable; action_run: ActionRunTable; entity_change: EntityChangeTable; event_outbox: EventOutboxTable; outbound_message: OutboundMessageTable; message_topic: MessageTopicTable; opening_hours: OpeningHoursTable; hours_exception: HoursExceptionTable; court_block: CourtBlockTable; booking: BookingTable; booking_player: BookingPlayerTable; price_rule: PriceRuleTable; booking_policy: BookingPolicyTable; membership_plan: MembershipPlanTable; membership: MembershipTable;
  channel_consent: ChannelConsentTable; oauth_client: OAuthClientTable; oauth_grant: OAuthGrantTable; oauth_code: OAuthCodeTable; oauth_token: OAuthTokenTable;
}
export type Db = Kysely<DB>;
export type Trx = Transaction<DB>;

export function connect(url = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/kumi"): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // An idle connection the server drops (a restart, a failover) must not crash the process; the
  // pool replaces it on the next query.
  pool.on("error", (e) => console.error(`postgres: idle connection lost: ${e.message}`));
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

/** Plain SQL migrations, each applied once, in file order, inside its own transaction. */
/** Migrations in the folder that this database hasn't applied yet (the server applies them when it starts). */
export async function pendingMigrations(db: Db, dir: URL = MIGRATIONS): Promise<{ applied: number; pending: string[] }> {
  const t = await sql<{ t: string | null }>`SELECT to_regclass('schema_migration')::text AS t`.execute(db);
  const done = t.rows[0]?.t ? new Set((await sql<{ name: string }>`SELECT name FROM schema_migration`.execute(db)).rows.map((r) => r.name)) : new Set<string>();
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  return { applied: files.filter((f) => done.has(f)).length, pending: files.filter((f) => !done.has(f)) };
}

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
