// "Tell me when" (the boards' priority alerts). A member asks to hear when a court frees up on a day, in a window of
// start times they pick at one location (Book), or when an open match opens whose level band fits theirs (Play).
// The alert is the member's own row, turned on and off by these actions; what notices the news is the change that
// makes it (a booking called off frees its time, an open match is confirmed), which says so through the outbox, and
// the messages code tells whoever's alert fits, through the usual consent, quiet hours, push and email (never a
// text). One message per freed start time or match per person, and a cap (ALERT_CAP) so a busy day isn't a flood.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, dateTime, formatLocale, type Key, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate, localParts, onDate } from "./clock.ts";
import { withManagers } from "./households.ts";
import { currentPolicy } from "./prices.ts";

/** At most this many messages from one court alert (its day), and from match alerts in any 24 hours. */
export const ALERT_CAP = 3;
/** Court alerts a person can have on at once, across days and locations. */
export const MAX_COURT_ALERTS = 7;
/** A freed time is worth telling only if a game fits in it: this many minutes from a start in the window. */
const SHORTEST_GAME = 60;

const join2 = (a: Text, b: Text): Text => ({ en: a.en + b.en, es: a.es + b.es });
const hhmm = z.string().check(z.regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.describe("A time of day in the location's time, HH:MM."));
const minutesOf = (t: string) => { const [h, m] = t.split(":").map(Number) as [number, number]; return h * 60 + m; };
/** "6:00 PM", "18:00", as the reader's language says a time of day. */
const clock = (t: string): Text => {
  const m = minutesOf(t), f = (l: Lang) => new Intl.DateTimeFormat(formatLocale(l), { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, Math.floor(m / 60), m % 60)));
  return { en: f("en"), es: f("es") };
};
/** "Wednesday, December 2" in each language. */
const dayOf = (date: string): Text => {
  const f = (l: Lang) => new Intl.DateTimeFormat(formatLocale(l), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  return { en: f("en"), es: f("es") };
};
const nameOf = async (db: Db | Trx, id: string) => (await db.selectFrom("person").select("display_name").where("id", "=", id).executeTakeFirst())?.display_name ?? "";
const levelOf = async (db: Db | Trx, id: string) => {
  const r = await db.selectFrom("rating").select("level").where("person_id", "=", id).where("sport", "=", "padel").executeTakeFirst();
  return r?.level == null ? null : Number(r.level);
};

export const playAlertSet = defineAction({
  name: "play_alert.set", version: 1,
  input: z.object({
    person_id: z.uuid(),
    kind: z.enum(["court", "match"]).check(z.describe("court: when a court frees up on a day, in a window of start times. match: when an open match opens whose level band has my level.")),
    location_id: z.optional(z.uuid().check(z.describe("Where. Needed for a court alert; for a match alert, leave it out for any location."))),
    date: z.optional(z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/), z.describe("A court alert's day, YYYY-MM-DD, in the location's time."))),
    from: z.optional(hhmm), until: z.optional(hhmm),
  }),
  owners: async (db, i) => ({ ownerIds: await withManagers(db, [i.person_id]), locationId: i.location_id ?? null }),
  async plan(ctx, i) {
    const person = await nameOf(ctx.db, i.person_id);
    const loc = i.location_id ? (await readRow(ctx.db, "location", i.location_id, "thing.location")).row : null;
    if (i.kind === "court") {
      if (!loc || !i.date || !i.from || !i.until) throw new KumiError("error.alert_court_needs");
      if (minutesOf(i.from) >= minutesOf(i.until)) throw new KumiError("error.alert_window");
      const today = localDate(ctx.now, loc.time_zone), policy = await currentPolicy(ctx.db);
      const last = new Date(`${today}T12:00:00Z`); last.setUTCDate(last.getUTCDate() + policy.days_ahead);
      // A day still to come (today too, while the window hasn't passed), no further ahead than members can book.
      if (i.date < today || i.date > last.toISOString().slice(0, 10) || onDate(i.date, i.until, loc.time_zone) <= ctx.now) throw new KumiError("error.alert_day", { days: policy.days_ahead });
      const same = await ctx.db.selectFrom("play_alert").selectAll().where("person_id", "=", i.person_id).where("kind", "=", "court").where("location_id", "=", loc.id)
        .where("on_date", "=", i.date).where("ended_at", "is", null).executeTakeFirst();
      if (same && same.from_time?.slice(0, 5) === i.from && same.until_time?.slice(0, 5) === i.until) throw new KumiError("error.alert_already_on");
      if (!same) {
        const on = await ctx.db.selectFrom("play_alert").select((x) => x.fn.countAll<string>().as("n")).where("person_id", "=", i.person_id).where("kind", "=", "court")
          .where("ended_at", "is", null).where("on_date", ">=", today).executeTakeFirstOrThrow();
        if (Number(on.n) >= MAX_COURT_ALERTS) throw new KumiError("error.alert_too_many", { count: MAX_COURT_ALERTS });
      }
      const p = { person, location: loc.name, day: dayOf(i.date), from: clock(i.from), until: clock(i.until) };
      return { title: both("action.play_alert.set"), summary: join2(both(same ? "plan.play_alert.court_change" : "plan.play_alert.court", p), both("plan.play_alert.court_how", { count: ALERT_CAP })),
        reads: same ? [{ entity: "play_alert" as const, id: same.id, version: same.version }] : [], locationId: loc.id, ownerIds: await withManagers(ctx.db, [i.person_id]),
        undo: { kind: "reversible" as const }, details: { alert_id: same?.id ?? null } };
    }
    if (i.date || i.from || i.until) throw new KumiError("error.alert_match_no_day");
    const level = await levelOf(ctx.db, i.person_id);
    if (level === null) throw new KumiError("error.alert_needs_level", { person });
    const same = await ctx.db.selectFrom("play_alert").selectAll().where("person_id", "=", i.person_id).where("kind", "=", "match").where("ended_at", "is", null).executeTakeFirst();
    if (same && (same.location_id ?? null) === (loc?.id ?? null)) throw new KumiError("error.alert_already_on");
    const p = { person, level: level.toFixed(2), where: loc ? both("plan.play_alert.at", { location: loc.name }) : { en: "", es: "" } };
    return { title: both("action.play_alert.set"), summary: join2(both(same ? "plan.play_alert.match_change" : "plan.play_alert.match", p), both("plan.play_alert.match_how", { count: ALERT_CAP })),
      reads: same ? [{ entity: "play_alert" as const, id: same.id, version: same.version }] : [], locationId: loc?.id ?? null, ownerIds: await withManagers(ctx.db, [i.person_id]),
      undo: { kind: "reversible" as const }, details: { alert_id: same?.id ?? null } };
  },
  async apply(ctx, i, plan) {
    const was = (plan.details as { alert_id: string | null }).alert_id;
    const row = { location_id: i.location_id ?? null, on_date: i.kind === "court" ? i.date! : null, from_time: i.kind === "court" ? i.from! : null, until_time: i.kind === "court" ? i.until! : null };
    if (was) { await ctx.update("play_alert", was, row); return { alert_id: was }; }
    const id = uuidv7();
    try { await ctx.insert("play_alert", { id, person_id: i.person_id, kind: i.kind, ...row }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.alert_already_on"); throw e; }
    return { alert_id: id };
  },
});

export const playAlertEnd = defineAction({
  name: "play_alert.end", version: 1,
  input: z.object({ alert_id: z.uuid() }),
  owners: async (db, i) => {
    const a = await db.selectFrom("play_alert").select(["person_id", "location_id"]).where("id", "=", i.alert_id).executeTakeFirst();
    return { ownerIds: await withManagers(db, [a?.person_id]), locationId: a?.location_id ?? null };
  },
  async plan(ctx, i) {
    const { row: a, read } = await readRow(ctx.db, "play_alert", i.alert_id, "thing.alert");
    if (a.ended_at) throw new KumiError("error.alert_not_on");
    const person = await nameOf(ctx.db, a.person_id);
    const loc = a.location_id ? (await ctx.db.selectFrom("location").select("name").where("id", "=", a.location_id).executeTakeFirst())?.name ?? "" : "";
    const summary = a.kind === "court" ? both("plan.play_alert.end_court", { person, location: loc, day: dayOf(a.on_date) }) : both("plan.play_alert.end_match", { person });
    return { title: both("action.play_alert.end"), summary, reads: [read], locationId: a.location_id, ownerIds: await withManagers(ctx.db, [a.person_id]), undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("play_alert", i.alert_id, { ended_at: ctx.now }); return null; },
});

/** A person's alerts that are on: match alerts, and court alerts for a day not past yet (in each location's time). */
export async function alertsOf(db: Db | Trx, personId: string, now: Date) {
  const rows = await db.selectFrom("play_alert").leftJoin("location", "location.id", "play_alert.location_id")
    .select(["play_alert.id", "play_alert.kind", "play_alert.location_id", "location.name as location", "location.time_zone", "play_alert.on_date", "play_alert.from_time", "play_alert.until_time"])
    .where("play_alert.person_id", "=", personId).where("play_alert.ended_at", "is", null).orderBy("play_alert.on_date").execute();
  return rows.filter((r) => r.kind === "match" || onDate(r.on_date!, r.until_time!.slice(0, 5), r.time_zone!) > now)
    .map((r) => ({ id: r.id, kind: r.kind, location_id: r.location_id, location: r.location, date: r.on_date, from: r.from_time?.slice(0, 5) ?? null, until: r.until_time?.slice(0, 5) ?? null }));
}

/** An open match made or paid for, now confirmed: if it's listed for anyone to join, it's news for match alerts. */
export async function matchOpened(ctx: ApplyCtx, bookingId: string) {
  const m = await ctx.trx.selectFrom("open_match").select("listed").where("booking_id", "=", bookingId).executeTakeFirst();
  if (m?.listed) await ctx.emit("open_match.opened", { booking_id: bookingId, at: ctx.now.toISOString() });
}

// ---- Who hears: for the messages code (messages.ts), after the change commits ----
export type AlertDraft = { to: string; kind: "court_free" | "match_alert"; params: Record<string, string | number | Text>; link: string; staleAt: Date };
const whenText = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });
const pad = (n: number) => String(n).padStart(2, "0");
/** Sent already: the same alert to the same person (the same freed time, the same match). */
async function told(db: Db, personId: string, kind: string, link: string) {
  return Boolean(await db.selectFrom("outbound_message").select("id").where("person_id", "=", personId).where("kind", "=", kind).where("link", "=", link).where("channel", "=", "inbox").executeTakeFirst());
}

