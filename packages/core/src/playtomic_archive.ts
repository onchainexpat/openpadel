// Moving from Playtomic (docs/setup/moving-from-playtomic.md), the bookings side:
//
// - The archive. Every booking the mirror reads is kept as Playtomic gave it, with its players by name and email,
//   from the first read (stage 1), because Playtomic itself keeps bookings only three months back. It's the club's
//   own record, in its own database: a member's rows go with their account (eraseArchiveOf) and come with their data
//   download (archiveOf), and staff see a person's Playtomic history on their page. Kumi never writes to Playtomic.
//   Keeping the copy isn't a change anyone makes, so it's written as the mirror's own bookkeeping (like
//   connector_status), not as an action; what anyone does with it (taking a booking over) is.
// - Taking over upcoming bookings (stage 3, mirror.take_over): a Playtomic booking becomes a Kumi booking on its
//   linked court, the players matched by email or Playtomic id, what was paid in Playtomic kept as paid there. A
//   refund of that is made in Playtomic, never as money in Kumi. Recurring ones become a weekly court where the weeks
//   are plain weekly. From then on Kumi's own booking holds the court, and the mirror doesn't hold it twice.
// - The owner's daily comparison (comparePlaytomic): bookings per court per day in Playtomic and in Kumi, and each
//   difference said once.
import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, money, dateTime, fromMajor, type Key, type Text } from "@kumi/i18n";
import { defineAction, runAsSystem, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate, localParts } from "./clock.ts";
import { insertTime, lockCourts, range } from "./bookings.ts";
import { courtAndPlace, newCode } from "./booking_pay.ts";
import { currentPolicy, quote } from "./prices.ts";
import { normalize, PLAYTOMIC, typeKey } from "./playtomic.ts";
import { erasedMatcher, learnErasedIds } from "./playtomic_erased.ts";

const usd = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const join = (xs: Text[], sep = " "): Text => ({ en: xs.map((x) => x.en).filter(Boolean).join(sep), es: xs.map((x) => x.es).filter(Boolean).join(sep) });
const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
const at = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });

/** Playtomic writes an amount as "10 EUR" or "12.50 USD": in the currency's smallest unit, with its code. */
export function parsePrice(v: unknown): { cents: number; currency: string } | null {
  const m = typeof v === "string" ? /^\s*(-?\d+(?:[.,]\d+)?)\s*([A-Za-z]{3})\s*$/.exec(v) : null;
  if (!m) return null;
  const currency = m[2]!.toUpperCase(), major = Number(m[1]!.replace(",", "."));
  if (!Number.isFinite(major) || major < 0) return null;
  return { cents: fromMajor(major, currency), currency };
}

interface Participant { participant_id: string; family_member_id: string | null; name: string | null; email: string | null; accepts_commercial: boolean | null; participant_type: string | null; is_owner: boolean }
interface ArchiveRow {
  booking_id: string; object_id: string | null; resource_id: string; resource_name: string; sport_id: string | null; booking_type: string; origin: string | null;
  starts_at: Date; ends_at: Date; price: string | null; price_cents: number | null; currency: string | null; payment_status: string | null; canceled: boolean;
  owner_id: string | null; coach_ids: string[]; course_id: string | null; course_name: string | null; activity_id: string | null; activity_name: string | null;
  raw: Record<string, unknown>; row_hash: string; participants: Participant[];
}

