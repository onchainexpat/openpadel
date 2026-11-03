// A member's copy of their data, and deleting an account (data_model.md ground rule 6: erasure is a
// redaction). The export is one JSON file: what Kumi holds about the person and the juniors they manage,
// with other people only as the names the member already sees. Deleting keeps the person as a row, renamed
// "Former member", with every way to reach or recognise them gone; payments, refunds, the ledger and game
// results stay, so the books and other players' levels still add up. Anything still running (a booking to
// come, a membership that renews, money owed) has to be cleared first: nothing is cancelled for them.
// Both are actions, so each is in Changes, and the club hears of each (permissions.md rule 6).
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, FORMER_MEMBER, formerMember, money, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { juniorsOf, managersOf, nameList, withManagers } from "./households.ts";
import { decide } from "./permissions.ts";
import { paymentsWhat } from "./kids.ts";
import { receiptNo } from "./receipts.ts";
import { QUIET } from "./messages.ts";
import { excerpt } from "./questions.ts";

/** How long the file can be fetched after the download was confirmed. */
export const EXPORT_MINUTES = 15;
/** What replaces a removed text that isn't a name (an email, a phone, a note of theirs). */
const REMOVED = "[removed]";
const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const iso = (d: Date | string | null | undefined) => d ? new Date(d).toISOString() : null;

// ---- What's still running ----
export type BlockerKind = "staff" | "bookings" | "programs" | "membership" | "balance" | "kid_requests";
export interface Blocker { kind: BlockerKind; text: Text; how: Text }

/** Juniors only this person manages: deleting them deletes these too. */
export async function aloneJuniors(db: Db | Trx, adultId: string) {
  const out: { id: string; display_name: string }[] = [];
  for (const j of await juniorsOf(db, adultId)) if ((await managersOf(db, j.id)).every((m) => m === adultId)) out.push({ id: j.id, display_name: j.display_name });
  return out;
}

/** One person's running things: each with what it is and how to clear it. */
async function runningFor(db: Db | Trx, personId: string, now: Date, opts: { checkStaff: boolean }): Promise<Blocker[]> {
  const out: Blocker[] = [];
  const add = (kind: BlockerKind, params: Record<string, string | number | Text> = {}) => out.push({ kind, text: both(`privacy.blocker_${kind}`, params), how: both(`privacy.how_${kind}`) });
  if (opts.checkStaff) {
    const staff = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key").where("person_role.person_id", "=", personId)
      .where("person_role.active", "=", true).where("role.key", "!=", "member").executeTakeFirst()
      ?? await db.selectFrom("staff_member").select("id").where("person_id", "=", personId).where("active", "=", true).executeTakeFirst();
    if (staff) add("staff");
  }
  const places = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").innerJoin("court_time", "court_time.booking_id", "booking.id")
    .select(sql<string>`count(DISTINCT booking.id)`.as("n")).where("booking_player.person_id", "=", personId).where("booking_player.removed_at", "is", null)
    .where("booking.status", "in", ["held", "confirmed"]).where("court_time.active", "=", true).where(sql<boolean>`upper(court_time.during) > ${now}`).executeTakeFirstOrThrow();
  if (Number(places.n)) add("bookings", { count: Number(places.n) });
  // A place in a date still to come (its own date, or for a course, any of the program's).
  const enrolled = await db.selectFrom("enrolment").select(sql<string>`count(*)`.as("n")).where("enrolment.person_id", "=", personId).where("enrolment.status", "in", ["booked", "waitlisted"])
    .where(sql<boolean>`EXISTS (SELECT 1 FROM session s WHERE s.status <> 'cancelled' AND s.ends_at > ${now}
      AND (s.id = enrolment.session_id OR (enrolment.session_id IS NULL AND s.program_id = enrolment.program_id)))`).executeTakeFirstOrThrow();
  if (Number(enrolled.n)) add("programs", { count: Number(enrolled.n) });
  // A membership they pay for that will charge again (or is owed, or covers anyone else) has to end first.
  // One that won't charge again (set to end, or given at the desk) and covers only them ends with the account.
  for (const m of await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership.id", "membership.status", "membership.source", "membership.cancel_at_period_end", "membership_plan.name"]).where("membership.person_id", "=", personId)
    .where("membership.status", "in", ["upcoming", "active", "past_due"]).execute()) {
    const others = await db.selectFrom("membership_member").select("id").where("membership_id", "=", m.id).where("person_id", "!=", personId)
      .where((w) => w.or([w("ends_at", "is", null), w("ends_at", ">", now)])).executeTakeFirst();
    const charges = m.status === "past_due" || (m.source === "app" && (m.status === "upcoming" || !m.cancel_at_period_end));
    if (charges || others) add("membership", { plan: m.name });
  }
  const owed = await db.selectFrom("booking").select(sql<string>`coalesce(sum(balance_cents), 0)`.as("c")).where("organiser_id", "=", personId).where("balance_cents", ">", 0).executeTakeFirstOrThrow();
  const toPay = await db.selectFrom("payment").select(sql<string>`coalesce(sum(amount_cents), 0)`.as("c")).where("person_id", "=", personId).where("status", "=", "pending").where("parent_to_pay_at", "is not", null).executeTakeFirstOrThrow();
  const cents = Number(owed.c) + Number(toPay.c);
  if (cents > 0) add("balance", { amount: usd(cents) });
  const asked = await db.selectFrom("kid_request").select(sql<string>`count(*)`.as("n")).where("person_id", "=", personId).where("status", "=", "asked").executeTakeFirstOrThrow();
  if (Number(asked.n)) add("kid_requests", { count: Number(asked.n) });
  return out;
}

/** Everything that stops this account being deleted now, the juniors who'd go with it, and what simply
 *  ends with it (shown in the preview). */
