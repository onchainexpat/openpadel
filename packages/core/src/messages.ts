// What Kumi tells people (messages.md). Events become messages after their change commits: each lands
// in the person's in-app inbox at once, and its email copy waits for the sender job, outside quiet
// hours unless it's essential. Every row keeps the exact words sent and the event behind it.
import { sql } from "kysely";
import { both, dateTime, money, t, pickLang, productName, type Key, type Lang, type Params, type Text, formatLocale } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import type { Handler, OutboxEvent } from "./outbox.ts";
import { uuidv7 } from "./ids.ts";
import { atLocal, localDate, localParts, onDate } from "./clock.ts";
import { dayText, endDay, kindList, lastTryAt, periodCents, planPrice } from "./memberships.ts";
import { band } from "./match_rules.ts";
import { gameView, teamsFor } from "./results.ts";
import { namesFor, pairText } from "./junior_names.ts";
import { hasPushDevice } from "./push.ts";
import { declineReason, refundReason } from "./declines.ts";
import { managersOf, withManagers } from "./households.ts";
import { textOf } from "./club_text.ts";
import { paymentWhat } from "./kids.ts";
import { TEXT_KINDS, textable, textingOn } from "./texts.ts";
import { receiptParams } from "./receipts.ts";
import { roleLabel } from "./roles.ts";
import { needsTwoFactor } from "./two_factor.ts";
import { skipRepeatsAfterRestore } from "./repeats.ts";
import { movedAway } from "./club_exit.ts";
import { isRestoreJob, type OpsJob } from "./ops.ts";
import { currentPrices, monthOf, nextMonthStart, usageAllows } from "./usage.ts";
import { lastClubExport } from "./club_exit.ts";
import { mayAnswer } from "./actions.ts";
import { emailSuppressed } from "./email_suppression.ts";
import { gameOf } from "./chat.ts";
import { typeKey } from "./playtomic.ts";

/** `id`, when given, makes a repeat of the same send a no-op at the provider (a retry after a timeout).
 *  `headers`: extra mail headers, such as a club news email's one-click unsubscribe (RFC 8058). */
export interface Mail { to: string; subject: string; text: string; id?: string; headers?: Record<string, string> }
/** `ref`: the email service's id for it, so its reports (bounces, complaints) find the message. */
export interface Mailer { send(mail: Mail): Promise<void | { ref?: string | null }> }

/** Quiet hours in the club's time, by default 9 pm to 8 am (messages.md). */
export const QUIET = { from: 21, until: 8 };
/** An event older than this tells nobody: no late news after an outage, or for events from before messages. */
const TOO_OLD_MS = 24 * 3600_000;
const MAX_SEND_ATTEMPTS = 5;

type Purpose = "account" | "staff";
interface Draft {
  to: string;
  kind: string;                 // msg.<kind>.subject and msg.<kind>.body in the catalogs
  params: Params;
  purpose: Purpose;
  essential: boolean;           // sign-ins, confirmations, removals, money: ignore quiet hours
  email: boolean;               // also by email, or the inbox only
  link?: string;
  staleAt?: Date | null;        // not worth sending after this
  push?: boolean;               // false: no notification on their phones (a receipt)
  inbox?: boolean;              // false: no new inbox copy (a receipt sent again by email)
  emailUnlessRead?: number;     // the email waits this many minutes, and isn't sent if the inbox copy was read by then
  parents?: string[];           // to a junior with a login of their own: these parents hear it too (one who sent it for them)
}
/** Emails not sent when the member saw it in the app first: an automatic answer, shown on their question's page
 *  as soon as they ask. Seen means the inbox copy read, or the question opened after the answer was written. */
const UNLESS_READ = new Set(["question_club_answered"]);
async function seenInApp(trx: Trx, m: { event_id: string | null; person_id: string; kind: string; link?: string | null }): Promise<boolean> {
  if (m.event_id && await trx.selectFrom("outbound_message").select("id").where("event_id", "=", m.event_id).where("person_id", "=", m.person_id).where("kind", "=", m.kind)
    .where("channel", "=", "inbox").where("read_at", "is not", null).executeTakeFirst()) return true;
  const qid = m.link?.match(/^\/ask\/([0-9a-f-]{36})$/)?.[1];
  if (!qid) return false;
  const r = await trx.selectFrom("question").select("member_seen_at")
    .select((eb) => eb.selectFrom("question_message").select((x) => x.fn.max("created_at").as("at")).whereRef("question_message.question_id", "=", "question.id").where("side", "=", "club").as("answered_at"))
    .where("id", "=", qid).executeTakeFirst();
  return Boolean(r?.member_seen_at && r.answered_at && new Date(r.member_seen_at) >= new Date(r.answered_at as Date));
}
export const ANSWER_EMAIL_MINUTES = 5;

/** When quiet hours end, if `now` is inside them in the club's time; otherwise null. */
export function quietUntil(now: Date, tz: string, q = QUIET): Date | null {
  const p = localParts(now, tz);
  if (p.h >= q.until && p.h < q.from) return null;
  if (p.h < q.until) return atLocal(p.y, p.m, p.d, q.until, tz);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return atLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), q.until, tz);
}

// ---- What each event says, and to whom ----
type Ctx = { db: Db; tz: string };
const amount = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const when = (d: Date | null, tz: string): Text => d ? { en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) } : { en: "", es: "" };
const NOTHING: Text = { en: "", es: "" };

/** The staff app's address (KUMI_PUBLIC_URL), for the email that tells someone they've been given a staff role:
 *  emails carry no links of their own, so it's said in words. The server sets it as it starts. */
let staffAddress: string | null = null;
export function setStaffAddress(url: string | null) { staffAddress = url ? url.replace(/\/$/, "") : null; }

