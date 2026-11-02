import { Kysely, PostgresDialect, sql, type Generated, type Transaction } from "kysely";
import pg from "pg";
// A club date ("2026-12-25") stays a string: as a JavaScript Date it would be midnight in the server's
// time zone, which isn't the club's, and could print as the day before.
pg.types.setTypeParser(1082, (v: string) => v);
import { readdirSync, readFileSync } from "node:fs";

type Json = unknown;
export interface ClubTable { singleton: Generated<boolean>; name: string; legal_name: string | null; brand_colour: Generated<string>; brand_font: string | null; time_zone: string; languages: Generated<string[]>; default_language: Generated<string>; currency: Generated<string>; stripe_account_id: string | null; stripe_charges_enabled: Generated<boolean>; stripe_details_submitted: Generated<boolean>; sign_up_open: Generated<boolean>; court_bookings: Generated<boolean>; tax_rate_bp: Generated<number>; public_page: Generated<boolean>; about: string | null; question_alert_hours: Generated<number>; broadcast_daily_cap: Generated<number>; broadcast_copy_managers: Generated<boolean>; program_decide_hours: Generated<number>; program_heads_up_hours: Generated<number>; two_factor: Generated<"owner_manager" | "all_staff" | "off">; version: Generated<number> }
export interface LocationTable { id: string; name: string; time_zone: string; address: string | null; opened_on: string | null; archived_at: Date | null; version: Generated<number> }
export interface PersonTable { id: string; given_name: string | null; family_name: string | null; display_name: string; email: string | null; phone: string | null; birth_year: number | null; locale: Generated<string>; status: Generated<string>; created_via: string; trust_level: Generated<number>; redacted_at: Date | null; created_at: Generated<Date>; friend_code: Generated<string>; junior: Generated<boolean>; own_login: Generated<boolean>; news_token: Generated<string>; version: Generated<number> }
export interface AuthIdentityTable { id: string; person_id: string; kind: "email" | "phone"; value: string; verified_at: Date | null; created_at: Generated<Date> }
export interface AuthChallengeTable { id: string; kind: "email_code" | "phone_code" | "passkey_add" | "passkey_sign_in" | "sign_up" | "totp_setup"; person_id: string | null; target: string; code_hash: string; attempts: Generated<number>; expires_at: Date; consumed_at: Date | null; created_at: Generated<Date> }
export interface WebSessionTable { token_hash: string; person_id: string; created_at: Generated<Date>; expires_at: Date; last_seen_at: Date | null; user_agent: string | null; revoked_at: Date | null; method: Generated<"email_code" | "passkey">; second_factor: "totp" | "recovery" | null }
export interface StaffFactorTable { person_id: string; secret: string; confirmed_at: Date; last_step: Generated<string>; removed_at: Date | null; created_at: Generated<Date>; version: Generated<number> }
export interface RecoveryCodeTable { id: string; person_id: string; code_hash: string; used_at: Date | null; created_at: Generated<Date> }
export interface PasskeyTable { credential_id: string; person_id: string; public_key: Buffer; counter: string; transports: string[] | null; name: string | null; created_at: Generated<Date>; last_used_at: Date | null; revoked_at: Date | null; version: Generated<number> }
export interface RoleTable { id: string; key: string; system: Generated<boolean>; name: string | null; based_on: string | null; active: Generated<boolean>; created_at: Generated<Date>; version: Generated<number> }
export interface RoleGrantTable { id: string; role_id: string; pattern: string; mode: "allow" | "ask" | "no"; rows_scope: Generated<"any" | "own">; time_scope: Generated<"any_time" | "on_shift">; field_mask: Json | null; active: Generated<boolean>; version: Generated<number> }
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
export interface OutboundMessageTable { id: string; event_id: string | null; person_id: string; kind: string; channel: "inbox" | "email" | "push" | "sms" | "whatsapp"; purpose: "account" | "invites" | "club_news" | "staff"; essential: boolean; lang: string; subject: string; body: string; link: string | null; status: "waiting" | "sent" | "failed" | "dropped"; send_after: Date; stale_at: Date | null; attempts: Generated<number>; failure: string | null; created_at: Generated<Date>; sent_at: Date | null; read_at: Date | null; broadcast_id: Generated<string | null>; provider_ref: Generated<string | null>; delivered_at: Generated<Date | null> }
export interface PriceRuleTable { id: string; location_id: string; name: string; court_ids: string[] | null; weekdays: number[] | null; starts: string | null; ends: string | null; valid_from: string | null; valid_to: string | null; cents_per_hour: number; plan_ids: string[] | null; priority: Generated<number>; active: Generated<boolean>; version: Generated<number> }
export interface BookingPolicyTable { id: string; version_no: number; days_ahead: Generated<number>; max_active: Generated<number>; free_cancel_hours: Generated<number>; late_refund_percent: Generated<number>; split_deadline_hours: Generated<number>; lengths: Generated<number[]>; late_sub_refund_percent: Generated<number>; late_filled_refund_percent: Generated<number>; late_empty_refund_percent: Generated<number>; active: Generated<boolean>; created_at: Generated<Date>; version: Generated<number> }
export interface MembershipPlanTable { id: string; name: string; description: string | null; price_cents: number; period: "month" | "year"; days_ahead: number | null; join_in_app: Generated<boolean>; sort: Generated<number>; active: Generated<boolean>; max_members: number | null; starts_on: string | null; program_percent_off: number | null; program_cents_off: number | null; included_sessions: number | null; included_kinds: Generated<string[]>; family_size: Generated<number | null>; extra_person_cents: Generated<number | null>; version: Generated<number> }
export interface MembershipTable { id: string; person_id: string; plan_id: string; status: "upcoming" | "active" | "past_due" | "ended"; source: "app" | "desk" | "import"; started_at: Generated<Date>; current_period_end: Date | null; cancel_at_period_end: Generated<boolean>; ended_at: Date | null; note: string | null; provider_ref: string | null; price_cents: number | null; period: "month" | "year" | null; saved_customer: string | null; saved_method: string | null; provider_account: string | null; failed_attempts: Generated<number>; next_attempt_at: Date | null; end_reason: string | null; created_at: Generated<Date>; paused_from: Date | null; paused_until: Date | null; family_size: Generated<number | null>; extra_person_cents: Generated<number | null>; version: Generated<number> }
export interface OpenMatchTable { booking_id: string; level_min: string; level_max: string; outside_band: Generated<"ask" | "closed">; rated: Generated<boolean>; listed: Generated<boolean>; note: string | null; version: Generated<number> }
export interface ClubFactTable { id: string; topic: string; question_en: string | null; answer_en: string | null; question_es: string | null; answer_es: string | null; active: Generated<boolean>; public: Generated<boolean>; created_by: string | null; created_at: Generated<Date>; version: Generated<number> }
export interface QuestionTable { id: string; person_id: string; asked_by: string; status: Generated<"open" | "answered" | "closed">; assigned_to: string | null; waiting_since: Date | null; alerted_at: Date | null; created_at: Generated<Date>; closed_at: Date | null; version: Generated<number> }
export interface QuestionMessageTable { id: string; question_id: string; side: "member" | "staff" | "club"; author_id: string | null; body: string; fact_id: string | null; created_at: Generated<Date>; version: Generated<number> }
export interface AnswerDecisionTable { id: string; question_id: string; message_id: string; answerer: string; questions_version: string; outcome: "fact" | "staff"; fact_id: string | null; confidence: string | null; detail: Json | null; corrected: "not_answered" | null; corrected_at: Date | null; created_at: Generated<Date> }
export interface LevelReviewTable { id: string; person_id: string; kind: "request" | "move"; note: string | null; status: Generated<"open" | "kept" | "changed">; level_at: string | null; answer: string | null; answered_by: string | null; answered_at: Date | null; created_at: Generated<Date>; version: Generated<number> }
export interface PlaceOfferTable { id: string; booking_player_id: string; to_person_id: string | null; code: string; status: Generated<"offered" | "taken" | "withdrawn">; taken_by: string | null; created_at: Generated<Date>; decided_at: Date | null; version: Generated<number> }
export interface HouseholdTable { id: string; created_by: string; created_at: Generated<Date>; version: Generated<number> }
export interface HouseholdMemberTable { id: string; household_id: string; person_id: string; role: "adult" | "member" | "junior"; added_by: string | null; created_at: Generated<Date>; removed_at: Date | null; version: Generated<number> }
export interface HouseholdInviteTable { id: string; household_id: string; code: string; invited_by: string; status: Generated<"open" | "accepted" | "withdrawn">; accepted_by: string | null; created_at: Generated<Date>; expires_at: Date; decided_at: Date | null; version: Generated<number> }
export interface WaiverTable { id: string; version_no: number; body: string; active: Generated<boolean>; created_by: string | null; created_at: Generated<Date>; version: Generated<number> }
export interface WaiverAcceptanceTable { id: string; waiver_id: string; person_id: string; accepted_by: string; accepted_at: Date; version: Generated<number> }
export interface MembershipMemberTable { id: string; membership_id: string; person_id: string; extra: Generated<boolean>; added_by: string | null; created_at: Generated<Date>; ends_at: Date | null; version: Generated<number> }
export interface FriendTable { id: string; person_id: string; friend_id: string; created_at: Generated<Date>; removed_at: Date | null; version: Generated<number> }
export interface JoinRequestTable { id: string; booking_id: string; person_id: string; level: string | null; note: string | null; status: Generated<"requested" | "approved" | "declined" | "withdrawn">; created_at: Generated<Date>; decided_at: Date | null; version: Generated<number> }
export interface PushSubscriptionTable { id: string; person_id: string; app: "member" | "staff"; endpoint: string; p256dh: string; auth: string; user_agent: string | null; created_at: Generated<Date>; last_ok_at: Date | null; revoked_at: Date | null }
export interface PushKeyTable { singleton: Generated<boolean>; public_key: string; private_key: string; created_at: Generated<Date> }
export interface MessageTopicTable { topic: string; since: Generated<Date> }
export interface ChannelConsentTable { id: string; person_id: string; channel: string; purpose: string; granted: boolean; source: string; form_version: string | null; evidence: Json | null; at: Generated<Date> }