export async function deleteCheck(db: Db | Trx, personId: string, now: Date) {
  const blockers = await runningFor(db, personId, now, { checkStaff: true });
  const juniors = await aloneJuniors(db, personId);
  for (const j of juniors)
    for (const b of await runningFor(db, j.id, now, { checkStaff: false }))
      blockers.push({ ...b, text: both("privacy.for_junior", { name: j.display_name, text: b.text }) });
  const ends: Text[] = [];
  if (await db.selectFrom("membership").select("id").where("person_id", "=", personId).where("status", "in", ["upcoming", "active", "past_due"]).executeTakeFirst())
    ends.push(both("plan.privacy.ends_membership"));
  if (await db.selectFrom("membership_member").innerJoin("membership", "membership.id", "membership_member.membership_id").select("membership_member.id")
    .where("membership_member.person_id", "=", personId).where("membership.person_id", "!=", personId).where("membership.status", "in", ["upcoming", "active", "past_due"])
    .where((w) => w.or([w("membership_member.ends_at", "is", null), w("membership_member.ends_at", ">", now)])).executeTakeFirst())
    ends.push(both("plan.privacy.ends_cover"));
  if (await db.selectFrom("family_card").select("id").where("saved_by", "=", personId).where("status", "in", ["pending", "saved"]).executeTakeFirst()) ends.push(both("plan.privacy.ends_card"));
  return { blockers, juniors, ends };
}

const joinTexts = (xs: Text[], sep: string): Text => ({ en: xs.map((x) => x.en).join(sep), es: xs.map((x) => x.es).join(sep) });

