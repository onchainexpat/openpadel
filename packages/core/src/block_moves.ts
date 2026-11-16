// Blocking a court that has bookings on it (court.block with move_bookings): each booking in the way moves to another
// free court of the same kind, for the same sport, at the same time. One that can't move (it has started, it isn't
// confirmed, or no court like it is free then) stays where it is, and the block leaves its time on that court free;
// the preview says what staff can do about it (another time, or cancel it with the refund rule, from the booking).
// Nothing is cancelled and no money moves here: leaving and refunding stay staff's own decisions (booking.move,
// booking.cancel). Anything else in the way (a program date, another block, a Playtomic copy, someone paying for that
// slot) stays too, and the block leaves its time. The players of each moved booking hear about it (booking.moved).
import { both, formatLocale, type Key, type Text } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { localDate } from "./clock.ts";
import { courtOpenings, occupied } from "./bookings.ts";

/** A booking moving off a blocked court: its court time now, and where it goes (the same time). */
export interface BlockMove { booking_id: string; time_id: string; from_court: string; to_court: string; start: string; end: string }
/** Something staying on a blocked court, which the block leaves free: why, and for a booking, a free time to offer. */
export interface BlockStay { booking_id: string | null; court_id: string; start: string; end: string; why: "started" | "not_confirmed" | "no_court" | "other";
  try?: { court_id: string; start: string } | null }
/** The block's own court time: each blocked court from start to end, less what stays on it. */
export interface BlockPiece { court_id: string; start: string; end: string }
export interface BlockLayout { pieces: BlockPiece[]; moves: BlockMove[]; stays: BlockStay[] }

/** How far either side of a booking's own time a free court is looked for, when none is free at that time. */
const TRY_MINUTES = 180, STEP = 30 * 60_000;
const t = (d: Date | string) => new Date(d).getTime();
const overlaps = (a: { start: string | Date; end: string | Date }, s: number, e: number) => t(a.start) < e && t(a.end) > s;

/** What blocking these courts from start to end would do to what's on them. `db` is the transaction at apply, with the
 *  location's courts locked, so what it finds then is all there is. */
