// Checking in at the desk: the players of a booking have arrived. Each place is marked on its own, so a group that comes
// in ones and twos is checked in as it comes, and a check-in made by mistake is taken back the same way. It tells
// nobody and moves no money; it's what Today's "Now and next" and the Schedule show of who's in.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, formatLocale, type Text } from "@kumi/i18n";
import { defineAction, type Read } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";

/** From when to when a booking can be checked in: a while before it starts (players come early) until well after. */
export const CHECK_IN_BEFORE_MINUTES = 120, CHECK_IN_AFTER_HOURS = 12;
export const checkInOpen = (start: Date, end: Date, now: Date) =>
  now.getTime() >= start.getTime() - CHECK_IN_BEFORE_MINUTES * 60_000 && now.getTime() <= end.getTime() + CHECK_IN_AFTER_HOURS * 3600_000;

/** A booking where it is now, and its places (those still in it), with who's checked in. */
export async function checkInFacts(db: Db | Trx, bookingId: string) {
  const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
    .innerJoin("location", "location.id", "court.location_id")
    .select(["booking.id", "booking.code", "booking.status", "booking.location_id", "booking.kind", "booking.coach_id", "court.name as court", "location.time_zone",
      sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
    .where("booking.id", "=", bookingId).where("court_time.active", "=", true).where("court_time.kind", "=", "booking").executeTakeFirst();
  if (!b) throw new KumiError("error.not_found", { thing: both("thing.booking") }, 404);
  const places = await db.selectFrom("booking_player").leftJoin("person", "person.id", "booking_player.person_id")
    .select(["booking_player.id", "booking_player.person_id", "booking_player.guest_name", "booking_player.checked_in_at", "booking_player.version", "person.display_name"])
    .where("booking_player.booking_id", "=", bookingId).where("booking_player.removed_at", "is", null).where("booking_player.leaving_at", "is", null).orderBy("booking_player.id").execute();
  return { ...b, start: new Date(b.start), end: new Date(b.end), places };
}

export const bookingCheckIn = defineAction({
  name: "booking.check_in", version: 1,
  input: z.object({ booking_id: z.uuid(),
    booking_player_ids: z.optional(z.array(z.uuid()).check(z.minLength(1), z.maxLength(8), z.describe("The places to mark. Left out: everyone in the booking."))),
    checked_in: z.optional(z.boolean().check(z.describe("No (false) takes a check-in back. Left out: checks in."))) }),
  async plan(ctx, i) {
    const b = await checkInFacts(ctx.db, i.booking_id), want = i.checked_in ?? true;
    if (b.status === "cancelled") throw new KumiError("error.already_cancelled");
    if (b.status !== "confirmed" && b.status !== "completed") throw new KumiError("error.booking_not_confirmed");
    if (!checkInOpen(b.start, b.end, ctx.now)) throw new KumiError("error.check_in_window", { before: CHECK_IN_BEFORE_MINUTES, after: CHECK_IN_AFTER_HOURS });
    if (i.booking_player_ids && new Set(i.booking_player_ids).size !== i.booking_player_ids.length) throw new KumiError("error.player_twice");
    const chosen = i.booking_player_ids ? i.booking_player_ids.map((id) => b.places.find((p) => p.id === id) ?? null) : b.places;
    if (!chosen.length || chosen.some((p) => !p)) throw new KumiError("error.not_in_booking");
    const changing = chosen.filter((p) => Boolean(p!.checked_in_at) !== want).map((p) => p!);
    if (!changing.length) throw new KumiError(want ? "error.already_checked_in" : "error.not_checked_in");
    const reads: Read[] = changing.map((p) => ({ entity: "booking_player", id: p.id, version: p.version }));
    const named = changing.map((x): Text => (x.display_name ? { en: x.display_name, es: x.display_name } : both("plan.check_in.guest", { name: x.guest_name ?? "" })));
    const clock = (l: "en" | "es") => new Intl.DateTimeFormat(formatLocale(l), { timeZone: b.time_zone, hour: "numeric", minute: "2-digit" }).format(b.start);
    const p = { names: { en: named.map((n) => n.en).join(", "), es: named.map((n) => n.es).join(", ") } as Text, court: b.court, time: { en: clock("en"), es: clock("es") } as Text, code: b.code };
    const all = !i.booking_player_ids && changing.length === b.places.length;
    const summary = both(want ? (all ? "plan.check_in.all" : "plan.check_in.some") : "plan.check_in.undo", { ...p, count: changing.length });
    const quiet = both("plan.check_in.quiet");
    return { title: both(want ? "action.booking.check_in" : "action.booking.check_in_undo"), summary: { en: `${summary.en} ${quiet.en}`, es: `${summary.es} ${quiet.es}` },
      reads, locationId: b.location_id, ownerIds: b.kind === "lesson" && b.coach_id ? [b.coach_id] : [], undo: { kind: "reversible" }, details: { places: changing.map((x) => x.id), want } };
  },
  async apply(ctx, i, plan) {
    const { places, want } = plan.details as { places: string[]; want: boolean };
    for (const id of places) await ctx.update("booking_player", id, want ? { checked_in_at: ctx.now, checked_in_by: ctx.actor.personId } : { checked_in_at: null, checked_in_by: null });
    return { booking_id: i.booking_id, checked_in: want ? places.length : 0, taken_back: want ? 0 : places.length };
  },
});
