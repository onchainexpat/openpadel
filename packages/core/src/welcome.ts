// The members' app's welcome for someone who moved in from Playtomic (the club's import, brought_in.ts and the mirror's
// take-over in playtomic_archive.ts): what came across with them, each part only when there is one, shown once at
// their first sign-in after the move and never again. Seeing it isn't a change anyone makes to the club, so it's kept
// as the app's own note on the person (like question.member_seen_at), not as an action; saying yes to texts there is
// the consent.texts action, as everywhere else.
import { sql } from "kysely";
import type { Db, Trx } from "./db.ts";
import { localDate } from "./clock.ts";
import { creditBalance } from "./money.ts";
import { endDay } from "./memberships.ts";

/** Whether this person came from Playtomic: added by the club's import, linked to a Playtomic player, or brought a
 *  membership or credit with them. */
export async function movedIn(db: Db | Trx, personId: string): Promise<boolean> {
  const r = await db.selectFrom("person").select(["created_via", "junior", "own_login"])
    .select((eb) => [
      eb.exists(eb.selectFrom("external_ref").select("entity_id").where("entity", "=", "person").where("system", "=", "playtomic").whereRef("entity_id", "=", sql`person.id::text`)).as("linked"),
      eb.exists(eb.selectFrom("membership").select("id").whereRef("membership.person_id", "=", "person.id").where("brought_from", "is not", null)).as("membership"),
      eb.exists(eb.selectFrom("brought_credit").select("id").whereRef("brought_credit.person_id", "=", "person.id")).as("credit"),
    ]).where("id", "=", personId).executeTakeFirst();
  if (!r || (r.junior && !r.own_login)) return false;
  return r.created_via === "import" || Boolean(r.linked) || Boolean(r.membership) || Boolean(r.credit);
}

/** Whether the welcome is still to show: moved in, and never seen. */
export async function welcomeDue(db: Db | Trx, personId: string): Promise<boolean> {
  const p = await db.selectFrom("person").select("welcomed_at").where("id", "=", personId).executeTakeFirst();
  return Boolean(p && !p.welcomed_at) && movedIn(db, personId);
}

/** Seen: never shown again. True the first time only. */
export async function welcomeSeen(db: Db | Trx, personId: string, now: Date): Promise<boolean> {
  const r = await db.updateTable("person").set({ welcomed_at: now }).where("id", "=", personId).where("welcomed_at", "is", null).executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** What came across: their upcoming bookings taken over from Playtomic, their level, club credit, and membership.
 *  Each is null (or empty) when there's none, and the app says so plainly. */
export async function welcomeFacts(db: Db | Trx, personId: string, now: Date) {
  const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
  const bookings = await db.selectFrom("booking_player").innerJoin("booking", "booking.id", "booking_player.booking_id").innerJoin("court_time", "court_time.booking_id", "booking.id")
    .innerJoin("court", "court.id", "court_time.court_id")
    .select(["booking.id", "court.name as court", sql<Date>`lower(court_time.during)`.as("start")])
    .where("booking_player.person_id", "=", personId).where("booking_player.removed_at", "is", null).where("booking.source", "=", "import")
    .where("booking.status", "=", "confirmed").where("court_time.active", "=", true).where(sql<boolean>`lower(court_time.during) > ${now}`)
    .orderBy(sql`lower(court_time.during)`).limit(20).execute();
  const rating = await db.selectFrom("rating").select("level").where("person_id", "=", personId).where("sport", "=", "padel").executeTakeFirst();
  const credit = await creditBalance(db, personId);
  const m = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
    .select(["membership.status", "membership.source", "membership.current_period_end", "membership.cancel_at_period_end", "membership.saved_method", "membership_plan.name", "membership_plan.translations"])
    // One that runs now (one not started yet came from the app, not across): the one brought from Playtomic first.
    .where("membership.person_id", "=", personId).where("membership.status", "in", ["active", "past_due"])
    .orderBy(sql`membership.brought_from IS NULL`).orderBy("membership.started_at", "desc").executeTakeFirst();
  // Renewing here (from the card they add in the app), or paid through a date and then over unless renewed at the desk.
  const renews = Boolean(m && m.source === "app" && !m.cancel_at_period_end);
  const membership = m ? { name: m.name, translations: m.translations, renews, needs_card: renews && !m.saved_method,
    date: m.current_period_end ? (renews ? localDate(m.current_period_end, tz) : endDay({ current_period_end: m.current_period_end, source: m.source }, tz)) : null } : null;
  return { time_zone: tz, bookings: bookings.map((b) => ({ id: b.id, court: b.court, start: new Date(b.start).toISOString() })), level: rating?.level ?? null, credit_cents: credit, membership };
}