export interface OAuthClientTable { client_id: string; kind: "registered" | "published"; name: string | null; redirect_uris: string[]; auth_method: Generated<string>; secret_hash: string | null; metadata: Json | null; created_at: Generated<Date> }
export interface OAuthGrantTable { id: string; person_id: string; client_id: string; scopes: string[]; weekly_cap_cents: Generated<number>; created_at: Generated<Date>; revoked_at: Date | null }
export interface OAuthCodeTable { code_hash: string; grant_id: string; redirect_uri: string; code_challenge: string; resource: string; expires_at: Date; consumed_at: Date | null }
export interface OAuthTokenTable { token_hash: string; kind: "access" | "refresh"; grant_id: string; family: string; resource: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null; created_at: Generated<Date> }

export interface CourtTable { id: string; location_id: string; name: string; kind: Generated<string>; sport: Generated<string>; bookable: Generated<boolean>; sort: Generated<number>; archived_at: Date | null; version: Generated<number> }
export interface ProgramTable { id: string; location_id: string; kind: string; rated: Generated<boolean>; format: string | null; name: string; level_min: string | null; level_max: string | null; capacity: number; price_cents: Generated<number>; sign_up: Generated<string>; refund_window_hours: Generated<number>; refund_inside_window: Generated<"none" | "credit" | "full">; refund_rule_version: Generated<number>; visibility: Generated<string>; status: Generated<"draft" | "published" | "cancelled">; member_price_cents: number | null; min_players: number | null; decide_hours: number | null; min_heads_up_at: Date | null; min_decided_at: Date | null; cancelled_at: Date | null; cancel_reason: "club" | "below_minimum" | null; version: Generated<number> }
export interface SessionTable { id: string; program_id: string; starts_at: Date; ends_at: Date; status: Generated<string>; capacity_override: number | null; coach_id: string | null; version: Generated<number> }
export interface PhotoTable { id: string; content_type: "image/jpeg" | "image/png" | "image/webp"; bytes: Buffer; created_by: string | null; created_at: Generated<Date> }
export interface CoachTable { person_id: string; bio: string | null; level_min: string | null; level_max: string | null; languages: Generated<string[]>; rates: Generated<Record<string, number>>; photo_id: string | null; lessons: Generated<boolean>; max_players: Generated<number>; active: Generated<boolean>; version: Generated<number> }
export interface CoachHoursTable { id: string; coach_id: string; location_id: string; weekday: number; starts: string; ends: string; active: Generated<boolean>; version: Generated<number> }
export interface CoachTimeOffTable { id: string; coach_id: string; during: string; note: string | null; active: Generated<boolean>; version: Generated<number> }
export interface CourtTimeTable { id: string; court_id: string; during: string; kind: string; session_id: string | null; booking_id: string | null; block_id: string | null; active: Generated<boolean>; hold_until: Date | null; version: Generated<number> }
export interface OpeningHoursTable { id: string; location_id: string; weekday: number; opens: string | null; closes: string | null; version: Generated<number> }
export interface HoursExceptionTable { id: string; location_id: string; on_date: string; opens: string | null; closes: string | null; note: string | null; active: Generated<boolean>; version: Generated<number> }
export interface CourtBlockTable { id: string; reason: string; note: string | null; active: Generated<boolean>; created_at: Generated<Date>; version: Generated<number> }
export interface BookingTable { id: string; code: string; location_id: string; kind: Generated<string>; organiser_id: string | null; status: "held" | "confirmed" | "cancelled" | "completed"; source: "app" | "desk" | "agent" | "import"; price_cents: Generated<number>; quote: Json | null; note: string | null; created_at: Generated<Date>; cancelled_at: Date | null; cancel_reason: string | null; policy_id: string | null; tax_cents: Generated<number>; pay_mode: Generated<"whole" | "split">; players: Generated<number>; invite_code: string | null; settled_at: Date | null; balance_cents: Generated<number>; reminded_at: Date | null; coach_id: string | null; version: Generated<number> }
export interface BookingPlayerTable { id: string; booking_id: string; person_id: string | null; guest_name: string | null; share_cents: Generated<number>; checked_in_at: Date | null; no_show: Generated<boolean>; removed_at: Date | null; held_until: Date | null; leaving_at: Date | null; late_leave: Generated<boolean>; saved_by: string | null; no_show_by: string | null; no_show_at: Date | null; replaces: string | null; fill_refund_percent: number | null; version: Generated<number> }
export interface EnrolmentTable { id: string; program_id: string; session_id: string | null; person_id: string; status: "booked" | "waitlisted" | "cancelled" | "attended" | "no_show"; waitlist_position: number | null; price_cents: Generated<number>; paid_by: Generated<string>; comp_note: string | null; left_at: Date | null; left_how: string | null; left_reason: string | null; refund_outcome: string | null; refund_cents: number | null; refund_rule_version: number | null; refund_changed_by_staff: Generated<boolean>; refund_note: string | null; replaced_by: string | null; created_at: Generated<Date>; price_basis: Generated<"full" | "member" | "included">; included_membership_id: string | null; included_period_start: Date | null; included_back: Generated<boolean>; version: Generated<number> }
export interface ProgramWatchTable { id: string; program_id: string; person_id: string; created_at: Generated<Date>; told_at: Date | null; ended_at: Date | null; version: Generated<number> }
export interface WaitlistOfferTable { id: string; enrolment_id: string; offered_at: Date; expires_at: Date; outcome: string | null; version: Generated<number> }