/** Court time a booking called off gave back: each start time in it that's still free when this runs, told to
 *  whoever's court alert covers it, once per start time, at most ALERT_CAP times for one alert's day. The booking's own
 *  players aren't told about the court they just gave up. */
export async function courtFreedDrafts(db: Db, p: { booking_id: string; at: string; times: { court_id: string; start: string; end: string }[] }): Promise<AlertDraft[]> {
  const at = new Date(p.at), out: AlertDraft[] = [];
  const own = new Set((await db.selectFrom("booking_player").select("person_id").where("booking_id", "=", p.booking_id).execute()).map((r) => r.person_id).filter(Boolean) as string[]);
  const org = (await db.selectFrom("booking").select("organiser_id").where("id", "=", p.booking_id).executeTakeFirst())?.organiser_id;
  if (org) own.add(org);
  for (const t of p.times) {
    const start = new Date(t.start), end = new Date(t.end);
    if (end.getTime() - Math.max(start.getTime(), at.getTime()) < SHORTEST_GAME * 60_000) continue;
    // Taken again since (the same court, any part of that time): nothing to tell.
    const taken = await db.selectFrom("court_time").select("id").where("court_id", "=", t.court_id).where("active", "=", true)
      .where(sql<boolean>`during && tstzrange(${start}, ${end})`).executeTakeFirst();
    if (taken) continue;
    const c = await db.selectFrom("court").innerJoin("location", "location.id", "court.location_id").select(["court.name", "court.location_id", "location.time_zone"]).where("court.id", "=", t.court_id).executeTakeFirst();
    if (!c) continue;
    const day = localDate(start, c.time_zone), s = localParts(start, c.time_zone), e = localParts(end, c.time_zone);
    const sMin = s.h * 60 + s.min, eMin = localDate(end, c.time_zone) === day ? e.h * 60 + e.min : 24 * 60;
    const alerts = await db.selectFrom("play_alert").select(["id", "person_id", "from_time", "until_time"]).where("kind", "=", "court").where("ended_at", "is", null)
      .where("location_id", "=", c.location_id).where("on_date", "=", day).execute();
    for (const a of alerts) {
      if (own.has(a.person_id)) continue;
      // The first start time in their window that a game fits after, and not already past.
      const nowMin = localDate(at, c.time_zone) === day ? (() => { const n = localParts(at, c.time_zone); return n.h * 60 + n.min; })() : 0;
      const first = Math.max(sMin, minutesOf(a.from_time!.slice(0, 5)), nowMin);
      if (first > minutesOf(a.until_time!.slice(0, 5)) || first + SHORTEST_GAME > eMin) continue;
      const time = `${pad(Math.floor(first / 60))}:${pad(first % 60)}`, base = `/book?location=${c.location_id}&date=${day}`, link = `${base}&time=${time}`;
      if (await told(db, a.person_id, "court_free", link)) continue;
      const sent = await db.selectFrom("outbound_message").select((x) => x.fn.countAll<string>().as("n")).where("person_id", "=", a.person_id).where("kind", "=", "court_free")
        .where("channel", "=", "inbox").where("link", "like", `${base}&%`).executeTakeFirstOrThrow();
      if (Number(sent.n) >= ALERT_CAP) continue;
      if (out.some((d) => d.to === a.person_id && d.link === link)) continue;
      const from = onDate(day, time, c.time_zone);
      out.push({ to: a.person_id, kind: "court_free", params: { court: c.name, when: whenText(from, c.time_zone) }, link, staleAt: from });
    }
  }
  return out;
}