export async function blockLayout(db: Db | Trx, o: { courtIds: string[]; locationId: string; tz: string; start: Date; end: Date; now: Date }): Promise<BlockLayout> {
  const all = await db.selectFrom("court").select(["id", "name", "kind", "sport", "bookable", "archived_at"]).where("location_id", "=", o.locationId).orderBy("sort").orderBy("name").execute();
  const blocked = new Set(o.courtIds), live = all.filter((c) => !c.archived_at && c.bookable);
  const inWay = await occupied(db, o.courtIds, o.start, o.end, o.now);
  const bookingItems = inWay.filter((x) => x.kind === "booking" && x.booking_id).sort((a, b) => t(a.start) - t(b.start) || a.court_id.localeCompare(b.court_id));
  const ids = bookingItems.map((x) => x.booking_id!);
  const status = new Map(ids.length ? (await db.selectFrom("booking").select(["id", "status"]).where("id", "in", ids).execute()).map((b) => [b.id, b.status]) : []);
  // Everything on the location's courts around the block, once: the free courts and times are worked out from it.
  const from = new Date(Math.min(o.start.getTime(), ...bookingItems.map((x) => t(x.start))) - TRY_MINUTES * 60_000);
  const to = new Date(Math.max(o.end.getTime(), ...bookingItems.map((x) => t(x.end))) + TRY_MINUTES * 60_000);
  const taken = (await occupied(db, live.map((c) => c.id), from, to, o.now)).map((x) => ({ court_id: x.court_id, start: x.start, end: x.end, booking_id: x.booking_id }));
  const days = [...new Set([from, o.start, to].map((d) => localDate(d, o.tz)))];
  const hours = new Map<string, Map<string, { opens: Date; closes: Date } | null>>();
  for (const d of days) hours.set(d, await courtOpenings(db, o.locationId, live.map((c) => c.id), d));
  const claimed: { court_id: string; start: string; end: string }[] = [];
  /** Whether a court can take this booking's time: open then, nothing else on it (the booking itself aside), not part
   *  of the block while it's on, and not given to another booking moved by this block. */
  const fits = (courtId: string, s: number, e: number, bookingId: string) => {
    const open = hours.get(localDate(new Date(s), o.tz))?.get(courtId);
    if (!open || s < open.opens.getTime() || e > open.closes.getTime()) return false;
    if (blocked.has(courtId) && s < o.end.getTime() && e > o.start.getTime()) return false;
    return !taken.some((x) => x.court_id === courtId && x.booking_id !== bookingId && overlaps(x, s, e)) && !claimed.some((x) => x.court_id === courtId && overlaps(x, s, e));
  };

  const moves: BlockMove[] = [], stays: BlockStay[] = [];
  for (const x of bookingItems) {
    const s = t(x.start), e = t(x.end), id = x.booking_id!, start = new Date(s).toISOString(), end = new Date(e).toISOString();
    if (status.get(id) !== "confirmed") { stays.push({ booking_id: id, court_id: x.court_id, start, end, why: "not_confirmed" }); continue; }
    if (s <= o.now.getTime()) { stays.push({ booking_id: id, court_id: x.court_id, start, end, why: "started" }); continue; }
    const was = all.find((c) => c.id === x.court_id)!;
    const like = live.filter((c) => c.kind === was.kind && c.sport === was.sport);
    const to = like.find((c) => !blocked.has(c.id) && fits(c.id, s, e, id));
    if (to) {
      moves.push({ booking_id: id, time_id: x.id, from_court: x.court_id, to_court: to.id, start, end });
      claimed.push({ court_id: to.id, start, end });
      continue;
    }
    // Nowhere at that time: the nearest time a court like it is free that day, later first, to offer the organiser.
    let found: BlockStay["try"] = null;
    for (let k = 1; !found && k <= TRY_MINUTES / 30; k++) for (const off of [k * STEP, -k * STEP]) {
      const ns = s + off, ne = e + off;
      if (ns <= o.now.getTime() || localDate(new Date(ns), o.tz) !== localDate(new Date(s), o.tz)) continue;
      const c = like.find((c) => fits(c.id, ns, ne, id));
      if (c) { found = { court_id: c.id, start: new Date(ns).toISOString() }; break; }
    }
    stays.push({ booking_id: id, court_id: x.court_id, start, end, why: "no_court", try: found });
  }
  for (const x of inWay.filter((x) => !(x.kind === "booking" && x.booking_id)))
    stays.push({ booking_id: null, court_id: x.court_id, start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString(), why: "other" });

  // Each blocked court from start to end, with what stays on it cut out.
  const pieces: BlockPiece[] = [];
  for (const courtId of [...o.courtIds].sort()) {
    const holes = stays.filter((x) => x.court_id === courtId).map((x) => [Math.max(t(x.start), o.start.getTime()), Math.min(t(x.end), o.end.getTime())] as const).sort((a, b) => a[0] - b[0]);
    let cursor = o.start.getTime();
    for (const [hs, he] of holes) { if (hs > cursor) pieces.push({ court_id: courtId, start: new Date(cursor).toISOString(), end: new Date(hs).toISOString() }); cursor = Math.max(cursor, he); }
    if (cursor < o.end.getTime()) pieces.push({ court_id: courtId, start: new Date(cursor).toISOString(), end: o.end.toISOString() });
  }
  if (!pieces.length) throw new KumiError("error.court_taken");
  return { pieces, moves, stays };
}

/** Two layouts are the same (one stored with a preview, whose keys the database put in its own order). */
export function sameLayout(a: BlockLayout, b: BlockLayout): boolean {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, canon(x)])) : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