// ---- The export ----
async function personExport(db: Db | Trx, personId: string, now: Date, lang: Lang) {
  const p = await db.selectFrom("person").selectAll().where("id", "=", personId).executeTakeFirstOrThrow();
  const name = async (id: string | null) => id ? ((await db.selectFrom("person").select("display_name").where("id", "=", id).executeTakeFirst())?.display_name ?? null) : null;
  const say = (t: unknown) => (t && typeof t === "object" && lang in (t as object)) ? (t as Text)[lang] : t;

  const identities = await db.selectFrom("auth_identity").select(["kind", "value", "verified_at", "created_at"]).where("person_id", "=", personId).execute();
  const passkeys = await db.selectFrom("passkey").select(["name", "created_at", "last_used_at", "revoked_at"]).where("person_id", "=", personId).orderBy("created_at").execute();
  const sessions = await db.selectFrom("web_session").select(["created_at", "last_seen_at", "expires_at", "revoked_at", "user_agent", "method"]).where("person_id", "=", personId).orderBy("created_at").execute();
  const agents = await db.selectFrom("oauth_grant").leftJoin("oauth_client", "oauth_client.client_id", "oauth_grant.client_id")
    .select(["oauth_client.name", "oauth_grant.scopes", "oauth_grant.weekly_cap_cents", "oauth_grant.created_at", "oauth_grant.revoked_at"]).where("oauth_grant.person_id", "=", personId).execute();
  const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").leftJoin("location", "location.id", "person_role.location_id")
    .select(["role.key", "location.name as location", "person_role.active"]).where("person_role.person_id", "=", personId).execute();
  // Receipts they were given, and ones someone else (a parent) paid for them, without that payer's card.
  const receipts = (await db.selectFrom("receipt").leftJoin("person as payer", "payer.id", "receipt.person_id").leftJoin("person as for", "for.id", "receipt.for_person_id")
    .select(["receipt.number", "receipt.kind", "receipt.person_id", "payer.display_name as paid_by", "for.display_name as for_name", "receipt.lines", "receipt.subtotal_cents", "receipt.tax_cents",
      "receipt.total_cents", "receipt.method", "receipt.card", "receipt.paid_at"])
    .where((eb) => eb.or([eb("receipt.person_id", "=", personId), eb("receipt.for_person_id", "=", personId)])).orderBy("receipt.paid_at").execute())
    .map((r) => ({ number: receiptNo(r.number), kind: r.kind, paid_by: r.person_id === personId ? null : r.paid_by, for: r.for_name, at: iso(r.paid_at),
      lines: (r.lines as { what: Text; cents: number }[]).map((l) => ({ what: say(l.what), cents: l.cents })), subtotal_cents: r.subtotal_cents, tax_cents: r.tax_cents, total_cents: r.total_cents,
      method: r.method, card: r.person_id === personId ? r.card : null }));

  // Bookings and match places: theirs, with the other players by name (what they already saw in the app).
  const seats = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").leftJoin("person as coach", "coach.id", "booking.coach_id")
    .select(["booking.id", "booking.code", "booking.kind", "booking.status", "booking.organiser_id", "booking.pay_mode", "booking.price_cents", "booking.created_at", "booking.cancelled_at", "coach.display_name as coach",
      "booking_player.share_cents", "booking_player.removed_at", "booking_player.leaving_at", "booking_player.late_leave", "booking_player.no_show"])
    .where("booking_player.person_id", "=", personId).orderBy("booking.created_at").execute();
  const bookings = [];
  for (const s of seats) {
    const t = await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id")
      .select(["court.name as court", "location.name as location", sql<Date>`lower(during)`.as("start"), sql<Date>`upper(during)`.as("end")]).where("court_time.booking_id", "=", s.id)
      .orderBy("court_time.active", "desc").orderBy("court_time.id", "desc").executeTakeFirst();
    const others = await db.selectFrom("booking_player").leftJoin("person", "person.id", "booking_player.person_id").select(["person.display_name", "booking_player.guest_name"])
      .where("booking_player.booking_id", "=", s.id).where((w) => w.or([w("booking_player.person_id", "is", null), w("booking_player.person_id", "!=", personId)])).where("booking_player.removed_at", "is", null).execute();
    bookings.push({ code: s.code, kind: s.kind, status: s.status, organised_by_you: s.organiser_id === personId, how_paid: s.pay_mode, court: t?.court ?? null, location: t?.location ?? null,
      starts_at: iso(t?.start), ends_at: iso(t?.end), coach: s.coach, price_cents: s.price_cents, your_share_cents: s.share_cents, booked_at: iso(s.created_at), cancelled_at: iso(s.cancelled_at),
      you_left_at: iso(s.removed_at ?? s.leaving_at), late_cancellation: s.late_leave, no_show: s.no_show, other_players: others.map((o) => o.display_name ?? o.guest_name).filter(Boolean) });
  }
  const asks = await db.selectFrom("join_request").innerJoin("booking", "booking.id", "join_request.booking_id").select(["booking.code", "join_request.status", "join_request.note", "join_request.level", "join_request.created_at", "join_request.decided_at"])
    .where("join_request.person_id", "=", personId).orderBy("join_request.created_at").execute();
  const offers = await db.selectFrom("place_offer").innerJoin("booking_player", "booking_player.id", "place_offer.booking_player_id").innerJoin("booking", "booking.id", "booking_player.booking_id")
    .select(["booking.code", "place_offer.status", "place_offer.created_at", "place_offer.decided_at", "place_offer.to_person_id", "place_offer.taken_by", "booking_player.person_id"])
    .where((w) => w.or([w("booking_player.person_id", "=", personId), w("place_offer.to_person_id", "=", personId), w("place_offer.taken_by", "=", personId)])).orderBy("place_offer.created_at").execute();

  const enrolments = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id").leftJoin("session", "session.id", "enrolment.session_id")
    .select(["program.name", "program.translations as name_in_other_languages", "program.kind", "session.starts_at", "enrolment.status", "enrolment.price_cents", "enrolment.price_basis", "enrolment.paid_by", "enrolment.created_at",
      "enrolment.left_at", "enrolment.left_how", "enrolment.refund_cents", "enrolment.refund_outcome"]).where("enrolment.person_id", "=", personId).orderBy("enrolment.created_at").execute();

  const pays = await db.selectFrom("payment").select(["id", "created_at", "amount_cents", "method", "status", "booking_player_id", "enrolment_id", "membership_id", "person_id"]).where("person_id", "=", personId).orderBy("created_at").execute();
  const payments = [];
  for (const x of pays) {
    const refunds = await db.selectFrom("refund").select(["amount_cents", "status", "destination", "created_at"]).where("payment_id", "=", x.id).orderBy("created_at").execute();
    const what = x.membership_id ? { en: "Membership", es: "Membresía" } : await paymentsWhat(db, [{ person_id: x.person_id, booking_player_id: x.booking_player_id, enrolment_id: x.enrolment_id }]);
    payments.push({ at: iso(x.created_at), for: say(what), amount_cents: x.amount_cents, method: x.method, status: x.status, refunds: refunds.map((r) => ({ ...r, created_at: iso(r.created_at) })) });
  }
  const memberships = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership_plan.name as plan", "membership_plan.translations as plan_in_other_languages", "membership.status", "membership.period", "membership.price_cents", "membership.started_at", "membership.current_period_end", "membership.cancel_at_period_end",
      "membership.ended_at", "membership.end_reason", "membership.paused_from", "membership.paused_until", "membership.created_at"]).where("membership.person_id", "=", personId).orderBy("membership.created_at").execute();
  const covered = await db.selectFrom("membership_member").innerJoin("membership", "membership.id", "membership_member.membership_id").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .leftJoin("person as payer", "payer.id", "membership.person_id").select(["membership_plan.name as plan", "membership_plan.translations as plan_in_other_languages", "payer.display_name as paid_by", "membership_member.created_at", "membership_member.ends_at", "membership_member.extra"])
    .where("membership_member.person_id", "=", personId).where("membership.person_id", "!=", personId).execute();

  const rating = await db.selectFrom("rating").select(["level", "rated_games", "provisional", "floor", "floor_reason", "self_adjust_used"]).where("person_id", "=", personId).executeTakeFirst();
  const history = await db.selectFrom("rating_event").select(["at", "kind", "level_before", "level_after", "explanation"]).where("person_id", "=", personId).orderBy("at").execute();
  const reviews = await db.selectFrom("level_review").select(["created_at", "kind", "note", "status", "level_at", "answer", "answered_at"]).where("person_id", "=", personId).orderBy("created_at").execute();
  const sides = await db.selectFrom("game_side").innerJoin("game", "game.id", "game_side.game_id").select(["game.id", "game.played_at", "game.rated", "game.status", "game_side.side"])
    .where("game_side.person_id", "=", personId).orderBy("game.played_at").execute();
  const games = [];
  for (const g of sides) {
    const all = await db.selectFrom("game_side").innerJoin("person", "person.id", "game_side.person_id").select(["game_side.side", "game_side.person_id", "person.display_name"]).where("game_id", "=", g.id).execute();
    const sets = await db.selectFrom("game_set").select(["a", "b"]).where("game_id", "=", g.id).orderBy("set_no").execute();
    games.push({ played_at: iso(g.played_at), rated: g.rated, status: g.status, partner: all.filter((x) => x.side === g.side && x.person_id !== personId).map((x) => x.display_name),
      opponents: all.filter((x) => x.side !== g.side).map((x) => x.display_name), sets: sets.map((s) => g.side === "a" ? { you: s.a, them: s.b } : { you: s.b, them: s.a }) });
  }
  const answers = await db.selectFrom("result_answer").select(["answer", "note", "at"]).where("person_id", "=", personId).orderBy("at").execute();

  const messages = await db.selectFrom("outbound_message").select(["created_at", "channel", "kind", "subject", "body", "status", "sent_at", "read_at"]).where("person_id", "=", personId).orderBy("created_at").execute();
  const consents = await db.selectFrom("channel_consent").select(["channel", "purpose", "granted", "source", "at"]).where("person_id", "=", personId).orderBy("at").execute();
  const waivers = await db.selectFrom("waiver_acceptance").innerJoin("waiver", "waiver.id", "waiver_acceptance.waiver_id").innerJoin("person as by", "by.id", "waiver_acceptance.accepted_by")
    .select(["waiver.version_no", "waiver_acceptance.accepted_at", "by.display_name as accepted_by"]).where("waiver_acceptance.person_id", "=", personId).orderBy("waiver_acceptance.accepted_at").execute();
  const friendRows = await db.selectFrom("friend").select(["person_id", "friend_id", "created_at", "removed_at"]).where((w) => w.or([w("person_id", "=", personId), w("friend_id", "=", personId)])).execute();
  const friendIds = [...new Set(friendRows.map((f) => f.person_id === personId ? f.friend_id : f.person_id))];
  const friends = [];
  for (const id of friendIds) {
    const mine = friendRows.find((f) => f.person_id === personId && f.friend_id === id), theirs = friendRows.find((f) => f.person_id === id && f.friend_id === personId);
    friends.push({ name: await name(id), you_added_them_at: iso(mine?.created_at), you_removed_them_at: iso(mine?.removed_at), they_added_you_at: iso(theirs?.created_at) });
  }
  const hm = await db.selectFrom("household_member").select(["household_id", "role", "created_at", "removed_at"]).where("person_id", "=", personId).orderBy("created_at").execute();
  const family = [];
  for (const h of hm) {
    const members = await db.selectFrom("household_member").innerJoin("person", "person.id", "household_member.person_id").select(["person.display_name", "household_member.role"])
      .where("household_id", "=", h.household_id).where("household_member.removed_at", "is", null).where("person.id", "!=", personId).execute();
    family.push({ your_role: h.role, joined_at: iso(h.created_at), left_at: iso(h.removed_at), others: members.map((m) => ({ name: m.display_name, role: m.role })) });
  }
  const kidRules = await db.selectFrom("kid_rule").select(["open_matches", "courts", "programs", "lessons", "monthly_limit_cents", "friends", "texts", "updated_at"]).where("person_id", "=", personId).executeTakeFirst();
  const kidRequests = await db.selectFrom("kid_request").select(["created_at", "kind", "reason", "cents", "what", "status", "decided_at"]).where("person_id", "=", personId).orderBy("created_at").execute();
  const devices = await db.selectFrom("push_subscription").select(["app", "endpoint", "user_agent", "created_at", "last_ok_at", "revoked_at"]).where("person_id", "=", personId).orderBy("created_at").execute();
  const asked = (await sql<{ asked: string; at: Date }>`SELECT asked, at FROM missing_feature WHERE person_id = ${personId} ORDER BY at`.execute(db)).rows;
  const coach = await db.selectFrom("coach").select(["bio", "translations as bio_in_other_languages", "level_min", "level_max", "languages", "rates", "lessons", "active"]).where("person_id", "=", personId).executeTakeFirst();
  // Whether they came, as their coaches marked it; and a calendar link of theirs (the address itself is a key, so not shown).
  const attended = await db.selectFrom("attendance").leftJoin("session", "session.id", "attendance.session_id").leftJoin("program", "program.id", "session.program_id")
    .leftJoin("booking", "booking.id", "attendance.booking_id")
    .select(["attendance.came", "attendance.marked_at", "program.name as program", "program.translations as program_in_other_languages", "session.starts_at", "booking.code as lesson"]).where("attendance.person_id", "=", personId).where("attendance.came", "is not", null)
    .orderBy("attendance.marked_at").execute();
  const feeds = await db.selectFrom("calendar_feed").select(["created_at", "revoked_at"]).where("person_id", "=", personId).orderBy("created_at").execute();
  // Programs they asked to hear about when a place opened.
  const watches = await db.selectFrom("program_watch").innerJoin("program", "program.id", "program_watch.program_id").select(["program.name", "program.translations as name_in_other_languages", "program_watch.created_at", "program_watch.told_at", "program_watch.ended_at"])
    .where("program_watch.person_id", "=", personId).orderBy("program_watch.created_at").execute();
  // The club's tags on them; and, for staff, the groups, templates and messages to members they made.
  const tagged = await db.selectFrom("person_tag").innerJoin("tag", "tag.id", "person_tag.tag_id").select(["tag.name", "person_tag.created_at", "person_tag.removed_at"])
    .where("person_tag.person_id", "=", personId).orderBy("person_tag.created_at").execute();
  const groupsMade = await db.selectFrom("segment").select(["name", "created_at", "active"]).where("created_by", "=", personId).orderBy("created_at").execute();
  const templatesMade = await db.selectFrom("message_template").select(["name", "created_at", "active"]).where("created_by", "=", personId).orderBy("created_at").execute();
  const broadcastsSent = await db.selectFrom("broadcast").select(["purpose", "subject_en", "subject_es", "status", "send_at", "sent_at", "recipients"]).where("created_by", "=", personId).orderBy("created_at").execute();
  // Questions they asked the club, or that were asked about them, with every message in each.
  const threads = await db.selectFrom("question").select(["id", "status", "created_at", "closed_at", "asked_by", "person_id"])
    .where((w) => w.or([w("asked_by", "=", personId), w("person_id", "=", personId)])).orderBy("created_at").execute();
  const questions = [];
  for (const q of threads) {
    const msgs = await db.selectFrom("question_message").leftJoin("person", "person.id", "question_message.author_id").select(["question_message.side", "question_message.body", "question_message.created_at", "person.display_name"])
      .where("question_id", "=", q.id).orderBy("question_message.created_at").orderBy("question_message.id").execute();
    questions.push({ status: q.status, asked_at: iso(q.created_at), closed_at: iso(q.closed_at), asked_by: q.asked_by === personId ? "you" : await name(q.asked_by),
      about: q.person_id === personId ? "you" : await name(q.person_id),
      messages: msgs.map((m) => ({ from: m.side === "club" ? "the club (common questions)" : m.display_name, side: m.side, at: iso(m.created_at), text: m.body })) });
  }

  return {
    profile: { name: p.display_name, given_name: p.given_name, family_name: p.family_name, email: p.email, phone: p.phone, birth_year: p.birth_year, language: p.locale, status: p.status,
      junior: p.junior, own_login: p.own_login, friend_code: p.friend_code, joined_at: iso(p.created_at), joined_by: p.created_via },
    sign_in: { addresses: identities.map((x) => ({ ...x, verified_at: iso(x.verified_at), created_at: iso(x.created_at) })), passkeys, sessions, agents },
    roles: roles.map((r) => ({ role: r.key, location: r.location, active: r.active })),
    bookings, match_asks: asks.map((a) => ({ ...a, created_at: iso(a.created_at), decided_at: iso(a.decided_at) })),
    places_offered: offers.map((o) => ({ booking: o.code, status: o.status, yours: o.person_id === personId, offered_to_you: o.to_person_id === personId, taken_by_you: o.taken_by === personId, at: iso(o.created_at), decided_at: iso(o.decided_at) })),
    programs: enrolments.map((e) => ({ ...e, starts_at: iso(e.starts_at), created_at: iso(e.created_at), left_at: iso(e.left_at) })),
    payments, receipts, memberships, covered_by_family_plans: covered,
    level: rating ?? null, level_history: history.map((h) => ({ at: iso(h.at), kind: h.kind, before: h.level_before, after: h.level_after, why: say(h.explanation) })),
    level_reviews: reviews, games, score_answers: answers,
    messages, consents, quiet_hours: { from: `${String(QUIET.from).padStart(2, "0")}:00`, until: `${String(QUIET.until).padStart(2, "0")}:00`, set_by: "club" },
    waivers, friends, family, kid_rules: kidRules ?? null, kid_requests: kidRequests.map((k) => ({ ...k, what: say(k.what) })),
    // A device's address names the push service, not the device: only the service is kept here.
    push_devices: devices.map((d) => ({ app: d.app, service: (() => { try { return new URL(d.endpoint).host; } catch { return null; } })(), user_agent: d.user_agent, created_at: iso(d.created_at), last_ok_at: iso(d.last_ok_at), revoked_at: iso(d.revoked_at) })),
    asked_for: asked, coach_profile: coach ?? null,
    attendance: attended.map((a) => ({ came: a.came, marked_at: iso(a.marked_at), program: a.program, starts_at: iso(a.starts_at), lesson: a.lesson })),
    calendar_links: feeds.map((f) => ({ created_at: iso(f.created_at), stopped_at: iso(f.revoked_at) })),
    place_watches: watches.map((w) => ({ program: w.name, asked_at: iso(w.created_at), told_at: iso(w.told_at), stopped_at: iso(w.ended_at) })),
    tags: tagged.map((x) => ({ tag: x.name, added_at: iso(x.created_at), removed_at: iso(x.removed_at) })),
    ...(groupsMade.length || templatesMade.length || broadcastsSent.length ? { made_for_the_club: {
      groups: groupsMade.map((g) => ({ name: g.name, made_at: iso(g.created_at), in_use: g.active })),
      templates: templatesMade.map((g) => ({ name: g.name, made_at: iso(g.created_at), in_use: g.active })),
      messages_to_members: broadcastsSent.map((b) => ({ purpose: b.purpose, subject: (lang === "es" ? b.subject_es ?? b.subject_en : b.subject_en ?? b.subject_es) ?? "", status: b.status, send_at: iso(b.send_at), sent_at: iso(b.sent_at), people: b.recipients })),
    } } : {}),
    questions,
  };
}

