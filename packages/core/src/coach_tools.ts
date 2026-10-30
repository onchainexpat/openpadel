// Coach tools (v1 scope, Coaches): who's coming to each lesson and program date a coach runs (their level,
// a junior's parents, the waiver), who came, the people a coach has worked with lately, and a calendar link
// a coach's phone subscribes to. "Didn't come" counts in a player's no-show record (playerRecord), and
// setting a clinic's levels leaves out whoever didn't come.
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, pickLang, t, type Lang, type Text } from "@kumi/i18n";
import { defineAction, type Read } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { managersOf, waiverStatus } from "./households.ts";
import { uuidv7 } from "./ids.ts";
import { icsCalendar, type IcsEvent } from "./ical.ts";

/** Attendance can be marked from the start until this many hours after (like an open match's no-shows). */
export const ATTENDANCE_HOURS = 48;
/** "My students": the people a coach worked with in this many days. */
export const STUDENT_DAYS = 90;
/** What a calendar link covers: this far back, and this far ahead. */
const FEED_BACK_DAYS = 90, FEED_AHEAD_DAYS = 180;

const clubTz = async (db: Db | Trx) => (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
const whenText = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });
const NONE = "00000000-0000-0000-0000-000000000000";
/** A junior goes into a coach's calendar (which leaves the club for Google, Apple or Microsoft) by first name only. */
const calendarName = (p: { display_name: string; junior: boolean }) => p.junior ? p.display_name.trim().split(/\s+/)[0]! : p.display_name;

export type CoachItemKind = "lesson" | "session";