/** An open match listed for anyone to join, now confirmed: whoever's match alert covers its location, with a level in
 *  its band, hears it once, and nobody more than ALERT_CAP match alerts in 24 hours. Not its own players. */
export async function matchOpenedDrafts(db: Db, p: { booking_id: string; at: string }): Promise<AlertDraft[]> {
  const at = new Date(p.at);
  const m = await db.selectFrom("open_match").innerJoin("booking", "booking.id", "open_match.booking_id").innerJoin("court_time", "court_time.booking_id", "booking.id")
    .innerJoin("court", "court.id", "court_time.court_id").innerJoin("location", "location.id", "court.location_id")
    .select(["booking.id", "booking.status", "booking.players", "booking.organiser_id", "open_match.level_min", "open_match.level_max", "open_match.listed", "open_match.gender",
      "court.name as court", "location.id as location_id", "location.name as location", "location.time_zone", sql<Date>`lower(court_time.during)`.as("start")])
    .where("booking.id", "=", p.booking_id).where("court_time.active", "=", true).executeTakeFirst();
  if (!m || !m.listed || m.status !== "confirmed" || new Date(m.start) <= at) return [];
  const seated = (await db.selectFrom("booking_player").select("person_id").where("booking_id", "=", m.id).where("removed_at", "is", null).where("leaving_at", "is", null).execute())
    .map((r) => r.person_id);
  if (seated.length >= m.players) return [];
  const alerts = await db.selectFrom("play_alert").innerJoin("rating", (j) => j.onRef("rating.person_id", "=", "play_alert.person_id").on("rating.sport", "=", "padel"))
    .select(["play_alert.person_id", "rating.level"]).where("play_alert.kind", "=", "match").where("play_alert.ended_at", "is", null)
    .where((w) => w.or([w("play_alert.location_id", "is", null), w("play_alert.location_id", "=", m.location_id)])).execute();
  const out: AlertDraft[] = [], link = `/match/${m.id}`, start = new Date(m.start);
  for (const a of alerts) {
    const level = Number(a.level);
    if (a.person_id === m.organiser_id || seated.includes(a.person_id) || level < Number(m.level_min) || level > Number(m.level_max)) continue;
    if (await told(db, a.person_id, "match_alert", link)) continue;
    const lately = await db.selectFrom("outbound_message").select((x) => x.fn.countAll<string>().as("n")).where("person_id", "=", a.person_id).where("kind", "=", "match_alert")
      .where("channel", "=", "inbox").where("created_at", ">", new Date(Date.now() - 24 * 3600_000)).executeTakeFirstOrThrow();
    if (Number(lately.n) >= ALERT_CAP) continue;
    out.push({ to: a.person_id, kind: "match_alert", link, staleAt: start, params: {
      when: whenText(start, m.time_zone), court: m.court, location: m.location, band: `${Number(m.level_min).toFixed(2)}-${Number(m.level_max).toFixed(2)}`,
      gender: m.gender ? both("msg.match_alert.gender", { label: both(`gender.${m.gender}` as Key) }) : { en: "", es: "" } } });
  }
  return out;
}