/** The whole file: the person, then each junior they manage. */
export async function exportData(db: Db | Trx, personId: string, now: Date, lang: Lang) {
  const club = await db.selectFrom("club").select(["name", "time_zone"]).executeTakeFirstOrThrow();
  const juniors = await juniorsOf(db, personId);
  return { format: "kumi-export-1", club: club.name, time_zone: club.time_zone, exported_at: now.toISOString(), note: both("privacy.export_note")[lang],
    ...(await personExport(db, personId, now, lang)), juniors: await Promise.all(juniors.map(async (j) => personExport(db, j.id, now, lang))) };
}

// ---- Who may ----
/** A kid with their own login can't delete themselves: a parent does. */
async function subject(ctx: { db: Db | Trx; actor: { personId: string | null } }, personId: string) {
  const { row, read } = await readRow(ctx.db, "person", personId, "thing.person");
  if (row.redacted_at) throw new KumiError("error.privacy_already");
  return { row, read, self: ctx.actor.personId === personId, ownerIds: await withManagers(ctx.db, [personId]) };
}

export const privacyExport = defineAction({
  name: "privacy.export", version: 1,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const s = await subject(ctx, i.person_id);
    const juniors = (await juniorsOf(ctx.db, i.person_id)).map((j) => j.display_name);
    const withJuniors = juniors.length ? both("plan.privacy.export_juniors", { names: nameList(juniors) }) : { en: "", es: "" };
    return { title: both("action.privacy.export"), summary: s.self ? both("plan.privacy.export_self", { juniors: withJuniors }) : both("plan.privacy.export_for", { name: s.row.display_name, juniors: withJuniors }),
      reads: [], ownerIds: s.ownerIds, undo: { kind: "none", note: both("reason.export_final") } };
  },
  async apply(ctx, i) {
    await ctx.emit("privacy.exported", { person_id: i.person_id, by: ctx.actor.personId, self: ctx.actor.personId === i.person_id, at: ctx.now.toISOString() });
    // A manager's download, applied now because the owner approved it: the manager who asked isn't there to get
    // the file, so they're sent its link, theirs alone, for the same few minutes (exportRun checks who's asking).
    const waited = (await ctx.trx.selectFrom("action_run").select("status").where("id", "=", ctx.runId).executeTakeFirst())?.status === "awaiting_approval";
    if (waited && ctx.actor.personId) await ctx.emit("privacy.export_ready", { to: ctx.actor.personId, person_id: i.person_id, run_id: ctx.runId, minutes: EXPORT_MINUTES });
    // The file itself is made when it's fetched (never stored, and never in Changes).
    return { person_id: i.person_id, download: `/my/privacy/export/${ctx.runId}` };
  },
});

