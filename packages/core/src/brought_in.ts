// Moving in from Playtomic, the money side (docs/setup/playtomic-wallets-and-memberships.md): Playtomic wallet balances
// become club credit, and Playtomic memberships carry over, paid through Playtomic's own date. Both read only what the
// server read itself: Playtomic's players through its Third Party API (playtomic_player, kept by readPlaytomicPlayers),
// or the club's customer export as uploaded and parsed here (playtomic_upload), never rows a request carries. Nothing
// here writes to Playtomic: the preview says what staff do there (zero the wallets, stop the memberships renewing).
//
// Credit brought in is money the club already owes its members: a liability (member_credit) whose other side is a
// brought_in account, never revenue. It's kept as one total per person (brought_credit): each run's target is the sum
// of that person's wallets as read, whatever the wallets are called, and a run moves only the difference. Less than
// before is taken back only when staff choose it, never by itself, since zeroing the wallets in Playtomic would
// otherwise take everyone's credit back. Once the owner says the wallets are at zero, it isn't run again.
import { createHash } from "node:crypto";
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, capFor, money, minorUnits, type Text } from "@kumi/i18n";
import { defineAction, runAsSystem } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate, localParts, onDate } from "./clock.ts";
import { account, creditBalance, post } from "./money.ts";
import { lockCredit } from "./credit.ts";
import { dayText, holds, planPrice } from "./memberships.ts";
import { textOf } from "./club_text.ts";
import { PLAYTOMIC, type PlaytomicClient } from "./playtomic.ts";
import { readMoveInCsv } from "./csv_read.ts";
import { erasedMatcher } from "./playtomic_erased.ts";

const amountText = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const joinLines = (lines: Text[]): Text => ({ en: lines.map((x) => x.en).join(" "), es: lines.map((x) => x.es).join(" ") });
/** The most one person's credit from Playtomic can be: $10,000, sized for the club's currency. Anything over is listed
 *  and left for the club to look at, never brought in (nor a balance a typo made a million). */
export const BROUGHT_CAP_USD_CENTS = 1_000_000;

/** A wallet as Playtomic shows it: "10 EUR", "25.50 USD", or an export's cell ("10,50", "€10", blank for empty). */
export interface BroughtWallet { ref: string; name: string; balance: string }
/** A benefit (Playtomic's membership or category) and the club date it runs until, if it has one. */
export interface BroughtBenefit { ref?: string; name: string; until: string | null; commitment?: string }
export interface BroughtPlayer { line?: number; playtomic_id?: string; email?: string; name: string; wallets?: BroughtWallet[]; benefits?: BroughtBenefit[] }

/** Where the move-in reads from: Playtomic itself (the players last read here), or an upload of the club's export, by
 *  its id and the hash of the file as read (the preview and the change are for that same file). */
const source = { source: z.enum(["playtomic", "file"]), upload_id: z.optional(z.uuid()), sha256: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/))) };

// ---- Amounts ----
const SIGNS: Record<string, string> = { "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW", "R$": "BRL", "Fr": "CHF" };
/** A balance in minor units and its currency: "10 EUR" is 1000 EUR, "1.234,56 €" 123456 EUR, "10" the club's own.
 *  A dollar sign is the club's currency when the club uses dollars (US, Canada, Mexico...), otherwise US dollars. */
export function parseBalance(raw: string, clubCurrency: string): { cents: number; currency: string } | null {
  let s = raw.trim();
  if (!s) return null;
  let currency: string | null = null;
  const code = s.match(/\b([A-Za-z]{3})\b/);
  if (code) { currency = code[1]!.toUpperCase(); s = s.replace(code[0], ""); }
  for (const [sign, cur] of Object.entries(SIGNS)) if (s.includes(sign)) { currency ??= cur; s = s.replace(sign, ""); }
  if (s.includes("$")) { currency ??= /^(USD|CAD|AUD|NZD|MXN|SGD|HKD)$/.test(clubCurrency) ? clubCurrency : "USD"; s = s.replace("$", ""); }
  s = s.replace(/\s/g, "");
  if (!/^-?[\d.,]+$/.test(s)) return null;
  // The last separator with one or two digits after it is the decimal one; the others group thousands.
  const last = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  const whole = last >= 0 && s.length - last - 1 <= 2 ? s.slice(0, last) : s, frac = last >= 0 && s.length - last - 1 <= 2 ? s.slice(last + 1) : "";
  const n = Number(`${whole.replace(/[.,]/g, "")}.${frac || "0"}`);
  if (!Number.isFinite(n)) return null;
  const cur = currency ?? clubCurrency;
  return { cents: Math.round(n * 10 ** minorUnits(cur)), currency: cur };
}