/** A lesson or a program date: when, where, who runs it, and whether it's off. */
export async function coachItem(db: Db | Trx, kind: CoachItemKind, id: string) {
  if (kind === "lesson") {
    const b = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
      .innerJoin("location", "location.id", "court.location_id").leftJoin("person as coach", "coach.id", "booking.coach_id")
      .select(["booking.id", "booking.code", "booking.status", "booking.coach_id", "booking.location_id", "booking.version", "court.name as court", "location.name as location", "location.address",
        "coach.display_name as coach", sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
      .where("booking.id", "=", id).where("booking.kind", "=", "lesson")
      // A cancelled lesson's court time is let go; its time is still when it was meant to be.
      .where(sql<boolean>`court_time.id = (SELECT ct.id FROM court_time ct WHERE ct.booking_id = booking.id ORDER BY ct.active DESC, ct.id LIMIT 1)`).executeTakeFirst();
    if (!b) throw new KumiError("error.not_found", { thing: both("thing.booking") }, 404);
    return { kind, id: b.id, program_id: null, name: null, code: b.code, start: new Date(b.start), end: new Date(b.end), cancelled: b.status === "cancelled", status: b.status,
      coach_id: b.coach_id, coach: b.coach, location_id: b.location_id, courts: [b.court], location: b.location, address: b.address };
  }
  const s = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").innerJoin("location", "location.id", "program.location_id")
    .leftJoin("person as coach", "coach.id", "session.coach_id")
    .select(["session.id", "session.program_id", "session.starts_at", "session.ends_at", "session.status", "session.coach_id", "program.name", "program.location_id",
      "location.name as location", "location.address", "coach.display_name as coach"])
    .where("session.id", "=", id).executeTakeFirst();
  if (!s) throw new KumiError("error.not_found", { thing: both("thing.session") }, 404);
  const courts = await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").select("court.name").where("court_time.session_id", "=", id).where("court_time.active", "=", true)
    .orderBy("court.sort").orderBy("court.name").execute();
  return { kind, id: s.id, program_id: s.program_id, name: s.name, code: null, start: new Date(s.starts_at), end: new Date(s.ends_at), cancelled: s.status === "cancelled", status: s.status,
    coach_id: s.coach_id, coach: s.coach, location_id: s.location_id, courts: courts.map((c) => c.name), location: s.location, address: s.address };
}

/** Whether attendance can be marked now: from the start until ATTENDANCE_HOURS after. */
export const attendanceOpen = (start: Date, now: Date) => now.getTime() >= start.getTime() && now.getTime() <= start.getTime() + ATTENDANCE_HOURS * 3600_000;

/** Who has a place: a lesson's players, or everyone signed up for the date (or the whole program). */
async function placesIn(db: Db | Trx, item: { kind: CoachItemKind; id: string; program_id: string | null }) {
  if (item.kind === "lesson")
    return db.selectFrom("booking_player").innerJoin("person", "person.id", "booking_player.person_id").select(["person.id as person_id", "person.display_name", "person.junior"])
      .where("booking_player.booking_id", "=", item.id).where("booking_player.removed_at", "is", null).where("booking_player.replaces", "is", null).orderBy("person.display_name").execute();
  return db.selectFrom("enrolment").innerJoin("person", "person.id", "enrolment.person_id").select(["person.id as person_id", "person.display_name", "person.junior"]).distinct()
    .where("enrolment.program_id", "=", item.program_id!).where("enrolment.status", "in", ["booked", "attended"])
    .where((eb) => eb.or([eb("enrolment.session_id", "=", item.id), eb("enrolment.session_id", "is", null)])).orderBy("person.display_name").execute();
}

/** The marks so far, by person (only real marks: a cleared one is as if never marked). */
async function marksFor(db: Db | Trx, kind: CoachItemKind, id: string) {
  const rows = await db.selectFrom("attendance").select(["id", "person_id", "came", "version"]).where(kind === "lesson" ? "booking_id" : "session_id", "=", id).execute();
  return new Map(rows.map((r) => [r.person_id, r]));
}

/** A lesson's or a program date's list: each player's level, a junior's parents, the waiver, and the mark. */
export async function rosterOf(db: Db | Trx, kind: CoachItemKind, id: string, now: Date) {
  const item = await coachItem(db, kind, id);
  const people = await placesIn(db, item), ids = people.length ? people.map((p) => p.person_id) : [NONE];
  const levels = await db.selectFrom("rating").select(["person_id", "level", "provisional"]).where("person_id", "in", ids).where("sport", "=", "padel").execute();
  const marks = await marksFor(db, kind, id);
  const players = [];
  for (const p of people) {
    const r = levels.find((l) => l.person_id === p.person_id), w = await waiverStatus(db, p.person_id);
    const parents = p.junior ? await db.selectFrom("person").select("display_name").where("id", "in", [...await managersOf(db, p.person_id), NONE]).orderBy("display_name").execute() : [];
    players.push({ person_id: p.person_id, name: p.display_name, level: r ? Number(r.level).toFixed(2) : null, provisional: r?.provisional ?? null, junior: p.junior,
      parents: parents.map((x) => x.display_name), waiver: w === null ? null : w.accepted_at ? "accepted" as const : "missing" as const, came: marks.get(p.person_id)?.came ?? null });
  }
  return { item, marking: { open: !item.cancelled && attendanceOpen(item.start, now), until: new Date(item.start.getTime() + ATTENDANCE_HOURS * 3600_000) }, players };
}

const markInput = z.object({ person_id: z.uuid(), came: z.nullable(z.boolean()) });
export const attendanceMark = defineAction({
  name: "attendance.mark", version: 1,
  input: z.object({ session_id: z.optional(z.uuid()), booking_id: z.optional(z.uuid()), marks: z.array(markInput).check(z.minLength(1), z.maxLength(64)) }),
  async plan(ctx, i) {
    if (Boolean(i.session_id) === Boolean(i.booking_id)) throw new KumiError("error.invalid_input", { details: "session_id or booking_id" }, 400);
    const kind: CoachItemKind = i.session_id ? "session" : "lesson", id = (i.session_id ?? i.booking_id)!;
    const r = await rosterOf(ctx.db, kind, id, ctx.now);
    if (r.item.cancelled) throw new KumiError(kind === "session" ? "error.session_cancelled" : "error.already_cancelled");
    if (!r.marking.open) throw new KumiError("error.attendance_window", { hours: ATTENDANCE_HOURS });
    if (new Set(i.marks.map((m) => m.person_id)).size !== i.marks.length) throw new KumiError("error.player_twice");
    const changes: { person_id: string; name: string; came: boolean | null }[] = [];
    for (const m of i.marks) {
      const p = r.players.find((x) => x.person_id === m.person_id);
      if (!p) {
        const who = await ctx.db.selectFrom("person").select("display_name").where("id", "=", m.person_id).executeTakeFirst();
        throw new KumiError("error.not_in_session", { person: who?.display_name ?? "" });
      }
      if (p.came !== m.came) changes.push({ person_id: m.person_id, name: p.name, came: m.came });
    }
    if (!changes.length) throw new KumiError("error.attendance_unchanged");
    const marks = await marksFor(ctx.db, kind, id);
    const reads: Read[] = changes.flatMap((c) => { const x = marks.get(c.person_id); return x ? [{ entity: "attendance" as const, id: x.id, version: x.version }] : []; });
    const tz = await clubTz(ctx.db), when = whenText(r.item.start, tz);
    const what: Text = kind === "lesson" ? both("plan.attendance.lesson", { court: r.item.courts.join(", ") }) : { en: r.item.name!, es: r.item.name! };
    const group = (came: boolean | null, key: "plan.attendance.came" | "plan.attendance.not_came" | "plan.attendance.cleared") => {
      const names = changes.filter((c) => c.came === came).map((c) => c.name);
      return names.length ? both(key, { names: names.join(", ") }) : null;
    };
    const parts = [group(true, "plan.attendance.came"), group(false, "plan.attendance.not_came"), group(null, "plan.attendance.cleared")].filter((x): x is Text => x !== null);
    const noShow = changes.some((c) => c.came === false) ? both("plan.attendance.told") : { en: "", es: "" };
    return { title: both("action.attendance.mark"), reads, locationId: r.item.location_id, ownerIds: r.item.coach_id ? [r.item.coach_id] : [], undo: { kind: "compensating" },
      details: { kind, id, changes: changes.map((c) => ({ person_id: c.person_id, came: c.came })) },
      summary: both("plan.attendance.mark", { what, when, marks: { en: parts.map((p) => p.en).join("; "), es: parts.map((p) => p.es).join("; ") }, told: noShow }) };
  },
  async apply(ctx, i, plan) {
    const { kind, id, changes } = plan.details as { kind: CoachItemKind; id: string; changes: { person_id: string; came: boolean | null }[] };
    const item = await coachItem(ctx.trx, kind, id), by = ctx.actor.personId;
    const told: string[] = [];
    for (const c of changes) {
      const was = await ctx.trx.selectFrom("attendance").select(["id", "came"]).where(kind === "lesson" ? "booking_id" : "session_id", "=", id).where("person_id", "=", c.person_id).forUpdate().executeTakeFirst();
      if (was) await ctx.update("attendance", was.id, { came: c.came, marked_by: by, marked_at: ctx.now });
      else {
        try { await ctx.insert("attendance", { id: uuidv7(), session_id: kind === "session" ? id : null, booking_id: kind === "lesson" ? id : null, person_id: c.person_id, came: c.came, marked_by: by, marked_at: ctx.now }); }
        catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
      }
      if (c.came === false && was?.came !== false) told.push(c.person_id);
    }
    // Someone marked as not having come hears it (so they can say if it's wrong), worked out now.
    if (told.length) {
      const tz = await clubTz(ctx.trx), marker = by ? (await ctx.trx.selectFrom("person").select("display_name").where("id", "=", by).executeTakeFirst())?.display_name ?? "" : "";
      const what: Text = kind === "lesson" ? both("msg.attendance_lesson", { coach: item.coach ?? marker }) : { en: item.name!, es: item.name! };
      await ctx.emit("attendance.no_show", { people: told, what, when: whenText(item.start, tz), by: marker });
    }
    return { marked: changes.length };
  },
});

/** The people a coach worked with in the last STUDENT_DAYS days (whoever was marked as not coming left out),
 *  each with their level now, how many times, and the last time. */
export async function coachStudents(db: Db | Trx, coachId: string, now: Date) {
  const since = new Date(now.getTime() - STUDENT_DAYS * 86400_000);
  const dates = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").innerJoin("enrolment", "enrolment.program_id", "program.id")
    .innerJoin("person", "person.id", "enrolment.person_id")
    .leftJoin("attendance", (j) => j.onRef("attendance.session_id", "=", "session.id").onRef("attendance.person_id", "=", "enrolment.person_id"))
    .select(["person.id as person_id", "person.display_name", "person.junior", "session.id", "session.starts_at as at", "program.name"])
    .where("session.coach_id", "=", coachId).where("session.status", "!=", "cancelled").where("session.starts_at", ">=", since).where("session.starts_at", "<=", now)
    .where("enrolment.status", "in", ["booked", "attended"]).where((w) => w.or([w("enrolment.session_id", "is", null), w("enrolment.session_id", "=", w.ref("session.id"))]))
    .where((w) => w.or([w("attendance.came", "is", null), w("attendance.came", "=", true)])).where("person.redacted_at", "is", null).execute();
  const lessons = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("booking_player", "booking_player.booking_id", "booking.id")
    .innerJoin("person", "person.id", "booking_player.person_id")
    .leftJoin("attendance", (j) => j.onRef("attendance.booking_id", "=", "booking.id").onRef("attendance.person_id", "=", "booking_player.person_id"))
    .select(["person.id as person_id", "person.display_name", "person.junior", "booking.id", sql<Date>`lower(court_time.during)`.as("at")])
    .where("booking.kind", "=", "lesson").where("booking.coach_id", "=", coachId).where("booking.status", "in", ["confirmed", "completed"]).where("court_time.active", "=", true)
    .where(sql<boolean>`lower(court_time.during) >= ${since}`).where(sql<boolean>`lower(court_time.during) <= ${now}`)
    .where("booking_player.removed_at", "is", null).where("booking_player.replaces", "is", null)
    .where((w) => w.or([w("attendance.came", "is", null), w("attendance.came", "=", true)])).where("person.redacted_at", "is", null).execute();
  const by = new Map<string, { person_id: string; name: string; junior: boolean; times: number; last_at: Date; last_kind: CoachItemKind; last_name: string | null }>();
  const add = (person_id: string, name: string, junior: boolean, at: Date, kind: CoachItemKind, what: string | null) => {
    const x = by.get(person_id);
    if (!x) by.set(person_id, { person_id, name, junior, times: 1, last_at: new Date(at), last_kind: kind, last_name: what });
    else { x.times++; if (new Date(at) > x.last_at) Object.assign(x, { last_at: new Date(at), last_kind: kind, last_name: what }); }
  };
  for (const d of dates) add(d.person_id, d.display_name, d.junior, d.at, "session", d.name);
  for (const l of lessons) add(l.person_id, l.display_name, l.junior, l.at, "lesson", null);
  const ids = [...by.keys()];
  const levels = await db.selectFrom("rating").select(["person_id", "level", "provisional"]).where("person_id", "in", ids.length ? ids : [NONE]).where("sport", "=", "padel").execute();
  return [...by.values()].map((x) => { const r = levels.find((l) => l.person_id === x.person_id); return { ...x, level: r ? Number(r.level).toFixed(2) : null, provisional: r?.provisional ?? null }; })
    .sort((a, b) => b.last_at.getTime() - a.last_at.getTime() || a.name.localeCompare(b.name));
}

// ---- The calendar link ----
/** The coach's live calendar token, if they've made one. */
export async function calendarToken(db: Db | Trx, personId: string): Promise<{ token: string; created_at: Date } | null> {
  return (await db.selectFrom("calendar_feed").select(["token", "created_at"]).where("person_id", "=", personId).where("revoked_at", "is", null).executeTakeFirst()) ?? null;
}
/** A new calendar link; the old one (if any) stops working at once. */
export async function newCalendarToken(db: Db, personId: string, now = new Date()): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("calendar_feed").set({ revoked_at: now }).where("person_id", "=", personId).where("revoked_at", "is", null).execute();
    await trx.insertInto("calendar_feed").values({ id: uuidv7(), person_id: personId, token, created_at: now }).execute();
  });
  return token;
}