/** The export a person just confirmed, for the file download: theirs, applied, and recent. */
export async function exportRun(db: Db, runId: string, actorId: string, now: Date) {
  const run = await db.selectFrom("action_run").select(["action", "status", "actor_person_id", "applied_at", "input"]).where("id", "=", runId).executeTakeFirst();
  if (!run || run.action !== "privacy.export" || run.status !== "applied" || run.actor_person_id !== actorId || !run.applied_at
    || now.getTime() - run.applied_at.getTime() > EXPORT_MINUTES * 60_000) throw new KumiError("error.privacy_export_gone", {}, 404);
  return (run.input as { person_id: string }).person_id;
}

export const privacyErase = defineAction({
  name: "privacy.erase", version: 1, strongAuth: true,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const s = await subject(ctx, i.person_id);
    if (s.self && s.row.junior) throw new KumiError("error.privacy_kid_parent");
    // A parent deletes a junior's account only when they alone manage them; with another parent, it's the club's.
    if (!s.self && s.row.junior && ctx.actor.personId && s.ownerIds.includes(ctx.actor.personId) && (await managersOf(ctx.db, i.person_id)).length > 1)
      throw new KumiError("error.privacy_kid_two_parents", { name: s.row.display_name });
    const c = await deleteCheck(ctx.db, i.person_id, ctx.now);
    if (c.blockers.length) throw new KumiError("error.privacy_blocked", { list: joinTexts(c.blockers.map((b) => both("privacy.blocker_line", { text: b.text, how: b.how })), "; ") });
    const also: Text[] = [...c.ends];
    if (c.juniors.length) also.unshift(both("plan.privacy.erase_juniors", { names: nameList(c.juniors.map((j) => j.display_name)), count: c.juniors.length }));
    const params = { name: s.row.display_name, also: joinTexts(also.map((x) => ({ en: `${x.en} `, es: `${x.es} ` })), "") };
    return { title: both("action.privacy.erase"), summary: both(s.self ? "plan.privacy.erase_self" : "plan.privacy.erase_for", params), reads: [s.read], ownerIds: s.ownerIds,
      undo: { kind: "none", note: both("reason.erase_final") }, details: { juniors: c.juniors.map((j) => j.id) } };
  },
  async apply(ctx, i, plan) {
    // Checked again inside the change: something booked since the preview stops it.
    const c = await deleteCheck(ctx.trx, i.person_id, ctx.now);
    const juniors = (plan.details as { juniors: string[] }).juniors;
    if (c.blockers.length || c.juniors.map((j) => j.id).sort().join() !== [...juniors].sort().join()) throw new KumiError("error.changed");
    let scrubbed = 0;
    for (const id of [...juniors, i.person_id]) scrubbed += await erasePerson(ctx, id);
    await ctx.emit("privacy.erased", { self: ctx.actor.personId === i.person_id, by: ctx.actor.personId === i.person_id ? null : ctx.actor.personId, juniors: juniors.length, at: ctx.now.toISOString() });
    return { erased: true, juniors: juniors.length, scrubbed };
  },
});