/** One booking as Playtomic gave it, split into the archive's row and its players; null when it can't be read. */
export function archiveRowOf(raw: unknown): ArchiveRow | null {
  const b = normalize(raw);
  if (!b || !raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>, id = str(r.booking_id ?? r.id);
  if (!id) return null;
  const info = (r.participant_info && typeof r.participant_info === "object" ? r.participant_info : {}) as { owner_id?: unknown; participants?: unknown };
  const owner = str(info.owner_id);
  const participants: Participant[] = (Array.isArray(info.participants) ? info.participants : []).flatMap((p: any) => {
    const pid = str(p?.participant_id);
    if (!pid) return [];
    const email = str(p.email);
    return [{ participant_id: pid, family_member_id: str(p.family_member_id), name: str(p.name), email: email ? email.toLowerCase() : null,
      accepts_commercial: typeof p.accepts_commercial_communications === "boolean" ? p.accepts_commercial_communications : null, participant_type: str(p.participant_type),
      is_owner: Boolean(owner) && pid === owner && !str(p.family_member_id) }];
  });
  // The same player twice in one booking (Playtomic's list can repeat one): kept once.
  const seen = new Set<string>(), players = participants.filter((p) => { const k = `${p.participant_id}|${p.family_member_id ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const { participant_info: _p, ...rest } = r;
  const price = str(r.price), parsed = parsePrice(price);
  return {
    booking_id: id, object_id: str(r.object_id), resource_id: b.courtRef, resource_name: b.courtName, sport_id: str(r.sport_id), booking_type: b.type, origin: str(r.origin),
    starts_at: b.start, ends_at: b.end, price, price_cents: parsed?.cents ?? null, currency: parsed?.currency ?? null, payment_status: str(r.payment_status), canceled: b.cancelled,
    owner_id: owner, coach_ids: Array.isArray(r.coach_ids) ? r.coach_ids.map(str).filter((x): x is string => Boolean(x)) : str(r.coach_id) ? [str(r.coach_id)!] : [],
    course_id: str(r.course_id), course_name: str(r.course_name), activity_id: str(r.activity_id ?? r.tournament_id), activity_name: str(r.activity_name),
    raw: rest, row_hash: createHash("sha256").update(JSON.stringify(raw)).digest("hex"), participants: players,
  };
}

/** Kumi's people for Playtomic's player ids (from an import) and emails, leaving out deleted accounts. */
async function whoIs(db: Db | Trx, ids: string[], emails: string[]) {
  const byId = new Map(ids.length ? (await db.selectFrom("external_ref").innerJoin("person", (j) => j.on(sql<boolean>`person.id::text = external_ref.entity_id`))
    .select(["external_ref.external_id", "external_ref.entity_id"]).where("external_ref.system", "=", PLAYTOMIC).where("external_ref.entity", "=", "person")
    .where("external_ref.external_id", "in", ids).where("person.redacted_at", "is", null).execute()).map((r) => [r.external_id, r.entity_id]) : []);
  const byEmail = new Map(emails.length ? (await db.selectFrom("person").select(["id", sql<string>`lower(email)`.as("email")]).where(sql<string>`lower(email)`, "in", emails)
    .where("redacted_at", "is", null).execute()).map((r) => [r.email, r.id]) : []);
  return (p: { participant_id: string; email: string | null; family_member_id: string | null }) =>
    p.family_member_id ? null : byId.get(p.participant_id) ?? (p.email ? byEmail.get(p.email) ?? null : null);
}

/**
 * Keep what one read of Playtomic gave: new and changed bookings written with their players, unchanged ones only
 * seen again. A player whose account here was deleted stays without a name or an email, in this booking and in any
 * booking read later.
 */
export async function archiveBookings(db: Db, raws: unknown[], now = new Date()): Promise<{ read: number; written: number; unreadable: number }> {
  const rows = [...new Map(raws.map(archiveRowOf).filter((r): r is ArchiveRow => r !== null).map((r) => [r.booking_id, r])).values()];
  if (!rows.length) return { read: 0, written: 0, unreadable: raws.length };
  const courts = new Map((await db.selectFrom("external_ref").select(["external_id", "entity_id"]).where("system", "=", PLAYTOMIC).where("entity", "=", "court").execute())
    .map((r) => [r.external_id, r.entity_id]));
  let written = 0;
  for (let k = 0; k < rows.length; k += 200) {
    const part = rows.slice(k, k + 200);
    await db.transaction().execute(async (trx) => {
      const had = new Map((await trx.selectFrom("playtomic_booking").select(["booking_id", "row_hash", "court_id"]).where("booking_id", "in", part.map((r) => r.booking_id)).execute())
        .map((r) => [r.booking_id, r]));
      const same = part.filter((r) => had.get(r.booking_id)?.row_hash === r.row_hash && (had.get(r.booking_id)?.court_id ?? null) === (courts.get(r.resource_id) ?? null));
      if (same.length) await trx.updateTable("playtomic_booking").set({ last_seen_at: now }).where("booking_id", "in", same.map((r) => r.booking_id)).execute();
      const changed = part.filter((r) => !same.includes(r));
      if (!changed.length) return;
      const players = changed.flatMap((r) => r.participants);
      const who = await whoIs(trx, [...new Set(players.map((p) => p.participant_id))], [...new Set(players.map((p) => p.email).filter((e): e is string => Boolean(e)))]);
      // Anyone whose account here was deleted, before or after this booking was first read (playtomic_erased.ts).
      const erased = await erasedMatcher(trx, { ids: players.map((p) => p.participant_id), emails: players.map((p) => p.email) });
      for (const r of changed) {
        const { participants, ...row } = r;
        const values = { ...row, court_id: courts.get(r.resource_id) ?? null, raw: JSON.stringify(r.raw), last_seen_at: now };
        await trx.insertInto("playtomic_booking").values({ ...values, first_seen_at: now })
          .onConflict((oc) => oc.column("booking_id").doUpdateSet({ ...values, version: sql`playtomic_booking.version + 1` })).execute();
        // The players as Playtomic lists them now, each kept out or not by the marker (playtomic_erased.ts), which holds
        // every deleted person's Playtomic ids: so one who came back by their own act comes in by name for what's after.
        await trx.deleteFrom("playtomic_booking_player").where("booking_id", "=", r.booking_id).execute();
        for (const p of participants) {
          const gone = erased({ id: p.family_member_id ? null : p.participant_id, email: p.email, at: r.starts_at });
          await trx.insertInto("playtomic_booking_player").values({ id: uuidv7(), booking_id: r.booking_id, participant_id: p.participant_id, family_member_id: p.family_member_id,
            name: gone ? null : p.name, email: gone ? null : p.email, accepts_commercial: gone ? null : p.accepts_commercial, participant_type: p.participant_type, is_owner: p.is_owner,
            person_id: gone ? null : who(p), erased_at: gone ? now : null }).execute();
        }
        written++;
      }
      await learnErasedIds(trx, erased);
    });
  }
  return { read: rows.length, written, unreadable: raws.length - rows.length };
}

/** Which archive rows are this person's: by who they are here, their Playtomic ids (an import's), or their emails. */
async function theirKeys(db: Db | Trx, personId: string) {
  const ids = (await db.selectFrom("external_ref").select("external_id").where("system", "=", PLAYTOMIC).where("entity", "=", "person").where("entity_id", "=", personId).execute()).map((r) => r.external_id);
  const p = await db.selectFrom("person").select("email").where("id", "=", personId).executeTakeFirst();
  const more = await db.selectFrom("auth_identity").select("value").where("person_id", "=", personId).execute();
  const emails = [...new Set([p?.email, ...more.map((m) => m.value)].filter((v): v is string => Boolean(v) && v!.includes("@")).map((v) => v.toLowerCase()))];
  return { ids, emails };
}
const theirs = (k: { ids: string[]; emails: string[] }, personId: string) => (w: any) => w.or([
  w("playtomic_booking_player.person_id", "=", personId),
  ...(k.ids.length ? [w.and([w("playtomic_booking_player.participant_id", "in", k.ids), w("playtomic_booking_player.family_member_id", "is", null)])] : []),
  ...(k.emails.length ? [w(sql`lower(playtomic_booking_player.email)`, "in", k.emails)] : []),
]);

/** A person's bookings in Playtomic's archive, newest first, with the others in each by name (as Playtomic showed them). */
export async function archiveOf(db: Db | Trx, personId: string, o: { limit?: number } = {}) {
  const k = await theirKeys(db, personId);
  const mine = await db.selectFrom("playtomic_booking_player").innerJoin("playtomic_booking", "playtomic_booking.booking_id", "playtomic_booking_player.booking_id")
    .leftJoin("booking", "booking.id", "playtomic_booking.taken_over_booking_id")
    .select(["playtomic_booking.booking_id", "playtomic_booking.starts_at", "playtomic_booking.ends_at", "playtomic_booking.resource_name", "playtomic_booking.booking_type",
      "playtomic_booking.price", "playtomic_booking.payment_status", "playtomic_booking.canceled", "playtomic_booking.origin", "playtomic_booking_player.is_owner", "playtomic_booking_player.id as row_id",
      "booking.code as kumi_code", "booking.status as kumi_status"])
    .where(theirs(k, personId)).where("playtomic_booking_player.erased_at", "is", null)
    .orderBy("playtomic_booking.starts_at", "desc").$if(Boolean(o.limit), (q) => q.limit(o.limit!)).execute();
  if (!mine.length) return [];
  const ids = [...new Set(mine.map((m) => m.booking_id))];
  const others = await db.selectFrom("playtomic_booking_player").select(["booking_id", "id", "name"]).where("booking_id", "in", ids).where("erased_at", "is", null).execute();
  const seen = new Set<string>();
  return mine.filter((m) => !seen.has(m.booking_id) && seen.add(m.booking_id)).map((m) => ({
    booking_id: m.booking_id, starts_at: m.starts_at, ends_at: m.ends_at, court: m.resource_name, type: m.booking_type, price: m.price, payment_status: m.payment_status,
    cancelled: m.canceled, origin: m.origin, owner: m.is_owner,
    // Taken over as a booking here: that booking while it stands; once cancelled here, said as such.
    taken_over_as: m.kumi_code && m.kumi_status !== "cancelled" ? m.kumi_code : null, cancelled_here_as: m.kumi_code && m.kumi_status === "cancelled" ? m.kumi_code : null,
    others: others.filter((x) => x.booking_id === m.booking_id && x.id !== m.row_id && x.name).map((x) => x.name!),
  }));
}

/** A deleted account: their name and email go from Playtomic's archive. Playtomic's own id stays on the rows, with
 *  neither, so a later read of the same booking (still in Playtomic) doesn't bring the name back. Read before the
 *  account's Playtomic ids are deleted (privacy.ts). */
export async function eraseArchiveOf(trx: Trx, personId: string, emails: string[], now: Date): Promise<number> {
  const k = await theirKeys(trx, personId);
  const keys = { ids: k.ids, emails: [...new Set([...k.emails, ...emails.map((e) => e.toLowerCase())])] };
  const r = await trx.updateTable("playtomic_booking_player").set({ name: null, email: null, accepts_commercial: null, erased_at: now, person_id: personId, version: sql`version + 1` })
    .where(theirs(keys, personId)).where("erased_at", "is", null).executeTakeFirst();
  return Number(r.numUpdatedRows ?? 0);
}

// ---- Taking over upcoming Playtomic bookings (stage 3) ----

/** Of Playtomic's types, the ones that are one player's court: a booking, or the recurring kind the club makes. */
const TAKEABLE = new Set(["REGULAR_BOOKING", "RECURRING_BOOKING"]);
type Why = "not_found" | "cancelled" | "past" | "already" | "kind" | "unlinked" | "not_held" | "clash" | "owner_unknown" | "currency" | "partial" | "refunded";
interface Item { booking_id: string; ref: string; court_id: string; court: string; starts_at: string; minutes: number; organiser_id: string; organiser: string;
  players: { person_id: string | null; name: string }[]; price_cents: number; paid: boolean; recurring: boolean; date: string; time: string; weekday: number }
interface Left { booking_id: string; court: string; starts_at: string | null; why: Why; what?: string }

async function clashName(db: Db | Trx, courtTimeId: string | null): Promise<string> {
  if (!courtTimeId) return "";
  const t = await db.selectFrom("court_time").leftJoin("booking", "booking.id", "court_time.booking_id").leftJoin("session", "session.id", "court_time.session_id")
    .leftJoin("program", "program.id", "session.program_id").select(["court_time.kind", "booking.code", "program.name"]).where("court_time.id", "=", courtTimeId).executeTakeFirst();
  return t?.name ?? t?.code ?? "";
}

/** What can be taken over of these Playtomic bookings, and why each of the rest stays in Playtomic. */
async function sortOut(db: Db | Trx, ids: string[], now: Date) {
  const club = await db.selectFrom("club").select(["currency"]).executeTakeFirstOrThrow();
  const rows = await db.selectFrom("playtomic_booking").selectAll().where("booking_id", "in", ids).execute();
  const players = rows.length ? await db.selectFrom("playtomic_booking_player").leftJoin("person", "person.id", "playtomic_booking_player.person_id")
    .select(["playtomic_booking_player.booking_id", "playtomic_booking_player.participant_id", "playtomic_booking_player.family_member_id", "playtomic_booking_player.name",
      "playtomic_booking_player.email", "playtomic_booking_player.is_owner", "playtomic_booking_player.erased_at", "playtomic_booking_player.person_id", "person.display_name", "person.redacted_at"])
    .where("playtomic_booking_player.booking_id", "in", rows.map((r) => r.booking_id)).execute() : [];
  // Matched again now: someone imported since the booking was read is known by their Playtomic id or email.
  const who = await whoIs(db, [...new Set(players.map((p) => p.participant_id))], [...new Set(players.map((p) => p.email).filter((e): e is string => Boolean(e)))]);
  const mirror = new Map((await db.selectFrom("mirror_booking").select(["ref", "status", "court_time_id", "clash_id"]).where("ref", "in", rows.map((r) => `${r.booking_id}:${r.resource_id}`).concat([""])).execute())
    .map((m) => [m.ref, m]));
  const items: Item[] = [], left: Left[] = [];
  for (const id of ids) {
    const r = rows.find((x) => x.booking_id === id);
    if (!r) { left.push({ booking_id: id, court: "", starts_at: null, why: "not_found" }); continue; }
    const base = { booking_id: id, court: r.resource_name, starts_at: new Date(r.starts_at).toISOString() };
    const m = mirror.get(`${r.booking_id}:${r.resource_id}`);
    const why: Why | null = r.canceled ? "cancelled" : new Date(r.starts_at) <= now ? "past" : r.taken_over_booking_id || m?.status === "taken" ? "already"
      : !TAKEABLE.has(r.booking_type) ? "kind" : !r.court_id ? "unlinked" : m?.status === "conflict" ? "clash" : m?.status !== "held" || !m.court_time_id ? "not_held"
      : r.payment_status === "PARTIAL_PAID" ? "partial" : r.payment_status === "REFUNDED" || r.payment_status === "VOID" ? "refunded"
      : r.price_cents === null || r.currency !== club.currency ? "currency" : null;
    if (why) { left.push({ ...base, why, what: why === "kind" ? r.booking_type : why === "clash" ? await clashName(db, m?.clash_id ?? null) : undefined }); continue; }
    const mine = players.filter((p) => p.booking_id === id);
    const owner = mine.find((p) => p.is_owner) ?? (r.owner_id ? mine.find((p) => p.participant_id === r.owner_id && !p.family_member_id) : undefined);
    const ownerId = owner && !owner.erased_at ? (owner.person_id && !owner.redacted_at ? owner.person_id : who(owner)) : null;
    if (!ownerId) { left.push({ ...base, why: "owner_unknown", what: owner?.erased_at ? "" : owner?.name ?? "" }); continue; }
    const ownerName = (await db.selectFrom("person").select("display_name").where("id", "=", ownerId).executeTakeFirstOrThrow()).display_name;
    const court = await courtAndPlace(db, r.court_id!), start = new Date(r.starts_at), tz = court.time_zone;
    const others = mine.filter((p) => p !== owner && !p.erased_at).map((p) => {
      const pid = p.person_id && !p.redacted_at ? p.person_id : who(p);
      return { person_id: pid && pid !== ownerId ? pid : null, name: p.name ?? "" };
    }).filter((p) => p.person_id || p.name);
    const lp = localParts(start, tz);
    items.push({ booking_id: id, ref: `${r.booking_id}:${r.resource_id}`, court_id: r.court_id!, court: court.name, starts_at: start.toISOString(),
      minutes: Math.round((new Date(r.ends_at).getTime() - start.getTime()) / 60_000), organiser_id: ownerId, organiser: ownerName,
      players: [...new Map(others.map((o) => [o.person_id ?? `guest:${o.name}`, o])).values()], price_cents: r.price_cents!,
      // Paid in Playtomic, or nothing to pay: nothing is owed here. Otherwise the price is owed at the desk.
      paid: r.payment_status === "PAID" || r.price_cents === 0, recurring: r.booking_type === "RECURRING_BOOKING",
      date: localDate(start, tz), time: `${String(lp.h).padStart(2, "0")}:${String(lp.min).padStart(2, "0")}`, weekday: lp.weekday });
  }
  // Recurring ones become a weekly court when they are: the same court, player, weekday, time and length, every week
  // with none missing. Any other pattern stays one booking a week.
  const groups = new Map<string, Item[]>();
  for (const it of items.filter((x) => x.recurring)) {
    const key = [it.court_id, it.organiser_id, it.weekday, it.time, it.minutes].join("|");
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  const series: Item[][] = [], weeklyIds = new Set<string>();
  for (const g of groups.values()) {
    const s = [...g].sort((a, b) => a.date.localeCompare(b.date));
    const weekly = s.length >= 2 && s.every((x, n) => n === 0 || Date.parse(`${x.date}T12:00:00Z`) - Date.parse(`${s[n - 1]!.date}T12:00:00Z`) === 7 * 86400_000);
    if (weekly) { series.push(s); s.forEach((x) => weeklyIds.add(x.booking_id)); }
  }
  return { items, left, series, singles: items.filter((x) => !weeklyIds.has(x.booking_id)), irregular: items.filter((x) => x.recurring && !weeklyIds.has(x.booking_id)).length };
}

const WHY_KEYS: Record<Why, Key> = {
  not_found: "plan.take_over.why_not_found", cancelled: "plan.take_over.why_cancelled", past: "plan.take_over.why_past", already: "plan.take_over.why_already",
  kind: "plan.take_over.why_kind", unlinked: "plan.take_over.why_unlinked", not_held: "plan.take_over.why_not_held", clash: "plan.take_over.why_clash",
  owner_unknown: "plan.take_over.why_owner_unknown", currency: "plan.take_over.why_currency", partial: "plan.take_over.why_partial", refunded: "plan.take_over.why_refunded",
};

export const mirrorTakeOver = defineAction({
  name: "mirror.take_over", version: 1,
  input: z.object({ booking_ids: z.array(z.string().check(z.minLength(1), z.maxLength(64))).check(z.minLength(1), z.maxLength(200)) }),
  async plan(ctx, i) {
    const ids = [...new Set(i.booking_ids)];
    const s = await sortOut(ctx.db, ids, ctx.now);
    if (!s.items.length) throw new KumiError("error.take_over_none", { list: listLeft(s.left, await clubTz(ctx.db)) });
    const tz = await clubTz(ctx.db), paid = s.items.filter((x) => x.paid).reduce((n, x) => n + x.price_cents, 0), owed = s.items.filter((x) => !x.paid).reduce((n, x) => n + x.price_cents, 0);
    const parts: Text[] = [both("plan.take_over.count", { count: s.items.length })];
    for (const g of s.series) parts.push(both("plan.take_over.weekly", { who: g[0]!.organiser, court: g[0]!.court, first: at(new Date(g[0]!.starts_at), tz), last: at(new Date(g.at(-1)!.starts_at), tz), count: g.length }));
    if (s.singles.length) parts.push(both("plan.take_over.singles", { count: s.singles.length }));
    if (s.irregular) parts.push(both("plan.take_over.not_weekly", { count: s.irregular }));
    if (paid) parts.push(both("plan.take_over.paid", { amount: usd(paid) }));
    if (owed) parts.push(both("plan.take_over.owed", { amount: usd(owed) }));
    parts.push(both("plan.take_over.refunds"));
    if (s.left.length) parts.push(both("plan.take_over.left", { count: s.left.length, list: listLeft(s.left, tz) }));
    return { title: both("action.mirror.take_over"), summary: join(parts), reads: [], ownerIds: [...new Set(s.items.map((x) => x.organiser_id))],
      moneyCents: 0, undo: { kind: "none", note: both("reason.take_over_undo") }, details: { ids } };
  },
  async apply(ctx, _i, plan) {
    const ids = (plan.details as { ids: string[] }).ids;
    // Sorted again under the courts' locks: a booking cancelled, moved or taken since the preview is left alone.
    const first = await sortOut(ctx.trx, ids, ctx.now);
    if (!first.items.length) return { bookings: 0, weekly: 0, left: first.left.length };
    await lockCourts(ctx, [...new Set(first.items.map((x) => x.court_id))]);
    const s = await sortOut(ctx.trx, ids, ctx.now), policy = await currentPolicy(ctx.trx);
    let bookings = 0, weekly = 0;
    for (const g of s.series) {
      const court = await courtAndPlace(ctx.trx, g[0]!.court_id), id = uuidv7();
      await ctx.insert("booking_series", { id, location_id: court.location_id, court_id: g[0]!.court_id, organiser_id: g[0]!.organiser_id, starts: g[0]!.time, minutes: g[0]!.minutes,
        first_date: g[0]!.date, last_date: g.at(-1)!.date, pay: "desk", source: "desk", policy_id: policy.id });
      for (const it of g) {
        const b = await takeOne(ctx, it, court.location_id, policy.id, id);
        await ctx.insert("booking_series_week", { id: uuidv7(), series_id: id, on_date: it.date, booking_id: b.booking_id, price_cents: it.price_cents, tax_cents: b.tax_cents, quote: null });
        bookings++;
      }
      // Every week is booked: nothing more for the series to book (as a weekly court the desk makes).
      await ctx.update("booking_series", id, { ended_at: ctx.now });
      weekly++;
    }
    for (const it of s.singles) {
      const court = await courtAndPlace(ctx.trx, it.court_id);
      await takeOne(ctx, it, court.location_id, policy.id, null);
      bookings++;
    }
    return { bookings, weekly, left: s.left.length + (s.items.length < first.items.length ? first.items.length - s.items.length : 0) };
  },
});

/** One Playtomic booking as a Kumi booking: its court time in place of the mirror's hold, its players, and what was
 *  paid in Playtomic. Nobody is told: the booking is the one they already had. */
async function takeOne(ctx: ApplyCtx, it: Item, locationId: string, policyId: string, seriesId: string | null) {
  const hold = await ctx.trx.selectFrom("mirror_booking").select(["court_time_id", "status"]).where("ref", "=", it.ref).forUpdate().executeTakeFirstOrThrow();
  if (hold.court_time_id) await ctx.update("court_time", hold.court_time_id, { active: false });
  const start = new Date(it.starts_at), end = new Date(start.getTime() + it.minutes * 60_000);
  const q = await quote(ctx.trx, { courtId: it.court_id, start, minutes: it.minutes, personId: it.organiser_id, at: ctx.now });
  const tax = Math.round(it.price_cents * q.tax_bp / (10_000 + q.tax_bp)), id = uuidv7(), code = await newCode(ctx.trx);
  await ctx.insert("booking", { id, code, location_id: locationId, organiser_id: it.organiser_id, status: "confirmed", source: "import", price_cents: it.price_cents, tax_cents: tax,
    quote: JSON.stringify({ from: "playtomic", booking_id: it.booking_id, price_cents: it.price_cents, paid_in_playtomic: it.paid }), policy_id: policyId,
    note: `Playtomic ${it.booking_id}`, invite_code: randomBytes(9).toString("base64url"), series_id: seriesId });
  const bp = uuidv7();
  await ctx.insert("booking_player", { id: bp, booking_id: id, person_id: it.organiser_id, guest_name: null, share_cents: it.price_cents });
  for (const p of it.players) await ctx.insert("booking_player", { id: uuidv7(), booking_id: id, person_id: p.person_id, guest_name: p.person_id ? null : p.name.slice(0, 80), share_cents: 0 });
  await insertTime(ctx, [{ id: uuidv7(), court_id: it.court_id, during: range(start, end), kind: "booking", booking_id: id }]);
  // Paid in Playtomic: kept as paid there. No money moved through Kumi, so nothing enters its books, and nothing of
  // it goes back through Kumi: a refund is made in Playtomic (booking.cancel says so).
  if (it.paid && it.price_cents > 0)
    await ctx.insert("payment", { id: uuidv7(), person_id: it.organiser_id, amount_cents: it.price_cents, method: "playtomic", provider: "none", status: "succeeded", booking_player_id: bp });
  await ctx.update("mirror_booking", it.ref, { status: "taken", court_time_id: null, clash_id: null });
  await ctx.update("playtomic_booking", it.booking_id, { taken_over_booking_id: id });
  return { booking_id: id, tax_cents: tax };
}

const clubTz = async (db: Db | Trx) => (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
function listLeft(left: Left[], tz: string): Text {
  const line = (l: Left): Text => join([l.court ? { en: l.court, es: l.court } : { en: "", es: "" }, l.starts_at ? at(new Date(l.starts_at), tz) : { en: "", es: "" },
    both(WHY_KEYS[l.why], { what: l.why === "kind" ? both(typeKey(l.what)) : l.what ?? "" })], ", ");
  const shown = left.slice(0, 12).map(line);
  return join([...shown, ...(left.length > 12 ? [both("plan.take_over.and_more", { count: left.length - 12 })] : [])], "; ");
}

/** Upcoming Playtomic bookings staff could take over: player bookings on linked courts, not taken over yet. */
export async function takeOverCandidates(db: Db | Trx, now: Date, o: { limit?: number } = {}) {
  const rows = await db.selectFrom("playtomic_booking").leftJoin("mirror_booking", (j) => j.on(sql<boolean>`mirror_booking.ref = playtomic_booking.booking_id || ':' || playtomic_booking.resource_id`))
    .leftJoin("court", "court.id", "playtomic_booking.court_id")
    .select(["playtomic_booking.booking_id", "playtomic_booking.starts_at", "playtomic_booking.ends_at", "playtomic_booking.booking_type", "playtomic_booking.price", "playtomic_booking.payment_status",
      "court.name as court", "mirror_booking.status"])
    .where("playtomic_booking.canceled", "=", false).where("playtomic_booking.starts_at", ">", now).where("playtomic_booking.taken_over_booking_id", "is", null)
    .where("playtomic_booking.court_id", "is not", null).where("playtomic_booking.booking_type", "in", [...TAKEABLE])
    .orderBy("playtomic_booking.starts_at").limit(o.limit ?? 300).execute();
  const owners = rows.length ? await db.selectFrom("playtomic_booking_player").select(["booking_id", "name", "person_id"]).where("booking_id", "in", rows.map((r) => r.booking_id))
    .where("is_owner", "=", true).execute() : [];
  return rows.map((r) => ({ booking_id: r.booking_id, starts_at: r.starts_at, ends_at: r.ends_at, type: r.booking_type, price: r.price, payment_status: r.payment_status, court: r.court ?? "",
    held: r.status === "held", owner: owners.find((x) => x.booking_id === r.booking_id)?.name ?? null, owner_known: Boolean(owners.find((x) => x.booking_id === r.booking_id)?.person_id) }));
}

// ---- The owner's daily comparison of Playtomic and Kumi (stages 1 to 3) ----

type Diff = { key: string; kind: "clash" | "missing" | "moved" | "cancelled" | "paid"; court: string; starts_at: Date; type: string; code?: string | null; booking_id?: string | null };

/** Per linked court and club day, from yesterday on: Playtomic's bookings, how Kumi has each one, and Kumi's own. */
export async function comparison(db: Db | Trx, now: Date, days = 14) {
  const tz = await clubTz(db), today = localDate(now, tz);
  const from = new Date(now.getTime() - 36 * 3600_000), to = new Date(now.getTime() + days * 86400_000);
  const courts = new Map((await db.selectFrom("external_ref").innerJoin("court", (j) => j.on(sql<boolean>`court.id::text = external_ref.entity_id`)).select(["court.id", "court.name"])
    .where("external_ref.system", "=", PLAYTOMIC).where("external_ref.entity", "=", "court").execute()).map((c) => [c.id, c.name]));
  if (!courts.size) return { today, days: [] as { day: string; court: string; playtomic: number; held: number; taken: number; kumi: number }[], diffs: [] as Diff[] };
  const ids = [...courts.keys()];
  const pt = await db.selectFrom("playtomic_booking").leftJoin("mirror_booking", (j) => j.on(sql<boolean>`mirror_booking.ref = playtomic_booking.booking_id || ':' || playtomic_booking.resource_id`))
    .leftJoin("booking", "booking.id", "playtomic_booking.taken_over_booking_id")
    .select(["playtomic_booking.booking_id", "playtomic_booking.court_id", "playtomic_booking.starts_at", "playtomic_booking.ends_at", "playtomic_booking.booking_type", "mirror_booking.status",
      "booking.code", "booking.id as kumi_id", "booking.status as kumi_status", "playtomic_booking.price_cents as pt_price", "playtomic_booking.payment_status",
      sql<string>`(SELECT coalesce(sum(p.amount_cents), 0) FROM payment p JOIN booking_player bp ON bp.id = p.booking_player_id WHERE bp.booking_id = booking.id AND p.status = 'succeeded' AND p.method = 'playtomic')`.as("kumi_pt_paid"),
      sql<Date | null>`(SELECT lower(ct.during) FROM court_time ct WHERE ct.booking_id = booking.id AND ct.active ORDER BY ct.id DESC LIMIT 1)`.as("kumi_start"),
      sql<string | null>`(SELECT ct.court_id::text FROM court_time ct WHERE ct.booking_id = booking.id AND ct.active ORDER BY ct.id DESC LIMIT 1)`.as("kumi_court")])
    .where("playtomic_booking.canceled", "=", false).where("playtomic_booking.court_id", "in", ids)
    .where("playtomic_booking.starts_at", ">=", from).where("playtomic_booking.starts_at", "<", to).execute();
  const kumi = await db.selectFrom("court_time").select(["court_id", sql<Date>`lower(during)`.as("s")]).where("court_id", "in", ids).where("active", "=", true)
    .where("kind", "in", ["booking", "session", "block"]).where(sql<boolean>`lower(during) >= ${from} AND lower(during) < ${to}`).execute();
  const cell = new Map<string, { day: string; court: string; playtomic: number; held: number; taken: number; kumi: number }>();
  const get = (court: string, d: Date) => {
    const day = localDate(d, tz), key = `${day}|${court}`;
    if (!cell.has(key)) cell.set(key, { day, court: courts.get(court) ?? "", playtomic: 0, held: 0, taken: 0, kumi: 0 });
    return cell.get(key)!;
  };
  const diffs: Diff[] = [];
  for (const r of pt) {
    const c = get(r.court_id!, new Date(r.starts_at));
    c.playtomic++;
    const base = { court: courts.get(r.court_id!) ?? "", starts_at: new Date(r.starts_at), type: r.booking_type };
    // Taken over (known by Playtomic's booking id, wherever Playtomic says it is now) and still booked here.
    if (r.code && r.kumi_status !== "cancelled") {
      c.taken++;
      // Then changed in Playtomic: the two no longer say the same court and time.
      if (r.kumi_start && (new Date(r.kumi_start).getTime() !== new Date(r.starts_at).getTime() || r.kumi_court !== r.court_id))
        diffs.push({ key: `moved:${r.booking_id}:${new Date(r.starts_at).toISOString()}:${r.court_id}`, kind: "moved", ...base, code: r.code });
      // Owed here when it was taken over, and paid in Playtomic since: staff mark it paid there (booking.paid_in_playtomic).
      // Measured against what Playtomic says it took, never the price here (time added here is owed here).
      if (r.payment_status === "PAID" && Number(r.kumi_pt_paid) < (r.pt_price ?? 0))
        diffs.push({ key: `paid:${r.booking_id}`, kind: "paid", ...base, code: r.code, booking_id: r.kumi_id });
    } else if (r.status === "held" || r.status === "covered") c.held++;
    else if (r.status === "conflict") diffs.push({ key: `clash:${r.booking_id}`, kind: "clash", ...base });
    else if (new Date(r.ends_at) > now) diffs.push({ key: `missing:${r.booking_id}`, kind: "missing", ...base });
  }
  // Taken over, then cancelled in Playtomic: still booked here.
  for (const r of await db.selectFrom("playtomic_booking").innerJoin("booking", "booking.id", "playtomic_booking.taken_over_booking_id")
    .select(["playtomic_booking.booking_id", "playtomic_booking.court_id", "playtomic_booking.starts_at", "playtomic_booking.booking_type", "booking.code"])
    .where("playtomic_booking.canceled", "=", true).where("booking.status", "!=", "cancelled").where("playtomic_booking.court_id", "in", ids)
    .where("playtomic_booking.starts_at", ">=", from).where("playtomic_booking.starts_at", "<", to).execute())
    diffs.push({ key: `cancelled:${r.booking_id}`, kind: "cancelled", court: courts.get(r.court_id!) ?? "", starts_at: new Date(r.starts_at), type: r.booking_type, code: r.code });
  for (const k of kumi) get(k.court_id, new Date(k.s)).kumi++;
  return { today, days: [...cell.values()].sort((a, b) => a.day.localeCompare(b.day) || a.court.localeCompare(b.court)), diffs: diffs.sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime()) };
}

/** Once a club day, while Playtomic is connected: compare, and tell the owners about differences not told before. */
export async function comparePlaytomic(db: Db, o: { now?: Date; days?: number } = {}): Promise<{ ran: boolean; differences: number; told: number }> {
  const now = o.now ?? new Date();
  const status = await db.selectFrom("connector_status").select(["last_ok_at", "compared_on"]).where("system", "=", PLAYTOMIC).executeTakeFirst();
  if (!status?.last_ok_at) return { ran: false, differences: 0, told: 0 };
  const c = await comparison(db, now, o.days);
  if (status.compared_on && String(status.compared_on).slice(0, 10) === c.today) return { ran: false, differences: c.diffs.length, told: 0 };
  const told = new Set(c.diffs.length ? (await db.selectFrom("playtomic_compare_told").select("key").where("key", "in", c.diffs.map((d) => d.key)).execute()).map((r) => r.key) : []);
  const fresh = c.diffs.filter((d) => !told.has(d.key));
  if (fresh.length) await runAsSystem(db, "mirror.compare_told", { keys: fresh.map((d) => d.key), lines: fresh.slice(0, 20).map((d) => ({ kind: d.kind, court: d.court, starts_at: d.starts_at.toISOString(), type: d.type, code: d.code ?? null })), more: Math.max(0, fresh.length - 20) }, "mirror:playtomic", { now });
  await db.updateTable("connector_status").set({ compared_on: c.today }).where("system", "=", PLAYTOMIC).execute();
  return { ran: true, differences: c.diffs.length, told: fresh.length };
}

const line = z.object({ kind: z.enum(["clash", "missing", "moved", "cancelled", "paid"]), court: z.string(), starts_at: z.iso.datetime(), type: z.string(), code: z.nullable(z.string()) });
export const mirrorCompareTold = defineAction({
  name: "mirror.compare_told", version: 1, system: true, internal: true,
  input: z.object({ keys: z.array(z.string()), lines: z.array(line), more: z.number().check(z.int(), z.minimum(0)) }),
  async plan(_ctx, i) {
    return { title: both("action.mirror.compare_told"), summary: both("plan.mirror.compare_told", { count: i.keys.length }), reads: [], undo: { kind: "none", note: both("reason.no_way_back") } };
  },
  async apply(ctx, i) {
    for (const key of i.keys) await ctx.trx.insertInto("playtomic_compare_told").values({ key, told_at: ctx.now }).onConflict((oc) => oc.column("key").doNothing()).execute();
    await ctx.emit("mirror.compared", { lines: i.lines, more: i.more });
    return null;
  },
});

/** A booking taken over unpaid, then paid in Playtomic (the daily comparison says so): the desk marks it paid there, so
 *  it isn't owed here. No money moves through Kumi and nothing enters its books, as at the take-over. */
export const bookingPaidInPlaytomic = defineAction({
  name: "booking.paid_in_playtomic", version: 1,
  input: z.object({ booking_id: z.uuid() }),
  async plan(ctx, i) {
    const b = await owedFromPlaytomic(ctx.db, i.booking_id);
    return { title: both("action.booking.paid_in_playtomic"), summary: both("plan.booking.paid_in_playtomic", { code: b.code, amount: usd(b.owed) }), reads: [],
      locationId: b.location_id, ownerIds: b.organiser_id ? [b.organiser_id] : [], moneyCents: 0, undo: { kind: "none", note: both("reason.no_way_back") } };
  },
  async apply(ctx, i) {
    await ctx.trx.selectFrom("booking").select("id").where("id", "=", i.booking_id).forUpdate().executeTakeFirstOrThrow();
    const b = await owedFromPlaytomic(ctx.trx, i.booking_id);   // again under the lock
    await ctx.insert("payment", { id: uuidv7(), person_id: b.organiser_id!, amount_cents: b.owed, method: "playtomic", provider: "none", status: "succeeded", booking_player_id: b.bp });
    return { cents: b.owed };
  },
});
async function owedFromPlaytomic(db: Db | Trx, bookingId: string) {
  const b = await db.selectFrom("booking").select(["id", "code", "status", "price_cents", "organiser_id", "location_id"]).where("id", "=", bookingId).executeTakeFirst();
  if (!b) throw new KumiError("error.not_found", { thing: both("thing.booking") }, 404);
  const twin = await db.selectFrom("playtomic_booking").select(["payment_status", "price_cents"]).where("taken_over_booking_id", "=", bookingId).executeTakeFirst();
  if (!twin) throw new KumiError("error.not_from_playtomic");
  if (twin.payment_status !== "PAID" || twin.price_cents === null) throw new KumiError("error.not_paid_in_playtomic");
  if (b.status === "cancelled") throw new KumiError("error.already_cancelled");
  const bp = await db.selectFrom("booking_player").select("id").where("booking_id", "=", bookingId).where("person_id", "=", b.organiser_id).where("removed_at", "is", null).executeTakeFirst();
  const paid = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
    .select([sql<string>`coalesce(sum(payment.amount_cents), 0)`.as("all"), sql<string>`coalesce(sum(payment.amount_cents) FILTER (WHERE payment.method = 'playtomic'), 0)`.as("pt")])
    .where("booking_player.booking_id", "=", bookingId).where("payment.status", "=", "succeeded").executeTakeFirstOrThrow();
  // What Playtomic says was paid there, less what's already counted as paid there: never the price here, so time added
  // here (owed at the desk) stays owed here.
  const owed = Math.min(twin.price_cents - Number(paid.pt), b.price_cents - Number(paid.all));
  if (owed <= 0 || !bp || !b.organiser_id) throw new KumiError("error.booking_paid_in_full");
  return { ...b, owed, bp: bp.id };
}

/** For booking.cancel: a booking that took over a Playtomic one, still booked there. */
export async function playtomicTwin(db: Db | Trx, bookingId: string) {
  return db.selectFrom("playtomic_booking").select(["booking_id", "canceled", "payment_status"]).where("taken_over_booking_id", "=", bookingId).executeTakeFirst();
}
