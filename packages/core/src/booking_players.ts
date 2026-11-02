// Players on a court booked and paid in full. The booker names who's playing (a member found by name, or a
// friend), or shares the booking's players link and the others add themselves. Nobody added pays anything, and
// taking a player off never moves money (rule 2: leaving and refunding are separate, and here there's nothing to
// refund). With four on it, any of them can enter the score, and the booker chooses whether it counts for levels.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { ENTER_DAYS } from "./results.ts";
import { notJunior, withManagers } from "./households.ts";
import { friendsOf } from "./friends.ts";
import { deskOrUp } from "./booking_pay.ts";

const when = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });

/** A court booking someone paid for in full, with its time, its booker and how many are on it now. Players can
 *  be named until the score can no longer be entered (a week after the start). */
async function wholeBooking(db: Db | Trx, o: { id?: string; code?: string }, now: Date) {
  const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
    .innerJoin("location", "location.id", "court.location_id").leftJoin("person", "person.id", "booking.organiser_id")
    .select(["booking.id", "booking.kind", "booking.status", "booking.pay_mode", "booking.players", "booking.organiser_id", "booking.location_id", "court.name as court", "location.time_zone",
      "person.display_name as booker", sql<Date>`lower(court_time.during)`.as("start")])
    .$if(Boolean(o.id), (q) => q.where("booking.id", "=", o.id!)).$if(!o.id, (q) => q.where("booking.invite_code", "=", o.code ?? ""))
    .where("court_time.active", "=", true).executeTakeFirst();
  if (!b) throw new KumiError(o.id ? "error.not_found" : "error.invite_closed", { thing: both("thing.booking") }, 404);
  if (b.kind !== "court" || b.pay_mode !== "whole" || !b.organiser_id) throw new KumiError("error.not_whole_booking");
  if (b.status !== "confirmed") throw new KumiError(b.status === "cancelled" ? "error.already_cancelled" : "error.invite_closed");
  if (now.getTime() > new Date(b.start).getTime() + ENTER_DAYS * 86400_000) throw new KumiError("error.players_closed");
  const on = await db.selectFrom("booking_player").select("person_id").where("booking_id", "=", b.id).where("removed_at", "is", null).where("leaving_at", "is", null).where("replaces", "is", null).execute();
  return { ...b, on: on.map((p) => p.person_id), when: when(new Date(b.start), b.time_zone) };
}
async function scored(db: Db | Trx, bookingId: string) {
  return Boolean(await db.selectFrom("game").select("id").where("booking_id", "=", bookingId).where("status", "!=", "void").executeTakeFirst());
}
async function someone(db: Db | Trx, personId: string): Promise<string> {
  const { row } = await readRow(db, "person", personId, "thing.person");
  if (row.status !== "active" || row.redacted_at) throw new KumiError("error.not_found", { thing: both("thing.person") }, 404);
  return row.display_name as string;
}
/** Put a player on the booking: one at a time, while there's room. */
async function seat(ctx: ApplyCtx, bookingId: string, personId: string, addedBy: string | null) {
  await ctx.trx.selectFrom("booking").select("id").where("id", "=", bookingId).forUpdate().execute();
  const b = await wholeBooking(ctx.trx, { id: bookingId }, ctx.now);
  if (b.on.includes(personId)) throw new KumiError("error.already_in_booking");
  if (b.on.length >= b.players) throw new KumiError("error.changed");
  const id = uuidv7();
  await ctx.insert("booking_player", { id, booking_id: bookingId, person_id: personId, share_cents: 0, added_by: addedBy });
  await ctx.emit("booking.player_added", { booking_player_id: id, by: addedBy });
  return id;
}