export interface LedgerAccountTable { id: string; kind: string; person_id: string | null; revenue_type: string | null }
export interface LedgerTxnTable { id: string; kind: string; action_run_id: string; at: Generated<Date>; memo: string | null }
export interface LedgerEntryTable { id: Generated<string>; txn_id: string; account_id: string; amount_cents: string }
export interface PaymentTable { id: string; person_id: string; membership_member_id: Generated<string | null>; amount_cents: number; method: string; provider: string; provider_ref: string | null; provider_account: string | null; status: "pending" | "succeeded" | "failed"; enrolment_id: string | null; booking_player_id: string | null; save_card: Generated<boolean>; saved_customer: string | null; saved_method: string | null; membership_plan_id: string | null; membership_id: string | null; group_id: string | null; family_card_id: Generated<string | null>; family_declines: Generated<number>; parent_to_pay_at: Generated<Date | null>; created_at: Generated<Date>; version: Generated<number> }
export interface RefundTable { id: string; payment_id: string; enrolment_id: string | null; amount_cents: number; destination: "card" | "credit"; status: "waiting_for_sub" | "pending" | "sent" | "failed"; provider_ref: string | null; failure: string | null; created_at: Generated<Date>; version: Generated<number> }
export interface MemberCreditBalanceView { person_id: string; cents: string }