/** A coach's calendar, for the link's token: their lessons and program dates from FEED_BACK_DAYS ago to
 *  FEED_AHEAD_DAYS ahead, in their language. Players by display name (juniors by first name), never contact
 *  details. Cancelled ones stay in as cancelled, so a calendar drops them. Null for a link that's been
 *  replaced, or a person who isn't a coach any more. */
export async function coachCalendar(db: Db | Trx, token: string, now = new Date()): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return null;
  const f = await db.selectFrom("calendar_feed").innerJoin("person", "person.id", "calendar_feed.person_id")
    .select(["person.id", "person.display_name", "person.locale", "person.status", "person.redacted_at"]).where("calendar_feed.token", "=", token).where("calendar_feed.revoked_at", "is", null).executeTakeFirst();
  if (!f || f.redacted_at || f.status === "archived") return null;
  const coach = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id")
    .where("person_role.person_id", "=", f.id).where("person_role.active", "=", true).where("role.key", "=", "coach").executeTakeFirst();
  if (!coach) return null;
  const club = await db.selectFrom("club").select(["name", "default_language"]).executeTakeFirstOrThrow();
  const lang: Lang = pickLang(f.locale, pickLang(club.default_language));
  const from = new Date(now.getTime() - FEED_BACK_DAYS * 86400_000), to = new Date(now.getTime() + FEED_AHEAD_DAYS * 86400_000);
  const place = (courts: string[], location: string, address: string | null) => [courts.join(", "), location, address].filter(Boolean).join(", ");
  const names = (rows: { display_name: string; junior: boolean }[]) => rows.map(calendarName).join(", ");
  const events: IcsEvent[] = [];

  const lessons = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
    .innerJoin("location", "location.id", "court.location_id")
    .select(["booking.id", "booking.code", "booking.status", "booking.version", "court.name as court", "location.name as location", "location.address",
      sql<Date>`lower(court_time.during)`.as("start"), sql<Date>`upper(court_time.during)`.as("end")])
    .where("booking.kind", "=", "lesson").where("booking.coach_id", "=", f.id).where("booking.status", "in", ["confirmed", "completed", "cancelled"])
    // Never confirmed (the card form wasn't finished, or the court went to someone else): never in a calendar.
    .where((w) => w.or([w("booking.cancel_reason", "is", null), w("booking.cancel_reason", "not in", ["not_paid", "hold_lost"])]))
    .where(sql<boolean>`court_time.id = (SELECT ct.id FROM court_time ct WHERE ct.booking_id = booking.id ORDER BY ct.active DESC, ct.id LIMIT 1)`)
    .where(sql<boolean>`lower(court_time.during) >= ${from}`).where(sql<boolean>`lower(court_time.during) < ${to}`).execute();
  for (const l of lessons) {
    const who = await db.selectFrom("booking_player").innerJoin("person", "person.id", "booking_player.person_id").select(["person.display_name", "person.junior"])
      .where("booking_player.booking_id", "=", l.id).where("booking_player.removed_at", "is", null).where("booking_player.replaces", "is", null).orderBy("person.display_name").execute();
    events.push({ uid: `lesson-${l.id}@kumi`, start: new Date(l.start), end: new Date(l.end), sequence: l.version, status: l.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
      summary: t(lang, "ical.lesson", { players: names(who) || t(lang, "ical.nobody") }), location: place([l.court], l.location, l.address),
      description: t(lang, "ical.lesson_details", { count: who.length, players: names(who), code: l.code }) });
  }

  const dates = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").innerJoin("location", "location.id", "program.location_id")
    .select(["session.id", "session.program_id", "session.starts_at", "session.ends_at", "session.status", "session.version", "program.name", "location.name as location", "location.address"])
    .where("session.coach_id", "=", f.id).where("session.starts_at", ">=", from).where("session.starts_at", "<", to).execute();
  for (const s of dates) {
    const courts = await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").select("court.name").where("court_time.session_id", "=", s.id)
      .where("court_time.active", "=", s.status !== "cancelled").orderBy("court.sort").orderBy("court.name").execute();
    const who = await placesIn(db, { kind: "session", id: s.id, program_id: s.program_id });
    events.push({ uid: `session-${s.id}@kumi`, start: new Date(s.starts_at), end: new Date(s.ends_at), sequence: s.version, status: s.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
      summary: t(lang, "ical.session", { program: s.name, count: who.length }), location: place([...new Set(courts.map((c) => c.name))], s.location, s.address),
      description: who.length ? t(lang, "ical.session_details", { players: names(who) }) : t(lang, "ical.nobody") });
  }
  events.sort((a, b) => a.start.getTime() - b.start.getTime());
  return icsCalendar({ prodId: "-//Kumi//Coach calendar//EN", name: t(lang, "ical.name", { club: club.name, coach: f.display_name }), refreshMinutes: 60, events, now });
}