// ---- Deleting one person ----
/** How to take a person's name, email and phone out of text, keeping everything else. A name goes only
 *  where it stands as a whole word, and becomes "Former member" in the text's own language. */
interface Scrub { emails: string[]; phones: string[]; names: string[]; texts?: string[] }
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function scrubString(s: string, x: Scrub, lang: Lang | null, names: boolean): string {
  let out = s;
  // Their own words (what they asked the club), wherever they were copied: the whole text, or its first words.
  for (const w of x.texts ?? []) out = out.split(w).join(REMOVED);
  for (const e of x.emails) out = out.replace(new RegExp(escape(e), "gi"), REMOVED);
  for (const p of x.phones) out = out.split(p).join(REMOVED);
  if (names) for (const n of x.names) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(n)}(?![\\p{L}\\p{N}])`, "giu"), formerMember[lang ?? "en"]);
  return out;
}
/** The same through any JSON: a { en, es } text gets each language's word; `drop` keys (their own notes) go. */
function scrubJson(v: unknown, x: Scrub, names: boolean, drop: ReadonlySet<string> = new Set(), lang: Lang | null = null): unknown {
  if (typeof v === "string") return scrubString(v, x, lang, names);
  if (Array.isArray(v)) return v.map((y) => scrubJson(y, x, names, drop, lang));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, y]) =>
    [k, drop.has(k) && typeof y === "string" ? REMOVED : scrubJson(y, x, names, drop, k === "en" || k === "es" ? k : lang)]));
  return v;
}
const PERSON_FIELDS = { given_name: null, family_name: null, display_name: FORMER_MEMBER, email: null, phone: null, birth_year: null, friend_code: null } as const;
const THEIR_WORDS = new Set(["note", "asked", "bio"]);

/** Every id that names something of theirs: a row of the change log, an event or a message that carries one
 *  is about them, so their name can be taken out of it without touching someone else with the same name. */
async function theirIds(db: Trx, personId: string): Promise<string[]> {
  const ids = new Set<string>([personId]);
  const add = (rows: Record<string, unknown>[]) => { for (const r of rows) for (const v of Object.values(r)) if (typeof v === "string") ids.add(v); };
  add(await db.selectFrom("booking_player").select(["id", "booking_id"]).where("person_id", "=", personId).execute());
  add(await db.selectFrom("booking").select("id").where("organiser_id", "=", personId).execute());
  add(await db.selectFrom("enrolment").select("id").where("person_id", "=", personId).execute());
  add(await db.selectFrom("game_side").select("game_id").where("person_id", "=", personId).execute());
  add(await db.selectFrom("membership").select("id").where("person_id", "=", personId).execute());
  add(await db.selectFrom("membership_member").select(["id", "membership_id"]).where("person_id", "=", personId).execute());
  add(await db.selectFrom("payment").select("id").where("person_id", "=", personId).execute());
  add(await db.selectFrom("join_request").select("id").where("person_id", "=", personId).execute());
  add(await db.selectFrom("level_review").select("id").where("person_id", "=", personId).execute());
  add(await db.selectFrom("kid_request").select("id").where("person_id", "=", personId).execute());
  add(await db.selectFrom("friend").select("id").where((w) => w.or([w("person_id", "=", personId), w("friend_id", "=", personId)])).execute());
  add(await db.selectFrom("household_member").select("id").where("person_id", "=", personId).execute());
  add(await db.selectFrom("place_offer").select("id").where((w) => w.or([w("to_person_id", "=", personId), w("taken_by", "=", personId)])).execute());
  add(await db.selectFrom("attendance").select("id").where("person_id", "=", personId).execute());
  add(await db.selectFrom("person_tag").select("id").where("person_id", "=", personId).execute());
  add(await db.selectFrom("program_watch").select("id").where("person_id", "=", personId).execute());
  const threads = await db.selectFrom("question").select("id").where((w) => w.or([w("asked_by", "=", personId), w("person_id", "=", personId)])).execute();
  add(threads);
  if (threads.length) add(await db.selectFrom("question_message").select("id").where("question_id", "in", threads.map((t) => t.id)).execute());
  return [...ids];
}

/** Rows of a jsonb-holding table whose text holds any of the needles (case-insensitive). */
const anyOf = (needles: string[]) => needles.map((n) => `%${n.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);