// ---- Who's who ----
interface Person { id: string; name: string }
/** The person here a Playtomic player is: by their Playtomic id (kept by the member import), else their email. */
async function personFor(db: Db | Trx, p: { playtomic_id?: string; email?: string }): Promise<Person | null> {
  if (p.playtomic_id) {
    const r = await db.selectFrom("external_ref").innerJoin("person", (j) => j.on(sql<boolean>`person.id::text = external_ref.entity_id`)).select(["person.id", "person.display_name"])
      .where("external_ref.system", "=", PLAYTOMIC).where("external_ref.entity", "=", "person").where("external_ref.external_id", "=", p.playtomic_id).where("person.redacted_at", "is", null).executeTakeFirst();
    if (r) return { id: r.id, name: r.display_name };
  }
  const email = p.email?.trim().toLowerCase();
  if (!email) return null;
  const r = await db.selectFrom("person").select(["id", "display_name"]).where(sql<string>`lower(email)`, "=", email).where("redacted_at", "is", null).executeTakeFirst();
  return r ? { id: r.id, name: r.display_name } : null;
}

/** The players to read: an upload the server parsed itself, or Playtomic's players as last read here. */
async function playersFrom(db: Db | Trx, i: { source: "playtomic" | "file"; upload_id?: string; sha256?: string }, tz: string):
  Promise<{ players: BroughtPlayer[]; readAt: Date | null; columns: { ref: string; name: string }[] | null }> {
  if (i.source === "file") {
    if (!i.upload_id || !i.sha256) throw new KumiError("error.upload_needed");
    const u = await db.selectFrom("playtomic_upload").select(["rows", "sha256", "wallet_columns", "at"]).where("id", "=", i.upload_id).executeTakeFirst();
    if (!u) throw new KumiError("error.upload_needed");
    if (u.sha256 !== i.sha256) throw new KumiError("error.changed");
    return { players: u.rows as BroughtPlayer[], readAt: u.at, columns: u.wallet_columns as { ref: string; name: string }[] };
  }
  const club = await db.selectFrom("club").select("playtomic_players_read_at").executeTakeFirstOrThrow();
  if (!club.playtomic_players_read_at) throw new KumiError("error.playtomic_players_not_read");
  const rows = await db.selectFrom("playtomic_player").selectAll().orderBy("name").execute();
  return { players: rows.map((r) => fromStored(r, tz)), readAt: club.playtomic_players_read_at, columns: null };
}

// ---- The club's export, uploaded ----
/** Staff upload the club's customer export: the server reads it here and keeps what it read (30 days), so the
 *  previews and changes after it apply only rows it parsed itself. The file itself isn't kept. */
export const playtomicUpload = defineAction({
  name: "playtomic.upload", version: 1, clubWide: true, forget: ["csv"],
  input: z.object({ csv: z.string().check(z.maxLength(5_000_000)), file_name: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const r = await readUpload(ctx.db, i.csv);
    const lines = [both("plan.playtomic.upload", { file: i.file_name || "CSV", players: both("count.movein_rows", { count: r.rows.length }) }),
      r.walletColumns.length ? both("plan.playtomic.upload_wallets", { columns: r.walletColumns.map((c) => c.name).join(", ") }) : both("plan.playtomic.upload_no_wallets")];
    if (r.problems.length) lines.push(both("count.lines_skipped", { count: r.problems.length }));
    return { title: both("action.playtomic.upload"), summary: joinLines(lines), reads: [], undo: { kind: "none" },
      details: { sha256: r.sha256, rows: r.rows.length, wallet_columns: r.walletColumns, problems: r.problems.slice(0, 50) } };
  },
  async apply(ctx, i, plan) {
    const r = await readUpload(ctx.trx, i.csv);
    if (r.sha256 !== (plan.details as { sha256: string }).sha256) throw new KumiError("error.changed");
    const id = uuidv7();
    await ctx.insert("playtomic_upload", { id, sha256: r.sha256, file_name: i.file_name ?? null, rows: JSON.stringify(r.rows), wallet_columns: JSON.stringify(r.walletColumns),
      problems: JSON.stringify(r.problems), uploaded_by: ctx.actor.personId ?? null, action_run_id: ctx.runId, at: ctx.now });
    // What was read a month ago has served its purpose: names and emails aren't kept longer than the move-in needs.
    await ctx.trx.deleteFrom("playtomic_upload").where("at", "<", new Date(ctx.now.getTime() - 30 * 86400_000)).execute();
    return { upload_id: id, sha256: r.sha256, rows: r.rows.length };
  },
});
async function readUpload(db: Db | Trx, csv: string) {
  const club = await db.selectFrom("club").select("format_locale").executeTakeFirstOrThrow();
  const r = readMoveInCsv(csv, { dayFirst: club.format_locale !== "en-US" });
  if (r.fatal) throw new KumiError("error.upload_unreadable", { why: r.fatal });
  return { ...r, sha256: createHash("sha256").update(csv).digest("hex") };
}

// ---- Playtomic's players, as read ----
/** One player from the Third Party API (/players, with WALLETS and BENEFITS), as kept here. */
export function normalizePlayer(raw: any): { player_id: string; name: string; email: string | null; phone: string | null; wallets: BroughtWallet[]; benefits: { ref: string; name: string; type: string | null; expires_at: string | null }[] } | null {
  const id = raw?.player_id ?? raw?.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  const wallets = (Array.isArray(raw?.wallets) ? raw.wallets : []).map((w: any) => ({ ref: String(w?.wallet_id ?? w?.name ?? "").slice(0, 120), name: String(w?.name ?? w?.wallet_id ?? "").slice(0, 120), balance: String(w?.balance ?? "").slice(0, 40) }))
    .filter((w: BroughtWallet) => w.ref && w.balance);
  const benefits = (Array.isArray(raw?.benefits) ? raw.benefits : []).map((b: any) => ({ ref: String(b?.benefit_id ?? b?.name ?? "").slice(0, 120), name: String(b?.name ?? "").slice(0, 120),
    type: typeof b?.type === "string" ? b.type : null, expires_at: typeof b?.expires_at === "string" && b.expires_at ? b.expires_at : null })).filter((b: { name: string }) => b.name);
  return { player_id: String(id).slice(0, 64), name: str(raw?.name, 120) ?? "", email: str(raw?.email, 200), phone: str(raw?.phone, 40), wallets, benefits };
}
/** The last club date a benefit's expires_at pays for: a bare date is that whole day on the club's clock; a time is when
 *  the period ends, so an end at midnight pays for the day before. */
export function lastDayPaid(expiresAt: string, tz: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return expiresAt;
  const end = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(expiresAt) ? expiresAt : `${expiresAt}Z`);
  return Number.isNaN(end.getTime()) ? null : localDate(new Date(end.getTime() - 1), tz);
}
function fromStored(r: { player_id: string; name: string; email: string | null; wallets: unknown; benefits: unknown }, tz: string): BroughtPlayer {
  const benefits = (r.benefits as { ref: string; name: string; type: string | null; expires_at: string | null }[])
    .map((b) => ({ ref: b.ref, name: b.name, until: b.expires_at ? lastDayPaid(b.expires_at, tz) : null }));
  return { playtomic_id: r.player_id, ...(r.email ? { email: r.email } : {}), name: r.name, wallets: r.wallets as BroughtWallet[], benefits };
}