export interface RatingTable { person_id: string; sport: Generated<string>; mu: number | null; sigma: number | null; level: string; rated_games: Generated<number>; provisional: Generated<boolean>; floor: string | null; floor_set_by: string | null; floor_reason: string | null; self_adjust_used: Generated<string>; version: Generated<number> }
export interface DrawTable { session_id: string; format: string; points_per_game: Generated<number>; rounds: number; seed: string; status: Generated<string>; version: Generated<number> }
export interface GameTable { id: string; session_id: string | null; round: number | null; court_id: string | null; format: Generated<string>; rated: Generated<boolean>; status: Generated<string>; predicted_a: string | null; played_at: Date | null; entered_by: string | null; editable_until: Date | null; booking_id: string | null; confirm_by: Date | null; version: Generated<number> }
export interface ResultAnswerTable { id: string; game_id: string; person_id: string | null; side: "a" | "b" | null; answer: string; note: string | null; at: Generated<Date> }
export interface GameSideTable { game_id: string; side: "a" | "b"; person_id: string }
export interface GameSetTable { game_id: string; set_no: number; a: number; b: number }

export interface RatingEventTable { id: string; person_id: string; sport: Generated<string>; game_id: string | null; kind: string; mu_before: number | null; sigma_before: number | null; level_before: string | null; mu_after: number; sigma_after: number; level_after: string; share: number | null; factors: Generated<unknown>; explanation: unknown; action_run_id: string; model_version: string; at: Generated<Date> }