async function erasePerson(ctx: ApplyCtx, personId: string): Promise<number> {
  const db = ctx.trx;
  const p = await db.selectFrom("person").selectAll().where("id", "=", personId).forUpdate().executeTakeFirstOrThrow();
  if (p.redacted_at) return 0;
  const names = [...new Set([p.display_name, [p.given_name, p.family_name].filter(Boolean).join(" ")].map((n) => n.trim()).filter((n) => n.length >= 2 && n !== FORMER_MEMBER))];
  const identities = await db.selectFrom("auth_identity").select("value").where("person_id", "=", personId).execute();
  const x: Scrub = { emails: [...new Set([p.email, ...identities.filter((v) => v.value.includes("@")).map((v) => v.value)].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase()))],
    phones: [...new Set([p.phone, ...identities.filter((v) => !v.value.includes("@")).map((v) => v.value)].filter((v): v is string => Boolean(v)))], names };
  const ids = await theirIds(db, personId);
  // What they wrote to the club (and what was written in their name about a junior): long enough to be theirs alone.
  const threads = (await db.selectFrom("question").select("id").where((w) => w.or([w("asked_by", "=", personId), w("person_id", "=", personId)])).execute()).map((q) => q.id);
  const said = await db.selectFrom("question_message").select(["id", "body"]).where("side", "=", "member")
    .where((w) => w.or([w("author_id", "=", personId), ...(threads.length ? [w("question_id", "in", threads)] : [])])).execute();
  x.texts = [...new Set(said.flatMap((m) => [m.body, excerpt(m.body), excerpt(m.body, 120), excerpt(m.body, 200)]).filter((w) => w.length >= 12))].sort((a, b) => b.length - a.length);

  // Whatever lets someone sign in as them, reach them or recognise them.
  for (const r of await db.selectFrom("person_role").select("id").where("person_id", "=", personId).where("active", "=", true).execute()) await ctx.update("person_role", r.id, { active: false });
  await db.deleteFrom("auth_identity").where("person_id", "=", personId).execute();
  await db.deleteFrom("auth_challenge").where(sql<boolean>`person_id = ${personId} OR lower(target) = ANY (${[...x.emails, ...x.phones]}::text[])`).execute();
  await db.deleteFrom("web_session").where("person_id", "=", personId).execute();
  await db.deleteFrom("passkey").where("person_id", "=", personId).execute();
  await db.deleteFrom("push_subscription").where("person_id", "=", personId).execute();
  await db.deleteFrom("calendar_feed").where("person_id", "=", personId).execute();
  await db.deleteFrom("program_watch").where("person_id", "=", personId).execute();
  const grants = await db.selectFrom("oauth_grant").select("id").where("person_id", "=", personId).execute();
  if (grants.length) {
    await db.updateTable("oauth_grant").set({ revoked_at: ctx.now }).where("person_id", "=", personId).where("revoked_at", "is", null).execute();
    await db.updateTable("oauth_token").set({ revoked_at: ctx.now }).where("grant_id", "in", grants.map((g) => g.id)).where("revoked_at", "is", null).execute();
  }
  await db.deleteFrom("external_ref").where("entity", "=", "person").where("entity_id", "=", personId).execute();
  await db.deleteFrom("kid_rule").where("person_id", "=", personId).execute();
  // Friends and family links.
  for (const f of await db.selectFrom("friend").select("id").where((w) => w.or([w("person_id", "=", personId), w("friend_id", "=", personId)])).where("removed_at", "is", null).execute())
    await ctx.update("friend", f.id, { removed_at: ctx.now });
  for (const h of await db.selectFrom("household_member").select("id").where("person_id", "=", personId).where("removed_at", "is", null).execute()) await ctx.update("household_member", h.id, { removed_at: ctx.now });
  for (const inv of await db.selectFrom("household_invite").select("id").where("invited_by", "=", personId).where("status", "=", "open").execute()) await ctx.update("household_invite", inv.id, { status: "withdrawn", decided_at: ctx.now });
  for (const fc of await db.selectFrom("family_card").select("id").where("saved_by", "=", personId).where("status", "in", ["pending", "saved"]).execute())
    await ctx.update("family_card", fc.id, { status: "removed", removed_at: ctx.now, saved_customer: null, saved_method: null });
  // What simply ends with the account: a membership already set to end, and cover on someone's family plan.
  for (const m of await db.selectFrom("membership").select("id").where("person_id", "=", personId).where("status", "in", ["upcoming", "active", "past_due"]).execute())
    await ctx.update("membership", m.id, { status: "ended", ended_at: ctx.now, end_reason: "erased", cancel_at_period_end: true, next_attempt_at: null });
  for (const c of await db.selectFrom("membership_member").select("id").where("person_id", "=", personId).where((w) => w.or([w("ends_at", "is", null), w("ends_at", ">", ctx.now)])).execute())
    await ctx.update("membership_member", c.id, { ends_at: ctx.now });
  // Saved cards at the payment provider: never charged again from Kumi.
  await db.updateTable("membership").set({ saved_customer: null, saved_method: null }).where("person_id", "=", personId).execute();
  await db.updateTable("payment").set({ saved_customer: null, saved_method: null }).where("person_id", "=", personId).where("saved_method", "is not", null).execute();
  // Their own words.
  await db.updateTable("join_request").set({ note: null }).where("person_id", "=", personId).execute();
  await db.updateTable("result_answer").set({ note: null }).where("person_id", "=", personId).execute();
  await db.updateTable("level_review").set({ note: null }).where("person_id", "=", personId).execute();
  await sql`UPDATE missing_feature SET asked = ${REMOVED} WHERE person_id = ${personId}`.execute(db);
  // Their questions: their words go, the staff's answers lose their name; anything still open is closed.
  if (said.length) await db.updateTable("question_message").set({ body: REMOVED }).where("id", "in", said.map((m) => m.id)).execute();
  if (threads.length) {
    for (const m of await db.selectFrom("question_message").select(["id", "body"]).where("question_id", "in", threads).where("side", "!=", "member").execute())
      await db.updateTable("question_message").set({ body: scrubString(m.body, x, null, true) }).where("id", "=", m.id).execute();
    for (const q of await db.selectFrom("question").select("id").where("id", "in", threads).where("status", "!=", "closed").execute())
      await ctx.update("question", q.id, { status: "closed", waiting_since: null, closed_at: ctx.now });
  }
  const coach = await db.selectFrom("coach").select(["photo_id"]).where("person_id", "=", personId).executeTakeFirst();
  if (coach) {
    await ctx.update("coach", personId, { bio: null, translations: JSON.stringify({}), photo_id: null, active: false });
    if (coach.photo_id) await db.deleteFrom("photo").where("id", "=", coach.photo_id).execute();
  }
  // Messages to them: kept as a record that something was sent, without the words; anything not sent yet isn't.
  await db.updateTable("outbound_message").set({ subject: REMOVED, body: REMOVED, link: null }).where("person_id", "=", personId).execute();
  await db.updateTable("outbound_message").set({ status: "dropped", failure: "account deleted" }).where("person_id", "=", personId).where("status", "in", ["waiting", "held"]).execute();
  // A new friend code nobody has, so an old friend link leads nowhere.
  // The club's tags come off; a new news key, so an old unsubscribe link leads nowhere.
  for (const pt of await db.selectFrom("person_tag").select("id").where("person_id", "=", personId).where("removed_at", "is", null).execute()) await ctx.update("person_tag", pt.id, { removed_at: ctx.now });
  await ctx.update("person", personId, { ...PERSON_FIELDS, friend_code: randomBytes(6).toString("hex"), news_token: randomBytes(20).toString("hex"), status: "archived", own_login: false, redacted_at: ctx.now });

  // The scrub: their name, email and phone out of the history. Email and phone go wherever they appear;
  // the name goes only from rows that carry one of their ids.
  const needles = anyOf([...x.emails, ...x.phones, ...x.names, ...(x.texts ?? [])]);
  if (!needles.length) return 0;
  const related = (text: string) => ids.some((id) => text.includes(id));
  let n = 0;
  for (const r of await db.selectFrom("action_run").select(["id", "input", "plan", "result", "error", "undo_note"])
    .where(sql<boolean>`(input::text || plan::text || coalesce(result::text, '') || coalesce(error::text, '') || coalesce(undo_note::text, '')) ILIKE ANY (${needles}::text[])`).execute()) {
    const mine = related(JSON.stringify([r.input, r.plan, r.result]));
    await db.updateTable("action_run").set({ input: JSON.stringify(scrubJson(r.input, x, mine)), plan: JSON.stringify(scrubJson(r.plan, x, mine)), result: r.result === null ? null : JSON.stringify(scrubJson(r.result, x, mine)),
      error: r.error === null ? null : JSON.stringify(scrubJson(r.error, x, mine)), undo_note: r.undo_note === null ? null : JSON.stringify(scrubJson(r.undo_note, x, mine)) }).where("id", "=", r.id).execute();
    n++;
  }
  for (const r of await db.selectFrom("entity_change").select(["id", "entity", "entity_id", "before", "after"])
    .where(sql<boolean>`(entity = 'person' AND entity_id = ${personId}) OR (coalesce(before::text, '') || after::text) ILIKE ANY (${needles}::text[])`).execute()) {
    const mine = r.entity_id === personId || related(JSON.stringify([r.before, r.after]));
    const own = r.entity === "person" && r.entity_id === personId;
    const fix = (row: unknown) => {
      if (row === null) return null;
      const s = scrubJson(row, x, mine, own ? THEIR_WORDS : undefined) as Record<string, unknown>;
      return JSON.stringify(own ? { ...s, ...Object.fromEntries(Object.keys(PERSON_FIELDS).filter((k) => k in s).map((k) => [k, PERSON_FIELDS[k as keyof typeof PERSON_FIELDS]])) } : s);
    };
    await db.updateTable("entity_change").set({ before: fix(r.before) as any, after: fix(r.after) as any }).where("id", "=", r.id).execute();
    n++;
  }
  // Passkeys they made: the public key goes from the history too.
  await db.updateTable("entity_change").set({ after: sql`after - 'public_key'`, before: sql`CASE WHEN before IS NULL THEN NULL ELSE before - 'public_key' END` })
    .where("entity", "=", "passkey").where(sql<boolean>`after->>'person_id' = ${personId}`).execute();
  for (const r of await db.selectFrom("event_outbox").select(["id", "payload"]).where(sql<boolean>`payload::text ILIKE ANY (${needles}::text[])`).execute()) {
    const mine = related(JSON.stringify(r.payload));
    await db.updateTable("event_outbox").set({ payload: JSON.stringify(scrubJson(r.payload, x, mine, mine ? THEIR_WORDS : undefined)) }).where("id", "=", r.id).execute();
    n++;
  }
  // Other people's messages that named them, about something of theirs.
  for (const m of await db.selectFrom("outbound_message").leftJoin("event_outbox", "event_outbox.id", "outbound_message.event_id").leftJoin("action_run", "action_run.id", "event_outbox.action_run_id")
    .select(["outbound_message.id", "outbound_message.lang", "outbound_message.subject", "outbound_message.body", "event_outbox.payload", "action_run.input", "action_run.plan"])
    .where("outbound_message.person_id", "!=", personId).where(sql<boolean>`(outbound_message.subject || ' ' || outbound_message.body) ILIKE ANY (${needles}::text[])`).execute()) {
    const mine = related(JSON.stringify([m.payload, m.input, m.plan])), lang = m.lang === "es" ? "es" : "en";
    await db.updateTable("outbound_message").set({ subject: scrubString(m.subject, x, lang, mine), body: scrubString(m.body, x, lang, mine) }).where("id", "=", m.id).execute();
    n++;
  }
  // Other players' level history: "Won 6-3 with Ann" in a game they played.
  const games = await db.selectFrom("game_side").select("game_id").where("person_id", "=", personId).execute();
  if (games.length) for (const r of await db.selectFrom("rating_event").select(["id", "explanation"]).where("game_id", "in", games.map((g) => g.game_id)).where("person_id", "!=", personId)
    .where(sql<boolean>`explanation::text ILIKE ANY (${needles}::text[])`).execute()) {
    await db.updateTable("rating_event").set({ explanation: JSON.stringify(scrubJson(r.explanation, x, true)) }).where("id", "=", r.id).execute();
    n++;
  }
  // Text written about them elsewhere: a kid's request as their parents saw it, a desk note, a payment memo.
  for (const r of await db.selectFrom("kid_request").select(["id", "input", "what", "person_id"]).where(sql<boolean>`(input::text || what::text) ILIKE ANY (${needles}::text[])`).execute()) {
    const mine = r.person_id === personId || related(JSON.stringify(r.input));
    await db.updateTable("kid_request").set({ input: JSON.stringify(scrubJson(r.input, x, mine)), what: JSON.stringify(scrubJson(r.what, x, mine)) }).where("id", "=", r.id).execute();
  }
  for (const e of await db.selectFrom("enrolment").select(["id", "comp_note", "refund_note"]).where("person_id", "=", personId).execute())
    await db.updateTable("enrolment").set({ comp_note: e.comp_note && scrubString(e.comp_note, x, null, true), refund_note: e.refund_note && scrubString(e.refund_note, x, null, true) }).where("id", "=", e.id).execute();
  for (const b of await db.selectFrom("booking").select(["id", "note"]).where("organiser_id", "=", personId).where("note", "is not", null).execute())
    await db.updateTable("booking").set({ note: scrubString(b.note!, x, null, true) }).where("id", "=", b.id).execute();
  for (const l of await db.selectFrom("ledger_txn").select(["id", "memo", "action_run_id"]).where(sql<boolean>`memo ILIKE ANY (${needles}::text[])`).execute())
    await db.updateTable("ledger_txn").set({ memo: scrubString(l.memo ?? "", x, null, true) }).where("id", "=", l.id).execute();
  return n;
}

/** Whether a person (signed in as `actorId`) may see what stops `personId` being deleted: themselves, a
 *  parent for their junior, or staff who could delete the account. */
export async function mayCheck(db: Db | Trx, actorId: string, personId: string, now: Date): Promise<boolean> {
  if (actorId === personId) return true;
  return (await decide(db, "privacy.erase", { personId: actorId, ownerIds: await withManagers(db, [personId]), at: now })).mode !== "no";
}