/** The enrolment, its program and when it starts (its own date, or the program's first). */
async function place(db: Db, enrolmentId: string) {
  const e = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id")
    .select(["enrolment.id", "enrolment.person_id", "enrolment.program_id", "enrolment.session_id", "enrolment.price_cents", "enrolment.waitlist_position", "enrolment.left_reason", "program.name", "program.translations"])
    .where("enrolment.id", "=", enrolmentId).executeTakeFirstOrThrow();
  const s = await db.selectFrom("session").select((eb) => eb.fn.min("starts_at").as("s")).where("program_id", "=", e.program_id).where("status", "!=", "cancelled")
    .$if(Boolean(e.session_id), (q) => q.where("id", "=", e.session_id!)).executeTakeFirst();
  const { translations, ...rest } = e;
  // The program's name in each reader's language, when the club wrote one.
  return { ...rest, name: textOf(e.name, translations, "name"), start: (s?.s as Date | null) ?? null };
}
async function paidFor(db: Db, enrolmentId: string): Promise<number> {
  const r = await db.selectFrom("payment").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", enrolmentId).where("status", "=", "succeeded").executeTakeFirst();
  return Number(r?.c ?? 0);
}
async function owes(db: Db, enrolmentId: string): Promise<number> {
  const r = await db.selectFrom("payment").select((eb) => eb.fn.sum<string>("amount_cents").as("c")).where("enrolment_id", "=", enrolmentId).where("status", "=", "pending").executeTakeFirst();
  return Number(r?.c ?? 0);
}
/** Front desk and up: who hears about a place left empty at the last minute. */
async function desk(db: Db): Promise<string[]> {
  const rows = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.person_id")
    .where("role.key", "in", ["owner", "manager", "front_desk"]).where("person_role.active", "=", true).distinct().execute();
  return rows.map((r) => r.person_id);
}
/** Owners and managers: who hears about money that went wrong and clashes with Playtomic. */
async function managers(db: Db): Promise<string[]> {
  const rows = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.person_id")
    .where("role.key", "in", ["owner", "manager"]).where("person_role.active", "=", true).distinct().execute();
  return rows.map((r) => r.person_id);
}
/** The club's owners: who's told the day the club's Kumi ends (leaving.ts), and about support access (support.ts). */
async function owners(db: Db): Promise<string[]> {
  const rows = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.person_id")
    .where("role.key", "=", "owner").where("person_role.active", "=", true).distinct().execute();
  return rows.map((r) => r.person_id);
}
/** What happens to the club's data after its Kumi ends, as the server's owner said (null: not said). */
function keptText(on: string, days: number | null, mail?: { leaving_email_domain: string | null; leaving_email_domain_host: boolean }): Text {
  const date = dayText(on);
  const kept = days === null ? both("msg.leaving_kept_unsaid", { date }) : days === 0 ? both("msg.leaving_kept_none", { date }) : both("msg.leaving_kept_days", { date, count: days });
  // What becomes of the domain the club's email comes from (`kumi leaving on --email-domain`), when it was said.
  const domain = mail?.leaving_email_domain;
  if (!domain) return kept;
  return both("msg.leaving_with_mail", { kept, mail: both(mail!.leaving_email_domain_host ? "msg.leaving_mail_host" : "msg.leaving_mail_own", { domain }) });
}
/** Support access (support.ts), as the messages about it say it. */
async function supportInfo(db: Db, grantId: string, tz: string) {
  const g = await db.selectFrom("support_grant").selectAll().where("id", "=", grantId).executeTakeFirstOrThrow();
  const club = (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;
  return { g, params: { club, name: g.name, email: g.email, reason: g.reason, until: when(new Date(g.ends_at), tz),
    level: both(g.level === "view" ? "msg.support_level_view" : "msg.support_level_manager") } };
}
async function nameOf(db: Db, personId: string): Promise<string> {
  return (await db.selectFrom("person").select("display_name").where("id", "=", personId).executeTakeFirst())?.display_name ?? "";
}
/** `desk`: the part paid at the desk, which waits there to be collected rather than going to a card. */
function refundLine(outcome: string, cents: number, paid: number, desk = 0, credit = 0, pass = 0, byPass = false): Text {
  // Paid with a pass: its use went back, or (part or nothing back) is spent, never an amount of money (passes.ts).
  if (byPass) return both(pass > 0 ? "msg.refund_pass_back" : "msg.refund_pass_spent");
  if (cents > 0) return outcome === "credit" ? both("msg.refund_credit", { amount: amount(cents) }) : backWords(cents - desk - credit, desk, credit);
  return paid > 0 ? both("msg.refund_none") : NOTHING;
}
/** Whether a place was paid with a pass alone. */
async function paidByPass(db: Db, enrolmentId: string): Promise<boolean> {
  const r = await db.selectFrom("payment").select(["method"]).where("enrolment_id", "=", enrolmentId).where("status", "=", "succeeded").execute();
  return r.length > 0 && r.every((x) => x.method === "pass");
}
/** What goes back to the card, and what's to collect at the desk (money paid there goes back there). */
function backWords(card: number, desk: number, credit = 0, playtomic = 0): Text {
  // Paid in Playtomic (a booking the club took over from it): the club gives it back there.
  const parts = [card > 0 ? both("msg.refund_card", { amount: amount(card) }) : null, desk > 0 ? both("msg.refund_desk", { amount: amount(desk) }) : null,
    credit > 0 ? both("msg.refund_credit", { amount: amount(credit) }) : null, playtomic > 0 ? both("msg.refund_playtomic", { amount: amount(playtomic) }) : null].filter((x): x is Text => Boolean(x));
  return { en: parts.map((x) => x.en).join(" "), es: parts.map((x) => x.es).join(" ") };
}

/** A court booking: where and when (in its location's time), and who's in it. */
/** Where a scored game was played, for its messages: a court booking's details, or a tournament or league match's. */
async function gameWhere(db: Db, g: { booking_id: string | null; fixture_id?: string | null }, tz: string) {
  if (g.booking_id) { const b = await bookingInfo(db, g.booking_id); return { base: b.base, link: `/match/${b.id}` }; }
  const f = await fixtureInfo(db, g.fixture_id!, tz, true);
  return { base: { court: f?.court ?? "", location: "", when: f?.when ?? when(null, tz), code: "", minutes: 0, coach: "" }, link: "/competitions" };
}
async function entryInfo(db: Db, entryId: string) {
  const e = await db.selectFrom("pair_entry").innerJoin("program", "program.id", "pair_entry.program_id").innerJoin("person as a", "a.id", "pair_entry.person_a").innerJoin("person as b", "b.id", "pair_entry.person_b")
    .select(["pair_entry.person_a", "pair_entry.person_b", "program.name as program", "a.display_name as a", "b.display_name as b"]).where("pair_entry.id", "=", entryId).executeTakeFirstOrThrow();
  return e;
}
/** A match's program, court, time and the two pairs (null while it has no time, unless asked anyway). */
async function fixtureInfo(db: Db, fixtureId: string, tz: string, any = false) {
  const f = await db.selectFrom("fixture").innerJoin("program", "program.id", "fixture.program_id").leftJoin("court", "court.id", "fixture.court_id")
    .select(["fixture.program_id", "fixture.entry_a", "fixture.entry_b", "fixture.starts_at", "program.name as program", "court.name as court"]).where("fixture.id", "=", fixtureId).executeTakeFirst();
  if (!f || (!any && (!f.starts_at || !f.entry_a || !f.entry_b))) return null;
  const es = await db.selectFrom("pair_entry").innerJoin("person as a", "a.id", "pair_entry.person_a").innerJoin("person as b", "b.id", "pair_entry.person_b")
    .select(["pair_entry.id", "pair_entry.person_a", "pair_entry.person_b", "a.display_name as an", "b.display_name as bn"]).where("pair_entry.id", "in", [f.entry_a, f.entry_b].filter((x): x is string => Boolean(x))).execute();
  const ea = es.find((e) => e.id === f.entry_a), eb = es.find((e) => e.id === f.entry_b);
  const pair = (e?: (typeof es)[number]) => (e ? `${e.an} + ${e.bn}` : "?");
  const teams = [ea, eb].filter((e): e is (typeof es)[number] => Boolean(e)).map((e) => [e.person_a, e.person_b]);
  /** The other pair, as one of the players may read it (a junior stays "Junior player": junior_names.ts). */
  const opponentsOf = async (reader: string, side: "a" | "b"): Promise<Text> => {
    const e = side === "a" ? eb : ea;
    if (!e) return { en: "?", es: "?" };
    const name = await namesFor(db, reader, teams.flat(), teams);
    return pairText(name(e.person_a), name(e.person_b));
  };
  return { program_id: f.program_id, program: f.program, court: f.court ?? "", starts_at: f.starts_at ?? undefined, when: when(f.starts_at, tz), a: pair(ea), b: pair(eb), opponentsOf,
    players: [...(ea ? [{ id: ea.person_a, side: "a" }, { id: ea.person_b, side: "a" }] : []), ...(eb ? [{ id: eb.person_a, side: "b" }, { id: eb.person_b, side: "b" }] : [])] as { id: string; side: "a" | "b" }[] };
}
async function bookingInfo(db: Db, bookingId: string) {
  const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
    .innerJoin("location", "location.id", "court.location_id").leftJoin("person as coach", "coach.id", "booking.coach_id")
    .select(["booking.id", "booking.code", "booking.kind", "booking.status", "booking.coach_id", "booking.organiser_id", "booking.pay_mode", "booking.balance_cents", "court.name as court", "location.name as location", "location.time_zone",
      "coach.display_name as coach", sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
    .where("booking.id", "=", bookingId).orderBy(sql`court_time.active`, "desc").orderBy("court_time.id", "desc").executeTakeFirstOrThrow();
  const players = await db.selectFrom("booking_player").leftJoin("person", "person.id", "booking_player.person_id").select(["booking_player.id", "booking_player.person_id", "person.display_name"])
    .where("booking_player.booking_id", "=", bookingId).where("booking_player.removed_at", "is", null).where("booking_player.replaces", "is", null).execute();
  const minutes = Math.round((new Date(b.end).getTime() - new Date(b.start).getTime()) / 60_000);
  return { ...b, minutes, players, base: { court: b.court, location: b.location, when: when(new Date(b.start), b.time_zone), code: b.code, minutes, coach: b.coach ?? "" } };
}
/** A weekly booking: its member, court, day and time, and how many weeks are booked. */
async function seriesInfo(db: Db, seriesId: string) {
  const s = await db.selectFrom("booking_series").innerJoin("court", "court.id", "booking_series.court_id").innerJoin("location", "location.id", "booking_series.location_id")
    .select(["booking_series.organiser_id", "booking_series.starts", "booking_series.minutes", "booking_series.first_date", "booking_series.last_date", "court.name as court", "location.time_zone"])
    .where("booking_series.id", "=", seriesId).executeTakeFirstOrThrow();
  const weeks = await db.selectFrom("booking_series_week").select(["on_date", "booking_id"]).where("series_id", "=", seriesId).where("booking_id", "is not", null).orderBy("on_date").execute();
  const start = onDate(s.first_date, s.starts.slice(0, 5), s.time_zone);
  const f = (o: Intl.DateTimeFormatOptions): Text => ({ en: new Intl.DateTimeFormat(formatLocale("en"), { timeZone: s.time_zone, ...o }).format(start), es: new Intl.DateTimeFormat(formatLocale("es"), { timeZone: s.time_zone, ...o }).format(start) });
  return { organiser_id: s.organiser_id, booked: weeks.length, firstText: dayText(weeks[0]?.on_date ?? s.first_date), lastText: dayText(weeks.at(-1)?.on_date ?? s.last_date),
    base: { court: s.court, weekday: f({ weekday: "long" }), time: f({ hour: "numeric", minute: "2-digit" }), minutes: s.minutes } };
}
/** What a change to a booking means for one player's money: more to pay at the desk (the organiser), or what goes back. */
function changeMoney(personId: string, organiserId: string | null, p: { owed: number; refunds: Record<string, number>; desk?: Record<string, number>; credit?: Record<string, number>; playtomic?: Record<string, number> }): Text {
  if (p.refunds[personId] || p.desk?.[personId] || p.credit?.[personId] || p.playtomic?.[personId])
    return backWords(p.refunds[personId] ?? 0, p.desk?.[personId] ?? 0, p.credit?.[personId] ?? 0, p.playtomic?.[personId] ?? 0);
  if (p.owed > 0 && personId === organiserId) return both("msg.change_owed", { amount: amount(p.owed) });
  return NOTHING;
}
/** A lesson's coach hears about it too, with who's coming. */
function toCoach(b: Awaited<ReturnType<typeof bookingInfo>>, kind: string, o: { essential?: boolean; staleAt?: Date } = {}): Draft[] {
  if (!b.coach_id) return [];
  const names = b.players.map((p) => p.display_name).filter(Boolean).join(", ");
  return [{ to: b.coach_id, kind, params: { ...b.base, players: names }, purpose: "staff", essential: o.essential ?? false, email: true, link: "/schedule", staleAt: o.staleAt }];
}

/** A membership and its plan. */
async function membershipInfo(db: Db, membershipId: string) {
  const m = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership.person_id", "membership.plan_id", "membership.current_period_end", "membership.source", "membership.price_cents", "membership.end_reason", "membership.balance_cents",
      "membership.family_size", "membership.extra_person_cents", "membership_plan.name", "membership_plan.translations", "membership_plan.days_ahead",
      "membership_plan.period", "membership_plan.program_percent_off", "membership_plan.program_cents_off", "membership_plan.included_sessions", "membership_plan.included_kinds"])
    .where("membership.id", "=", membershipId).executeTakeFirstOrThrow();
  // The plan's name in each reader's language, when the club wrote one.
  const { translations, ...rest } = m;
  return { ...rest, name: textOf(m.name, translations, "name") };
}

/** One player's seat in a booking: who they are, the booking, and its host's name. */
async function seatInfo(db: Db, bookingPlayerId: string) {
  const s = await db.selectFrom("booking_player").leftJoin("person", "person.id", "booking_player.person_id").select(["booking_player.booking_id", "booking_player.person_id", "booking_player.share_cents", "person.display_name"])
    .where("booking_player.id", "=", bookingPlayerId).executeTakeFirstOrThrow();
  const b = await bookingInfo(db, s.booking_id);
  const host = b.organiser_id ? (await db.selectFrom("person").select("display_name").where("id", "=", b.organiser_id).executeTakeFirst())?.display_name ?? "" : "";
  return { ...s, name: s.display_name ?? "", b, host };
}

/** What came back to a player who gave up a place: the amount, or that the club's rules give nothing more. */
const backLine = (cents: number): Text => cents > 0 ? both("msg.refund_card", { amount: amount(cents) }) : both("msg.refund_none_rule");
async function placeChanged(db: Db, p: { from_seat: string; to_seat: string; refunded: number }, kind: string): Promise<Draft[]> {
  const from = await seatInfo(db, p.from_seat), to = await seatInfo(db, p.to_seat);
  const drafts: Draft[] = from.person_id ? [{ to: from.person_id, kind, params: { ...from.b.base, person: to.name, refund: backLine(p.refunded) }, purpose: "account", essential: true, email: true, link: "/places" }] : [];
  for (const x of from.b.players) if (x.person_id && x.person_id !== to.person_id && x.person_id !== from.person_id)
    drafts.push({ to: x.person_id, kind: "match_place_changed", params: { ...from.b.base, person: from.name, sub: to.name }, purpose: "account", essential: false, email: false, link: `/match/${from.b.id}`, staleAt: new Date(from.b.start) });
  return drafts;
}

const composers: Record<string, (c: Ctx, p: any) => Promise<Draft[]>> = {
  async "booking.confirmed"({ db }, p: { booking_id: string }) {
    const b = await bookingInfo(db, p.booking_id), lesson = b.kind === "lesson";
    // Cancelled before this was written (in the same moment): the cancellation tells them.
    if (!b.organiser_id || b.status === "cancelled") return [];
    const kind = `${lesson ? "lesson" : "booking"}_confirmed${b.pay_mode === "split" ? "_split" : ""}`;
    return [{ to: b.organiser_id, kind, params: b.base, purpose: "account", essential: true, email: true, link: "/places" }, ...toCoach(b, "coach_lesson_booked")];
  },
  // Several courts paid together: one message for them all.
  async "booking.courts_confirmed"(c, p: { person_id: string; booking_ids: string[]; cents: number }) {
    const items: Text[] = [], left: string[] = [];
    // Those cancelled before this was written aren't listed (their cancellation tells them); none left, nothing to say;
    // one left, it's told as any one court booked is (never "Booked: 1 courts").
    for (const id of p.booking_ids) { const b = await bookingInfo(c.db, id); if (b.status !== "cancelled") { items.push(both("msg.booking_courts.item", b.base)); left.push(id); } }
    if (!items.length) return [];
    if (left.length === 1) return composers["booking.confirmed"]!(c, { booking_id: left[0] });
    const list = { en: items.map((x) => x.en).join("; "), es: items.map((x) => x.es).join("; ") };
    // What the courts listed came to (each court's part of the one card payment), not the whole payment: one cancelled
    // before this was written is told, with its refund, by its own cancellation.
    const cents = left.length === p.booking_ids.length ? p.cents : Number((await c.db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
      .select(sql<string>`coalesce(sum(payment.amount_cents), 0)`.as("c")).where("booking_player.booking_id", "in", left).where("payment.person_id", "=", p.person_id)
      .where("payment.status", "=", "succeeded").executeTakeFirstOrThrow()).c);
    return [{ to: p.person_id, kind: "booking_courts", params: { count: items.length, list, amount: amount(cents) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "booking.cancelled"({ db }, p: { booking_id: string; by?: string | null }) {
    // The weeks of a weekly booking called off together are told once, by booking.repeat_ended.
    if ((await db.selectFrom("booking").select("cancel_reason").where("id", "=", p.booking_id).executeTakeFirstOrThrow()).cancel_reason === "series_ended") return [];
    const b = await bookingInfo(db, p.booking_id), lesson = b.kind === "lesson";
    // Each player who paid hears what comes back to them; everyone in it hears it's off.
    const drafts: Draft[] = [];
    for (const pl of b.players) {
      if (!pl.person_id) continue;
      const back = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").select(["refund.destination", (eb) => eb.fn.sum<string>("refund.amount_cents").as("c")])
        .where("payment.booking_player_id", "=", pl.id).groupBy("refund.destination").execute();
      const cents = (where: string) => Number(back.find((x) => x.destination === where)?.c ?? 0);
      drafts.push({ to: pl.person_id, kind: lesson ? "lesson_cancelled" : "booking_cancelled", params: { ...b.base, refund: backWords(cents("card"), cents("desk"), cents("credit"), cents("playtomic")) }, purpose: "account", essential: true, email: true, link: "/places" });
    }
    // The coach, unless they called it off themselves.
    return [...drafts, ...(p.by && p.by === b.coach_id ? [] : toCoach(b, "coach_lesson_cancelled", { essential: true }))];
  },
  // Staff moved a booking or changed its length: everyone in it hears the new time, and what it means for money
  // (more to pay at the desk, for the organiser; what goes back, for each player it goes back to).
  // Called off since: the cancellation tells them, with the time it had last and all that comes back.
  async "booking.moved"({ db }, p: { booking_id: string; from: Text; to: Text; owed: number; refunds: Record<string, number>; desk?: Record<string, number>; credit?: Record<string, number>; playtomic?: Record<string, number> }) {
    const b = await bookingInfo(db, p.booking_id), lesson = b.kind === "lesson";
    if (b.status === "cancelled") return [];
    const drafts: Draft[] = b.players.filter((pl) => pl.person_id).map((pl) => ({ to: pl.person_id!, kind: lesson ? "lesson_moved" : "booking_moved",
      params: { ...b.base, from: p.from, to: p.to, money: changeMoney(pl.person_id!, b.organiser_id, p) }, purpose: "account" as const, essential: true, email: true, link: "/places" }));
    return [...drafts, ...toCoach(b, "coach_lesson_moved", { essential: true }).map((d) => ({ ...d, params: { ...d.params, from: p.from, to: p.to } }))];
  },
  async "booking.resized"({ db }, p: { booking_id: string; old: number; until: Text; owed: number; refunds: Record<string, number>; desk?: Record<string, number>; credit?: Record<string, number>; playtomic?: Record<string, number> }) {
    const b = await bookingInfo(db, p.booking_id), lesson = b.kind === "lesson";
    if (b.status === "cancelled") return [];
    const drafts: Draft[] = b.players.filter((pl) => pl.person_id).map((pl) => ({ to: pl.person_id!, kind: lesson ? "lesson_resized" : "booking_resized",
      params: { ...b.base, old: p.old, until: p.until, money: changeMoney(pl.person_id!, b.organiser_id, p) }, purpose: "account" as const, essential: true, email: true, link: "/places" }));
    return [...drafts, ...toCoach(b, "coach_lesson_resized", { essential: true }).map((d) => ({ ...d, params: { ...d.params, old: p.old, until: p.until } }))];
  },
  async "booking.lost"({ db }, p: { booking_id: string }) {
    const b = await bookingInfo(db, p.booking_id);
    const paid = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select((eb) => eb.fn.sum<string>("payment.amount_cents").as("c"))
      .where("booking_player.booking_id", "=", b.id).where("payment.status", "=", "succeeded").executeTakeFirst();
    // The first week of a weekly court: the weekly court is off too (booking_series.ts ends it).
    const weekly = Boolean((await db.selectFrom("booking").select("series_id").where("id", "=", p.booking_id).executeTakeFirstOrThrow()).series_id);
    return b.organiser_id ? [{ to: b.organiser_id, kind: weekly ? "booking_lost_weekly" : "booking_lost", params: { ...b.base, amount: amount(Number(paid?.c ?? 0)) }, purpose: "account", essential: true, email: true, link: "/book" }] : [];
  },
  async "booking.shares_charged"({ db }, p: { booking_id: string; cents: number }) {
    const b = await bookingInfo(db, p.booking_id);
    return b.organiser_id ? [{ to: b.organiser_id, kind: "booking_shares_charged", params: { ...b.base, amount: amount(p.cents) }, purpose: "account", essential: true, email: true, link: "/places" }] : [];
  },
  async "booking.balance_due"({ db }, p: { booking_id: string; cents: number; failure: string | null }) {
    const b = await bookingInfo(db, p.booking_id);
    const name = b.organiser_id ? (await db.selectFrom("person").select("display_name").where("id", "=", b.organiser_id).executeTakeFirst())?.display_name ?? "" : "";
    const params = { ...b.base, amount: amount(p.cents), reason: declineReason(p.failure), name };
    // A week of a weekly booking: its own words (it isn't unpaid places).
    const week = Boolean((await db.selectFrom("booking").select("series_id").where("id", "=", p.booking_id).executeTakeFirstOrThrow()).series_id);
    return [
      ...(b.organiser_id ? [{ to: b.organiser_id, kind: week ? "booking_week_due" : "booking_balance_due", params, purpose: "account" as const, essential: true, email: true, link: "/places" }] : []),
      ...(await managers(db)).map((to) => ({ to, kind: "booking_balance_due_staff", params, purpose: "staff" as const, essential: false, email: true, link: "/courts" })),
    ];
  },
  async "booking.week_charged"({ db }, p: { booking_id: string; cents: number }) {
    const b = await bookingInfo(db, p.booking_id);
    return b.organiser_id ? [{ to: b.organiser_id, kind: "booking_week_charged", params: { ...b.base, amount: amount(p.cents) }, purpose: "account", essential: true, email: true, link: "/places" }] : [];
  },
  // Weekly bookings (booking_series.ts): made by the desk, a week that couldn't be booked, the rest called off.
  async "booking.repeat_made"({ db }, p: { series_id: string }) {
    const s = await seriesInfo(db, p.series_id);
    return [{ to: s.organiser_id, kind: "booking_repeat_made", params: { ...s.base, count: s.booked, first: s.firstText, last: s.lastText }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  // Every week a run left out, and why, in one message.
  async "booking.repeat_missed"({ db }, p: { series_id: string; weeks: { date: string; why: string }[] }) {
    const s = await seriesInfo(db, p.series_id);
    const list = p.weeks.map((w) => both("msg.repeat_week_why", { date: dayText(w.date), why: both(`msg.repeat_why_${w.why}` as Key) }));
    const joined: Text = { en: list.map((x) => x.en).join("; "), es: list.map((x) => x.es).join("; ") };
    return [{ to: s.organiser_id, kind: "booking_repeat_missed", params: { ...s.base, count: p.weeks.length, list: joined }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "booking.repeat_stopped"({ db }, p: { series_id: string; why: string }) {
    const s = await seriesInfo(db, p.series_id);
    return [{ to: s.organiser_id, kind: "booking_repeat_stopped", params: { ...s.base, why: both(`msg.repeat_stopped_${p.why}` as Key) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  // The club stopped taking weekly bookings for now: no weeks are booked until it takes them again.
  async "booking.repeat_paused"({ db }, p: { series_id: string; why: string }) {
    const s = await seriesInfo(db, p.series_id);
    return [{ to: s.organiser_id, kind: "booking_repeat_paused", params: { ...s.base, why: both(`msg.repeat_paused_${p.why}` as Key) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "booking.repeat_resumed"({ db }, p: { series_id: string }) {
    const s = await seriesInfo(db, p.series_id);
    return [{ to: s.organiser_id, kind: "booking_repeat_resumed", params: s.base, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "booking.repeat_ended"({ db }, p: { series_id: string; from: string; by?: string | null }) {
    const s = await seriesInfo(db, p.series_id);
    // The member ending their own hears nothing more (they did it); otherwise they hear it, once, with what comes back.
    if (p.by && (await withManagers(db, [s.organiser_id])).includes(p.by)) return [];
    const back = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
      .innerJoin("booking", "booking.id", "booking_player.booking_id").select(["refund.destination", (eb) => eb.fn.sum<string>("refund.amount_cents").as("c")])
      .where("booking.series_id", "=", p.series_id).where("booking.cancel_reason", "=", "series_ended").groupBy("refund.destination").execute();
    const cents = (where: string) => Number(back.find((x) => x.destination === where)?.c ?? 0);
    return [{ to: s.organiser_id, kind: "booking_repeat_ended", params: { ...s.base, from: dayText(p.from), refund: backWords(cents("card"), cents("desk"), cents("credit"), cents("playtomic")) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  /** Every member's weekly courts stopped by the club at once (weekly.end_all): each member hears once, with what came back. */
  // A gift card ready to give (gift_cards.ts): the buyer hears where to find its code (in the app, never here).
  async "gift_card.ready"({ db }, p: { gift_card_id: string }) {
    const c = await db.selectFrom("gift_card").select(["buyer_id", "amount_cents", "for_name", "status"]).where("id", "=", p.gift_card_id).executeTakeFirst();
    if (!c || c.status !== "active") return [];
    return [{ to: c.buyer_id, kind: "gift_card_ready", params: { amount: amount(c.amount_cents), for: c.for_name ?? "" }, purpose: "account", essential: true, email: true, link: "/gift-cards" }];
  },
  async "weekly.ended_all"({ db }, p: { person_id: string; series_ids: string[]; booked: "keep" | "cancel"; from: string }) {
    if (p.booked === "keep") return [{ to: p.person_id, kind: "weekly_all_stopped", params: { count: p.series_ids.length }, purpose: "account", essential: true, email: true, link: "/places" }];
    const back = p.series_ids.length ? await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
      .innerJoin("booking", "booking.id", "booking_player.booking_id").select(["refund.destination", (eb) => eb.fn.sum<string>("refund.amount_cents").as("c")])
      .where("booking.series_id", "in", p.series_ids).where("booking.cancel_reason", "=", "series_ended").groupBy("refund.destination").execute() : [];
    const cents = (where: string) => Number(back.find((x) => x.destination === where)?.c ?? 0);
    return [{ to: p.person_id, kind: "weekly_all_ended", params: { count: p.series_ids.length, from: dayText(p.from), refund: backWords(cents("card"), cents("desk"), cents("credit"), cents("playtomic")) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "booking.asked"({ db }, p: { request_id: string }) {
    const r = await db.selectFrom("join_request").innerJoin("person", "person.id", "join_request.person_id").innerJoin("open_match", "open_match.booking_id", "join_request.booking_id")
      .select(["join_request.booking_id", "join_request.level", "person.display_name", "open_match.level_min", "open_match.level_max"]).where("join_request.id", "=", p.request_id).executeTakeFirstOrThrow();
    const b = await bookingInfo(db, r.booking_id);
    if (!b.organiser_id) return [];
    const level = r.level === null ? both("plan.booking.no_level") : Number(r.level).toFixed(2);
    return [{ to: b.organiser_id, kind: "match_ask", params: { ...b.base, person: r.display_name, level, band: band(r) }, purpose: "account", essential: false, email: true,
      link: `/match/${b.id}`, staleAt: new Date(b.start) }];
  },
  async "booking.ask_answered"({ db }, p: { request_id: string }) {
    const r = await db.selectFrom("join_request").select(["booking_id", "person_id", "status"]).where("id", "=", p.request_id).executeTakeFirstOrThrow();
    const b = await bookingInfo(db, r.booking_id);
    const host = b.organiser_id ? (await db.selectFrom("person").select("display_name").where("id", "=", b.organiser_id).executeTakeFirst())?.display_name ?? "" : "";
    const share = await db.selectFrom("booking_player").select("share_cents").where("booking_id", "=", b.id).where("person_id", "=", r.person_id).where("removed_at", "is", null).executeTakeFirst();
    return [{ to: r.person_id, kind: r.status === "approved" ? "match_ask_yes" : "match_ask_no", params: { ...b.base, host, share: amount(share?.share_cents ?? 0), hours: both("count.hours", { count: 1 }) },
      purpose: "account", essential: true, email: true, link: r.status === "approved" ? `/match/${b.id}` : "/play", staleAt: new Date(b.start) }];
  },
  async "booking.seat_released"({ db }, p: { booking_player_id: string }) {
    const bp = await db.selectFrom("booking_player").select(["booking_id", "person_id"]).where("id", "=", p.booking_player_id).executeTakeFirstOrThrow();
    if (!bp.person_id) return [];
    const b = await bookingInfo(db, bp.booking_id);
    return [{ to: bp.person_id, kind: "match_seat_released", params: b.base, purpose: "account", essential: false, email: false, link: `/match/${b.id}`, staleAt: new Date(b.start) }];
  },
  async "booking.player_paid"({ db }, p: { booking_id: string; booking_player_id: string; left: number }) {
    const b = await bookingInfo(db, p.booking_id);
    const who = await db.selectFrom("booking_player").innerJoin("person", "person.id", "booking_player.person_id").select("person.display_name").where("booking_player.id", "=", p.booking_player_id).executeTakeFirst();
    if (!b.organiser_id || !who) return [];
    return [{ to: b.organiser_id, kind: "match_player_in", params: { ...b.base, person: who.display_name, spots: p.left > 0 ? both("msg.match_spots", { count: p.left }) : both("msg.match_full") },
      purpose: "account", essential: false, email: false, link: `/match/${b.id}`, staleAt: new Date(b.start) }];
  },
  async "booking.place_saved"({ db }, p: { booking_player_id: string }) {
    const s = await seatInfo(db, p.booking_player_id);
    return s.person_id ? [{ to: s.person_id, kind: "match_place_saved", params: { ...s.b.base, host: s.host, share: amount(s.share_cents) }, purpose: "account", essential: false, email: true,
      link: `/match/${s.b.id}`, staleAt: new Date(s.b.start) }] : [];
  },
  async "booking.place_dropped"({ db }, p: { booking_player_id: string }) {
    const s = await seatInfo(db, p.booking_player_id);
    return s.person_id ? [{ to: s.person_id, kind: "match_place_dropped", params: { ...s.b.base, host: s.host }, purpose: "account", essential: false, email: false, link: "/play", staleAt: new Date(s.b.start) }] : [];
  },
  // Players named on a court booked in full (booking_players.ts): added by the booker, the player hears; joined by
  // the players link, the booker hears; taken off by the booker, the player hears.
  async "booking.player_added"({ db }, p: { booking_player_id: string; by: string | null }) {
    const s = await seatInfo(db, p.booking_player_id);
    if (!s.person_id) return [];
    if (p.by === s.person_id) return s.b.organiser_id ? [{ to: s.b.organiser_id, kind: "booking_player_joined", params: { ...s.b.base, person: s.name }, purpose: "account", essential: false, email: false,
      link: `/match/${s.b.id}` }] : [];
    return [{ to: s.person_id, kind: "booking_player_added", params: { ...s.b.base, booker: s.host }, purpose: "account", essential: false, email: true, link: `/match/${s.b.id}` }];
  },
  async "booking.player_removed"({ db }, p: { booking_player_id: string; by: string | null }) {
    const s = await seatInfo(db, p.booking_player_id);
    return s.person_id && p.by !== s.person_id ? [{ to: s.person_id, kind: "booking_player_removed", params: { ...s.b.base, booker: s.host }, purpose: "account", essential: false, email: false, link: "/places" }] : [];
  },
  async "booking.player_left"({ db }, p: { booking_player_id: string; paid: boolean; late?: boolean; refunded?: number }) {
    const s = await seatInfo(db, p.booking_player_id);
    // Paid and past the deadline, the place stays empty; otherwise it's open again (and a paid player is paid back).
    const drafts: Draft[] = s.b.organiser_id ? [{ to: s.b.organiser_id, kind: p.paid && p.late ? "match_player_leaving" : "match_player_left", params: { ...s.b.base, person: s.name },
      purpose: "account", essential: false, email: false, link: `/match/${s.b.id}`, staleAt: new Date(s.b.start) }] : [];
    if (s.person_id && p.refunded) drafts.push({ to: s.person_id, kind: "match_left_refund", params: { ...s.b.base, amount: amount(p.refunded) }, purpose: "account", essential: true, email: true, link: "/places" });
    // A paid place left empty after the deadline: the desk hears once, straight away (it may be hours away).
    if (p.paid && p.late) for (const to of await desk(db))
      drafts.push({ to, kind: "match_late_cancel_staff", params: { ...s.b.base, person: s.name }, purpose: "staff", essential: true, email: true, link: "/courts", staleAt: new Date(s.b.start) });
    return drafts;
  },
  async "booking.not_filled"({ db }, p: { booking_id: string; players: { person_id: string; cents: number }[] }) {
    const b = await bookingInfo(db, p.booking_id);
    return p.players.map((x) => ({ to: x.person_id, kind: "match_not_filled", params: { ...b.base, refund: x.cents ? both("msg.refund_card", { amount: amount(x.cents) }) : NOTHING },
      purpose: "account" as const, essential: true, email: true, link: "/play" }));
  },
  async "booking.place_taken"({ db }, p: { booking_player_id: string; by: string; refunded?: number }) {
    const s = await seatInfo(db, p.booking_player_id);
    const by = (await db.selectFrom("person").select("display_name").where("id", "=", p.by).executeTakeFirst())?.display_name ?? "";
    return s.person_id ? [{ to: s.person_id, kind: "match_place_taken", params: { ...s.b.base, person: by, refund: backLine(p.refunded ?? 0) }, purpose: "account", essential: true, email: true, link: "/places" }] : [];
  },
  async "booking.place_offered"({ db }, p: { offer_id: string }) {
    const o = await db.selectFrom("place_offer").select(["booking_player_id", "to_person_id", "code"]).where("id", "=", p.offer_id).executeTakeFirstOrThrow();
    if (!o.to_person_id) return [];
    const s = await seatInfo(db, o.booking_player_id);
    return [{ to: o.to_person_id, kind: "match_place_offered", params: { ...s.b.base, name: s.name, share: amount(s.share_cents) }, purpose: "account", essential: false, email: true,
      link: `/take/${o.code}`, staleAt: new Date(s.b.start) }];
  },
  // A sub paid and took over a place, or staff gave it to someone: its player hears what comes back, and the
  // rest of the match (host included) who's in now.
  async "booking.place_handed"({ db }, p: { from_seat: string; to_seat: string; refunded: number }) {
    return placeChanged(db, p, "match_place_handed");
  },
  async "booking.place_given"({ db }, p: { from_seat: string; to_seat: string; refunded: number }) {
    const drafts = await placeChanged(db, p, "match_place_taken");
    const to = await seatInfo(db, p.to_seat);
    if (to.person_id) drafts.push({ to: to.person_id, kind: "match_place_given", params: to.b.base, purpose: "account", essential: true, email: true, link: `/match/${to.b.id}` });
    return drafts;
  },
  // ---- Households: the other adults hear when a junior is added, and when a parent joins or leaves ----
  async "household.junior_added"({ db }, p: { junior_id: string; by: string; to: string[] }) {
    const names = await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", [p.junior_id, p.by]).execute();
    const name = (id: string) => names.find((x) => x.id === id)?.display_name ?? "";
    return p.to.map((to) => ({ to, kind: "household_junior_added", params: { name: name(p.junior_id), by: name(p.by) }, purpose: "account" as const, essential: false, email: true, link: "/family" }));
  },
  async "household.joined"({ db }, p: { person_id: string; to: string[] }) {
    const name = (await db.selectFrom("person").select("display_name").where("id", "=", p.person_id).executeTakeFirst())?.display_name ?? "";
    return p.to.map((to) => ({ to, kind: "household_joined", params: { name }, purpose: "account" as const, essential: false, email: true, link: "/family" }));
  },
  async "household.left"({ db }, p: { person_id: string; to: string[] }) {
    const name = (await db.selectFrom("person").select("display_name").where("id", "=", p.person_id).executeTakeFirst())?.display_name ?? "";
    return p.to.map((to) => ({ to, kind: "household_left", params: { name }, purpose: "account" as const, essential: false, email: true, link: "/family" }));
  },
  async "household.login_given"({ db }, p: { person_id: string }) {
    const r = await db.selectFrom("person").select(["email"]).where("id", "=", p.person_id).executeTakeFirst();
    const club = await db.selectFrom("club").select("name").executeTakeFirstOrThrow();
    return [{ to: p.person_id, kind: "household_login_given", params: { club: club.name, email: r?.email ?? "" }, purpose: "account", essential: true, email: true, link: "/" }];
  },
  // ---- Kids with a login of their own: what they ask for, and what goes on the family card ----
  async "kid.login_given"({ db }, p: { person_id: string; by: string | null; email: string }) {
    const by = p.by ? (await db.selectFrom("person").select("display_name").where("id", "=", p.by).executeTakeFirst())?.display_name ?? "" : "";
    const club = await db.selectFrom("club").select("name").executeTakeFirstOrThrow();
    return [{ to: p.person_id, kind: "kid_login", params: { by, club: club.name, email: p.email }, purpose: "account", essential: true, email: true, link: "/" }];
  },
  async "kid.asked"({ db }, p: { kid: string; to: string[]; what: Text; cents: number; why: Text }) {
    const name = (await db.selectFrom("person").select("display_name").where("id", "=", p.kid).executeTakeFirst())?.display_name ?? "";
    return p.to.map((to) => ({ to, kind: "kid_asked", params: { name, what: p.what, why: p.why }, purpose: "account" as const, essential: true, email: true, link: "/family" }));
  },
  async "kid.answered"({ db }, p: { kid: string; outcome: "declined" | "done" | "failed"; by: string | null; what: Text; error?: Text | null; to: string[] }) {
    const names = await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", [p.kid, ...(p.by ? [p.by] : [])]).execute();
    const name = (id: string | null) => names.find((x) => x.id === id)?.display_name ?? "";
    const params = { by: name(p.by), name: name(p.kid), what: p.what, error: p.error ?? NOTHING };
    const kind = { declined: "kid_declined", done: "kid_approved", failed: "kid_approval_failed" }[p.outcome];
    return [{ to: p.kid, kind, params, purpose: "account" as const, essential: p.outcome !== "declined", email: p.outcome !== "declined", link: "/family" },
      ...p.to.map((to) => ({ to, kind: "kid_approval_failed_parent", params, purpose: "account" as const, essential: true, email: true, link: "/family" }))];
  },
  async "family.charged"({ db }, p: { kid: string; to: string[]; cents: number; what: Text }) {
    const name = (await db.selectFrom("person").select("display_name").where("id", "=", p.kid).executeTakeFirst())?.display_name ?? "";
    return p.to.map((to) => ({ to, kind: "family_charged", params: { name, what: p.what, amount: amount(p.cents) }, purpose: "account" as const, essential: true, email: true, link: "/family" }));
  },
  async "family.refunded"({ db }, p: { kid: string; to: string[]; cents: number; what: Text }) {
    const name = (await db.selectFrom("person").select("display_name").where("id", "=", p.kid).executeTakeFirst())?.display_name ?? "";
    return p.to.map((to) => ({ to, kind: "family_refunded", params: { name, what: p.what, amount: amount(p.cents) }, purpose: "account" as const, essential: true, email: true, link: "/family" }));
  },
  async "kid.pay_needed"({ db }, p: { kid: string; to: string[]; cents: number; what: Text; why: string; failure: string | null }) {
    const name = (await db.selectFrom("person").select("display_name").where("id", "=", p.kid).executeTakeFirst())?.display_name ?? "";
    const why = both(`kid.pay_why.${p.why}` as Key, { reason: declineReason(p.failure) });
    return [...p.to.map((to) => ({ to, kind: "kid_pay_needed", params: { name, what: p.what, amount: amount(p.cents), why }, purpose: "account" as const, essential: true, email: true, link: "/family" })),
      { to: p.kid, kind: "kid_parent_pays", params: { what: p.what, amount: amount(p.cents) }, purpose: "account" as const, essential: false, email: false, link: "/places" }];
  },
  // ---- Family memberships: the person added or taken off hears it (a junior's parents already know) ----
  async "membership.person_added"({ db }, p: { membership_id: string; person_id: string }) {
    const r = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id").innerJoin("person as payer", "payer.id", "membership.person_id")
      .select(["membership_plan.name as plan", "membership_plan.translations", "payer.display_name as payer"]).where("membership.id", "=", p.membership_id).executeTakeFirstOrThrow();
    if ((await db.selectFrom("person").select("junior").where("id", "=", p.person_id).executeTakeFirst())?.junior) return [];
    return [{ to: p.person_id, kind: "membership_person_added", params: { plan: textOf(r.plan, r.translations, "name"), payer: r.payer }, purpose: "account", essential: false, email: true, link: "/membership" }];
  },
  async "membership.person_removed"({ db, tz }, p: { membership_id: string; person_id: string; until: string }) {
    const r = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id").innerJoin("person as payer", "payer.id", "membership.person_id")
      .select(["membership_plan.name as plan", "membership_plan.translations", "payer.display_name as payer", "membership.source"]).where("membership.id", "=", p.membership_id).executeTakeFirstOrThrow();
    if ((await db.selectFrom("person").select("junior").where("id", "=", p.person_id).executeTakeFirst())?.junior) return [];
    return [{ to: p.person_id, kind: "membership_person_removed", params: { plan: textOf(r.plan, r.translations, "name"), payer: r.payer, date: dayText(endDay({ current_period_end: new Date(p.until), source: r.source }, tz)) },
      purpose: "account", essential: false, email: true, link: "/membership" }];
  },
  async "friend.added"({ db }, p: { person_id: string; friend_id: string; mutual: boolean }) {
    const name = (await db.selectFrom("person").select("display_name").where("id", "=", p.person_id).executeTakeFirst())?.display_name ?? "";
    return [{ to: p.friend_id, kind: p.mutual ? "friend_added_back" : "friend_added", params: { name }, purpose: "account", essential: false, email: true, link: "/friends" }];
  },
  async "booking.running_late"({ db }, p: { booking_id: string; person_id: string; minutes: number }) {
    const b = await bookingInfo(db, p.booking_id);
    const name = (await db.selectFrom("person").select("display_name").where("id", "=", p.person_id).executeTakeFirst())?.display_name ?? "";
    return b.players.filter((x) => x.person_id && x.person_id !== p.person_id).map((x) => ({ to: x.person_id!, kind: "match_running_late", params: { ...b.base, person: name, minutes: p.minutes },
      purpose: "account" as const, essential: true, email: false, staleAt: new Date(new Date(b.start).getTime() + 60 * 60_000) }));
  },
  async "booking.no_show"({ db }, p: { booking_player_id: string }) {
    const s = await seatInfo(db, p.booking_player_id);
    return s.person_id ? [{ to: s.person_id, kind: "match_no_show", params: { ...s.b.base, host: s.host }, purpose: "account", essential: false, email: true, link: "/places" }] : [];
  },
  async "result.entered"({ db, tz }, p: { game_id: string }) {
    const g = await gameView(db, p.game_id), b = await gameWhere(db, g, tz);
    const out: Draft[] = [];
    for (const x of g.b) {
      const seen = await teamsFor(db, g, x.person_id);   // a junior stays "Junior player" to the other pair
      out.push({ to: x.person_id, kind: "result_to_confirm", params: { ...b.base, person: seen.name(g.entered_by), teamA: seen.teamA, teamB: seen.teamB, score: g.score, date: when(g.confirm_by, tz) },
        purpose: "account" as const, essential: false, email: true, link: b.link, staleAt: g.confirm_by });
    }
    return out;
  },
  async "result.confirmed"({ db, tz }, p: { game_id: string }) {
    const g = await gameView(db, p.game_id), b = await gameWhere(db, g, tz);
    const out: Draft[] = [];
    for (const x of [...g.a, ...g.b]) {
      const seen = await teamsFor(db, g, x.person_id);
      out.push({ to: x.person_id, kind: g.rated ? "result_confirmed" : "result_confirmed_friendly", params: { ...b.base, teamA: seen.teamA, teamB: seen.teamB, score: g.score },
        purpose: "account" as const, essential: false, email: false, link: g.rated ? "/level" : b.link });
    }
    return out;
  },
  async "result.disputed"({ db, tz }, p: { game_id: string; person_id: string; note: string }) {
    const g = await gameView(db, p.game_id), b = await gameWhere(db, g, tz);
    const by = [...g.a, ...g.b].find((x) => x.person_id === p.person_id)?.display_name ?? "";
    const params = { ...b.base, person: by, teamA: g.teamA, teamB: g.teamB, score: g.score, note: p.note };
    const out: Draft[] = (await managers(db)).map((to) => ({ to, kind: "result_disputed_staff", params, purpose: "staff" as const, essential: false, email: true, link: "/scores" }));
    for (const x of [...g.a, ...g.b].filter((x) => x.person_id !== p.person_id)) {
      const seen = await teamsFor(db, g, x.person_id);
      out.push({ to: x.person_id, kind: "result_disputed", params: { ...params, person: seen.name(p.person_id), teamA: seen.teamA, teamB: seen.teamB }, purpose: "account" as const, essential: false, email: false, link: b.link });
    }
    return out;
  },
  // Tournaments and leagues (competitions.ts).
  async "entry.invited"({ db }, p: { entry_id: string }) {
    const e = await entryInfo(db, p.entry_id);
    return [{ to: e.person_b, kind: "entry_invited", params: { person: e.a, program: e.program }, purpose: "account", essential: false, email: true, link: "/competitions" }];
  },
  async "entry.accepted"({ db }, p: { entry_id: string; by_staff?: boolean }) {
    const e = await entryInfo(db, p.entry_id);
    if (p.by_staff) return [e.person_a, e.person_b].map((to) => ({ to, kind: "entry_paired", params: { partner: to === e.person_a ? e.b : e.a, program: e.program }, purpose: "account" as const, essential: false, email: true, link: "/competitions" }));
    return [{ to: e.person_a, kind: "entry_accepted", params: { person: e.b, program: e.program }, purpose: "account", essential: false, email: true, link: "/competitions" }];
  },
  async "entry.declined"({ db }, p: { entry_id: string }) {
    const e = await entryInfo(db, p.entry_id);
    return [{ to: e.person_a, kind: "entry_declined", params: { person: e.b, program: e.program }, purpose: "account", essential: false, email: true, link: "/competitions" }];
  },
  async "entry.closed"({ db }, p: { entry_id: string }) {
    // An invitation still open when the draw was made: both players hear it's closed.
    const e = await entryInfo(db, p.entry_id);
    return [e.person_a, e.person_b].map((to) => ({ to, kind: "entry_closed", params: { program: e.program }, purpose: "account" as const, essential: false, email: true, link: "/competitions" }));
  },
  async "fixture.reopened"({ db }, p: { fixture_id: string; people: string[]; note: string | null }) {
    const prog = await db.selectFrom("fixture").innerJoin("program", "program.id", "fixture.program_id").select("program.name").where("fixture.id", "=", p.fixture_id).executeTakeFirstOrThrow();
    const note = p.note ? both("msg.fixture_reopened_note", { note: p.note }) : NOTHING;
    return p.people.map((to) => ({ to, kind: "fixture_reopened", params: { program: prog.name, note }, purpose: "account" as const, essential: false, email: true, link: "/competitions" }));
  },
  async "competition.drawn"({ db }, p: { program_id: string }) {
    const prog = await db.selectFrom("program").select("name").where("id", "=", p.program_id).executeTakeFirstOrThrow();
    const es = await db.selectFrom("pair_entry").select(["person_a", "person_b"]).where("program_id", "=", p.program_id).where("status", "=", "entered").execute();
    return es.flatMap((e) => [e.person_a, e.person_b]).map((to) => ({ to, kind: "competition_drawn", params: { program: prog.name }, purpose: "account" as const, essential: false, email: true, link: "/competitions" }));
  },
  async "fixture.placed"({ db, tz }, p: { fixture_id: string; moved?: boolean }) {
    const f = await fixtureInfo(db, p.fixture_id, tz);
    if (!f) return [];
    const out: Draft[] = [];
    for (const x of f.players) out.push({ to: x.id, kind: p.moved ? "fixture_moved" : "fixture_placed", params: { program: f.program, court: f.court, when: f.when, opponents: await f.opponentsOf(x.id, x.side) },
      purpose: "account" as const, essential: true, email: true, link: "/competitions", staleAt: f.starts_at });
    return out;
  },
  async "fixture.move_asked"({ db, tz }, p: { fixture_id: string; person_id: string; note: string }) {
    const f = await fixtureInfo(db, p.fixture_id, tz, true);
    if (!f) return [];
    const person = (await db.selectFrom("person").select("display_name").where("id", "=", p.person_id).executeTakeFirst())?.display_name ?? "";
    return (await desk(db)).map((to) => ({ to, kind: "fixture_move_asked_staff", params: { person, program: f.program, a: f.a, b: f.b, when: f.when, note: p.note }, purpose: "staff" as const, essential: false, email: true, link: `/programs/${f.program_id}` }));
  },
  async "level.review_requested"({ db }, p: { person_id: string; level: string | null; note: string | null }) {
    const person = (await db.selectFrom("person").select("display_name").where("id", "=", p.person_id).executeTakeFirstOrThrow()).display_name;
    const params = { person, level: p.level ?? both("plan.level.no_level"), note: p.note ? both("msg.level_review_note", { note: p.note }) : NOTHING };
    return (await desk(db)).map((to) => ({ to, kind: "level_review_requested_staff", params, purpose: "staff" as const, essential: false, email: false, link: "/levels" }));
  },
  async "level.import_claimed"({ db }, p: { person_id: string; platform: string; shown: Text; start_level: number | null; sent_by?: string }) {
    const person = (await db.selectFrom("person").select("display_name").where("id", "=", p.person_id).executeTakeFirstOrThrow()).display_name;
    // Sent by a parent for their junior: staff hear whose word it is.
    const by = p.sent_by ? await nameOf(db, p.sent_by) : null;
    const params = { person, source: both(`level_source.${p.platform}` as Key), shown: p.shown, ...(by ? { by } : {}) };
    return (await desk(db)).map((to) => ({ to, kind: by ? "level_import_claimed_staff_by" : "level_import_claimed_staff", params, purpose: "staff" as const, essential: false, email: false, link: "/levels" }));
  },
  async "level.reviewed"(_c, p: { person_id: string; asked: boolean; outcome: "keep" | "change" | "accept"; before: string | null; after: string | null; reason: string | null; platform?: string; sent_by?: string }) {
    // A big move staff checked and kept: the player never asked, so there's nothing to tell them.
    if (!p.asked && p.outcome === "keep") return [];
    const note = p.reason ? both("msg.level_review_note", { note: p.reason }) : NOTHING;
    // The parent who sent a junior's level hears the answer, as the preview said, even if the junior has a login.
    const parents = p.sent_by ? [p.sent_by] : undefined;
    // A level they brought from another app: started there, or not used.
    if (p.platform && p.outcome !== "change") return [{ to: p.person_id, kind: p.outcome === "accept" ? "level_import_accepted" : "level_import_kept", purpose: "account" as const, essential: false, email: true, link: "/level",
      params: { source: both(`level_source.${p.platform}` as Key), level: p.after ?? both("plan.level.no_level"), note }, parents }];
    return [{ to: p.person_id, kind: p.outcome === "keep" ? "level_review_kept" : "level_review_changed", purpose: "account" as const, essential: false, email: true, link: "/level",
      params: { before: p.before ?? both("plan.level.no_level"), after: p.after ?? both("plan.level.no_level"), level: p.after ?? both("plan.level.no_level"), note }, parents }];
  },
  // ---- Asking the club ----
  async "question.answered"(_c, p: { question_id: string; to: string; by: string; question: string; answer: string }) {
    return [{ to: p.to, kind: "question_answered", params: { by: p.by, question: p.question, answer: p.answer }, purpose: "account" as const, essential: false, email: true, link: `/ask/${p.question_id}` }];
  },
  async "question.club_answered"(_c, p: { question_id: string; to: string; question: string; fact: Text; answer: Text }) {
    // Mostly seen in the app at once: the email waits a few minutes, and goes only if it wasn't.
    return [{ to: p.to, kind: "question_club_answered", params: { question: p.question, fact: p.fact, answer: p.answer }, purpose: "account" as const, essential: false, email: true,
      link: `/ask/${p.question_id}`, emailUnlessRead: ANSWER_EMAIL_MINUTES }];
  },
  // A player reported a message in a chat (chat.ts), the first report of it: front desk and up hear once. The
  // message's words stay in the chat (the staff read them there), not in the alert.
  async "chat.reported"({ db, tz }, p: { thread_id: string; kind: "booking" | "session"; ref_id: string; author: string }) {
    const g = await gameOf(db, p.kind, p.ref_id);
    const params = { author: p.author || both("ui.chat_a_player"), game: g ? { en: `${g.title}, ${dateTime(g.starts_at, "en", tz)}`, es: `${g.title}, ${dateTime(g.starts_at, "es", tz)}` } : NOTHING };
    return (await desk(db)).map((to) => ({ to, kind: "chat_reported_staff", params, purpose: "staff" as const, essential: false, email: true, link: `/chats/${p.thread_id}` }));
  },
  async "question.unanswered"({ db, tz }, p: { question_id: string; person: string; asked_at: string; hours: number; question: string; assigned_to: string | null }) {
    const params = { person: p.person, when: when(new Date(p.asked_at), tz), question: p.question, hours: both("count.hours", { count: p.hours }) };
    return (await desk(db)).map((to) => ({ to, kind: "question_unanswered_staff", params, purpose: "staff" as const, essential: false, email: true, link: `/questions/${p.question_id}` }));
  },
  // The server's own jobs: the owner and managers hear once when the backup, its offsite copy or the restore test starts failing.
  async "ops.failed"({ db }, p: { job: OpsJob; error: string; words?: Text }) {
    // What a restore left to look at isn't a failure: said as what to do, opening where it's done (Reports for money).
    if (isRestoreJob(p.job)) return (await managers(db)).map((to) => ({ to, kind: "ops_restore_staff", params: { what: both(`ops.restore_about_${p.job}` as Key), error: p.words ?? p.error },
      purpose: "staff" as const, essential: true, email: true, link: p.job === "restore_erase" ? "/" : "/reports" }));
    const params = { job: both(`ops.job_${p.job}`), error: p.words ?? p.error };
    return (await managers(db)).map((to) => ({ to, kind: "ops_failed_staff", params, purpose: "staff" as const, essential: true, email: true, link: "/" }));
  },
  // ...and once more when it works again.
  async "ops.cleared"({ db }, p: { job: OpsJob }) {
    // A restore's alert that needs nobody now (Payments has nothing left) just closes: nothing "works again".
    if (isRestoreJob(p.job)) return [];
    return (await managers(db)).map((to) => ({ to, kind: "ops_cleared_staff", params: { job: both(`ops.job_${p.job}`) }, purpose: "staff" as const, essential: true, email: true, link: "/" }));
  },
  // The club's monthly meter (usage.ts): 80% of the cap, the cap, and past what's allowed over it. Each said once
  // per cap. "Reached" with nothing allowed over, and "paused", stay on Today until the cap is raised or seen to.
  async "usage.cap"({ db, tz }, p: { level: "near" | "reached" | "over" | "paused"; spent_cents: number; cap_cents: number; over_cents: number; month: string }) {
    const resets = nextMonthStart(p.month, tz);
    // The meter is in US dollars, as the services bill them, whatever the club's currency.
    const $ = (c: number): Text => ({ en: money(c, "en", "USD"), es: money(c, "es", "USD") });
    const params = { spent: $(p.spent_cents), cap: $(p.cap_cents), over: $(p.over_cents), limit: $(p.cap_cents + p.over_cents), resets: dayText(localDate(resets, tz)) };
    return (await managers(db)).map((to) => ({ to, kind: `usage_${p.level}_staff`, params, purpose: "staff" as const, essential: true, email: true, link: "/usage", staleAt: resets }));
  },
  // The day the club's Kumi ends (leaving.ts): the owner hears at once, a week before and a day before, to download
  // everything before then. Said whatever the club's state (read-only, past its cap), and at once: these are staff's.
  // Each only while that's still the day: not once it's moved or taken away (or this server is another one, an
  // export put in here with the old server's news still waiting).
  async "club.leaving_set"({ db, tz }, p: { on: string; kept_days: number | null; tell?: boolean }) {
    const c = await db.selectFrom("club").select(["name", "leaving_on", "leaving_email_domain", "leaving_email_domain_host"]).executeTakeFirstOrThrow();
    if (p.tell === false || c.leaving_on !== p.on) return [];
    const club = c.name;
    const params = { club, date: dayText(p.on), kept: keptText(p.on, p.kept_days, c) };
    return (await owners(db)).map((to) => ({ to, kind: "club_leaving_staff", params, purpose: "staff" as const, essential: true, email: true, link: "/settings#download-everything",
      staleAt: onDate(p.on, "24:00", tz) }));
  },
  async "club.leaving_reminder"({ db, tz }, p: { on: string; kind: "week" | "day"; kept_days: number | null }) {
    const c = await db.selectFrom("club").select(["name", "leaving_on", "leaving_email_domain", "leaving_email_domain_host"]).executeTakeFirstOrThrow();
    if (c.leaving_on !== p.on) return [];
    const club = c.name, last = await lastClubExport(db);
    const done = last ? both("msg.leaving_done", { when: when(last.at, tz), by: last.by }) : both("msg.leaving_not_done");
    const params = { club, date: dayText(p.on), kept: keptText(p.on, p.kept_days, c), done };
    return (await owners(db)).map((to) => ({ to, kind: `club_leaving_${p.kind}_staff`, params, purpose: "staff" as const, essential: true, email: true, link: "/settings#download-everything",
      staleAt: onDate(p.on, "24:00", tz) }));
  },
  async "club.leaving_off"({ db }, p: { was: string | null; tell?: boolean }) {
    if (p.tell === false || !p.was) return [];
    const club = (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;
    return (await owners(db)).map((to) => ({ to, kind: "club_leaving_off_staff", params: { club, date: dayText(p.was!) }, purpose: "staff" as const, essential: true, email: true, link: "/" }));
  },
  async "question.assigned"(_c, p: { question_id: string; to: string; by: string; person: string; question: string }) {
    return [{ to: p.to, kind: "question_assigned_staff", params: { by: p.by, person: p.person, question: p.question }, purpose: "staff" as const, essential: false, email: false, link: `/questions/${p.question_id}` }];
  },
  async "attendance.no_show"(_c, p: { people: string[]; what: Text; when: Text; by: string }) {
    return p.people.map((to) => ({ to, kind: "attendance_no_show", params: { what: p.what, when: p.when, by: p.by }, purpose: "account" as const, essential: false, email: true, link: "/places" }));
  },
  async "level.session_set"({ tz }, p: { program: string; starts_at: string; by: string; reason: string; changes: { person_id: string; before: string | null; after: string }[] }) {
    return p.changes.map((c) => ({ to: c.person_id, kind: c.before === null ? "level_set_session_first" : "level_set_session", purpose: "account" as const, essential: false, email: true, link: "/level",
      params: { program: p.program, when: when(new Date(p.starts_at), tz), by: p.by, reason: p.reason, before: c.before ?? both("plan.level.no_level"), after: c.after } }));
  },
  async "result.resolved"({ db, tz }, p: { game_id: string; outcome: "keep" | "correct" | "set_aside" }) {
    // A tournament or league match has no booking: where and when come from its fixture (gameWhere). Set aside,
    // its match is open again, and the players enter the score again.
    const g = await gameView(db, p.game_id), b = await gameWhere(db, g, tz);
    const kind = p.outcome === "keep" ? "result_kept" : p.outcome === "correct" ? "result_corrected" : g.fixture_id ? "fixture_result_set_aside" : "result_set_aside";
    const out: Draft[] = [];
    for (const x of [...g.a, ...g.b]) {
      const seen = await teamsFor(db, g, x.person_id);
      out.push({ to: x.person_id, kind, params: { ...b.base, teamA: seen.teamA, teamB: seen.teamB, score: g.score }, purpose: "account" as const, essential: false, email: true, link: b.link });
    }
    return out;
  },
  async "booking.reminder"({ db }, p: { booking_id: string }) {
    const b = await bookingInfo(db, p.booking_id);
    return [...b.players.filter((pl) => pl.person_id).map((pl) => ({ to: pl.person_id!, kind: b.kind === "lesson" ? "lesson_reminder" : "booking_reminder", params: b.base, purpose: "account" as const, essential: false, email: true, link: "/places", staleAt: new Date(b.start) })),
      ...toCoach(b, "coach_lesson_reminder", { staleAt: new Date(b.start) })];
  },
  async "membership.started"({ db, tz }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    const prices = await db.selectFrom("price_rule").select("id").where("active", "=", true).where(sql<boolean>`${m.plan_id} = ANY(plan_ids)`).executeTakeFirst();
    const app = m.source === "app" && m.current_period_end;
    const more = [prices ? both("msg.membership_perk_prices") : null, m.days_ahead ? both("msg.membership_perk_window", { count: m.days_ahead }) : null,
      m.program_percent_off ? both("msg.membership_perk_program_percent", { percent: m.program_percent_off }) : m.program_cents_off ? both("msg.membership_perk_program_cents", { amount: amount(m.program_cents_off) }) : null,
      m.included_sessions ? both("msg.membership_perk_included", { count: m.included_sessions, period: both(`ui.period_${m.period}`), kinds: kindList(m.included_kinds) }) : null,
      app ? both("msg.membership_renews", { date: dayText(endDay({ current_period_end: m.current_period_end!, source: m.source }, tz)), amount: amount(m.price_cents ?? 0) }) : null].filter((x): x is Text => Boolean(x));
    const until = m.current_period_end && !app ? both("msg.membership_until", { date: dayText(endDay({ current_period_end: m.current_period_end, source: m.source }, tz)) }) : NOTHING;
    // Sold at the desk with part still to pay there.
    if (m.balance_cents > 0) more.push(both("msg.membership_owed", { amount: amount(m.balance_cents) }));
    return [{ to: m.person_id, kind: "membership_started", params: { name: m.name, until, perks: { en: more.map((x) => x.en.trim()).join(" "), es: more.map((x) => x.es.trim()).join(" ") } },
      purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  // A renewal paid after it failed (`late`): the owner and managers, told of the failure, hear it's sorted.
  async "membership.renewed"({ db, tz }, p: { membership_id: string; payment_id: string; late?: boolean }) {
    const m = await membershipInfo(db, p.membership_id);
    const pay = await db.selectFrom("payment").select("amount_cents").where("id", "=", p.payment_id).executeTakeFirstOrThrow();
    // A membership from the desk doesn't renew: it's paid until its new end, and what's still owed there is said.
    const desk = m.source !== "app";
    const drafts: Draft[] = [{ to: m.person_id, kind: desk ? "membership_paid_until" : "membership_renewed", params: { name: m.name, amount: amount(pay.amount_cents), date: dayText(endDay({ current_period_end: m.current_period_end!, source: m.source }, tz)),
      owed: m.balance_cents > 0 ? both("msg.membership_owed", { amount: amount(m.balance_cents) }) : NOTHING }, purpose: "account", essential: true, email: true, link: "/membership" }];
    if (p.late) {
      const params = { person: await nameOf(db, m.person_id), name: m.name, amount: amount(pay.amount_cents) };
      for (const to of await managers(db)) drafts.push({ to, kind: "membership_renewal_paid_staff", params, purpose: "staff", essential: false, email: true, link: `/people/${m.person_id}` });
    }
    return drafts;
  },
  // A card payment for a period already paid another way (at the desk, or by the saved card's retry) while its form
  // was open: what went back to the card, and what it paid of what was still owed at the desk.
  async "membership.paid_twice"({ db, tz }, p: { membership_id: string; payment_id: string; kept: number; back: number }) {
    const m = await membershipInfo(db, p.membership_id);
    const date = dayText(endDay({ current_period_end: m.current_period_end!, source: m.source }, tz));
    const owed = m.balance_cents > 0 ? both("msg.membership_owed", { amount: amount(m.balance_cents) }) : NOTHING;
    // All of it paid what was owed at the desk: nothing went back, so it's a payment like any other.
    if (p.back <= 0) return [{ to: m.person_id, kind: "membership_paid_until", params: { name: m.name, amount: amount(p.kept), date, owed }, purpose: "account", essential: true, email: true, link: "/membership" }];
    return [{ to: m.person_id, kind: "membership_paid_twice", params: { name: m.name, amount: amount(p.kept + p.back), back: amount(p.back), date, owed,
      kept: p.kept > 0 ? both("msg.membership_paid_twice_kept", { amount: amount(p.kept) }) : NOTHING }, purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  // Twilio decided the club's texting registration (texting_registration.ts): the owner and managers hear once.
  async "texting.reviewed"({ db }, p: { status: "approved" | "rejected"; number: string; reasons: { reason: string; code: number | null }[] }) {
    const reasons = p.reasons.map((r) => (r.code ? `${r.reason} (${r.code})` : r.reason)).join("; ");
    const kind = p.status === "approved" ? "texting_approved_staff" : "texting_rejected_staff";
    return (await managers(db)).map((to) => ({ to, kind, params: { number: p.number, reasons }, purpose: "staff" as const, essential: false, email: true, link: "/settings" }));
  },
  // The owner and managers hear of the first failed try only, not every try after it (money that went wrong).
  async "membership.payment_failed"({ db, tz }, p: { membership_id: string; cents: number; next_attempt_at: string; tries?: number; failure?: string | null; first?: boolean }) {
    const m = await membershipInfo(db, p.membership_id), next = new Date(p.next_attempt_at);
    const drafts: Draft[] = [{ to: m.person_id, kind: "membership_payment_failed", params: { name: m.name, amount: amount(p.cents), date: dayText(localDate(next, tz)) },
      purpose: "account", essential: true, email: true, link: "/membership" }];
    if ((p.tries ?? 1) === 1) {
      // A membership joined before its plan started: its first payment, not a renewal.
      const which = p.first ? "first" : "renewal";
      const params = { person: await nameOf(db, m.person_id), name: m.name, amount: amount(p.cents), reason: declineReason(p.failure),
        what: both(`membership.failed_what_${which}`), couldnt: both(`membership.failed_couldnt_${which}`),
        retry: dayText(localDate(next, tz)), last: dayText(localDate(lastTryAt(next, p.tries ?? 1), tz)) };
      for (const to of await managers(db)) drafts.push({ to, kind: "membership_payment_failed_staff", params, purpose: "staff", essential: false, email: true, link: `/people/${m.person_id}` });
    }
    return drafts;
  },
  // A membership paid at the desk ends within a week (memberships.ts): what the next period costs, and where to pay it.
  async "membership.ending"({ db, tz }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    if (!m.current_period_end) return [];
    const plan = await db.selectFrom("membership_plan").select(["price_cents", "join_in_app"]).where("id", "=", m.plan_id).executeTakeFirstOrThrow();
    const next = await periodCents(db, { id: p.membership_id, price_cents: m.price_cents, family_size: m.family_size, extra_person_cents: m.extra_person_cents }, plan.price_cents, m.current_period_end);
    return [{ to: m.person_id, kind: "membership_ending", params: { name: m.name, date: dayText(endDay({ current_period_end: m.current_period_end, source: m.source }, tz)), amount: amount(next),
      app: plan.join_in_app ? both("msg.membership_ending_app") : NOTHING, owed: m.balance_cents > 0 ? both("msg.membership_owed", { amount: amount(m.balance_cents) }) : NOTHING },
      purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  // Carried over from Playtomic (brought_in.ts) and renewing here: within a week of the day, add a card to keep it.
  async "membership.brought_ending"({ db, tz }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    if (!m.current_period_end) return [];
    // The last day paid, as Playtomic gave it (it renews, or ends, as that day is over).
    return [{ to: m.person_id, kind: "membership_brought_ending", params: { name: m.name, date: dayText(endDay({ current_period_end: m.current_period_end, source: "desk" }, tz)),
      price: planPrice(m.price_cents ?? 0, m.period) }, purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "membership.brought_card"({ db, tz }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    if (!m.current_period_end) return [];
    return [{ to: m.person_id, kind: "membership_brought_card", params: { name: m.name, date: dayText(endDay({ current_period_end: m.current_period_end, source: m.source }, tz)),
      price: planPrice(m.price_cents ?? 0, m.period) }, purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "membership.brought_ended"({ db, tz }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    if (!m.current_period_end) return [];
    return [{ to: m.person_id, kind: "membership_brought_ended", params: { name: m.name, date: dayText(endDay({ current_period_end: m.current_period_end, source: "desk" }, tz)) },
      purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  // Club credit came over from Playtomic's wallets: the owner and managers zero those wallets in the same hour (Today).
  async "credit.brought_in"({ db }, p: { people: number; cents: number }) {
    return (await managers(db)).map((to) => ({ to, kind: "playtomic_wallets_staff", params: { people: both("count.people", { count: p.people }), amount: amount(p.cents) },
      purpose: "staff" as const, essential: false, email: true, link: "/playtomic/move-in" }));
  },
  async "membership.cancelled"({ db, tz }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    return [{ to: m.person_id, kind: "membership_cancelled", params: { name: m.name, date: dayText(endDay({ current_period_end: m.current_period_end!, source: m.source }, tz)) },
      purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "membership.resumed"({ db, tz }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    return [{ to: m.person_id, kind: "membership_resumed", params: { name: m.name, amount: amount(m.price_cents ?? 0), date: dayText(endDay({ current_period_end: m.current_period_end!, source: m.source }, tz)) },
      purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "membership.reserved"({ db, tz }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    return [{ to: m.person_id, kind: "membership_reserved", params: { name: m.name, amount: amount(m.price_cents ?? 0), date: dayText(localDate(m.current_period_end!, tz)) },
      purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "membership.released"({ db }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    return [{ to: m.person_id, kind: "membership_released", params: { name: m.name }, purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "membership.paused"({ db, tz }, p: { membership_id: string; until: string; renews: string | null }) {
    const m = await membershipInfo(db, p.membership_id);
    const back = dayText(localDate(new Date(new Date(p.until).getTime() - 1), tz));
    const renews = m.source === "app" && p.renews ? both("msg.membership_renews_on", { date: dayText(endDay({ current_period_end: new Date(p.renews), source: m.source }, tz)) }) : NOTHING;
    return [{ to: m.person_id, kind: "membership_paused", params: { name: m.name, date: back, renews }, purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "membership.unpaused"({ db }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    return [{ to: m.person_id, kind: "membership_unpaused", params: { name: m.name }, purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "membership.ended"({ db }, p: { membership_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    const drafts: Draft[] = [{ to: m.person_id, kind: m.end_reason === "not_paid" ? "membership_ended_unpaid" : "membership_ended", params: { name: m.name }, purpose: "account", essential: true, email: true, link: "/membership" }];
    // Its renewal was never paid: the owner and managers hear it's over (the failure alert closes; this one takes its place).
    if (m.end_reason === "not_paid") {
      const params = { person: await nameOf(db, m.person_id), name: m.name };
      for (const to of await managers(db)) drafts.push({ to, kind: "membership_ended_unpaid_staff", params, purpose: "staff", essential: false, email: true, link: `/people/${m.person_id}` });
    }
    return drafts;
  },
  async "enrolment.booked"({ db, tz }, p: { enrolment_id: string; by_other?: boolean }) {
    if (p.by_other) return [];   // signed up by the desk for several dates: enrolment.signed_up_for_you says it once
    const e = await place(db, p.enrolment_id), due = await owes(db, e.id);
    // With something to pay, the confirmation comes with the payment; until then it's in the inbox only.
    // Paid already by the time this runs: the payment's message is the confirmation.
    if (due > 0) return [{ to: e.person_id, kind: "booked_to_pay", params: { name: e.name, when: when(e.start, tz), amount: amount(due) }, purpose: "account", essential: false, email: false, link: "/places" }];
    if (await paidFor(db, e.id) > 0) return [];
    return [{ to: e.person_id, kind: "booked", params: { name: e.name, when: when(e.start, tz) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  // The desk signed them up for dates of a program: one message with every date they have a place on, and what
  // to pay in the app (a waitlisted date has its own message).
  async "enrolment.signed_up_for_you"({ db, tz }, p: { person_id: string; enrolment_ids: string[] }) {
    const rows = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id").leftJoin("session", "session.id", "enrolment.session_id")
      .select(["enrolment.id", "program.name", "session.starts_at"]).where("enrolment.id", "in", p.enrolment_ids).where("enrolment.status", "=", "booked").orderBy("session.starts_at").execute();
    if (!rows.length) return [];
    let due = 0;
    for (const r of rows) due += await owes(db, r.id);
    const dates: Text = { en: rows.map((r) => when(r.starts_at, tz).en).join("; "), es: rows.map((r) => when(r.starts_at, tz).es).join("; ") };
    return [{ to: p.person_id, kind: due > 0 ? "signed_up_for_you" : "signed_up_for_you_free", params: { name: rows[0]!.name, dates, amount: amount(due) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "payment.succeeded"({ db, tz }, p: { payment_id: string }) {
    const pay = await db.selectFrom("payment").select(["enrolment_id", "amount_cents", "person_id", "booking_player_id"]).where("id", "=", p.payment_id).executeTakeFirstOrThrow();
    if (pay.booking_player_id) {
      // A player's part of a shared court; the organiser's payment is confirmed by booking.confirmed instead.
      const bp = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").select(["booking.id", "booking.organiser_id", "booking.status"]).where("booking_player.id", "=", pay.booking_player_id).executeTakeFirstOrThrow();
      if (bp.organiser_id === pay.person_id || bp.status !== "confirmed") return [];
      const b = await bookingInfo(db, bp.id);
      return [{ to: pay.person_id, kind: "booking_share_paid", params: { ...b.base, amount: amount(pay.amount_cents) }, purpose: "account", essential: true, email: true, link: "/places" }];
    }
    if (!pay.enrolment_id) return [];
    const e = await place(db, pay.enrolment_id);
    return [{ to: pay.person_id, kind: "paid", params: { name: e.name, when: when(e.start, tz), amount: amount(pay.amount_cents) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  // Several dates of a program paid together: one message for them all.
  async "enrolment.dates_paid"({ db, tz }, p: { person_id: string; enrolment_ids: string[]; cents: number }) {
    const places = await Promise.all(p.enrolment_ids.map((id) => place(db, id)));
    places.sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
    const dates: Text = { en: places.map((x) => x.start ? dateTime(x.start, "en", tz) : "").join("; "), es: places.map((x) => x.start ? dateTime(x.start, "es", tz) : "").join("; ") };
    return [{ to: p.person_id, kind: "dates_paid", params: { name: places[0]?.name ?? "", dates, amount: amount(p.cents) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "payment.failed"({ db }, p: { payment_id: string }) {
    const pay = await db.selectFrom("payment").select(["enrolment_id", "amount_cents", "person_id", "membership_plan_id", "membership_id"]).where("id", "=", p.payment_id).executeTakeFirstOrThrow();
    // A membership payment fails only when it was left unfinished and called off (closeUnfinishedPayments): nothing was charged.
    if (!pay.enrolment_id && (pay.membership_plan_id || pay.membership_id)) {
      const plan = pay.membership_plan_id ?? (await db.selectFrom("membership").select("plan_id").where("id", "=", pay.membership_id!).executeTakeFirst())?.plan_id;
      const row = plan ? await db.selectFrom("membership_plan").select(["name", "translations"]).where("id", "=", plan).executeTakeFirst() : null;
      const name = row ? textOf(row.name, row.translations, "name") : "";
      return [{ to: pay.person_id, kind: "membership_payment_unfinished", params: { name, amount: amount(pay.amount_cents) }, purpose: "account", essential: true, email: true, link: "/membership" }];
    }
    if (!pay.enrolment_id) return [];
    const e = await place(db, pay.enrolment_id);
    return [{ to: pay.person_id, kind: "payment_failed", params: { name: e.name, amount: amount(pay.amount_cents) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "enrolment.waitlisted"({ db }, p: { enrolment_id: string }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "waitlisted", params: { name: e.name, position: e.waitlist_position ?? 1 }, purpose: "account", essential: false, email: false, link: "/places" }];
  },
  async "waitlist.offered"({ db, tz }, p: { enrolment_id: string; offer_id: string }) {
    const e = await place(db, p.enrolment_id);
    const o = await db.selectFrom("waitlist_offer").select("expires_at").where("id", "=", p.offer_id).executeTakeFirstOrThrow();
    return [{ to: e.person_id, kind: "offered", params: { name: e.name, when: when(e.start, tz), until: when(o.expires_at, tz) }, purpose: "account", essential: false, email: true, link: "/", staleAt: o.expires_at }];
  },
  async "waitlist.offer_expired"({ db }, p: { enrolment_id: string }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "offer_expired", params: { name: e.name }, purpose: "account", essential: false, email: true, link: "/places", staleAt: e.start }];
  },
  async "enrolment.unpaid_reminder"({ db, tz }, p: { enrolment_id: string; until: string | null }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "unpaid_reminder", params: { name: e.name, when: when(e.start, tz), amount: amount(await owes(db, e.id)), until: when(p.until ? new Date(p.until) : e.start, tz) },
      purpose: "account", essential: true, email: true, link: "/places", staleAt: p.until ? new Date(p.until) : e.start }];
  },
  async "enrolment.lapsed"({ db, tz }, p: { enrolment_id: string; credit_cents?: number }) {
    const e = await place(db, p.enrolment_id);
    const refund = p.credit_cents ? both("msg.refund_credit", { amount: amount(p.credit_cents) }) : NOTHING;
    return [{ to: e.person_id, kind: "place_lapsed", params: { name: e.name, when: when(e.start, tz), refund }, purpose: "account", essential: true, email: true, link: "/" }];
  },
  async "enrolment.left"({ db, tz }, p: { enrolment_id: string; refund_outcome: string; refund_cents: number; refund_desk?: number; refund_credit?: number; refund_pass?: number }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "left", params: { name: e.name, when: when(e.start, tz), refund: refundLine(p.refund_outcome, p.refund_cents, await paidFor(db, e.id), p.refund_desk, p.refund_credit, p.refund_pass ?? 0, await paidByPass(db, e.id)) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "enrolment.removed"({ db, tz }, p: { enrolment_id: string; reason: string; refund_outcome: string; refund_cents: number; refund_desk?: number; refund_credit?: number; refund_pass?: number }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "removed", params: { name: e.name, when: when(e.start, tz), reason: both(`reason.${p.reason}` as Key), refund: refundLine(p.refund_outcome, p.refund_cents, await paidFor(db, e.id), p.refund_desk, p.refund_credit, p.refund_pass ?? 0, await paidByPass(db, e.id)) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "enrolment.transferred"({ db, tz }, p: { from: string; to: string; pay: "sub_pays" | "gift" }) {
    const from = await place(db, p.from), to = await place(db, p.to);
    const names = await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", [from.person_id, to.person_id]).execute();
    const name = (id: string) => names.find((n) => n.id === id)?.display_name ?? "";
    const due = await owes(db, to.id), paid = await paidFor(db, from.id);
    // Paid at the desk: it's collected there once the sub pays, not sent to a card.
    const atDesk = Boolean(await db.selectFrom("refund").select("id").where("enrolment_id", "=", from.id).where("destination", "=", "desk").executeTakeFirst());
    const drafts: Draft[] = [
      { to: from.person_id, kind: "passed_on", params: { name: from.name, when: when(from.start, tz), sub: name(to.person_id),
        refund: p.pay === "sub_pays" && paid > 0 ? both(atDesk ? "msg.refund_after_sub_desk" : "msg.refund_after_sub", { amount: amount(paid), sub: name(to.person_id) }) : NOTHING }, purpose: "account", essential: true, email: true, link: "/places" },
      { to: to.person_id, kind: "passed_to_you", params: { name: to.name, when: when(to.start, tz), person: name(from.person_id),
        pay: due > 0 ? both("msg.pay_to_keep", { amount: amount(due) }) : both("msg.paid_for") }, purpose: "account", essential: true, email: true, link: "/places" },
    ];
    return drafts;
  },
  // ---- Programs over time: dates moved or cancelled, a minimum not reached, a place open to anyone ----
  async "dates.changed"(_c, p: { program_id: string; name: string | Text; lines: Text; people: string[] }) {
    return p.people.map((to) => ({ to, kind: "dates_changed", params: { name: p.name, lines: p.lines }, purpose: "account" as const, essential: true, email: true, link: "/places" }));
  },
  async "dates.cancelled"({ tz }, p: { program_id: string; name: string | Text; starts: string[]; entire: boolean; reason: "club" | "below_minimum"; people: { person_id: string; status: string; cents: number; paid: number; desk?: number }[] }) {
    const first = p.starts.length ? new Date(p.starts[0]!) : null;
    const dates: Text = { en: p.starts.map((s) => dateTime(new Date(s), "en", tz)).join("; "), es: p.starts.map((s) => dateTime(new Date(s), "es", tz)).join("; ") };
    const kind = !p.entire ? "dates_cancelled" : p.reason === "below_minimum" ? "program_cancelled_minimum" : "program_cancelled";
    return p.people.map((x) => ({ to: x.person_id, kind, params: { name: p.name, when: when(first, tz), dates,
      refund: x.status === "waitlisted" ? both("msg.cancel_was_waiting") : refundLine(x.cents >= x.paid ? "full" : "partial", x.cents, x.paid, x.desk) }, purpose: "account" as const, essential: true, email: true, link: "/places" }));
  },
  async "program.min_cancelled"({ db, tz }, p: { program_id: string; name: string | Text; starts_at: string | null; booked: number; min: number }) {
    return (await desk(db)).map((to) => ({ to, kind: "program_min_cancelled_staff", params: { name: p.name, when: when(p.starts_at ? new Date(p.starts_at) : null, tz), booked: p.booked, min: p.min },
      purpose: "staff" as const, essential: true, email: true, link: `/programs/${p.program_id}` }));
  },
  async "program.min_short"({ db, tz }, p: { program_id: string; name: string | Text; starts_at: string | null; decide_at: string | null; booked: number; min: number }) {
    return (await desk(db)).map((to) => ({ to, kind: "program_min_short", params: { name: p.name, when: when(p.starts_at ? new Date(p.starts_at) : null, tz), booked: p.booked, min: p.min, missing: p.min - p.booked,
      decide: when(p.decide_at ? new Date(p.decide_at) : null, tz) }, purpose: "staff" as const, essential: false, email: true, link: `/programs/${p.program_id}`, staleAt: p.decide_at ? new Date(p.decide_at) : null }));
  },
  async "program.place_open"({ tz }, p: { program_id: string; name: string | Text; starts_at: string | null; people: string[] }) {
    const start = p.starts_at ? new Date(p.starts_at) : null;
    return p.people.map((to) => ({ to, kind: "place_open", params: { name: p.name, when: when(start, tz) }, purpose: "account" as const, essential: false, email: true, link: "/", staleAt: start }));
  },
  // An edit to a program's dates undone: the people told about it hear it's back as it was.
  async "action.undone"({ db }, p: { run_id: string }) {
    const run = await db.selectFrom("action_run").select(["action", "plan"]).where("id", "=", p.run_id).executeTakeFirst();
    if (run?.action !== "series.edit") return [];
    const d = (run.plan as { details?: { name: string; back: Text; people: string[]; changed: unknown[] } }).details;
    if (!d?.changed?.length) return [];
    return d.people.map((to) => ({ to, kind: "dates_restored", params: { name: d.name, lines: d.back }, purpose: "account" as const, essential: true, email: true, link: "/places" }));
  },
  // A refund that didn't go through: the managers hear what it was for (a program place, a court or lesson, a
  // membership) and where to look, the program's page or the person's.
  async "refund.failed"({ db }, p: { refund_id: string }) {
    const r = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("person", "person.id", "payment.person_id")
      .leftJoin("membership_plan", "membership_plan.id", "payment.membership_plan_id")
      .select(["refund.amount_cents", "refund.failure", "refund.enrolment_id", "payment.enrolment_id as paid_enrolment", "payment.booking_player_id", "payment.person_id", "person.display_name", "membership_plan.name as plan"])
      .where("refund.id", "=", p.refund_id).executeTakeFirstOrThrow();
    const enrolmentId = r.enrolment_id ?? r.paid_enrolment;
    const e = enrolmentId ? await place(db, enrolmentId) : null;
    const what = !e && !r.booking_player_id && r.plan ? both("msg.what_membership", { name: r.plan })
      : await paymentWhat(db, { person_id: r.person_id, booking_player_id: r.booking_player_id, enrolment_id: enrolmentId });
    const where = e ? both("msg.refund_failed.where_program") : both("msg.refund_failed.where_person", { person: r.display_name });
    const params = { amount: amount(r.amount_cents), person: r.display_name, what, where, reason: refundReason(r.failure) };
    return (await managers(db)).map((to) => ({ to, kind: "refund_failed", params, purpose: "staff" as const, essential: false, email: true, link: e ? `/programs/${e.program_id}` : `/people/${r.person_id}` }));
  },
  // Moving from Playtomic (playtomic_archive.ts): a cancelled booking that had been paid in Playtomic, to give back
  // there; and the owner's daily comparison, each difference said once.
  // Why it goes back (cancelled, or changed to cost less) and by what: the club's rule, or what staff chose instead.
  async "booking.refund_in_playtomic"({ db }, p: { booking_id: string; cents: number; chosen?: boolean; changed?: boolean }) {
    const b = await db.selectFrom("booking").leftJoin("person", "person.id", "booking.organiser_id").select(["booking.code", "booking.organiser_id", "person.display_name"])
      .where("booking.id", "=", p.booking_id).executeTakeFirst();
    if (!b) return [];
    const who = { code: b.code, person: b.display_name ?? "" }, sum = { amount: amount(p.cents) };
    const params = { ...who, ...sum, what: both(p.changed ? "msg.playtomic_refund_staff.changed" : "msg.playtomic_refund_staff.cancelled", who),
      back: both(p.chosen ? "msg.playtomic_refund_staff.back_chosen" : "msg.playtomic_refund_staff.back_rule", sum) };
    return (await managers(db)).map((to) => ({ to, kind: "playtomic_refund_staff", params, purpose: "staff" as const, essential: false, email: true, link: b.organiser_id ? `/people/${b.organiser_id}` : "/playtomic" }));
  },
  async "mirror.compared"({ db, tz }, p: { lines: { kind: "clash" | "missing" | "moved" | "cancelled" | "paid"; court: string; starts_at: string; type: string; code: string | null }[]; more: number }) {
    const kinds: Record<string, Key> = { clash: "msg.playtomic_compare.clash", missing: "msg.playtomic_compare.missing", moved: "msg.playtomic_compare.moved", cancelled: "msg.playtomic_compare.cancelled",
      paid: "msg.playtomic_compare.paid" };
    const lines = p.lines.map((l) => both(kinds[l.kind]!, { court: l.court, when: when(new Date(l.starts_at), tz), type: both(typeKey(l.type)), code: l.code ?? "" }));
    const list: Text = { en: lines.map((x) => `- ${x.en}`).join("\n"), es: lines.map((x) => `- ${x.es}`).join("\n") };
    const params = { count: p.lines.length + p.more, list, more: p.more ? both("msg.playtomic_compare.more", { count: p.more }) : { en: "", es: "" } };
    return (await owners(db)).map((to) => ({ to, kind: "playtomic_compare", params, purpose: "staff" as const, essential: false, email: true, link: "/playtomic" }));
  },
  async "mirror.conflict"({ db, tz }, p: { court_name: string | null; start: string; type: string }) {
    const params = { court: p.court_name ?? "", when: when(new Date(p.start), tz), type: both(typeKey(p.type)) };
    return (await managers(db)).map((to) => ({ to, kind: "mirror_conflict", params, purpose: "staff" as const, essential: false, email: true, link: "/playtomic" }));
  },
  // A copy of someone's data left Kumi: they hear of it (if it wasn't them, they can say so), and so does the
  // club when they took it themselves (permissions.md rule 6: these always reach a person).
  async "privacy.exported"({ db, tz }, p: { person_id: string; by: string | null; self: boolean; at: string }) {
    const params = { when: when(new Date(p.at), tz) };
    const drafts: Draft[] = [{ to: p.person_id, kind: p.self ? "privacy_exported" : "privacy_exported_by_club", params, purpose: "account", essential: true, email: true, link: "/profile" }];
    if (p.self) {
      const name = (await db.selectFrom("person").select("display_name").where("id", "=", p.person_id).executeTakeFirst())?.display_name ?? "";
      for (const to of await managers(db)) if (to !== p.person_id) drafts.push({ to, kind: "privacy_exported_staff", params: { ...params, name }, purpose: "staff", essential: false, email: false, link: `/people/${p.person_id}` });
    }
    return drafts;
  },
  // The owner approved a manager's download of someone's data: the manager who asked gets the link.
  async "privacy.export_ready"({ db }, p: { to: string; person_id: string; run_id: string; minutes: number }) {
    const name = (await db.selectFrom("person").select("display_name").where("id", "=", p.person_id).executeTakeFirst())?.display_name ?? "";
    return [{ to: p.to, kind: "privacy_export_ready_staff", params: { name, minutes: p.minutes }, purpose: "staff" as const, essential: true, email: true, link: `/my/privacy/export/${p.run_id}` }];
  },
  // Their second sign-in step was started over: they hear who did it, and what to do next time.
  async "person.sign_in_reset"(_ctx, p: { person_id: string; by: string | null }) {
    return [{ to: p.person_id, kind: "sign_in_reset", params: { by: p.by ? both("msg.sign_in_reset_by", { by: p.by }) : both("msg.sign_in_reset_kumi") }, purpose: "account" as const, essential: true, email: true, link: "/profile" }];
  },
  // An account deleted: the club hears, without a name (it's gone), and who did it.
  // A receipt, to whoever paid: by email and in the app, with no notification (it's a record, not news).
  // Sent again by the staff: by email only.
  async "receipt.issued"({ db }, p: { receipt_id: string }) {
    const r = await receiptParams(db, p.receipt_id);
    return r ? [{ to: r.view.person_id, kind: r.kind, params: r.params, purpose: "account" as const, essential: true, email: true, push: false, link: `/receipts/${p.receipt_id}` }] : [];
  },
  async "receipt.resent"({ db }, p: { receipt_id: string }) {
    const r = await receiptParams(db, p.receipt_id);
    return r ? [{ to: r.view.person_id, kind: r.kind, params: r.params, purpose: "account" as const, essential: true, email: true, push: false, inbox: false, link: `/receipts/${p.receipt_id}` }] : [];
  },
  // Someone given a staff role hears it once, with where to sign in; and once when it's taken away. Not the person
  // who did it to themselves, and not the member role every account has.
  async "role.assigned"({ db }, p: { person_id: string; role: string; location_id?: string | null; by?: string | null }) {
    if (p.role === "member" || p.by === p.person_id) return [];
    const params = { ...await roleParams(db, p), url: staffAddress ?? both("msg.staff_app"),
      two_step: await needsTwoFactor(db, p.person_id) ? both("msg.staff_role_two_step") : NOTHING };
    return [{ to: p.person_id, kind: "staff_role_given", params, purpose: "staff" as const, essential: true, email: true, push: false, link: "/" }];
  },
  // An assistant connection held to a member's reach (assistant_reach.ts): its person hears it once, and why.
  async "assistant.limited"({ db }, p: { grant_id: string; why: "widened" | "second_step" }) {
    const g = await db.selectFrom("oauth_grant").innerJoin("oauth_client", "oauth_client.client_id", "oauth_grant.client_id").select(["oauth_grant.person_id", "oauth_client.name"])
      .where("oauth_grant.id", "=", p.grant_id).executeTakeFirst();
    if (!g) return [];
    const club = (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;
    const params = { club, client: g.name ?? both("msg.an_assistant"), why: both(p.why === "widened" ? "msg.assistant_limited_widened" : "msg.assistant_limited_second_step") };
    return [{ to: g.person_id, kind: "assistant_limited", params, purpose: "account" as const, essential: true, email: true, push: false, link: "/profile" }];
  },
  async "role.removed"({ db }, p: { person_id: string; role: string; location_id?: string | null; by?: string | null }) {
    if (p.role === "member" || p.by === p.person_id) return [];
    return [{ to: p.person_id, kind: "staff_role_removed", params: await roleParams(db, p), purpose: "staff" as const, essential: true, email: true, push: false, link: "/" }];
  },
  async "privacy.erased"({ db, tz }, p: { self: boolean; by: string | null; juniors: number; at: string }) {
    const by = p.by ? (await db.selectFrom("person").select("display_name").where("id", "=", p.by).executeTakeFirst())?.display_name ?? "" : "";
    const params = { when: when(new Date(p.at), tz), how: p.self ? both("msg.privacy_erased_self") : both("msg.privacy_erased_by", { by }),
      juniors: p.juniors ? both("msg.privacy_erased_juniors", { count: p.juniors }) : NOTHING };
    return (await managers(db)).filter((to) => to !== p.by).map((to) => ({ to, kind: "privacy_erased_staff", params, purpose: "staff" as const, essential: false, email: true, link: "/people" }));
  },
  // Support access: the person let in hears where to sign in; the owners hear when it's first used and when it ends.
  async "support.granted"({ db, tz }, p: { grant_id: string }) {
    const { g, params } = await supportInfo(db, p.grant_id, tz);
    return [{ to: g.person_id, kind: "support_granted_you", params: { ...params, url: staffAddress ?? both("msg.staff_app") }, purpose: "staff" as const, essential: true, email: true, push: false, link: "/" }];
  },
  async "support.first_seen"({ db, tz }, p: { grant_id: string; at: string }) {
    const { params } = await supportInfo(db, p.grant_id, tz);
    return (await owners(db)).map((to) => ({ to, kind: "support_first_seen_owner", params: { ...params, when: when(new Date(p.at), tz) }, purpose: "staff" as const, essential: true, email: true, link: "/support" }));
  },
  async "support.ended"({ db, tz }, p: { grant_id: string; how: "ended" | "expired" | "moved" | "restored"; by: string | null }) {
    const { params } = await supportInfo(db, p.grant_id, tz);
    const how = p.how === "expired" ? both("msg.support_ended_expired") : p.how === "moved" ? both("msg.support_ended_moved")
      : p.how === "restored" ? both("msg.support_ended_restored") : both("msg.support_ended_by", { by: p.by ? await nameOf(db, p.by) : "" });
    return (await owners(db)).map((to) => ({ to, kind: "support_ended_owner", params: { ...params, how }, purpose: "staff" as const, essential: true, email: true, link: "/support" }));
  },
  // A change someone asked for (a manager asking the owner, or money that needs a second person): everyone on the staff
  // who could say yes hears once, with what it is and who asked; the person who asked hears the answer.
  async "approval.waiting"({ db }, p: { run_id: string }) {
    const r = await askedRun(db, p.run_id);
    if (!r || r.run.status !== "awaiting_approval") return [];
    const staff = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.person_id")
      .where("role.key", "!=", "member").where("person_role.active", "=", true).distinct().execute();
    const to: string[] = [];
    for (const s of staff) if (await mayAnswer(db, r.run, s.person_id, new Date())) to.push(s.person_id);
    return to.map((id) => ({ to: id, kind: "approval_waiting", params: { by: r.by, what: r.what }, purpose: "staff" as const, essential: false, email: true, link: "/changes" }));
  },
  async "approval.approved"({ db }, p: { run_id: string; by: string }) {
    const r = await askedRun(db, p.run_id);
    if (!r?.run.actor_person_id) return [];
    return [{ to: r.run.actor_person_id, kind: "approval_approved", params: { by: await nameOf(db, p.by), what: r.what }, purpose: "staff" as const, essential: false, email: true, link: "/changes" }];
  },
  async "approval.declined"({ db }, p: { run_id: string; by: string; reason: string | null }) {
    const r = await askedRun(db, p.run_id);
    if (!r?.run.actor_person_id) return [];
    const why = p.reason ? both("msg.approval_declined_why", { reason: p.reason }) : NOTHING;
    return [{ to: r.run.actor_person_id, kind: "approval_declined", params: { by: await nameOf(db, p.by), what: r.what, why }, purpose: "staff" as const, essential: false, email: true, link: "/changes" }];
  },
};

/** An ask, what it would do in both languages, and who asked (support access says so, with the name the owner gave). */
async function askedRun(db: Db, runId: string) {
  const run = await db.selectFrom("action_run").leftJoin("support_grant", "support_grant.id", "action_run.support_grant_id")
    .select(["action_run.id", "action_run.action", "action_run.input", "action_run.plan", "action_run.location_id", "action_run.actor_person_id", "action_run.status", "support_grant.name as support_name"])
    .where("action_run.id", "=", runId).executeTakeFirst();
  if (!run) return null;
  const by: Params[string] = run.support_name ? both("ui.support_by", { name: run.support_name }) : run.actor_person_id ? await nameOf(db, run.actor_person_id) : productName();
  return { run, by, what: (run.plan as { summary: Text }).summary };
}

/** Who gave or took a role, which role, where, and the club's name: for the staff role messages. */
async function roleParams(db: Db, p: { role: string; location_id?: string | null; by?: string | null }) {
  const by = p.by ? (await db.selectFrom("person").select("display_name").where("id", "=", p.by).executeTakeFirst())?.display_name ?? null : null;
  const loc = p.location_id ? (await db.selectFrom("location").select("name").where("id", "=", p.location_id).executeTakeFirst())?.name ?? null : null;
  const club = (await db.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;
  return { club, role: await roleLabel(db, p.role), where: loc ? both("where.at", { location: loc }) : NOTHING, by: by ?? both("msg.the_club") };
}

/** A junior has no login: what's said to them goes to each adult who manages them, in that adult's language,
 *  saying whom it's about. An adult who'd get the same message anyway gets it once. A kid with a login of
 *  their own hears it themselves; their parents also hear what goes on their card at the deadline. */
const PARENTS_TOO = new Set(["booking_shares_charged", "booking_balance_due"]);
async function forJuniors(db: Db, drafts: Draft[]): Promise<(Draft & { junior?: string })[]> {
  const out: (Draft & { junior?: string })[] = [];
  for (const d of drafts) {
    const p = await db.selectFrom("person").select(["junior", "own_login", "display_name"]).where("id", "=", d.to).executeTakeFirst();
    if (!p?.junior) { out.push(d); continue; }
    if (p.own_login) { out.push(d); if (!PARENTS_TOO.has(d.kind) && !d.parents?.length) continue; }
    // The junior's level is on the parent's Family page, not their own My level.
    const link = d.link === "/level" ? "/family" : d.link;
    for (const to of await managersOf(db, d.to)) {
      if (p.own_login && !PARENTS_TOO.has(d.kind) && !d.parents?.includes(to)) continue;   // a kid with a login hears it themselves
      if (!out.some((x) => x.to === to && x.kind === d.kind)) out.push({ ...d, to, link, junior: p.display_name });
    }
  }
  return out;
}

/** A sentence that ends on a Spanish time ("10:00 a.m.") keeps one full stop, and an empty last line goes. */
const tidy = (text: string) => text.replace(/([ap]\.\s?m\.)\./g, "$1").replace(/\s+$/, "");

/** An in-app message in the reader's language now: its own words when it was written in that language, the other
 *  language's when it kept them (migration 107), or else as it was written. */
export function messageInLang<T extends { lang: string; subject: string; body: string; alt_subject?: string | null; alt_body?: string | null }>(m: T, lang: Lang): { subject: string; body: string } {
  return m.lang !== lang && m.alt_subject != null && m.alt_body != null ? { subject: m.alt_subject, body: m.alt_body } : { subject: m.subject, body: m.body };
}
/** The language someone reads in: their own, or the club's. */
export async function readerLang(db: Db | Trx, personId: string): Promise<Lang> {
  const p = await db.selectFrom("person").select("locale").where("id", "=", personId).executeTakeFirst();
  const club = await db.selectFrom("club").select("default_language").executeTakeFirst();
  return pickLang(p?.locale ?? null, pickLang(club?.default_language ?? null));
}

/** Record when this server started telling people about each kind of event. Called when the server
 *  starts, before any event is handled; a kind that's already recorded keeps its date. */
export async function registerMessageTopics(db: Db, now = new Date()): Promise<string[]> {
  const r = await db.insertInto("message_topic").values(Object.keys(composers).map((topic) => ({ topic, since: now })))
    .onConflict((oc) => oc.column("topic").doNothing()).returning("topic").execute();
  return r.map((x) => x.topic);
}

/** Write an event's messages: the inbox copy now, the email copy for the sender. Safe to run twice. */
async function compose(db: Db, ev: OutboxEvent, now = new Date()): Promise<number> {
  if (now.getTime() - new Date(ev.created_at).getTime() > TOO_OLD_MS) return 0;
  // An event from before this kind of message existed here (an update just added it) tells nobody.
  const since = (await db.selectFrom("message_topic").select("since").where("topic", "=", ev.topic).executeTakeFirst())?.since;
  if (since && new Date(ev.created_at) < since) return 0;
  const club = await db.selectFrom("club").select(["time_zone", "default_language"]).executeTakeFirstOrThrow();
  const drafts = await forJuniors(db, await composers[ev.topic]!({ db, tz: club.time_zone }, ev.payload));
  let written = 0;
  for (const d of drafts) {
    const person = await db.selectFrom("person").select(["locale", "email", "status", "redacted_at"]).where("id", "=", d.to).executeTakeFirst();
    if (!person || person.redacted_at || person.status === "archived") continue;
    const lang: Lang = pickLang(person.locale, pickLang(club.default_language));
    const wordsIn = (l: Lang) => {
      const w = { subject: tidy(t(l, `msg.${d.kind}.subject` as Key, d.params)), body: tidy(t(l, `msg.${d.kind}.body` as Key, d.params)) };
      return d.junior ? { subject: t(l, "msg.for_junior.subject", { name: d.junior, text: w.subject }), body: t(l, "msg.for_junior.body", { name: d.junior, text: w.body }) } : w;
    };
    const words = wordsIn(lang);
    const base = { event_id: ev.id, person_id: d.to, kind: d.kind, purpose: d.purpose, essential: d.essential, lang, ...words, link: d.link ?? null, stale_at: d.staleAt ?? null };
    // The inbox copy keeps the other language's words too, so it reads in the reader's language when it's shown (messageInLang).
    const other = wordsIn(lang === "en" ? "es" : "en");
    const rows: Record<string, unknown>[] = d.inbox === false ? [] : [{ ...base, alt_subject: other.subject, alt_body: other.body, id: uuidv7(now.getTime()), channel: "inbox", status: "sent", send_after: now, sent_at: now }];
    // Staff alerts and essential messages go straight away; the rest wait out quiet hours.
    const wait = d.essential || d.purpose === "staff" ? null : quietUntil(now, club.time_zone);
    const later = d.emailUnlessRead ? new Date(now.getTime() + d.emailUnlessRead * 60_000) : null;
    const emailAt = [wait, later].filter((x): x is Date => Boolean(x)).sort((a, b) => b.getTime() - a.getTime())[0] ?? now;
    if (d.email && person.email) rows.push({ ...base, id: uuidv7(now.getTime()), channel: "email", status: "waiting", send_after: emailAt, sent_at: null as any });
    // Every message also goes to the phones they turned notifications on for.
    if (d.push !== false && await hasPushDevice(db, d.to)) rows.push({ ...base, id: uuidv7(now.getTime()), channel: "push", status: "waiting", send_after: wait ?? now, sent_at: null as any });
    // And by text, what they need to know soon, if they said yes to texts (texts.ts); never news of what they did themselves.
    if (textingOn() && d.purpose === "account" && TEXT_KINDS.has(d.kind) && (ev.payload as { by?: unknown } | null)?.by !== d.to && "phone" in await textable(db, d.to)) {
      let text = t(lang, `msg.${d.kind}.sms` as Key, d.params);
      if (d.junior) text = t(lang, "msg.for_junior.sms", { name: d.junior, text });
      rows.push({ ...base, body: tidy(text), id: uuidv7(now.getTime()), channel: "sms", status: "waiting", send_after: wait ?? now, sent_at: null as any });
    }
    if (!rows.length) continue;
    const r = await db.insertInto("outbound_message").values(rows as any).onConflict((oc) => oc.columns(["event_id", "person_id", "kind", "channel"]).doNothing()).execute();
    written += r.reduce((n, x) => n + Number(x.numInsertedOrUpdatedRows ?? 0), 0);
  }
  return written;
}

/** The outbox handlers for messages, one per event that tells someone something. */
export const messageHandlers: Record<string, Handler> = Object.fromEntries(Object.keys(composers).map((topic) => [topic, (db: Db, _p: unknown, ev?: OutboxEvent) => compose(db, ev!).then(() => {})]));

/** Whether the person's latest answer for this channel and purpose is no (consent is append-only). */
async function refused(db: Db | Trx, personId: string, channel: string, purpose: string): Promise<boolean> {
  const c = await db.selectFrom("channel_consent").select("granted").where("person_id", "=", personId).where("channel", "=", channel).where("purpose", "=", purpose)
    .orderBy("at", "desc").limit(1).executeTakeFirst();
  return c?.granted === false;
}

/** Send the emails that are due. Ones gone stale are dropped, not sent late; a failure is tried again. */
/** `unsubscribeUrl` turns a person's news key into the address of the page that stops club news; with it,
 *  every club news email carries that link at the foot and in its headers, for mail apps' one-click button. */
export async function sendEmails(db: Db, mailer: Mailer, now = new Date(), limit = 50, o: { unsubscribeUrl?: (token: string) => string } = {}): Promise<{ sent: number; dropped: number; failed: number; waiting: number }> {
  const out = { sent: 0, dropped: 0, failed: 0, waiting: 0 };
  // After a restore, what the jobs made again that the database before it had sent doesn't go twice (repeats.ts).
  await skipRepeatsAfterRestore(db, now);
  // Moved to another server (club_exit.ts): that one talks to members now; what waits here stays waiting.
  if (await movedAway(db)) return out;
  let clubName: string | null = null;
  for (let i = 0; i < limit; i++) {
    const done = await db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom("outbound_message").innerJoin("person", "person.id", "outbound_message.person_id")
        .select(["outbound_message.id", "outbound_message.person_id", "outbound_message.purpose", "outbound_message.essential", "outbound_message.subject", "outbound_message.body",
          "outbound_message.stale_at", "outbound_message.attempts", "outbound_message.lang", "outbound_message.kind", "outbound_message.event_id", "outbound_message.link", "person.email", "person.news_token"])
        .where("outbound_message.status", "=", "waiting").where("outbound_message.channel", "=", "email").where("outbound_message.send_after", "<=", now)
        .orderBy("outbound_message.send_after").limit(1).forUpdate("outbound_message").skipLocked().executeTakeFirst();
      if (!m) return null;
      // Consent is checked now, at the send: a member who said no to email since still isn't emailed,
      // except what they can't do without (sign-ins, confirmations, money).
      const seen = UNLESS_READ.has(m.kind) && await seenInApp(trx, m);
      // An address the email service said can't take the club's email (email_suppression.ts) gets none, essential or
      // not: it wouldn't arrive, and sending it hurts the club's sending name. The in-app copy stays.
      const held = m.email ? await emailSuppressed(trx, m.email) : null;
      const why = !m.email ? "no email" : held ? `held back: ${held.reason === "bounce" ? "bounced" : held.reason === "complaint" ? "marked as spam" : "the email service won't send to it"}`
        : !m.essential && m.purpose !== "staff" && await refused(trx, m.person_id, "email", m.purpose) ? "no consent" : m.stale_at && m.stale_at <= now ? "stale"
        : seen ? "read in the app" : null;
      if (why) {
        await trx.updateTable("outbound_message").set({ status: "dropped", failure: why }).where("id", "=", m.id).execute();
        return "dropped" as const;
      }
      // Club news can wait: past the club's monthly limit (usage.ts) it goes when the next month starts, unless
      // it's stale by then.
      if (m.purpose === "club_news" && !(await usageAllows(db, "can_wait", currentPrices().email, now))) {
        const tz = (await trx.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
        await trx.updateTable("outbound_message").set({ send_after: nextMonthStart(monthOf(now, tz), tz) }).where("id", "=", m.id).execute();
        return "waiting" as const;
      }
      let text = m.body, headers: Record<string, string> | undefined;
      if (m.purpose === "club_news" && o.unsubscribeUrl) {
        const url = o.unsubscribeUrl(m.news_token);
        clubName ??= (await trx.selectFrom("club").select("name").executeTakeFirstOrThrow()).name;
        text = `${m.body}\n\n--\n${t(m.lang === "es" ? "es" : "en", "msg.club_news_footer", { club: clubName, url })}`;
        headers = { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
      }
      try {
        const took = await mailer.send({ to: m.email!, subject: m.subject, text, id: m.id, ...(headers ? { headers } : {}) });
        await trx.updateTable("outbound_message").set({ status: "sent", sent_at: now, attempts: sql`attempts + 1`, ...(took?.ref ? { provider_ref: took.ref } : {}) }).where("id", "=", m.id).execute();
        return "sent" as const;
      } catch (e) {
        const gaveUp = m.attempts + 1 >= MAX_SEND_ATTEMPTS;
        // Try again in a few minutes, longer each time.
        await trx.updateTable("outbound_message").set({ status: gaveUp ? "failed" : "waiting", attempts: sql`attempts + 1`, failure: String((e as Error).message).slice(0, 500),
          send_after: new Date(now.getTime() + 5 * 60_000 * 2 ** m.attempts) }).where("id", "=", m.id).execute();
        return "failed" as const;
      }
    });
    if (!done) break;
    out[done]++;
  }
  return out;
}