export interface ExternalRefTable { entity: string; entity_id: string; system: string; external_id: string }
export interface MirrorBookingTable { ref: string; system: Generated<string>; court_id: string; during: string; booking_type: string; status: "held" | "covered" | "conflict" | "gone"; court_time_id: string | null; clash_id: string | null; first_seen_at: Generated<Date>; version: Generated<number> }
export interface ConnectorStatusTable { system: string; last_sync_at: Date | null; last_ok_at: Date | null; last_error: string | null; fetched: number | null; unmapped: Generated<unknown>; courts: Generated<unknown> }

export interface KidRuleTable { person_id: string; open_matches: Generated<boolean>; courts: Generated<boolean>; programs: Generated<boolean>; lessons: Generated<boolean>; monthly_limit_cents: Generated<number>; friends: Generated<boolean>; texts: Generated<boolean>; updated_by: string | null; updated_at: Generated<Date>; version: Generated<number> }
export interface FamilyCardTable { id: string; household_id: string; saved_by: string; status: Generated<"pending" | "saved" | "removed">; provider: string; provider_ref: string | null; provider_account: string | null; saved_customer: string | null; saved_method: string | null; created_at: Generated<Date>; saved_at: Date | null; removed_at: Date | null; version: Generated<number> }
export interface KidRequestTable { id: string; person_id: string; action: string; input: Json; kind: "open_matches" | "courts" | "programs" | "lessons"; reason: "off" | "limit"; cents: Generated<number>; what: Json; status: Generated<"asked" | "approved" | "declined" | "withdrawn" | "done" | "failed">; decided_by: string | null; decided_at: Date | null; run_id: string | null; error: Json | null; created_at: Generated<Date>; version: Generated<number> }
export interface AttendanceTable { id: string; session_id: string | null; booking_id: string | null; person_id: string; came: boolean | null; marked_by: string | null; marked_at: Date; version: Generated<number> }
export interface VaultBlobTable { id: string; kind: "secret" | "document"; bytes: Buffer; size_bytes: number; content_type: string | null; filename: string | null; last4: string | null; created_by: string | null; created_at: Generated<Date>; attached_at: Date | null }
export interface VaultItemTable { id: string; kind: "secret" | "document"; name: string; note: string | null; blob_id: string; last4: string | null; filename: string | null; content_type: string | null; size_bytes: number; created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>; active: Generated<boolean>; version: Generated<number> }
export interface VaultAccessTable { id: string; item_id: string; person_id: string | null; at: Generated<Date> }
export interface OpsHeartbeatTable { name: string; last_run_at: Date | null; last_ok_at: Date | null; last_error: string | null; details: Generated<unknown> }
export interface StaffAlertTable { id: string; event_id: string; kind: string; handled_by: string | null; handled_at: Date; version: Generated<number> }
export interface CalendarFeedTable { id: string; person_id: string; token: string; created_at: Generated<Date>; revoked_at: Date | null }
export interface TagTable { id: string; name: string; active: Generated<boolean>; created_by: string | null; created_at: Generated<Date>; version: Generated<number> }
export interface PersonTagTable { id: string; person_id: string; tag_id: string; added_by: string | null; created_at: Generated<Date>; removed_at: Date | null; version: Generated<number> }
export interface SegmentTable { id: string; name: string; filters: unknown; active: Generated<boolean>; created_by: string | null; created_at: Generated<Date>; version: Generated<number> }
export interface MessageTemplateTable { id: string; name: string; subject_en: string | null; body_en: string | null; subject_es: string | null; body_es: string | null; active: Generated<boolean>; created_by: string | null; created_at: Generated<Date>; version: Generated<number> }
export interface BroadcastTable { id: string; purpose: "club_news" | "service"; subject_en: string | null; body_en: string | null; subject_es: string | null; body_es: string | null; filters: unknown; segment_id: string | null; segment_name: string | null;
  status: Generated<"scheduled" | "sent" | "cancelled" | "stopped">; send_at: Date; created_by: string | null; created_at: Generated<Date>; sent_at: Date | null; cancelled_at: Date | null; matched: Generated<number>; recipients: Generated<number>; left_out_consent: Generated<number>; email_days: Generated<number>; version: Generated<number> }