/** Read every player from Playtomic (paced, so a big club takes a while) and keep what changed. Someone whose account
 *  was deleted here (playtomic_erased.ts) isn't kept again. A read that doesn't reach the end fails, and keeps what
 *  was there: never a part said to be the whole. */
export async function readPlaytomicPlayers(db: Db, client: Pick<PlaytomicClient, "players">, now = new Date()): Promise<{ ok: true; read: number; changed: number } | { ok: false; error: string }> {
  let raw: unknown[];
  try { raw = await client.players(); }
  catch (e) {
    await runAsSystem(db, "playtomic.players_store", { upserts: [], deletes: [], done: false, error: (e as Error).message.slice(0, 300) }, "job:playtomic", { now });
    return { ok: false, error: (e as Error).message };
  }
  const all = raw.map(normalizePlayer).filter((p): p is NonNullable<ReturnType<typeof normalizePlayer>> => Boolean(p));
  const erased = await erasedMatcher(db, { ids: all.map((p) => p.player_id), emails: all.map((p) => p.email) });
  const got = all.filter((p) => !erased({ id: p.player_id, email: p.email }));
  const kept = new Map((await db.selectFrom("playtomic_player").select(["player_id", "name", "email", "phone", "wallets", "benefits"]).execute())
    .map((r) => [r.player_id, JSON.stringify([r.name, r.email, r.phone, r.wallets, r.benefits])]));
  const upserts = got.filter((p) => kept.get(p.player_id) !== JSON.stringify([p.name, p.email, p.phone, p.wallets, p.benefits]));
  const seen = new Set(got.map((p) => p.player_id)), deletes = [...kept.keys()].filter((id) => !seen.has(id));
  // In parts, so no one change carries the whole club.
  for (let k = 0; k < Math.max(upserts.length, 1); k += 500) {
    const last = k + 500 >= upserts.length;
    await runAsSystem(db, "playtomic.players_store", { upserts: upserts.slice(k, k + 500), deletes: last ? deletes : [], done: last }, "job:playtomic", { now });
  }
  return { ok: true, read: got.length, changed: upserts.length + deletes.length };
}

const stored = z.object({ player_id: z.string(), name: z.string(), email: z.nullable(z.string()), phone: z.nullable(z.string()),
  wallets: z.array(z.object({ ref: z.string(), name: z.string(), balance: z.string() })), benefits: z.array(z.object({ ref: z.string(), name: z.string(), type: z.nullable(z.string()), expires_at: z.nullable(z.string()) })) });