const clockOf = (d: string, tz: string): Text => ({ en: new Intl.DateTimeFormat(formatLocale("en"), { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(d)),
  es: new Intl.DateTimeFormat(formatLocale("es"), { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(d)) });
const plain = (s: string): Text => ({ en: s, es: s });
const join = (xs: Text[], sep = " "): Text => ({ en: xs.map((x) => x.en).filter(Boolean).join(sep), es: xs.map((x) => x.es).filter(Boolean).join(sep) });

/** The preview's words for a layout: a sentence for each move and each thing that stays, who's told, and the money;
 *  and the same as labelled rows (Plan.rows). `block` is the sentence that says what's blocked. */
export async function layoutWords(db: Db | Trx, l: BlockLayout, tz: string, block: Text): Promise<{ summary: Text; rows: { label: Text; text: Text }[]; told: number }> {
  const ids = [...new Set([...l.moves.map((m) => m.booking_id), ...l.stays.flatMap((s) => (s.booking_id ? [s.booking_id] : []))])];
  const books = ids.length ? await db.selectFrom("booking").leftJoin("person", "person.id", "booking.organiser_id").select(["booking.id", "booking.code", "person.display_name"])
    .select((eb) => eb.selectFrom("booking_player").select("guest_name").whereRef("booking_player.booking_id", "=", "booking.id").where("guest_name", "is not", null).limit(1).as("guest"))
    .where("booking.id", "in", ids).execute() : [];
  const names = new Map((await db.selectFrom("court").select(["id", "name"]).where("id", "in", [...new Set([...l.pieces, ...l.stays].map((x) => x.court_id).concat(l.moves.flatMap((m) => [m.from_court, m.to_court]), l.stays.flatMap((s) => (s.try ? [s.try.court_id] : []))))]).execute())
    .map((c) => [c.id, c.name]));
  const court = (id: string) => plain(names.get(id) ?? "");
  const which = (id: string) => { const b = books.find((x) => x.id === id); return { code: b?.code ?? "", who: b?.display_name ?? b?.guest ?? "" }; };
  const moves = l.moves.map((m) => both("plan.court.block_move", { ...which(m.booking_id), time: clockOf(m.start, tz), from: court(m.from_court), to: court(m.to_court) }));
  const stays: Text[] = [];
  for (const s of l.stays.filter((x) => x.booking_id)) {
    const p = { ...which(s.booking_id!), time: clockOf(s.start, tz), court: court(s.court_id) };
    if (s.why === "no_court") stays.push(join([both("plan.court.block_stays_no_court", p),
      s.try ? both("plan.court.block_try", { court: court(s.try.court_id), time: clockOf(s.try.start, tz) }) : both("plan.court.block_try_none"), both("plan.court.block_stays_choose")]));
    else stays.push(both(s.why === "started" ? "plan.court.block_stays_started" : "plan.court.block_stays_unconfirmed", p));
  }
  const other = l.stays.filter((x) => !x.booking_id);
  if (other.length) stays.push(both("plan.court.block_stays_other", { count: other.length, courts: plain([...new Set(other.map((x) => names.get(x.court_id) ?? ""))].join(", ")) }));
  // Who hears: everyone with an account in each moved booking (booking.moved), a lesson's coach too.
  const told = l.moves.length ? Number((await db.selectFrom("booking_player").select((eb) => eb.fn.count<string>("person_id").distinct().as("n")).where("booking_id", "in", l.moves.map((m) => m.booking_id))
    .where("removed_at", "is", null).where("person_id", "is not", null).executeTakeFirst())?.n ?? 0) : 0;
  const tells = l.moves.length ? both("plan.court.block_told", { count: told }) : null;
  const money = l.moves.length || l.stays.some((s) => s.booking_id) ? both("plan.court.block_money") : null;
  const label = (k: string) => both(`plan.row.${k}` as Key);
  const rows = [{ label: label("block"), text: block }, ...moves.map((text) => ({ label: label("moves"), text })), ...stays.map((text) => ({ label: label("stays"), text })),
    ...(tells ? [{ label: label("messages"), text: tells }] : []), ...(money ? [{ label: label("money"), text: money }] : [])];
  return { summary: join([block, ...moves, ...stays, ...(tells ? [tells] : []), ...(money ? [money] : [])]), rows, told };
}
