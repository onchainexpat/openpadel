// The read-only Playtomic mirror (strategy.md, "alongside Playtomic"). It reads a club's bookings
// through Playtomic's Third Party API with the club's own credentials and holds those courts in
// Kumi, so Kumi never puts an event on a court Playtomic has sold. It never writes to Playtomic.
import * as z from "zod/mini";
import { sql } from "kysely";
import { both } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";

export const PLAYTOMIC = "playtomic";
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The Third Party API, read-only: a token, then bookings by date window, page by page. */
export class PlaytomicClient {
  private token: string | null = null;
  private tokenUntil = 0;
  private readonly o: { clientId: string; secret: string; tenantId: string; fetch: Fetch; baseUrl: string; pageDelayMs: number };
  constructor(o: { clientId: string; secret: string; tenantId: string; fetch?: Fetch; baseUrl?: string; pageDelayMs?: number }) {
    // About one call a minute is what the API takes in practice, so pages are a minute apart by default.
    this.o = { fetch: globalThis.fetch.bind(globalThis), baseUrl: "https://thirdparty.playtomic.io", pageDelayMs: 60_000, ...o };
  }
  private async bearer(): Promise<string> {
    if (this.token && Date.now() < this.tokenUntil) return this.token;
    const r = await this.o.fetch(`${this.o.baseUrl}/api/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: this.o.clientId, secret: this.o.secret }) });
    if (!r.ok) throw new Error(`playtomic auth failed: ${r.status}`);
    const d = await r.json() as { token?: string; expires_in?: number };
    if (!d.token) throw new Error("playtomic auth: no token");
    this.token = d.token; this.tokenUntil = Date.now() + ((d.expires_in ?? 3600) - 60) * 1000;
    return this.token;
  }
  /** Bookings starting in [from, to). The list comes back bare; a short page is the last one. */
  async bookings(from: Date, to: Date, size = 200, maxPages = 50): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 0; page < maxPages; page++) {
      if (page > 0 && this.o.pageDelayMs) await new Promise((r) => setTimeout(r, this.o.pageDelayMs));
      const q = new URLSearchParams({ tenant_id: this.o.tenantId, start_booking_date: from.toISOString().slice(0, 19), end_booking_date: to.toISOString().slice(0, 19), page: String(page), size: String(size) });
      const r = await this.o.fetch(`${this.o.baseUrl}/api/v1/bookings?${q}`, { headers: { authorization: `Bearer ${await this.bearer()}` } });
      if (!r.ok) throw new Error(`playtomic bookings failed: ${r.status}`);
      const items = await r.json() as unknown;
      if (!Array.isArray(items)) throw new Error("playtomic bookings: not a list");
      out.push(...items);
      if (items.length < size) break;
    }
    return out;
  }
}

export interface Booking { ref: string; courtRef: string; courtName: string; start: Date; end: Date; type: string; cancelled: boolean }

/** Playtomic's duration arrives in milliseconds, seconds or minutes. A padel booking is about 1 to 2 hours. */
export function durationMs(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return n;
  if (n >= 1_000) return n * 1000;
  return n * 60_000;
}

/** One API row to a booking, or null when it can't be read safely. Times without a zone are UTC. */
export function normalize(raw: any): Booking | null {
  const id = raw?.booking_id ?? raw?.id, court = raw?.resource_id, startRaw = raw?.booking_start_date;
  if (!id || !court || typeof startRaw !== "string") return null;
  const start = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(startRaw) ? startRaw : `${startRaw}Z`), ms = durationMs(raw.duration_ms ?? raw.duration);
  if (Number.isNaN(start.getTime()) || !ms) return null;
  return { ref: `${id}:${court}`, courtRef: String(court), courtName: String(raw.resource_name ?? court), start, end: new Date(start.getTime() + ms), type: String(raw.booking_type ?? ""), cancelled: Boolean(raw.is_canceled) };
}

// Players' own bookings and the club's lessons and courses are real use of the court. Anything else
// Playtomic shows over a Kumi event (a block, the event's own listing) is the club holding the court for it.
export const PLAYER_TYPES: ReadonlySet<string> = new Set(["REGULAR_BOOKING", "OPEN_MATCH", "PRIVATE_CLASS", "COURSE_CLASS"]);
export const isClubBlock = (type: string | null | undefined) => Boolean(type) && !PLAYER_TYPES.has(type!);

interface Slot { id: string; courtId: string; kind: string; s: number; e: number }
type Verdict = { status: "held" | "covered" | "conflict"; clashId: string | null };

/** Held if the court is free in Kumi; covered if it's the club's block over Kumi events; otherwise a conflict. */
export function classify(b: { courtId: string; s: number; e: number; type: string }, slots: Slot[]): Verdict {
  const over = slots.filter((x) => x.courtId === b.courtId && x.s < b.e && b.s < x.e);
  if (!over.length) return { status: "held", clashId: null };
  if (isClubBlock(b.type) && over.every((x) => x.kind === "session")) return { status: "covered", clashId: over[0]!.id };
  return { status: "conflict", clashId: (over.find((x) => x.kind !== "mirror") ?? over[0]!).id };
}

async function slotsFor(db: Db | Trx, courtIds: string[], from: Date, to: Date): Promise<Slot[]> {
  if (!courtIds.length) return [];
  const rows = await db.selectFrom("court_time").select(["id", "court_id", "kind", sql<Date>`lower(during)`.as("s"), sql<Date>`upper(during)`.as("e")])
    .where("court_id", "in", courtIds).where("active", "=", true).where(sql<boolean>`during && tstzrange(${from}, ${to})`).execute();
  return rows.map((r) => ({ id: r.id, courtId: r.court_id, kind: r.kind, s: new Date(r.s).getTime(), e: new Date(r.e).getTime() }));
}

const linkedCourts = async (db: Db | Trx) => new Map((await db.selectFrom("external_ref").select(["external_id", "entity_id"])
  .where("system", "=", PLAYTOMIC).where("entity", "=", "court").execute()).map((r) => [r.external_id, r.entity_id]));

export interface MirrorChange { ref: string; courtId: string; courtName: string; start: string; end: string; type: string; gone: boolean }
export interface MirrorDiff { changes: MirrorChange[]; unmapped: { courtRef: string; courtName: string; bookings: number }[] }

/**
 * What changed since the last copy, for bookings starting in [from, to): new, moved, cancelled or gone,
 * or now judged differently (a Kumi event added or removed under it). Unchanged bookings aren't touched.
 */
export async function diffMirror(db: Db | Trx, fetched: Booking[], from: Date, to: Date): Promise<MirrorDiff> {
  const courts = await linkedCourts(db);
  const stored = new Map((await db.selectFrom("mirror_booking").select(["ref", "court_id", "status", "booking_type", "court_time_id", "clash_id", sql<Date>`lower(during)`.as("s"), sql<Date>`upper(during)`.as("e")])
    .where("system", "=", PLAYTOMIC).where(sql<boolean>`lower(during) >= ${from} AND lower(during) < ${to}`).execute()).map((r) => [r.ref, r]));
  const slots = await slotsFor(db, [...new Set(courts.values())], from, new Date(to.getTime() + 864e5));
  const unmapped = new Map<string, { courtName: string; bookings: number }>(), seen = new Set<string>(), changes: MirrorChange[] = [];
  for (const b of fetched) {
    const courtId = courts.get(b.courtRef);
    if (!courtId) { const u = unmapped.get(b.courtRef) ?? { courtName: b.courtName, bookings: 0 }; u.bookings++; unmapped.set(b.courtRef, u); continue; }
    seen.add(b.ref);
    const cur = stored.get(b.ref), change = { ref: b.ref, courtId, courtName: b.courtName, start: b.start.toISOString(), end: b.end.toISOString(), type: b.type };
    if (b.cancelled) { if (cur && cur.status !== "gone") changes.push({ ...change, gone: true }); continue; }
    const v = classify({ courtId, s: b.start.getTime(), e: b.end.getTime(), type: b.type }, slots.filter((x) => x.id !== cur?.court_time_id));
    const same = cur && cur.status === v.status && cur.court_id === courtId && cur.booking_type === b.type && (cur.clash_id ?? null) === v.clashId
      && new Date(cur.s).getTime() === b.start.getTime() && new Date(cur.e).getTime() === b.end.getTime();
    if (!same) changes.push({ ...change, gone: false });
  }
  for (const [ref, r] of stored) if (!seen.has(ref) && r.status !== "gone")
    changes.push({ ref, courtId: r.court_id, courtName: "", start: new Date(r.s).toISOString(), end: new Date(r.e).toISOString(), type: r.booking_type, gone: true });
  return { changes, unmapped: [...unmapped].map(([courtRef, u]) => ({ courtRef, ...u })) };
}

export const mapCourt = defineAction({
  name: "connector.map_court", version: 1,
  input: z.object({ resource_id: z.string().check(z.minLength(1)), resource_name: z.optional(z.string()), court_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "court", i.court_id, "thing.court");
    const taken = await ctx.db.selectFrom("external_ref").select("entity_id").where("system", "=", PLAYTOMIC).where("entity", "=", "court")
      .where((eb) => eb.or([eb("external_id", "=", i.resource_id), eb("entity_id", "=", i.court_id)])).executeTakeFirst();
    if (taken) throw new KumiError("error.already_mapped");
    return { title: both("action.connector.map_court"), summary: both("plan.connector.map_court", { resource: i.resource_name ?? i.resource_id, court: row.name }), reads: [read], locationId: row.location_id, undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    await ctx.trx.insertInto("external_ref").values({ entity: "court", entity_id: i.court_id, system: PLAYTOMIC, external_id: i.resource_id }).execute();
    return null;
  },
});

const changeIn = z.object({ ref: z.string(), courtId: z.uuid(), courtName: z.string(), start: z.iso.datetime(), end: z.iso.datetime(), type: z.string(), gone: z.boolean() });

export const mirrorApply = defineAction({
  name: "mirror.apply", version: 1, system: true, internal: true,
  input: z.object({ changes: z.array(changeIn) }),
  async plan(_ctx, i) {
    const gone = i.changes.filter((c) => c.gone).length;
    return { title: both("action.mirror.apply"), summary: both("plan.mirror.apply", { changed: i.changes.length - gone, removed: gone }), reads: [], undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    const refs = i.changes.map((c) => c.ref);
    const stored = new Map((await ctx.trx.selectFrom("mirror_booking").selectAll().where("ref", "in", refs.length ? refs : [""]).execute()).map((r) => [r.ref, r]));
    // Lock every court involved first, in id order (spikes/booking_race.md); then judge each booking against what's there now.
    const courtIds = [...new Set([...i.changes.map((c) => c.courtId), ...[...stored.values()].map((r) => r.court_id)])].sort();
    for (const id of courtIds) await ctx.trx.selectFrom("court").select("id").where("id", "=", id).forUpdate().execute();
    const times = i.changes.flatMap((c) => [Date.parse(c.start), Date.parse(c.end)]);
    let slots = await slotsFor(ctx.trx, courtIds, new Date(Math.min(...times, Date.now()) - 864e5), new Date(Math.max(...times, Date.now()) + 864e5));
    for (const c of i.changes) {   // let go of the old hold first, so a booking that moved can't clash with itself
      const id = stored.get(c.ref)?.court_time_id;
      if (id) { await ctx.update("court_time", id, { active: false }); slots = slots.filter((x) => x.id !== id); }
    }
    const counts = { held: 0, covered: 0, conflict: 0, gone: 0 };
    for (const c of [...i.changes].sort((a, b) => a.start.localeCompare(b.start))) {
      const cur = stored.get(c.ref);
      const during = sql`tstzrange(${new Date(c.start)}, ${new Date(c.end)})`;
      if (c.gone) {
        if (cur && cur.status !== "gone") { await ctx.update("mirror_booking", c.ref, { status: "gone", court_time_id: null }); counts.gone++; }
        continue;
      }
      const v = classify({ courtId: c.courtId, s: Date.parse(c.start), e: Date.parse(c.end), type: c.type }, slots);
      let courtTimeId: string | null = null;
      if (v.status === "held") {
        courtTimeId = uuidv7();
        await ctx.insert("court_time", { id: courtTimeId, court_id: c.courtId, during, kind: "mirror" });
        slots.push({ id: courtTimeId, courtId: c.courtId, kind: "mirror", s: Date.parse(c.start), e: Date.parse(c.end) });
      }
      const row = { court_id: c.courtId, during, booking_type: c.type, status: v.status, court_time_id: courtTimeId, clash_id: v.clashId };
      if (cur) await ctx.update("mirror_booking", c.ref, row);
      else await ctx.insert("mirror_booking", { ref: c.ref, system: PLAYTOMIC, ...row });
      // A conflict is said once: when it starts, or when it's with a different court time.
      if (v.status === "conflict" && (cur?.status !== "conflict" || cur.clash_id !== v.clashId))
        await ctx.emit("mirror.conflict", { ref: c.ref, court_id: c.courtId, court_name: c.courtName, start: c.start, end: c.end, type: c.type, clash_id: v.clashId });
      counts[v.status]++;
    }
    return counts;
  },
});

/**
 * One sync: read Playtomic, work out what changed, write only that. Nothing changed means no action
 * run at all. How it went is kept in connector_status for the staff screen (not an action: it's
 * Kumi's own bookkeeping, like a sign-in session).
 */
export async function syncMirror(db: Db, client: PlaytomicClient, o: { now?: Date; daysBack?: number; daysAhead?: number } = {}) {
  const now = o.now ?? new Date();
  const from = new Date(now.getTime() - (o.daysBack ?? 1) * 864e5), to = new Date(now.getTime() + (o.daysAhead ?? 30) * 864e5);
  const status = (v: { last_ok_at?: Date; last_error: string | null; fetched?: number; unmapped?: unknown }) => {
    const row = { last_sync_at: now, ...v, unmapped: v.unmapped === undefined ? undefined : JSON.stringify(v.unmapped) };
    return db.insertInto("connector_status").values({ system: PLAYTOMIC, ...row } as any).onConflict((oc) => oc.column("system").doUpdateSet(row as any)).execute();
  };
  try {
    const raw = await client.bookings(from, to);
    // Paging over a list that changes while it's read can return a booking twice; the last copy wins.
    const fetched = [...new Map(raw.map(normalize).filter((b): b is Booking => b !== null).map((b) => [b.ref, b])).values()];
    const diff = await diffMirror(db, fetched, from, to);
    type Counts = { held: number; covered: number; conflict: number; gone: number };
    const result = diff.changes.length
      ? (await runAsSystem(db, "mirror.apply", { changes: diff.changes }, "mirror:playtomic", { now })).result as Counts
      : { held: 0, covered: 0, conflict: 0, gone: 0 };
    await status({ last_ok_at: now, last_error: null, fetched: raw.length, unmapped: diff.unmapped });
    return { ok: true as const, fetched: raw.length, unreadable: raw.length - fetched.length, changes: diff.changes.length, unmapped: diff.unmapped, ...result };
  } catch (e) {
    await status({ last_error: (e as Error).message.slice(0, 500) });
    return { ok: false as const, error: (e as Error).message };
  }
}