/** Keeps what a read of Playtomic's players brought (system, from the read above). */
export const playtomicPlayersStore = defineAction({
  name: "playtomic.players_store", version: 1, system: true, internal: true,
  input: z.object({ upserts: z.array(stored).check(z.maxLength(500)), deletes: z.array(z.string()).check(z.maxLength(100_000)), done: z.boolean(), error: z.optional(z.string()) }),
  async plan() {
    return { title: both("action.playtomic.players_store"), summary: both("action.playtomic.players_store"), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    if (i.error) { await ctx.update("club", "singleton", { playtomic_players_error: i.error, playtomic_players_wanted_at: null }); return null; }
    for (const p of i.upserts)
      await ctx.trx.insertInto("playtomic_player").values({ ...p, wallets: JSON.stringify(p.wallets), benefits: JSON.stringify(p.benefits), read_at: ctx.now } as any)
        .onConflict((oc) => oc.column("player_id").doUpdateSet({ name: p.name, email: p.email, phone: p.phone, wallets: JSON.stringify(p.wallets), benefits: JSON.stringify(p.benefits), read_at: ctx.now } as any)).execute();
    if (i.deletes.length) await ctx.trx.deleteFrom("playtomic_player").where("player_id", "in", i.deletes).execute();
    if (i.done) await ctx.update("club", "singleton", { playtomic_players_read_at: ctx.now, playtomic_players_error: null, playtomic_players_wanted_at: null });
    return { kept: i.upserts.length, removed: i.deletes.length };
  },
});

/** Staff ask for Playtomic's players to be read again (the mirror's loop reads them, at Playtomic's pace). */
export const playtomicReadPlayers = defineAction({
  name: "playtomic.read_players", version: 1, clubWide: true,
  input: z.object({}),
  async plan() {
    return { title: both("action.playtomic.read_players"), summary: both("plan.playtomic.read_players"), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx) {
    await ctx.update("club", "singleton", { playtomic_players_wanted_at: ctx.now, playtomic_players_error: null });
    return null;
  },
});
/** Whether someone asked for Playtomic's players and they haven't been read since. */
export async function playersWanted(db: Db): Promise<boolean> {
  const c = await db.selectFrom("club").select(["playtomic_players_wanted_at", "playtomic_players_read_at"]).executeTakeFirst();
  return Boolean(c?.playtomic_players_wanted_at && (!c.playtomic_players_read_at || c.playtomic_players_read_at < c.playtomic_players_wanted_at));
}

// ---- Wallets into club credit ----
interface CreditLine { person_id: string; name: string; before: number; after: number; delta: number; wallets: { name: string; cents: number }[] }
interface CreditPlan { people: CreditLine[]; total: number; taken_back: number; less: { name: string; cents: number }[]; not_taken_back: { name: string; cents: number }[];
  other_currency: { name: string; wallet: string; balance: string }[]; unreadable: { name: string; wallet: string; balance: string }[]; unmatched: string[]; disagree: string[];
  over_cap: { name: string; cents: number }[]; columns: string[] | null; read_at: string | null; cap: number }

async function creditPlan(db: Db | Trx, i: { source: "playtomic" | "file"; upload_id?: string; sha256?: string; columns?: string[]; take_back?: boolean }): Promise<CreditPlan> {
  const club = await db.selectFrom("club").select(["currency", "time_zone", "brought_wallets_zeroed_at"]).executeTakeFirstOrThrow();
  if (club.brought_wallets_zeroed_at) throw new KumiError("error.brought_wallets_closed", { date: dayText(localDate(club.brought_wallets_zeroed_at, club.time_zone)) });
  const { players, readAt, columns } = await playersFrom(db, i, club.time_zone);
  // An export's wallet columns: all of them unless staff left some out (one that isn't a wallet after all).
  const use = columns ? new Set((i.columns ?? columns.map((c) => c.ref)).filter((r) => columns.some((c) => c.ref === r))) : null;
  const cap = capFor(BROUGHT_CAP_USD_CENTS, club.currency);
  const out: CreditPlan = { people: [], total: 0, taken_back: 0, less: [], not_taken_back: [], other_currency: [], unreadable: [], unmatched: [], disagree: [], over_cap: [],
    columns: columns ? columns.filter((c) => use!.has(c.ref)).map((c) => c.name) : null, read_at: readAt?.toISOString() ?? null, cap };
  // Each row's wallets as one target, grouped by the person here it is. The same person on two rows (one membership a
  // row) is one person: rows that agree count once, rows that disagree are listed and left.
  const byPerson = new Map<string, { name: string; rows: { cents: number; wallets: { name: string; cents: number }[]; key: string }[]; bad: boolean }>();
  for (const p of players) {
    const ws = (p.wallets ?? []).filter((w) => !use || use.has(w.ref));
    if (!ws.length) continue;
    const who = await personFor(db, p);
    if (!who) { if (ws.some((w) => (parseBalance(w.balance, club.currency)?.cents ?? 1) !== 0)) out.unmatched.push(p.name || p.email || p.playtomic_id || "?"); continue; }
    const entry = byPerson.get(who.id) ?? { name: who.name, rows: [], bad: false };
    let cents = 0;
    const wallets: { name: string; cents: number }[] = [];
    for (const w of ws) {
      const b = parseBalance(w.balance, club.currency);
      if (!b || b.cents < 0) { out.unreadable.push({ name: who.name, wallet: w.name, balance: w.balance }); entry.bad = true; continue; }
      if (b.currency !== club.currency) { if (b.cents) out.other_currency.push({ name: who.name, wallet: w.name, balance: w.balance }); continue; }
      cents += b.cents; wallets.push({ name: w.name || w.ref, cents: b.cents });
    }
    entry.rows.push({ cents, wallets, key: JSON.stringify(wallets.map((w) => [w.name, w.cents]).sort()) });
    byPerson.set(who.id, entry);
  }
  for (const [personId, e] of byPerson) {
    // An amount that can't be read leaves the total unknown: listed (above), and nothing moves for them.
    if (e.bad) continue;
    if (new Set(e.rows.map((r) => r.key)).size > 1) { out.disagree.push(e.name); continue; }
    const target = e.rows[0]!;
    if (target.cents > cap) { out.over_cap.push({ name: e.name, cents: target.cents }); continue; }
    const before = (await db.selectFrom("brought_credit").select("cents").where("person_id", "=", personId).where("system", "=", "playtomic").executeTakeFirst())?.cents ?? 0;
    const delta = target.cents - before;
    if (!delta) continue;
    if (delta < 0) {
      // Less in Playtomic now: spent there since, or the wallets being zeroed for the switch. Taken back only when staff
      // choose it, and never more than they still hold here.
      if (!i.take_back) { out.less.push({ name: e.name, cents: -delta }); continue; }
      if (-delta > await creditBalance(db, personId)) { out.not_taken_back.push({ name: e.name, cents: -delta }); continue; }
    }
    out.people.push({ person_id: personId, name: e.name, before, after: target.cents, delta, wallets: target.wallets });
    if (delta > 0) out.total += delta; else out.taken_back += -delta;
  }
  out.people.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Playtomic wallet balances become club credit (the owner; a manager asks), once the members are here. */
export const creditBringIn = defineAction({
  name: "credit.bring_in", version: 1, clubWide: true,
  input: z.object({ ...source, columns: z.optional(z.array(z.string().check(z.maxLength(120))).check(z.maxLength(50))), take_back: z.optional(z.boolean()) }),
  async plan(ctx, i) {
    const d = await creditPlan(ctx.db, i);
    const adds = d.people.filter((p) => p.delta > 0), backs = d.people.filter((p) => p.delta < 0);
    const lines: Text[] = [adds.length ? both("plan.credit.bring_in", { people: both("count.people", { count: adds.length }), amount: amountText(d.total) }) : both("plan.credit.bring_in_nothing")];
    if (d.columns) lines.push(both("plan.credit.bring_in_columns", { columns: d.columns.join(", ") || "-" }));
    for (const p of adds.slice(0, 40)) lines.push(both("plan.credit.bring_in_person", { name: p.name, amount: amountText(p.delta), wallets: p.wallets.filter((w) => w.cents).map((w) => w.name).join(", ") || "-" }));
    if (adds.length > 40) lines.push(both("plan.credit.bring_in_more", { count: adds.length - 40 }));
    if (backs.length) lines.push(both("plan.credit.bring_in_taken_back", { amount: amountText(d.taken_back), names: backs.map((p) => `${p.name} (${money(-p.delta, "en")})`).join(", ") }));
    if (d.less.length) lines.push(both("plan.credit.bring_in_less_kept", { names: d.less.map((x) => `${x.name} (${money(x.cents, "en")})`).join(", ") }));
    if (d.not_taken_back.length) lines.push(both("plan.credit.bring_in_not_taken_back", { names: d.not_taken_back.map((x) => x.name).join(", ") }));
    if (d.disagree.length) lines.push(both("plan.credit.bring_in_disagree", { names: d.disagree.join(", ") }));
    if (d.over_cap.length) lines.push(both("plan.credit.bring_in_over_cap", { cap: amountText(d.cap), names: d.over_cap.map((x) => `${x.name} (${money(x.cents, "en")})`).join(", ") }));
    if (d.other_currency.length) lines.push(both("plan.credit.bring_in_other_currency", { names: d.other_currency.map((x) => `${x.name} (${x.balance})`).join(", ") }));
    if (d.unreadable.length) lines.push(both("plan.credit.bring_in_unreadable", { names: d.unreadable.map((x) => `${x.name} (${x.balance})`).join(", ") }));
    if (d.unmatched.length) lines.push(both("plan.credit.bring_in_unmatched", { count: d.unmatched.length, names: d.unmatched.slice(0, 20).join(", ") }));
    if (adds.length) lines.push(both("plan.credit.bring_in_zero"));
    return { title: both("action.credit.bring_in"), summary: joinLines(lines), reads: [], ownerIds: d.people.map((p) => p.person_id), moneyCents: d.total,
      undo: { kind: "none", note: both("reason.bring_in_again") }, details: d };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as CreditPlan;
    if (!d.people.length) throw new KumiError("error.nothing_to_do");
    const club = await ctx.trx.selectFrom("club").select("brought_wallets_zeroed_at").forUpdate().executeTakeFirstOrThrow();
    if (club.brought_wallets_zeroed_at) throw new KumiError("error.changed");
    const first = !(await ctx.trx.selectFrom("brought_credit").select("id").where("system", "=", "playtomic").executeTakeFirst());
    for (const p of d.people) {
      if (p.after > d.cap) throw new KumiError("error.changed");
      await lockCredit(ctx.trx, p.person_id);
      const row = await ctx.trx.selectFrom("brought_credit").select(["id", "cents"]).where("person_id", "=", p.person_id).where("system", "=", "playtomic").executeTakeFirst();
      // What the preview saw is still so: nothing brought in or spent meanwhile.
      if ((row?.cents ?? 0) !== p.before) throw new KumiError("error.changed");
      if (p.delta < 0 && -p.delta > await creditBalance(ctx.trx, p.person_id)) throw new KumiError("error.changed");
      const wallets = JSON.stringify(p.wallets);
      if (row) await ctx.update("brought_credit", row.id, { cents: p.after, wallets, updated_at: ctx.now });
      else await ctx.insert("brought_credit", { id: uuidv7(), person_id: p.person_id, system: "playtomic", cents: p.after, wallets, action_run_id: ctx.runId, at: ctx.now, updated_at: ctx.now });
      // A liability: credit given is a negative entry (credit.ts); the club took this money before, in Playtomic.
      await post(ctx.trx, ctx.runId, "brought_in", p.delta > 0 ? "club credit brought from Playtomic's wallets" : "club credit from Playtomic taken back (spent there)", [
        { account: await account(ctx.trx, "member_credit", { personId: p.person_id }), cents: -p.delta },
        { account: await account(ctx.trx, "brought_in"), cents: p.delta }]);
    }
    await ctx.update("club", "singleton", { brought_wallets_at: ctx.now });
    // The owner and managers hear once, on Today, to zero the wallets in Playtomic.
    if (first) await ctx.emit("credit.brought_in", { people: d.people.length, cents: d.total });
    return { people: d.people.length, cents: d.total, taken_back: d.taken_back };
  },
});

/** The owner says the Playtomic wallets are at zero: credit isn't brought in again, and Today's reminder is done. */
export const creditBroughtZeroed = defineAction({
  name: "credit.brought_zeroed", version: 1, clubWide: true,
  input: z.object({}),
  async plan(ctx) {
    const c = await ctx.db.selectFrom("club").select(["brought_wallets_at", "brought_wallets_zeroed_at"]).executeTakeFirstOrThrow();
    if (!c.brought_wallets_at) throw new KumiError("error.brought_nothing_yet");
    if (c.brought_wallets_zeroed_at) throw new KumiError("error.already_done");
    return { title: both("action.credit.brought_zeroed"), summary: both("plan.credit.brought_zeroed"), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx) {
    await ctx.update("club", "singleton", { brought_wallets_zeroed_at: ctx.now, brought_wallets_zeroed_by: ctx.actor.personId ?? null });
    const open = await ctx.trx.selectFrom("event_outbox").select("id").where("topic", "=", "credit.brought_in")
      .where((eb) => eb.not(eb.exists(eb.selectFrom("staff_alert").select("staff_alert.id").whereRef("staff_alert.event_id", "=", "event_outbox.id").where("staff_alert.kind", "=", BROUGHT_ALERT)))).execute();
    for (const e of open) await ctx.insert("staff_alert", { id: uuidv7(), event_id: e.id, kind: BROUGHT_ALERT, handled_by: ctx.actor.personId ?? null, handled_at: ctx.now });
    return null;
  },
});
export const BROUGHT_ALERT = "playtomic_wallets_staff";

/** What the move-in has done so far, for the staff page. */
export async function moveInStatus(db: Db | Trx) {
  const c = await db.selectFrom("club").select(["brought_wallets_at", "brought_wallets_zeroed_at", "playtomic_players_read_at", "playtomic_players_wanted_at", "playtomic_players_error"]).executeTakeFirstOrThrow();
  const credit = await db.selectFrom("brought_credit").select([sql<string>`coalesce(sum(cents), 0)`.as("c"), sql<string>`count(*) FILTER (WHERE cents > 0)`.as("n")]).executeTakeFirstOrThrow();
  const kept = await db.selectFrom("membership").select(sql<string>`count(*)`.as("n")).where("brought_from", "=", "playtomic").executeTakeFirstOrThrow();
  const players = await db.selectFrom("playtomic_player").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow();
  const upload = await db.selectFrom("playtomic_upload").select(["id", "sha256", "file_name", "rows", "wallet_columns", "problems", "at"]).orderBy("at", "desc").limit(1).executeTakeFirst();
  return { players_read_at: c.playtomic_players_read_at, players_wanted_at: c.playtomic_players_wanted_at, players_error: c.playtomic_players_error, players: Number(players.n),
    credit_cents: Number(credit.c), credit_people: Number(credit.n), wallets_brought_at: c.brought_wallets_at, wallets_zeroed_at: c.brought_wallets_zeroed_at, memberships: Number(kept.n),
    upload: upload ? { id: upload.id, sha256: upload.sha256, file_name: upload.file_name, at: upload.at, rows: (upload.rows as BroughtPlayer[]).length,
      players: upload.rows as BroughtPlayer[], wallet_columns: upload.wallet_columns as { ref: string; name: string }[], problems: upload.problems as { line: number; text: Text }[] } : null };
}

// ---- Memberships carried over ----
const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
interface MembershipLine { person_id: string; name: string; benefit: string; ref: string; plan_id: string; plan: string; until: string; renews: boolean; note: string | null }
interface MembershipPlan { people: MembershipLine[]; unmapped: { benefit: string; people: number }[]; already: string[]; no_end: { name: string; benefit: string }[]; ended: number;
  skipped: number; unmatched: string[]; full: { name: string; plan: string }[]; read_at: string | null }

async function membershipPlan(db: Db | Trx, i: { source: "playtomic" | "file"; upload_id?: string; sha256?: string; map: Record<string, string> }, today: string): Promise<MembershipPlan> {
  const club = await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow();
  const { players, readAt } = await playersFrom(db, i, club.time_zone);
  const map = new Map(Object.entries(i.map).filter(([, v]) => v).map(([k, v]) => [normName(k), v]));
  const plans = new Map((await db.selectFrom("membership_plan").select(["id", "name", "translations", "active", "join_in_app", "max_members"]).execute()).map((p) => [p.id, p]));
  // A plan with a limit (a founding offer): what it holds now, and what this run would add.
  const holding = new Map((await db.selectFrom("membership").select(["plan_id", sql<string>`count(*)`.as("n")]).where("status", "in", ["upcoming", "active", "past_due"]).groupBy("plan_id").execute())
    .map((r) => [r.plan_id, Number(r.n)]));
  const out: MembershipPlan = { people: [], unmapped: [], already: [], no_end: [], ended: 0, skipped: 0, unmatched: [], full: [], read_at: readAt?.toISOString() ?? null };
  const unmapped = new Map<string, { benefit: string; people: number }>(), taken = new Set<string>();
  // The same player on several rows (one membership a row): their memberships together, once.
  const byKey = new Map<string, BroughtPlayer>();
  for (const p of players) {
    const k = p.playtomic_id ? `id:${p.playtomic_id}` : p.email ? `mail:${p.email.toLowerCase()}` : `row:${byKey.size}`;
    const had = byKey.get(k);
    byKey.set(k, had ? { ...had, benefits: [...(had.benefits ?? []), ...(p.benefits ?? [])] } : p);
  }
  for (const p of byKey.values()) {
    if (!(p.benefits ?? []).length) continue;
    const current = (p.benefits ?? []).filter((b) => b.until === null || b.until >= today);
    if (!current.length) { out.ended++; continue; }
    const who = await personFor(db, p);
    if (!who) { out.unmatched.push(p.name || p.email || p.playtomic_id || "?"); continue; }
    if (taken.has(who.id)) continue;
    // The one running longest, of those mapped to a plan here; one membership per person.
    const mapped = current.filter((b) => { const m = map.get(normName(b.name)); return m && m !== "skip" && plans.get(m)?.active; });
    for (const b of current) if (!map.has(normName(b.name))) {
      const u = unmapped.get(normName(b.name)) ?? { benefit: b.name, people: 0 }; u.people++; unmapped.set(normName(b.name), u);
    }
    if (!mapped.length) { if (current.every((b) => map.get(normName(b.name)) === "skip")) out.skipped++; continue; }
    const withEnd = mapped.filter((b) => b.until !== null).sort((a, b) => (b.until! > a.until! ? 1 : -1));
    if (!withEnd.length) { out.no_end.push({ name: who.name, benefit: mapped[0]!.name }); continue; }
    const b = withEnd[0]!, plan = plans.get(map.get(normName(b.name))!)!, ref = (b.ref || normName(b.name)).slice(0, 120);
    const brought = await db.selectFrom("membership").select("id").where("person_id", "=", who.id).where("brought_from", "=", "playtomic").where("brought_ref", "=", ref).executeTakeFirst();
    if (brought) continue;   // carried over already: a re-run leaves it
    if (await holds(db, who.id)) { out.already.push(who.name); continue; }
    if (plan.max_members && (holding.get(plan.id) ?? 0) >= plan.max_members) { out.full.push({ name: who.name, plan: plan.name }); continue; }
    holding.set(plan.id, (holding.get(plan.id) ?? 0) + 1);
    taken.add(who.id);
    out.people.push({ person_id: who.id, name: who.name, benefit: b.name, ref, plan_id: plan.id, plan: plan.name, until: b.until!, renews: plan.join_in_app, note: b.commitment ?? null });
  }
  out.unmapped = [...unmapped.values()].sort((a, b) => b.people - a.people);
  out.people.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Playtomic memberships become memberships here, paid through Playtomic's date: nothing is charged now (the owner; a
 *  manager asks). On a plan members join in the app, it renews here from that date on a card the member adds before
 *  then (they're reminded), and without one it ends that day; on a desk plan, the next period is paid at the desk. */
export const membershipBringIn = defineAction({
  name: "membership.bring_in", version: 1, clubWide: true,
  input: z.object({ ...source, map: z.record(z.string().check(z.maxLength(120)), z.string().check(z.maxLength(40))), note: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    for (const v of Object.values(i.map)) if (v && v !== "skip" && !/^[0-9a-f-]{36}$/i.test(v)) throw new KumiError("error.not_found", { thing: both("thing.membership_plan") }, 404);
    const tz = (await ctx.db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
    const d = await membershipPlan(ctx.db, i, localDate(ctx.now, tz));
    const plans = new Map((await ctx.db.selectFrom("membership_plan").select(["id", "name", "translations", "price_cents", "period"]).execute()).map((p) => [p.id, p]));
    const lines: Text[] = [d.people.length ? both("plan.membership.bring_in", { people: both("count.memberships", { count: d.people.length }) }) : both("plan.membership.bring_in_nothing")];
    for (const p of d.people.slice(0, 40)) {
      const pl = plans.get(p.plan_id)!;
      lines.push(both(p.renews ? "plan.membership.bring_in_person" : "plan.membership.bring_in_person_desk", { name: p.name, plan: textOf(pl.name, pl.translations, "name"), until: dayText(p.until), price: planPrice(pl.price_cents, pl.period) }));
    }
    if (d.people.length > 40) lines.push(both("plan.credit.bring_in_more", { count: d.people.length - 40 }));
    if (d.unmapped.length) lines.push(both("plan.membership.bring_in_unmapped", { names: d.unmapped.map((u) => `${u.benefit} (${u.people})`).join(", ") }));
    if (d.already.length) lines.push(both("plan.membership.bring_in_already", { names: d.already.join(", ") }));
    if (d.full.length) lines.push(both("plan.membership.bring_in_full", { names: d.full.map((x) => `${x.name} (${x.plan})`).join(", ") }));
    if (d.no_end.length) lines.push(both("plan.membership.bring_in_no_end", { names: d.no_end.map((x) => `${x.name} (${x.benefit})`).join(", ") }));
    if (d.unmatched.length) lines.push(both("plan.credit.bring_in_unmatched", { count: d.unmatched.length, names: d.unmatched.slice(0, 20).join(", ") }));
    if (d.people.some((p) => p.note)) lines.push(both("plan.membership.bring_in_commitment"));
    if (d.people.length) lines.push(both("plan.membership.bring_in_stop"));
    return { title: both("action.membership.bring_in"), summary: joinLines(lines), reads: [], ownerIds: d.people.map((p) => p.person_id), undo: { kind: "reversible" }, details: d };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as MembershipPlan;
    if (!d.people.length) throw new KumiError("error.nothing_to_do");
    const tz = (await ctx.trx.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
    const ids: string[] = [];
    for (const p of d.people) {
      if (await holds(ctx.trx, p.person_id)) throw new KumiError("error.changed");
      const pl = await ctx.trx.selectFrom("membership_plan").select(["price_cents", "period", "family_size", "extra_person_cents", "active", "max_members"]).where("id", "=", p.plan_id).executeTakeFirstOrThrow();
      if (!pl.active) throw new KumiError("error.changed");
      if (pl.max_members) {
        const n = await ctx.trx.selectFrom("membership").select(sql<string>`count(*)`.as("n")).where("plan_id", "=", p.plan_id).where("status", "in", ["upcoming", "active", "past_due"]).executeTakeFirstOrThrow();
        if (Number(n.n) >= pl.max_members) throw new KumiError("error.changed");
      }
      const id = uuidv7(), end = onDate(p.until, "24:00", tz);
      const note = [i.note, p.note ? `Playtomic commitment: ${p.note}` : null].filter(Boolean).join(" · ") || null;
      try {
        // Paid through the day Playtomic's period ends: renewed (or ended) as that day is over, and after that on the
        // same day of the month (anchor_day), however short a month in between.
        await ctx.insert("membership", { id, person_id: p.person_id, plan_id: p.plan_id, status: "active", source: p.renews ? "app" : "desk", started_at: ctx.now,
          current_period_end: end, price_cents: pl.price_cents, period: pl.period, family_size: pl.family_size, extra_person_cents: pl.extra_person_cents,
          note, brought_from: "playtomic", brought_ref: p.ref, brought_note: p.note, anchor_day: localParts(end, tz).d });
      } catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
      ids.push(id);
    }
    // Nobody is told now: telling members about the club's new app is the club's own announcement (as with an import).
    return { memberships: ids.length };
  },
});