export const bookingAddPlayer = defineAction({
  name: "booking.add_player", version: 1,
  input: z.object({ booking_id: z.uuid(), person_id: z.uuid() }),
  async plan(ctx, i) {
    const b = await wholeBooking(ctx.db, { id: i.booking_id }, ctx.now);
    const person = await someone(ctx.db, i.person_id);
    if (b.on.includes(i.person_id)) throw new KumiError("error.already_in_booking");
    if (b.on.length >= b.players) throw new KumiError("error.booking_full");
    await notJunior(ctx.db, i.person_id);
    // The front desk and up name anyone (they know the members, and add them at the desk). A booker only names someone
    // they know (a host can't put a stranger's name on a booking); anyone else uses the link.
    const staff = await deskOrUp(ctx.db, ctx.actor.personId) && ctx.actor.personId !== b.organiser_id;
    if (!staff) {
      const f = await friendsOf(ctx.db, b.organiser_id!);
      if (![...f.friends, ...f.added_you, ...f.you_added, ...f.played_with].some((p) => p.id === i.person_id)) throw new KumiError("error.not_known_player");
    }
    const summary = staff ? both("plan.booking.add_player_staff", { person, booker: b.booker ?? "", court: b.court, when: b.when }) : both("plan.booking.add_player", { person, court: b.court, when: b.when });
    return { title: both("action.booking.add_player"), summary, reads: [], locationId: b.location_id,
      ownerIds: await withManagers(ctx.db, [b.organiser_id]), undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { return { booking_player_id: await seat(ctx, i.booking_id, i.person_id, ctx.actor.personId) }; },
});

/** From the booking's players link: add yourself. Nothing to pay; the booker paid for the court. */
export const bookingJoinPlayers = defineAction({
  name: "booking.join_players", version: 1,
  input: z.object({ invite_code: z.string().check(z.minLength(8)), person_id: z.uuid() }),
  async plan(ctx, i) {
    const b = await wholeBooking(ctx.db, { code: i.invite_code }, ctx.now);
    if (b.on.includes(i.person_id)) throw new KumiError("error.already_in_booking");
    if (b.on.length >= b.players) throw new KumiError("error.booking_full");
    await notJunior(ctx.db, i.person_id);
    return { title: both("action.booking.join_players"), summary: both("plan.booking.join_players", { booker: b.booker ?? "", court: b.court, when: b.when }), reads: [],
      locationId: b.location_id, ownerIds: await withManagers(ctx.db, [i.person_id]), undo: { kind: "reversible" }, details: { booking_id: b.id } };
  },
  async apply(ctx, i, plan) {
    const { booking_id } = plan.details as { booking_id: string };
    return { booking_id, booking_player_id: await seat(ctx, booking_id, i.person_id, i.person_id) };
  },
});

/** Take a named player off: the booker, or the player themself. Never moves money. */
export const bookingRemovePlayer = defineAction({
  name: "booking.remove_player", version: 1,
  input: z.object({ booking_player_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "booking_player", i.booking_player_id, "thing.booking");
    const b = await wholeBooking(ctx.db, { id: p.booking_id }, ctx.now);
    if (p.removed_at || !p.person_id || p.person_id === b.organiser_id || p.share_cents) throw new KumiError("error.not_in_match");
    if (await scored(ctx.db, b.id)) throw new KumiError("error.players_scored");
    const self = ctx.actor.personId === p.person_id || (await withManagers(ctx.db, [p.person_id])).includes(ctx.actor.personId ?? "");
    const booker = (await withManagers(ctx.db, [b.organiser_id])).includes(ctx.actor.personId ?? "");
    const summary = self ? both("plan.booking.remove_me", { booker: b.booker ?? "", court: b.court, when: b.when })
      : both(booker ? "plan.booking.remove_player" : "plan.booking.remove_player_staff", { person: await someone(ctx.db, p.person_id), booker: b.booker ?? "", court: b.court, when: b.when });
    return { title: both("action.booking.remove_player"), summary, reads: [read], locationId: b.location_id, undo: { kind: "reversible" },
      ownerIds: await withManagers(ctx.db, [b.organiser_id, p.person_id]) };
  },
  async apply(ctx, i) {
    await ctx.update("booking_player", i.booking_player_id, { removed_at: ctx.now });
    await ctx.emit("booking.player_removed", { booking_player_id: i.booking_player_id, by: ctx.actor.personId });
    return null;
  },
});

/** A booking that isn't an open match: whether its game counts for levels. The booker chooses, before the score's in. */
export const bookingSetRated = defineAction({
  name: "booking.set_rated", version: 1,
  input: z.object({ booking_id: z.uuid(), rated: z.boolean() }),
  async plan(ctx, i) {
    const b = await ctx.db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
      .innerJoin("location", "location.id", "court.location_id").select(["booking.id", "booking.kind", "booking.status", "booking.organiser_id", "booking.location_id", "court.name as court",
        "location.time_zone", sql<Date>`lower(court_time.during)`.as("start")]).where("booking.id", "=", i.booking_id).where("court_time.active", "=", true).executeTakeFirst();
    if (!b) throw new KumiError("error.not_found", { thing: both("thing.booking") }, 404);
    if (b.kind !== "court" || !b.organiser_id) throw new KumiError("error.not_whole_booking");
    if (b.status === "cancelled") throw new KumiError("error.already_cancelled");
    if (await ctx.db.selectFrom("open_match").select("booking_id").where("booking_id", "=", b.id).executeTakeFirst()) throw new KumiError("error.match_rated_fixed");
    if (await scored(ctx.db, b.id)) throw new KumiError("error.players_scored");
    const p = { court: b.court, when: when(new Date(b.start), b.time_zone) };
    return { title: both("action.booking.set_rated"), summary: both(i.rated ? "plan.booking.rated_on" : "plan.booking.rated_off", p), reads: [], locationId: b.location_id,
      ownerIds: await withManagers(ctx.db, [b.organiser_id]), undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("booking", i.booking_id, { rated: i.rated }); return null; },
});

/** Finding players to name on a booking, by name: only people whose names this person already sees on their Friends
 *  page (friends first, then who added them, whom they added, and who they've played with lately). No other member's
 *  name is shown to someone they haven't played with or given their link to: anyone else comes in by the players link. */
export async function findPlayers(db: Db | Trx, personId: string, q: string) {
  const needle = q.trim().toLocaleLowerCase();
  if (needle.length < 2) return [];
  const f = await friendsOf(db, personId), match = (p: { display_name: string }) => p.display_name.toLocaleLowerCase().includes(needle);
  return [...f.friends.filter(match).map((p) => ({ id: p.id, display_name: p.display_name, friend: true })),
    ...[...f.added_you, ...f.you_added, ...f.played_with].filter(match).map((p) => ({ id: p.id, display_name: p.display_name, friend: false }))].slice(0, 10);
}