export interface DB {
  club: ClubTable; location: LocationTable; person: PersonTable; auth_identity: AuthIdentityTable; auth_challenge: AuthChallengeTable;
  web_session: WebSessionTable; passkey: PasskeyTable; staff_factor: StaffFactorTable; recovery_code: RecoveryCodeTable; external_ref: ExternalRefTable; mirror_booking: MirrorBookingTable; connector_status: ConnectorStatusTable; rating_event: RatingEventTable; rating: RatingTable; draw: DrawTable; game: GameTable; game_side: GameSideTable; game_set: GameSetTable; ledger_account: LedgerAccountTable; ledger_txn: LedgerTxnTable; ledger_entry: LedgerEntryTable; payment: PaymentTable; refund: RefundTable; member_credit_balance: MemberCreditBalanceView; court: CourtTable; program: ProgramTable; session: SessionTable; photo: PhotoTable; coach: CoachTable; coach_hours: CoachHoursTable; coach_time_off: CoachTimeOffTable; court_time: CourtTimeTable; enrolment: EnrolmentTable; waitlist_offer: WaitlistOfferTable; program_watch: ProgramWatchTable; role: RoleTable; role_grant: RoleGrantTable; person_role: PersonRoleTable; staff_member: StaffMemberTable;
  staff_shift: StaffShiftTable; agent: AgentTable; action_run: ActionRunTable; entity_change: EntityChangeTable; event_outbox: EventOutboxTable; outbound_message: OutboundMessageTable; message_topic: MessageTopicTable; opening_hours: OpeningHoursTable; hours_exception: HoursExceptionTable; court_block: CourtBlockTable; booking: BookingTable; booking_player: BookingPlayerTable; price_rule: PriceRuleTable; booking_policy: BookingPolicyTable; membership_plan: MembershipPlanTable; membership: MembershipTable; membership_member: MembershipMemberTable; open_match: OpenMatchTable; join_request: JoinRequestTable; friend: FriendTable; household: HouseholdTable; household_member: HouseholdMemberTable; household_invite: HouseholdInviteTable; waiver: WaiverTable; waiver_acceptance: WaiverAcceptanceTable; place_offer: PlaceOfferTable; level_review: LevelReviewTable; result_answer: ResultAnswerTable; push_subscription: PushSubscriptionTable; push_key: PushKeyTable; kid_rule: KidRuleTable; family_card: FamilyCardTable; kid_request: KidRequestTable; attendance: AttendanceTable; calendar_feed: CalendarFeedTable; staff_alert: StaffAlertTable; vault_blob: VaultBlobTable; vault_item: VaultItemTable; vault_access: VaultAccessTable; ops_heartbeat: OpsHeartbeatTable; club_fact: ClubFactTable; question: QuestionTable; question_message: QuestionMessageTable; answer_decision: AnswerDecisionTable;
  tag: TagTable; person_tag: PersonTagTable; segment: SegmentTable; message_template: MessageTemplateTable; broadcast: BroadcastTable;
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
