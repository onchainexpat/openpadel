// What Kumi tells people (messages.md). Events become messages after their change commits: each lands
// in the person's in-app inbox at once, and its email copy waits for the sender job, outside quiet
// hours unless it's essential. Every row keeps the exact words sent and the event behind it.
import { sql } from "kysely";
import { both, dateTime, money, t, pickLang, type Key, type Lang, type Params, type Text } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import type { Handler, OutboxEvent } from "./outbox.ts";
import { uuidv7 } from "./ids.ts";
import { atLocal, localDate, localParts } from "./clock.ts";
import { dayText, endDay, kindList } from "./memberships.ts";
import { band } from "./match_rules.ts";
import { gameView } from "./results.ts";
import { hasPushDevice } from "./push.ts";
import { managersOf } from "./households.ts";

/** `id`, when given, makes a repeat of the same send a no-op at the provider (a retry after a timeout). */
export interface Mail { to: string; subject: string; text: string; id?: string }
export interface Mailer { send(mail: Mail): Promise<void> }

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
}

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

/** The enrolment, its program and when it starts (its own date, or the program's first). */
async function place(db: Db, enrolmentId: string) {
  const e = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id")
    .select(["enrolment.id", "enrolment.person_id", "enrolment.program_id", "enrolment.session_id", "enrolment.price_cents", "enrolment.waitlist_position", "enrolment.left_reason", "program.name"])
    .where("enrolment.id", "=", enrolmentId).executeTakeFirstOrThrow();
  const s = await db.selectFrom("session").select((eb) => eb.fn.min("starts_at").as("s")).where("program_id", "=", e.program_id).where("status", "!=", "cancelled")
    .$if(Boolean(e.session_id), (q) => q.where("id", "=", e.session_id!)).executeTakeFirst();
  return { ...e, start: (s?.s as Date | null) ?? null };
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
function refundLine(outcome: string, cents: number, paid: number): Text {
  if (cents > 0) return both(outcome === "credit" ? "msg.refund_credit" : "msg.refund_card", { amount: amount(cents) });
  return paid > 0 ? both("msg.refund_none") : NOTHING;
}

/** A court booking: where and when (in its location's time), and who's in it. */
async function bookingInfo(db: Db, bookingId: string) {
  const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
    .innerJoin("location", "location.id", "court.location_id").leftJoin("person as coach", "coach.id", "booking.coach_id")
    .select(["booking.id", "booking.code", "booking.kind", "booking.coach_id", "booking.organiser_id", "booking.pay_mode", "booking.balance_cents", "court.name as court", "location.name as location", "location.time_zone",
      "coach.display_name as coach", sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
    .where("booking.id", "=", bookingId).orderBy(sql`court_time.active`, "desc").executeTakeFirstOrThrow();
  const players = await db.selectFrom("booking_player").leftJoin("person", "person.id", "booking_player.person_id").select(["booking_player.id", "booking_player.person_id", "person.display_name"])
    .where("booking_player.booking_id", "=", bookingId).where("booking_player.removed_at", "is", null).where("booking_player.replaces", "is", null).execute();
  const minutes = Math.round((new Date(b.end).getTime() - new Date(b.start).getTime()) / 60_000);
  return { ...b, minutes, players, base: { court: b.court, location: b.location, when: when(new Date(b.start), b.time_zone), code: b.code, minutes, coach: b.coach ?? "" } };
}
/** A lesson's coach hears about it too, with who's coming. */
function toCoach(b: Awaited<ReturnType<typeof bookingInfo>>, kind: string, o: { essential?: boolean; staleAt?: Date } = {}): Draft[] {
  if (!b.coach_id) return [];
  const names = b.players.map((p) => p.display_name).filter(Boolean).join(", ");
  return [{ to: b.coach_id, kind, params: { ...b.base, players: names }, purpose: "staff", essential: o.essential ?? false, email: true, link: "/schedule", staleAt: o.staleAt }];
}

/** A membership and its plan. */
async function membershipInfo(db: Db, membershipId: string) {
  return db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership.person_id", "membership.plan_id", "membership.current_period_end", "membership.source", "membership.price_cents", "membership.end_reason", "membership_plan.name", "membership_plan.days_ahead",
      "membership_plan.period", "membership_plan.program_percent_off", "membership_plan.program_cents_off", "membership_plan.included_sessions", "membership_plan.included_kinds"])
    .where("membership.id", "=", membershipId).executeTakeFirstOrThrow();
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
    if (!b.organiser_id) return [];
    const kind = `${lesson ? "lesson" : "booking"}_confirmed${b.pay_mode === "split" ? "_split" : ""}`;
    return [{ to: b.organiser_id, kind, params: b.base, purpose: "account", essential: true, email: true, link: "/places" }, ...toCoach(b, "coach_lesson_booked")];
  },
  // Several courts paid together: one message for them all.
  async "booking.courts_confirmed"({ db }, p: { person_id: string; booking_ids: string[]; cents: number }) {
    const items: Text[] = [];
    for (const id of p.booking_ids) items.push(both("msg.booking_courts.item", (await bookingInfo(db, id)).base));
    const list = { en: items.map((x) => x.en).join("; "), es: items.map((x) => x.es).join("; ") };
    return [{ to: p.person_id, kind: "booking_courts", params: { count: p.booking_ids.length, list, amount: amount(p.cents) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "booking.cancelled"({ db }, p: { booking_id: string; by?: string | null }) {
    const b = await bookingInfo(db, p.booking_id), lesson = b.kind === "lesson";
    // Each player who paid hears what comes back to them; everyone in it hears it's off.
    const drafts: Draft[] = [];
    for (const pl of b.players) {
      if (!pl.person_id) continue;
      const back = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").select((eb) => eb.fn.sum<string>("refund.amount_cents").as("c"))
        .where("payment.booking_player_id", "=", pl.id).executeTakeFirst();
      const cents = Number(back?.c ?? 0);
      drafts.push({ to: pl.person_id, kind: lesson ? "lesson_cancelled" : "booking_cancelled", params: { ...b.base, refund: cents ? both("msg.refund_card", { amount: amount(cents) }) : NOTHING }, purpose: "account", essential: true, email: true, link: "/places" });
    }
    // The coach, unless they called it off themselves.
    return [...drafts, ...(p.by && p.by === b.coach_id ? [] : toCoach(b, "coach_lesson_cancelled", { essential: true }))];
  },
  async "booking.lost"({ db }, p: { booking_id: string }) {
    const b = await bookingInfo(db, p.booking_id);
    const paid = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select((eb) => eb.fn.sum<string>("payment.amount_cents").as("c"))
      .where("booking_player.booking_id", "=", b.id).where("payment.status", "=", "succeeded").executeTakeFirst();
    return b.organiser_id ? [{ to: b.organiser_id, kind: "booking_lost", params: { ...b.base, amount: amount(Number(paid?.c ?? 0)) }, purpose: "account", essential: true, email: true, link: "/book" }] : [];
  },
  async "booking.shares_charged"({ db }, p: { booking_id: string; cents: number }) {
    const b = await bookingInfo(db, p.booking_id);
    return b.organiser_id ? [{ to: b.organiser_id, kind: "booking_shares_charged", params: { ...b.base, amount: amount(p.cents) }, purpose: "account", essential: true, email: true, link: "/places" }] : [];
  },
  async "booking.balance_due"({ db }, p: { booking_id: string; cents: number; failure: string | null }) {
    const b = await bookingInfo(db, p.booking_id);
    const name = b.organiser_id ? (await db.selectFrom("person").select("display_name").where("id", "=", b.organiser_id).executeTakeFirst())?.display_name ?? "" : "";
    const params = { ...b.base, amount: amount(p.cents), failure: p.failure ?? "", name };
    return [
      ...(b.organiser_id ? [{ to: b.organiser_id, kind: "booking_balance_due", params, purpose: "account" as const, essential: true, email: true, link: "/places" }] : []),
      ...(await managers(db)).map((to) => ({ to, kind: "booking_balance_due_staff", params, purpose: "staff" as const, essential: false, email: true, link: "/courts" })),
    ];
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
    const why = both(`kid.pay_why.${p.why}` as Key, { failure: p.failure ?? "" });
    return [...p.to.map((to) => ({ to, kind: "kid_pay_needed", params: { name, what: p.what, amount: amount(p.cents), why }, purpose: "account" as const, essential: true, email: true, link: "/family" })),
      { to: p.kid, kind: "kid_parent_pays", params: { what: p.what, amount: amount(p.cents) }, purpose: "account" as const, essential: false, email: false, link: "/places" }];
  },
  // ---- Family memberships: the person added or taken off hears it (a junior's parents already know) ----
  async "membership.person_added"({ db }, p: { membership_id: string; person_id: string }) {
    const r = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id").innerJoin("person as payer", "payer.id", "membership.person_id")
      .select(["membership_plan.name as plan", "payer.display_name as payer"]).where("membership.id", "=", p.membership_id).executeTakeFirstOrThrow();
    if ((await db.selectFrom("person").select("junior").where("id", "=", p.person_id).executeTakeFirst())?.junior) return [];
    return [{ to: p.person_id, kind: "membership_person_added", params: { plan: r.plan, payer: r.payer }, purpose: "account", essential: false, email: true, link: "/membership" }];
  },
  async "membership.person_removed"({ db, tz }, p: { membership_id: string; person_id: string; until: string }) {
    const r = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id").innerJoin("person as payer", "payer.id", "membership.person_id")
      .select(["membership_plan.name as plan", "payer.display_name as payer"]).where("membership.id", "=", p.membership_id).executeTakeFirstOrThrow();
    if ((await db.selectFrom("person").select("junior").where("id", "=", p.person_id).executeTakeFirst())?.junior) return [];
    return [{ to: p.person_id, kind: "membership_person_removed", params: { plan: r.plan, payer: r.payer, date: dayText(endDay({ current_period_end: new Date(p.until), source: "app" }, tz)) },
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
    const g = await gameView(db, p.game_id), b = await bookingInfo(db, g.booking_id!);
    const by = g.a.find((x) => x.person_id === g.entered_by)?.display_name ?? "";
    return g.b.map((x) => ({ to: x.person_id, kind: "result_to_confirm", params: { ...b.base, person: by, teamA: g.teamA, teamB: g.teamB, score: g.score, date: when(g.confirm_by, tz) },
      purpose: "account" as const, essential: false, email: true, link: `/match/${b.id}`, staleAt: g.confirm_by }));
  },
  async "result.confirmed"({ db }, p: { game_id: string }) {
    const g = await gameView(db, p.game_id), b = await bookingInfo(db, g.booking_id!);
    return [...g.a, ...g.b].map((x) => ({ to: x.person_id, kind: g.rated ? "result_confirmed" : "result_confirmed_friendly", params: { ...b.base, teamA: g.teamA, teamB: g.teamB, score: g.score },
      purpose: "account" as const, essential: false, email: false, link: g.rated ? "/level" : `/match/${b.id}` }));
  },
  async "result.disputed"({ db }, p: { game_id: string; person_id: string; note: string }) {
    const g = await gameView(db, p.game_id), b = await bookingInfo(db, g.booking_id!);
    const by = [...g.a, ...g.b].find((x) => x.person_id === p.person_id)?.display_name ?? "";
    const params = { ...b.base, person: by, teamA: g.teamA, teamB: g.teamB, score: g.score, note: p.note };
    return [
      ...(await managers(db)).map((to) => ({ to, kind: "result_disputed_staff", params, purpose: "staff" as const, essential: false, email: true, link: "/scores" })),
      ...[...g.a, ...g.b].filter((x) => x.person_id !== p.person_id).map((x) => ({ to: x.person_id, kind: "result_disputed", params, purpose: "account" as const, essential: false, email: false, link: `/match/${b.id}` })),
    ];
  },
  async "level.review_requested"({ db }, p: { person_id: string; level: string | null; note: string | null }) {
    const person = (await db.selectFrom("person").select("display_name").where("id", "=", p.person_id).executeTakeFirstOrThrow()).display_name;
    const params = { person, level: p.level ?? both("plan.level.no_level"), note: p.note ? both("msg.level_review_note", { note: p.note }) : NOTHING };
    return (await desk(db)).map((to) => ({ to, kind: "level_review_requested_staff", params, purpose: "staff" as const, essential: false, email: false, link: "/levels" }));
  },
  async "level.reviewed"(_c, p: { person_id: string; asked: boolean; outcome: "keep" | "change"; before: string | null; after: string | null; reason: string | null }) {
    // A big move staff checked and kept: the player never asked, so there's nothing to tell them.
    if (!p.asked && p.outcome === "keep") return [];
    const note = p.reason ? both("msg.level_review_note", { note: p.reason }) : NOTHING;
    return [{ to: p.person_id, kind: p.outcome === "keep" ? "level_review_kept" : "level_review_changed", purpose: "account" as const, essential: false, email: true, link: "/level",
      params: { before: p.before ?? both("plan.level.no_level"), after: p.after ?? both("plan.level.no_level"), level: p.after ?? both("plan.level.no_level"), note } }];
  },
  async "attendance.no_show"(_c, p: { people: string[]; what: Text; when: Text; by: string }) {
    return p.people.map((to) => ({ to, kind: "attendance_no_show", params: { what: p.what, when: p.when, by: p.by }, purpose: "account" as const, essential: false, email: true, link: "/places" }));
  },
  async "level.session_set"({ tz }, p: { program: string; starts_at: string; by: string; reason: string; changes: { person_id: string; before: string | null; after: string }[] }) {
    return p.changes.map((c) => ({ to: c.person_id, kind: "level_set_session", purpose: "account" as const, essential: false, email: true, link: "/level",
      params: { program: p.program, when: when(new Date(p.starts_at), tz), by: p.by, reason: p.reason, before: c.before ?? both("plan.level.no_level"), after: c.after } }));
  },
  async "result.resolved"({ db }, p: { game_id: string; outcome: "keep" | "correct" | "set_aside" }) {
    const g = await gameView(db, p.game_id), b = await bookingInfo(db, g.booking_id!);
    return [...g.a, ...g.b].map((x) => ({ to: x.person_id, kind: `result_${p.outcome === "keep" ? "kept" : p.outcome === "correct" ? "corrected" : "set_aside"}`,
      params: { ...b.base, teamA: g.teamA, teamB: g.teamB, score: g.score }, purpose: "account" as const, essential: false, email: true, link: `/match/${b.id}` }));
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
    return [{ to: m.person_id, kind: "membership_started", params: { name: m.name, until, perks: { en: more.map((x) => x.en).join(" "), es: more.map((x) => x.es).join(" ") } },
      purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "membership.renewed"({ db, tz }, p: { membership_id: string; payment_id: string }) {
    const m = await membershipInfo(db, p.membership_id);
    const pay = await db.selectFrom("payment").select("amount_cents").where("id", "=", p.payment_id).executeTakeFirstOrThrow();
    return [{ to: m.person_id, kind: "membership_renewed", params: { name: m.name, amount: amount(pay.amount_cents), date: dayText(endDay({ current_period_end: m.current_period_end!, source: m.source }, tz)) },
      purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "membership.payment_failed"({ db, tz }, p: { membership_id: string; cents: number; next_attempt_at: string }) {
    const m = await membershipInfo(db, p.membership_id);
    return [{ to: m.person_id, kind: "membership_payment_failed", params: { name: m.name, amount: amount(p.cents), date: dayText(localDate(new Date(p.next_attempt_at), tz)) },
      purpose: "account", essential: true, email: true, link: "/membership" }];
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
    return [{ to: m.person_id, kind: m.end_reason === "not_paid" ? "membership_ended_unpaid" : "membership_ended", params: { name: m.name }, purpose: "account", essential: true, email: true, link: "/membership" }];
  },
  async "enrolment.booked"({ db, tz }, p: { enrolment_id: string }) {
    const e = await place(db, p.enrolment_id), due = await owes(db, e.id);
    // With something to pay, the confirmation comes with the payment; until then it's in the inbox only.
    // Paid already by the time this runs: the payment's message is the confirmation.
    if (due > 0) return [{ to: e.person_id, kind: "booked_to_pay", params: { name: e.name, when: when(e.start, tz), amount: amount(due) }, purpose: "account", essential: false, email: false, link: "/places" }];
    if (await paidFor(db, e.id) > 0) return [];
    return [{ to: e.person_id, kind: "booked", params: { name: e.name, when: when(e.start, tz) }, purpose: "account", essential: true, email: true, link: "/places" }];
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
  async "payment.failed"({ db }, p: { payment_id: string }) {
    const pay = await db.selectFrom("payment").select(["enrolment_id", "amount_cents", "person_id"]).where("id", "=", p.payment_id).executeTakeFirstOrThrow();
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
  async "enrolment.left"({ db, tz }, p: { enrolment_id: string; refund_outcome: string; refund_cents: number }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "left", params: { name: e.name, when: when(e.start, tz), refund: refundLine(p.refund_outcome, p.refund_cents, await paidFor(db, e.id)) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "enrolment.removed"({ db, tz }, p: { enrolment_id: string; reason: string; refund_outcome: string; refund_cents: number }) {
    const e = await place(db, p.enrolment_id);
    return [{ to: e.person_id, kind: "removed", params: { name: e.name, when: when(e.start, tz), reason: both(`reason.${p.reason}` as Key), refund: refundLine(p.refund_outcome, p.refund_cents, await paidFor(db, e.id)) }, purpose: "account", essential: true, email: true, link: "/places" }];
  },
  async "enrolment.transferred"({ db, tz }, p: { from: string; to: string; pay: "sub_pays" | "gift" }) {
    const from = await place(db, p.from), to = await place(db, p.to);
    const names = await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", [from.person_id, to.person_id]).execute();
    const name = (id: string) => names.find((n) => n.id === id)?.display_name ?? "";
    const due = await owes(db, to.id), paid = await paidFor(db, from.id);
    const drafts: Draft[] = [
      { to: from.person_id, kind: "passed_on", params: { name: from.name, when: when(from.start, tz), sub: name(to.person_id),
        refund: p.pay === "sub_pays" && paid > 0 ? both("msg.refund_after_sub", { amount: amount(paid), sub: name(to.person_id) }) : NOTHING }, purpose: "account", essential: true, email: true, link: "/places" },
      { to: to.person_id, kind: "passed_to_you", params: { name: to.name, when: when(to.start, tz), person: name(from.person_id),
        pay: due > 0 ? both("msg.pay_to_keep", { amount: amount(due) }) : both("msg.paid_for") }, purpose: "account", essential: true, email: true, link: "/places" },
    ];
    return drafts;
  },
  async "refund.failed"({ db }, p: { refund_id: string }) {
    const r = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("person", "person.id", "payment.person_id")
      .select(["refund.amount_cents", "refund.failure", "refund.enrolment_id", "person.display_name"]).where("refund.id", "=", p.refund_id).executeTakeFirstOrThrow();
    const e = r.enrolment_id ? await place(db, r.enrolment_id) : null;
    const params = { amount: amount(r.amount_cents), person: r.display_name, name: e?.name ?? "", failure: r.failure ?? "" };
    return (await managers(db)).map((to) => ({ to, kind: "refund_failed", params, purpose: "staff" as const, essential: false, email: true, link: e ? `/programs/${e.program_id}` : "/" }));
  },
  async "mirror.conflict"({ db, tz }, p: { court_name: string | null; start: string; type: string }) {
    const params = { court: p.court_name ?? "", when: when(new Date(p.start), tz), type: p.type.toLowerCase().replace(/_/g, " ") };
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
  // An account deleted: the club hears, without a name (it's gone), and who did it.
  async "privacy.erased"({ db, tz }, p: { self: boolean; by: string | null; juniors: number; at: string }) {
    const by = p.by ? (await db.selectFrom("person").select("display_name").where("id", "=", p.by).executeTakeFirst())?.display_name ?? "" : "";
    const params = { when: when(new Date(p.at), tz), how: p.self ? both("msg.privacy_erased_self") : both("msg.privacy_erased_by", { by }),
      juniors: p.juniors ? both("msg.privacy_erased_juniors", { count: p.juniors }) : NOTHING };
    return (await managers(db)).filter((to) => to !== p.by).map((to) => ({ to, kind: "privacy_erased_staff", params, purpose: "staff" as const, essential: false, email: true, link: "/people" }));
  },
};

/** A junior has no login: what's said to them goes to each adult who manages them, in that adult's language,
 *  saying whom it's about. An adult who'd get the same message anyway gets it once. A kid with a login of
 *  their own hears it themselves; their parents also hear what goes on their card at the deadline. */
const PARENTS_TOO = new Set(["booking_shares_charged", "booking_balance_due"]);
async function forJuniors(db: Db, drafts: Draft[]): Promise<(Draft & { junior?: string })[]> {
  const out: (Draft & { junior?: string })[] = [];
  for (const d of drafts) {
    const p = await db.selectFrom("person").select(["junior", "own_login", "display_name"]).where("id", "=", d.to).executeTakeFirst();
    if (!p?.junior) { out.push(d); continue; }
    if (p.own_login) { out.push(d); if (!PARENTS_TOO.has(d.kind)) continue; }
    for (const to of await managersOf(db, d.to)) if (!out.some((x) => x.to === to && x.kind === d.kind)) out.push({ ...d, to, junior: p.display_name });
  }
  return out;
}

/** A sentence that ends on a Spanish time ("10:00 a.m.") keeps one full stop, and an empty last line goes. */
const tidy = (text: string) => text.replace(/([ap]\.\s?m\.)\./g, "$1").replace(/\s+$/, "");

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
    let words = { subject: tidy(t(lang, `msg.${d.kind}.subject` as Key, d.params)), body: tidy(t(lang, `msg.${d.kind}.body` as Key, d.params)) };
    if (d.junior) words = { subject: t(lang, "msg.for_junior.subject", { name: d.junior, text: words.subject }), body: t(lang, "msg.for_junior.body", { name: d.junior, text: words.body }) };
    const base = { event_id: ev.id, person_id: d.to, kind: d.kind, purpose: d.purpose, essential: d.essential, lang, ...words, link: d.link ?? null, stale_at: d.staleAt ?? null };
    const rows = [{ ...base, id: uuidv7(now.getTime()), channel: "inbox", status: "sent", send_after: now, sent_at: now }];
    // Staff alerts and essential messages go straight away; the rest wait out quiet hours.
    const wait = d.essential || d.purpose === "staff" ? null : quietUntil(now, club.time_zone);
    if (d.email && person.email) rows.push({ ...base, id: uuidv7(now.getTime()), channel: "email", status: "waiting", send_after: wait ?? now, sent_at: null as any });
    // Every message also goes to the phones they turned notifications on for.
    if (await hasPushDevice(db, d.to)) rows.push({ ...base, id: uuidv7(now.getTime()), channel: "push", status: "waiting", send_after: wait ?? now, sent_at: null as any });
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
export async function sendEmails(db: Db, mailer: Mailer, now = new Date(), limit = 50): Promise<{ sent: number; dropped: number; failed: number }> {
  const out = { sent: 0, dropped: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const done = await db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom("outbound_message").innerJoin("person", "person.id", "outbound_message.person_id")
        .select(["outbound_message.id", "outbound_message.person_id", "outbound_message.purpose", "outbound_message.essential", "outbound_message.subject", "outbound_message.body",
          "outbound_message.stale_at", "outbound_message.attempts", "person.email"])
        .where("outbound_message.status", "=", "waiting").where("outbound_message.channel", "=", "email").where("outbound_message.send_after", "<=", now)
        .orderBy("outbound_message.send_after").limit(1).forUpdate("outbound_message").skipLocked().executeTakeFirst();
      if (!m) return null;
      // Consent is checked now, at the send: a member who said no to email since still isn't emailed,
      // except what they can't do without (sign-ins, confirmations, money).
      const why = !m.email ? "no email" : !m.essential && m.purpose !== "staff" && await refused(trx, m.person_id, "email", m.purpose) ? "no consent" : m.stale_at && m.stale_at <= now ? "stale" : null;
      if (why) {
        await trx.updateTable("outbound_message").set({ status: "dropped", failure: why }).where("id", "=", m.id).execute();
        return "dropped" as const;
      }
      try {
        await mailer.send({ to: m.email!, subject: m.subject, text: m.body, id: m.id });
        await trx.updateTable("outbound_message").set({ status: "sent", sent_at: now, attempts: sql`attempts + 1` }).where("id", "=", m.id).execute();
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
