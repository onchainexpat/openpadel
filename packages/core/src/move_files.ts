// Moving in from CourtReserve or Playbypoint (docs/setup/moving-from-courtreserve.md, docs/setup/moving-in.md): the
// files the club exports there, read by the server (move_read.ts) and kept 30 days, then brought in step by step, each
// a previewed change of its own:
//   move.upload       a file read and kept: a people list, bookings, or program sign-ups;
//   move.members      the people in it become members (or those already here get what's new);
//   move.memberships  their memberships carry over on plans staff choose, paid through the date there;
//   move.credit       their club credit there becomes club credit here: what the club owes them, never a payment;
//   move.bookings     upcoming court bookings, on the courts here, holding court time like any booking;
//   move.programs     sign-ups to the events and programs staff set up here.
// The steps read only what the server parsed itself (an upload, by its id and hash), never rows a request carries,
// and, like the Playtomic move and a members' import, they are the staff app's and the server's command line's alone
// (actions.ts, APP_ONLY): rows an assistant typed could make credit from nothing. Nothing here writes to the old system,
// tells anyone anything, or takes a payment: money paid there stays there, and so does any refund of it.
import { createHash, randomBytes } from "node:crypto";
import * as z from "zod/mini";
import { sql } from "kysely";
import { both, capFor, money, minorUnits, sizesCurrency, type Key, type Text } from "@kumi/i18n";
import { defineAction, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate, localParts, onDate } from "./clock.ts";
import { account, post } from "./money.ts";
import { lockCredit, playtomicLeft } from "./credit.ts";
import { dayText, holds, planPrice } from "./memberships.ts";
import { textOf } from "./club_text.ts";
import { anyPhone } from "./texts.ts";
import { insertTime, lockCourts, occupied, range } from "./bookings.ts";
import { newCode } from "./booking_pay.ts";
import { currentPolicy } from "./prices.ts";
import { erasedMatcher } from "./playtomic_erased.ts";
import { BROUGHT_CAP_USD_CENTS, parseBalance } from "./brought_in.ts";
import { MOVE_FILE_KINDS, MOVE_SYSTEMS, normColumn, readMoveFile, type MoveBooking, type MoveFileKind, type MovePerson, type MoveSignup, type MoveSystem, type MoveWho } from "./move_read.ts";

const SYSTEM = z.enum(MOVE_SYSTEMS);
export const systemName = (s: MoveSystem): string => (s === "courtreserve" ? "CourtReserve" : "Playbypoint");
const amount = (cents: number): Text => ({ en: money(cents, "en"), es: money(cents, "es") });
const lines = (parts: Text[]): Text => ({ en: parts.map((x) => x.en).join(" "), es: parts.map((x) => x.es).join(" ") });
const plain = (s: string): Text => ({ en: s, es: s });
/** Names in a preview line: the first 30, and how many more. */
const names = (xs: string[]): Text => {
  const shown = xs.slice(0, 30).join(", ");
  return xs.length > 30 ? { en: `${shown}, ${both("plan.move.and_more", { count: xs.length - 30 }).en}`, es: `${shown}, ${both("plan.move.and_more", { count: xs.length - 30 }).es}` } : plain(shown);
};
/** Lines of a list in each language, the first 30 and how many more. */
const joined = (xs: Text[], sep = "; "): Text => {
  const more = xs.length > 30 ? [both("plan.move.and_more", { count: xs.length - 30 })] : [];
  const all = [...xs.slice(0, 30), ...more];
  return { en: all.map((x) => x.en).join(sep), es: all.map((x) => x.es).join(sep) };
};
const whenText = (d: Date, tz: string): Text => {
  const f = (l: string) => new Intl.DateTimeFormat(l, { timeZone: tz, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
  return { en: f("en-US"), es: f("es-US") };
};
const clubOf = async (db: Db | Trx) => db.selectFrom("club").select(["time_zone", "currency", "country", "format_locale", "erase_salt"]).executeTakeFirstOrThrow();

// ---- The file, read and kept ----
/** A file from the old system, read by the server: what it found (rows, the columns read as what, the lines it couldn't
 *  use), kept 30 days so the steps after it read only that. An Excel sheet comes as its cells (the staff app and the
 *  command line read the workbook on the server first, xlsx.ts); the file itself is never kept. */
export const moveUpload = defineAction({
  name: "move.upload", version: 1, clubWide: true, forget: ["csv", "cells"],
  input: z.object({ from: SYSTEM, kind: z.enum(MOVE_FILE_KINDS), csv: z.optional(z.string().check(z.maxLength(5_000_000))),
    cells: z.optional(z.array(z.array(z.string().check(z.maxLength(2000))).check(z.maxLength(64))).check(z.maxLength(20_000))),
    file_name: z.optional(z.string().check(z.maxLength(200))) }),
  async plan(ctx, i) {
    const r = await readUpload(ctx.db, i);
    const from = systemName(i.from), problems = r.problems;
    const parts: Text[] = [both("plan.move.upload", { file: i.file_name || "CSV", from, kind: both(`move.kind_${i.kind}` as Key), rows: both("count.move_rows", { count: r.rows.length }) }),
      both("plan.move.columns", { columns: r.columns.length ? joined(r.columns.map((c) => { const w = both(`move.col_${c.what}` as Key); return { en: `${c.name} (${w.en})`, es: `${c.name} (${w.es})` }; }), ", ") : plain("-") })];
    if (problems.length) parts.push(both("count.move_lines_left", { count: problems.length, list: lines(problems.slice(0, 30).map((p) => p.text)) }));
    if (problems.length > 30) parts.push(both("plan.move.and_more", { count: problems.length - 30 }));
    parts.push(both("plan.move.unverified", { from }));
    return { title: both("action.move.upload"), summary: lines(parts), reads: [], undo: { kind: "none", note: both("reason.move_upload") },
      details: { sha256: r.sha256, rows: r.rows.length, columns: r.columns, problems: problems.slice(0, 500) } };
  },
  async apply(ctx, i, plan) {
    const r = await readUpload(ctx.trx, i);
    if (r.sha256 !== (plan.details as { sha256: string }).sha256) throw new KumiError("error.changed");
    const id = uuidv7();
    // The change log keeps its hash and counts, never the people in it (actions.ts, KEYS_NOT_KEPT).
    await ctx.insert("move_upload", { id, system: i.from, kind: i.kind, sha256: r.sha256, file_name: i.file_name ?? null, rows: JSON.stringify(r.rows), row_count: r.rows.length,
      columns: JSON.stringify(r.columns), problems: JSON.stringify(r.problems.slice(0, 500)), uploaded_by: ctx.actor.personId ?? null, action_run_id: ctx.runId, at: ctx.now });
    // A month on, a file has served the move: names and emails aren't kept longer than it needs.
    await ctx.trx.deleteFrom("move_upload").where("at", "<", new Date(ctx.now.getTime() - 30 * 86400_000)).execute();
    return { upload_id: id, sha256: r.sha256, rows: r.rows.length, lines_left: r.problems.length };
  },
});
async function readUpload(db: Db | Trx, i: { kind: MoveFileKind; csv?: string; cells?: string[][] }) {
  if (i.csv === undefined && i.cells === undefined) throw new KumiError("error.move_no_file", {}, 400);
  const club = await clubOf(db);
  const r = readMoveFile(i.kind, { ...(i.cells ? { cells: i.cells } : { csv: i.csv! }) }, { dayFirst: club.format_locale !== "en-US" });
  if (r.fatal) throw new KumiError("error.upload_unreadable", { why: r.fatal });
  const sha256 = createHash("sha256").update(i.cells ? JSON.stringify(i.cells) : i.csv!).digest("hex");
  return { ...r, sha256 };
}

const fileRef = { upload_id: z.uuid(), sha256: z.string().check(z.regex(/^[0-9a-f]{64}$/)) };
/** The upload a step reads, as the server kept it: by its id and hash, so a step is for that same file. */
async function uploadOf<R>(db: Db | Trx, i: { upload_id: string; sha256: string }, kind: MoveFileKind) {
  const u = await db.selectFrom("move_upload").leftJoin("person", "person.id", "move_upload.uploaded_by")
    .select(["move_upload.system", "move_upload.kind", "move_upload.sha256", "move_upload.rows", "move_upload.file_name", "move_upload.at", "person.display_name"])
    .where("move_upload.id", "=", i.upload_id).executeTakeFirst();
  if (!u) throw new KumiError("error.move_upload_needed");
  if (u.sha256 !== i.sha256) throw new KumiError("error.changed");
  if (u.kind !== kind) throw new KumiError("error.move_wrong_file", { kind: both(`move.kind_${u.kind}` as Key), want: both(`move.kind_${kind}` as Key) }, 400);
  const tz = (await clubOf(db)).time_zone;
  return { system: u.system as MoveSystem, rows: u.rows as R[], from: both("plan.movein_from_file", { file: u.file_name || "CSV", name: u.display_name ?? "-", when: whenText(u.at, tz) }) };
}

// ---- Who's who ----
interface Found { id: string; name: string; by: "id" | "email" | "name" }
/** The people here a file's lines name: by their id in the old system (kept by move.members), else their email, else
 *  (for a booking's or program's players, which may list names only) a name that only one member here has. A name two
 *  members share matches nobody. Two reads, whatever the file's size. */
async function matcher(db: Db | Trx, system: MoveSystem, whos: MoveWho[]) {
  const ids = [...new Set(whos.map((w) => w.ext_id).filter((x): x is string => Boolean(x)))];
  const emails = [...new Set(whos.map((w) => w.email).filter((x): x is string => Boolean(x)))];
  const byId = new Map(ids.length ? (await db.selectFrom("external_ref").innerJoin("person", (j) => j.on(sql<boolean>`person.id::text = external_ref.entity_id`))
    .select(["external_ref.external_id", "person.id", "person.display_name"]).where("external_ref.system", "=", system).where("external_ref.entity", "=", "person")
    .where("external_ref.external_id", "in", ids).where("person.redacted_at", "is", null).execute()).map((r) => [r.external_id, { id: r.id, name: r.display_name }]) : []);
  const byMail = new Map(emails.length ? (await db.selectFrom("person").select(["id", "display_name", sql<string>`lower(email)`.as("e")]).where(sql<string>`lower(email)`, "in", emails)
    .where("redacted_at", "is", null).execute()).map((r) => [r.e, { id: r.id, name: r.display_name }]) : []);
  let byName: Map<string, { id: string; name: string } | null> | null = null;
  return async (w: MoveWho, o: { names?: boolean } = {}): Promise<Found | null> => {
    const a = w.ext_id ? byId.get(w.ext_id) : undefined;
    if (a) return { ...a, by: "id" };
    const b = w.email ? byMail.get(w.email) : undefined;
    if (b) return { ...b, by: "email" };
    if (!o.names || !w.name) return null;
    if (!byName) {
      byName = new Map();
      for (const p of await db.selectFrom("person").select(["id", "display_name"]).where("redacted_at", "is", null).where("status", "!=", "archived").execute()) {
        const k = normColumn(p.display_name);
        byName.set(k, byName.has(k) ? null : { id: p.id, name: p.display_name });
      }
    }
    const c = byName.get(normColumn(w.name));
    return c ? { ...c, by: "name" } : null;
  };
}

// ---- Members ----
interface MemberLine { line: number; person_id: string | null; name: string; email: string | null; phone: string | null; news: boolean; link: string | null; locale: "en" | "es" }
async function membersPlan(db: Db | Trx, rows: MovePerson[], system: MoveSystem) {
  const club = await clubOf(db);
  const find = await matcher(db, system, rows);
  const gone = await erasedMatcher(db, { ids: [], emails: rows.map((r) => r.email) });
  const seen = new Set<string>(), seenPhone = new Set<string>();
  const out: MemberLine[] = [];
  let same = 0, twice = 0, erased = 0, phoneBad = 0, phoneTaken = 0, news = 0;
  for (const r of rows) {
    const keys = [r.email && `m:${r.email}`, r.ext_id && `i:${r.ext_id}`].filter((x): x is string => Boolean(x));
    // The same person on two lines (a membership report has a line for each membership): the first counts.
    if (keys.some((k) => seen.has(k))) { twice++; continue; }
    keys.forEach((k) => seen.add(k));
    if (gone({ email: r.email ?? null })) { erased++; continue; }
    const here = await find(r);
    const p = here ? await db.selectFrom("person").select(["phone", "junior"]).where("id", "=", here.id).executeTakeFirstOrThrow() : null;
    let phone: string | null = null;
    if (r.phone && !p?.junior && !p?.phone) {
      const e164 = anyPhone(r.phone, club.country);
      if (!e164) phoneBad++;
      else if (seenPhone.has(e164) || await db.selectFrom("person").select("id").where("phone", "=", e164).$if(Boolean(here), (q) => q.where("id", "!=", here!.id)).executeTakeFirst()) phoneTaken++;
      else { phone = e164; seenPhone.add(e164); }
    }
    // Their number in the old system, kept so a later file finds them by it.
    const link = r.ext_id && !(here?.by === "id") && !(here && await db.selectFrom("external_ref").select("external_id").where("system", "=", system).where("entity", "=", "person").where("entity_id", "=", here.id).executeTakeFirst())
      && !await db.selectFrom("external_ref").select("entity_id").where("system", "=", system).where("entity", "=", "person").where("external_id", "=", r.ext_id).executeTakeFirst() ? r.ext_id : null;
    // A yes to club news only when the file says yes, and only for someone who has never answered here.
    const yes = Boolean(r.news) && !(here && await db.selectFrom("channel_consent").select("id").where("person_id", "=", here.id).where("purpose", "=", "club_news").executeTakeFirst());
    if (yes) news++;
    if (here && !phone && !link && !yes) { same++; continue; }
    out.push({ line: r.line, person_id: here?.id ?? null, name: here?.name ?? r.name, email: here ? null : r.email ?? null, phone, news: yes, link, locale: club.format_locale.startsWith("es") ? "es" : "en" });
  }
  return { lines: out, add: out.filter((x) => !x.person_id), updated: out.filter((x) => x.person_id), same, twice, erased, phoneBad, phoneTaken, news };
}

/** The people in a file become members here; those already here (by their number there, else their email) keep their
 *  name and email and get only what's new: a phone when they have none, a yes to club news when the file says yes and
 *  they've never answered here, and their number there. Nobody is told: that's the club's own announcement. */
export const moveMembers = defineAction({
  name: "move.members", version: 1, clubWide: true,
  input: z.object(fileRef),
  async plan(ctx, i) {
    const u = await uploadOf<MovePerson>(ctx.db, i, "people"), from = systemName(u.system);
    const p = await membersPlan(ctx.db, u.rows, u.system);
    const parts: Text[] = [p.lines.length ? both("plan.move.members", { from, added: both("count.move_new_people", { count: p.add.length }), updated: both("count.people", { count: p.updated.length }) })
      : both("plan.move.members_nothing", { from }), u.from];
    if (p.add.length) parts.push(both("plan.move.members_new", { names: names(p.add.map((x) => x.name)) }));
    for (const [n, k] of [[p.same, "count.move_same"], [p.twice, "count.move_twice"], [p.news, "count.move_news"], [p.phoneBad, "count.import_phone_bad"], [p.phoneTaken, "count.import_phone_taken"], [p.erased, "count.import_erased"]] as const)
      if (n) parts.push(both(k, { count: n }));
    parts.push(both("plan.move.nobody_told"));
    return { title: both("action.move.members"), summary: lines(parts), reads: [], ownerIds: p.updated.map((x) => x.person_id!), undo: { kind: "compensating" },
      details: { add: p.add.length, updated: p.updated.length, same: p.same, news: p.news } };
  },
  async apply(ctx, i) {
    const u = await uploadOf<MovePerson>(ctx.trx, i, "people");
    const p = await membersPlan(ctx.trx, u.rows, u.system);   // again, in case someone joined meanwhile
    if (!p.lines.length) throw new KumiError("error.nothing_to_do");
    const member = await ctx.trx.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
    for (const r of p.lines) {
      let id = r.person_id;
      if (!id) {
        id = uuidv7();
        await ctx.insert("person", { id, display_name: r.name.trim(), email: r.email, phone: r.phone, locale: r.locale, created_via: "import" });
        if (r.email) await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: id, kind: "email", value: r.email, verified_at: null }).execute();
        await ctx.insert("person_role", { id: uuidv7(), person_id: id, role_id: member.id, location_id: null });
      } else if (r.phone) await ctx.update("person", id, { phone: r.phone });
      if (r.link) await ctx.trx.insertInto("external_ref").values({ entity: "person", entity_id: id, system: u.system, external_id: r.link }).execute();
      if (r.news) {
        await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: id, channel: "email", purpose: "club_news", granted: true, source: "import", form_version: null,
          evidence: JSON.stringify({ via: "import", from: u.system, by: ctx.actor.personId }), at: ctx.now }).execute();
        await ctx.emit("club_news.joined", { person_id: id });
      }
    }
    await ctx.emit("person.imported", { count: p.add.length });
    return { added: p.add.length, updated: p.updated.length };
  },
});

// ---- Memberships ----
const ENDED = /^(expired|cancelled|canceled|lapsed|terminated|inactive|ended|suspended|paused|deleted|frozen|vencid|cancelad)/;
interface CarryLine { person_id: string; name: string; membership: string; ref: string; plan_id: string; until: string; renews: boolean; ending: boolean }
/** Running to its end there and not renewing (Playbypoint's "Cancelling"): it ends here on that day too. */
const ENDING = /^(cancelling|canceling|pendingcancel|nonrenewing|notrenewing|endsatperiodend)/;
async function membershipsPlan(db: Db | Trx, rows: MovePerson[], system: MoveSystem, map: Record<string, string>, today: string) {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const chosen = new Map(Object.entries(map).filter(([, v]) => v).map(([k, v]) => [norm(k), v]));
  const plans = new Map((await db.selectFrom("membership_plan").select(["id", "name", "translations", "active", "join_in_app", "max_members", "price_cents", "period"]).execute()).map((p) => [p.id, p]));
  const holding = new Map((await db.selectFrom("membership").select(["plan_id", sql<string>`count(*)`.as("n")]).where("status", "in", ["upcoming", "active", "past_due"]).groupBy("plan_id").execute()).map((r) => [r.plan_id, Number(r.n)]));
  const find = await matcher(db, system, rows);
  const out = { people: [] as CarryLine[], unmapped: new Map<string, { name: string; people: number }>(), already: [] as string[], no_end: [] as string[], full: [] as string[], ended: 0, skipped: 0, unmatched: 0 };
  // Each person's memberships together (a report has a line for each), the current ones only.
  const byWho = new Map<string, { who: MovePerson; list: NonNullable<MovePerson["membership"]>[] }>();
  for (const r of rows) {
    if (!r.membership) continue;
    const k = r.ext_id ? `i:${r.ext_id}` : `m:${r.email}`;
    const e = byWho.get(k) ?? { who: r, list: [] };
    e.list.push(r.membership);
    byWho.set(k, e);
  }
  const taken = new Set<string>();
  for (const { who, list } of byWho.values()) {
    const current = list.filter((m) => !(m.status && ENDED.test(m.status)) && (!m.until || m.until >= today));
    if (!current.length) { out.ended++; continue; }
    const here = await find(who);
    if (!here) { out.unmatched++; continue; }
    if (taken.has(here.id)) continue;
    for (const m of current) if (!chosen.has(norm(m.name))) { const u = out.unmapped.get(norm(m.name)) ?? { name: m.name, people: 0 }; u.people++; out.unmapped.set(norm(m.name), u); }
    const mapped = current.filter((m) => { const id = chosen.get(norm(m.name)); return id && id !== "skip" && plans.get(id)?.active; });
    if (!mapped.length) { if (current.every((m) => chosen.get(norm(m.name)) === "skip")) out.skipped++; continue; }
    // The one running longest; one membership a person.
    const withEnd = mapped.filter((m) => m.until).sort((a, b) => (b.until! > a.until! ? 1 : -1));
    if (!withEnd.length) { out.no_end.push(`${here.name} (${mapped[0]!.name})`); continue; }
    const m = withEnd[0]!, plan = plans.get(chosen.get(norm(m.name))!)!, ref = norm(m.name).slice(0, 120);
    if (await db.selectFrom("membership").select("id").where("person_id", "=", here.id).where("brought_from", "=", system).where("brought_ref", "=", ref).executeTakeFirst()) continue;
    if (await holds(db, here.id)) { out.already.push(here.name); continue; }
    if (plan.max_members && (holding.get(plan.id) ?? 0) >= plan.max_members) { out.full.push(`${here.name} (${plan.name})`); continue; }
    holding.set(plan.id, (holding.get(plan.id) ?? 0) + 1);
    taken.add(here.id);
    out.people.push({ person_id: here.id, name: here.name, membership: m.name, ref, plan_id: plan.id, until: m.until!, renews: plan.join_in_app,
      ending: Boolean(m.status && ENDING.test(m.status)) });
  }
  out.people.sort((a, b) => a.name.localeCompare(b.name));
  return { ...out, plans };
}

/** Memberships there become memberships here, on the plan staff choose for each, paid through the date there: nothing is
 *  charged now (the owner; a manager asks). On a plan members join in the app it renews here from that day on a card
 *  they add (they're reminded), else it ends that day; on a desk plan the next period is paid at the desk. */
export const moveMemberships = defineAction({
  name: "move.memberships", version: 1, clubWide: true,
  input: z.object({ ...fileRef, map: z.record(z.string().check(z.maxLength(120)), z.string().check(z.maxLength(40))) }),
  async plan(ctx, i) {
    for (const v of Object.values(i.map)) if (v && v !== "skip" && !/^[0-9a-f-]{36}$/i.test(v)) throw new KumiError("error.not_found", { thing: both("thing.membership_plan") }, 404);
    const u = await uploadOf<MovePerson>(ctx.db, i, "people"), from = systemName(u.system), tz = (await clubOf(ctx.db)).time_zone;
    const d = await membershipsPlan(ctx.db, u.rows, u.system, i.map, localDate(ctx.now, tz));
    const parts: Text[] = [d.people.length ? both("plan.move.memberships", { from, people: both("count.memberships", { count: d.people.length }) }) : both("plan.move.memberships_nothing", { from }), u.from];
    for (const p of d.people.slice(0, 40)) {
      const pl = d.plans.get(p.plan_id)!;
      parts.push(both(p.ending ? "plan.move.membership_ending" : p.renews ? "plan.membership.bring_in_person" : "plan.membership.bring_in_person_desk", { name: p.name, plan: textOf(pl.name, pl.translations, "name"), until: dayText(p.until), price: planPrice(pl.price_cents, pl.period) }));
    }
    if (d.people.length > 40) parts.push(both("plan.credit.bring_in_more", { count: d.people.length - 40 }));
    if (d.unmapped.size) parts.push(both("plan.membership.bring_in_unmapped", { names: [...d.unmapped.values()].map((x) => `${x.name} (${x.people})`).join(", ") }));
    if (d.already.length) parts.push(both("plan.membership.bring_in_already", { names: names(d.already) }));
    if (d.full.length) parts.push(both("plan.membership.bring_in_full", { names: names(d.full) }));
    if (d.no_end.length) parts.push(both("plan.move.memberships_no_end", { from, names: names(d.no_end) }));
    if (d.ended) parts.push(both("count.move_ended", { count: d.ended }));
    if (d.unmatched) parts.push(both("count.move_unmatched", { count: d.unmatched }));
    if (d.people.length) parts.push(both("plan.move.memberships_stop", { from }));
    const { plans: _p, unmapped, ...rest } = d;
    return { title: both("action.move.memberships"), summary: lines(parts), reads: [], ownerIds: d.people.map((p) => p.person_id), undo: { kind: "reversible" },
      details: { ...rest, unmapped: [...unmapped.values()] } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { people: CarryLine[] };
    if (!d.people.length) throw new KumiError("error.nothing_to_do");
    const u = await uploadOf<MovePerson>(ctx.trx, i, "people"), tz = (await clubOf(ctx.trx)).time_zone;
    for (const p of d.people) {
      if (await holds(ctx.trx, p.person_id)) throw new KumiError("error.changed");
      const pl = await ctx.trx.selectFrom("membership_plan").select(["price_cents", "period", "family_size", "extra_person_cents", "active", "max_members"]).where("id", "=", p.plan_id).executeTakeFirstOrThrow();
      if (!pl.active) throw new KumiError("error.changed");
      if (pl.max_members) {
        const n = await ctx.trx.selectFrom("membership").select(sql<string>`count(*)`.as("n")).where("plan_id", "=", p.plan_id).where("status", "in", ["upcoming", "active", "past_due"]).executeTakeFirstOrThrow();
        if (Number(n.n) >= pl.max_members) throw new KumiError("error.changed");
      }
      const end = onDate(p.until, "24:00", tz);
      try {
        await ctx.insert("membership", { id: uuidv7(), person_id: p.person_id, plan_id: p.plan_id, status: "active", source: p.renews ? "app" : "desk", started_at: ctx.now,
          current_period_end: end, cancel_at_period_end: p.ending, price_cents: pl.price_cents, period: pl.period, family_size: pl.family_size, extra_person_cents: pl.extra_person_cents,
          note: `${systemName(u.system)}: ${p.membership}`.slice(0, 200), brought_from: u.system, brought_ref: p.ref, brought_note: null, anchor_day: localParts(end, tz).d, first_renewal_at: end });
      } catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
    }
    return { memberships: d.people.length };
  },
});

// ---- Club credit ----
interface CreditLine { person_id: string; name: string; before: number; after: number; delta: number; short: number }
async function creditPlan(db: Db | Trx, rows: MovePerson[], system: MoveSystem, i: { take_back?: boolean; cap?: number }) {
  const club = await clubOf(db);
  const unit = 10 ** minorUnits(club.currency);
  const cap = sizesCurrency(club.currency) ? Math.min(capFor(BROUGHT_CAP_USD_CENTS, club.currency), i.cap ? i.cap * unit : Infinity)
    : i.cap ? i.cap * unit : (() => { throw new KumiError("error.brought_cap_needed", { currency: club.currency }); })();
  const find = await matcher(db, system, rows);
  const out = { people: [] as CreditLine[], total: 0, taken_back: 0, less: [] as string[], not_taken_back: [] as string[], owes: [] as string[], unreadable: [] as string[], other_currency: [] as string[],
    disagree: [] as string[], over_cap: [] as string[], unmatched: 0, cap };
  const byPerson = new Map<string, { name: string; cents: Set<number>; bad: boolean }>();
  for (const r of rows) {
    if (r.credit === undefined) continue;
    const b = parseBalance(r.credit, club.currency);
    const here = await find(r);
    if (!here) { if (b?.cents) out.unmatched++; continue; }
    const e = byPerson.get(here.id) ?? { name: here.name, cents: new Set<number>(), bad: false };
    if (!b) { out.unreadable.push(`${here.name} (${r.credit})`); e.bad = true; }
    else if (b.currency !== club.currency) { if (b.cents) out.other_currency.push(`${here.name} (${r.credit})`); e.bad = true; }
    // Below zero is what they owe there: settled there, never brought as credit (nor as a debt).
    else if (b.cents < 0) { out.owes.push(`${here.name} (${r.credit})`); e.bad = true; }
    else e.cents.add(b.cents);
    byPerson.set(here.id, e);
  }
  for (const [personId, e] of byPerson) {
    if (e.bad) continue;
    if (e.cents.size > 1) { out.disagree.push(e.name); continue; }
    const target = [...e.cents][0] ?? 0;
    if (target > cap) { out.over_cap.push(`${e.name} (${money(target, "en")})`); continue; }
    const before = (await db.selectFrom("brought_credit").select("cents").where("person_id", "=", personId).where("system", "=", system).executeTakeFirst())?.cents ?? 0;
    let delta = target - before, short = 0;
    if (!delta) continue;
    if (delta < 0) {
      // Less there now (spent there since): taken back only when staff choose, and only from what came over that they
      // still hold here (credit.ts, playtomicLeft counts every source brought in); a refund or gift card here is never touched.
      if (!i.take_back) { out.less.push(`${e.name} (${money(-delta, "en")})`); continue; }
      const left = Math.min(await playtomicLeft(db, personId), before);
      if (!left) { out.not_taken_back.push(e.name); continue; }
      if (-delta > left) { short = -delta - left; delta = -left; }
    }
    out.people.push({ person_id: personId, name: e.name, before, after: before + delta, delta, short });
    if (delta > 0) out.total += delta; else out.taken_back += -delta;
  }
  out.people.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** The credit members hold there becomes club credit here (the owner; a manager asks): money the club already owes
 *  them, a liability whose other side is the "brought in" account, never a payment or revenue. One total per person
 *  and system, so running it again with a newer file moves only the difference. */
export const moveCredit = defineAction({
  name: "move.credit", version: 1, clubWide: true,
  input: z.object({ ...fileRef, take_back: z.optional(z.boolean()), cap: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(10_000_000))) }),
  async plan(ctx, i) {
    const u = await uploadOf<MovePerson>(ctx.db, i, "people"), from = systemName(u.system);
    if (!u.rows.some((r) => r.credit !== undefined)) throw new KumiError("error.move_no_credit_column", { from }, 400);
    const d = await creditPlan(ctx.db, u.rows, u.system, i);
    const adds = d.people.filter((p) => p.delta > 0), backs = d.people.filter((p) => p.delta < 0);
    const parts: Text[] = [adds.length ? both("plan.move.credit", { from, people: both("count.people", { count: adds.length }), amount: amount(d.total) }) : both("plan.move.credit_nothing", { from }), u.from];
    for (const p of adds.slice(0, 40)) parts.push(both("plan.move.credit_person", { name: p.name, amount: amount(p.delta) }));
    if (adds.length > 40) parts.push(both("plan.credit.bring_in_more", { count: adds.length - 40 }));
    if (backs.length) parts.push(both("plan.move.credit_taken_back", { from, amount: amount(d.taken_back), names: names(backs.map((p) => `${p.name} (${money(-p.delta, "en")})`)) }));
    if (backs.some((p) => p.short)) parts.push(both("plan.credit.bring_in_short", { names: names(backs.filter((p) => p.short).map((p) => `${p.name} (${money(p.short, "en")})`)) }));
    if (d.less.length) parts.push(both("plan.move.credit_less", { from, names: names(d.less) }));
    if (d.not_taken_back.length) parts.push(both("plan.credit.bring_in_not_taken_back", { names: names(d.not_taken_back) }));
    if (d.owes.length) parts.push(both("plan.move.credit_owes", { from, names: names(d.owes) }));
    if (d.disagree.length) parts.push(both("plan.move.credit_disagree", { names: names(d.disagree) }));
    if (d.over_cap.length) parts.push(both("plan.credit.bring_in_over_cap", { cap: amount(d.cap), names: names(d.over_cap) }));
    if (d.other_currency.length) parts.push(both("plan.credit.bring_in_other_currency", { names: names(d.other_currency) }));
    if (d.unreadable.length) parts.push(both("plan.credit.bring_in_unreadable", { names: names(d.unreadable) }));
    if (d.unmatched) parts.push(both("count.move_unmatched", { count: d.unmatched }));
    if (adds.length) parts.push(both("plan.move.credit_zero", { from }));
    return { title: both("action.move.credit"), summary: lines(parts), reads: [], ownerIds: d.people.map((p) => p.person_id), moneyCents: d.total,
      undo: { kind: "none", note: both("reason.move_credit_again") }, details: { people: d.people, total: d.total, taken_back: d.taken_back, cap: d.cap } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { people: CreditLine[]; cap: number };
    if (!d.people.length) throw new KumiError("error.nothing_to_do");
    const u = await uploadOf<MovePerson>(ctx.trx, i, "people"), from = systemName(u.system);
    for (const p of d.people) {
      if (p.after > d.cap || p.after < 0) throw new KumiError("error.changed");
      await lockCredit(ctx.trx, p.person_id);
      const row = await ctx.trx.selectFrom("brought_credit").select(["id", "cents"]).where("person_id", "=", p.person_id).where("system", "=", u.system).forUpdate().executeTakeFirst();
      // What the preview saw is still so: nothing brought in, or spent, meanwhile.
      if ((row?.cents ?? 0) !== p.before) throw new KumiError("error.changed");
      if (p.delta < 0 && -p.delta > await playtomicLeft(ctx.trx, p.person_id)) throw new KumiError("error.changed");
      if (row) await ctx.update("brought_credit", row.id, { cents: p.after, updated_at: ctx.now });
      else await ctx.insert("brought_credit", { id: uuidv7(), person_id: p.person_id, system: u.system, cents: p.after, wallets: JSON.stringify([{ name: from, cents: p.after }]), action_run_id: ctx.runId, at: ctx.now, updated_at: ctx.now });
      // A liability: credit given is a negative entry (credit.ts); the club took this money before, in the old system.
      await post(ctx.trx, ctx.runId, "brought_in", p.delta > 0 ? `club credit brought from ${from}` : `club credit from ${from} taken back (spent there)`, [
        { account: await account(ctx.trx, "member_credit", { personId: p.person_id }), cents: -p.delta },
        { account: await account(ctx.trx, "brought_in"), cents: p.delta }]);
    }
    return { people: d.people.length, cents: d.people.filter((p) => p.delta > 0).reduce((n, p) => n + p.delta, 0) };
  },
});

// ---- Upcoming bookings ----
type BookingWhy = "court" | "organiser" | "clash" | "twice" | "closed";
interface BookingItem { key: string; line: number; court_id: string; court: string; location_id: string; starts_at: string; minutes: number; organiser_id: string; organiser: string;
  players: { person_id: string | null; name: string }[]; by_name: boolean; type: string | null }
async function bookingsPlan(db: Db | Trx, rows: MoveBooking[], system: MoveSystem, map: Record<string, string>, now: Date) {
  const courts = await db.selectFrom("court").innerJoin("location", "location.id", "court.location_id").select(["court.id", "court.name", "court.location_id", "location.time_zone"])
    .where("court.archived_at", "is", null).execute();
  const byName = new Map(courts.map((c) => [normColumn(c.name), c])), byId = new Map(courts.map((c) => [c.id, c]));
  const chosen = new Map(Object.entries(map).map(([k, v]) => [normColumn(k), v]));
  const find = await matcher(db, system, rows.flatMap((r) => [...(r.organiser ? [r.organiser] : []), ...r.players]));
  const items: BookingItem[] = [], left: { line: number; why: BookingWhy; what: string }[] = [];
  let past = 0, already = 0;
  const unknownCourts = new Map<string, number>();
  for (const r of rows) {
    const pick = chosen.get(normColumn(r.court));
    if (pick === "skip") continue;
    const court = pick ? byId.get(pick) : byName.get(normColumn(r.court));
    if (!court) { unknownCourts.set(r.court, (unknownCourts.get(r.court) ?? 0) + 1); continue; }
    const start = onDate(r.date, r.start, court.time_zone), end = new Date(start.getTime() + r.minutes * 60_000);
    if (start <= now) { past++; continue; }
    const key = `${system}:${r.ref ?? `${court.id}:${start.toISOString()}`}`.slice(0, 200);
    const had = await db.selectFrom("external_ref").innerJoin("booking", (j) => j.on(sql<boolean>`booking.id::text = external_ref.entity_id`)).select("booking.status")
      .where("external_ref.system", "=", system).where("external_ref.entity", "=", "booking").where("external_ref.external_id", "=", key).executeTakeFirst();
    if (had && had.status !== "cancelled") { already++; continue; }
    const what = `${r.court}, ${r.date} ${r.start}`;
    const org = r.organiser ? await find(r.organiser, { names: true }) : null;
    if (!org) { left.push({ line: r.line, why: "organiser", what: `${what} (${r.organiser?.name ?? "-"})` }); continue; }
    // Two lines of the file on the same court and time: the first holds it.
    if (items.some((x) => x.court_id === court.id && new Date(x.starts_at) < end && new Date(new Date(x.starts_at).getTime() + x.minutes * 60_000) > start)) { left.push({ line: r.line, why: "twice", what }); continue; }
    const clash = await occupied(db, [court.id], start, end, now);
    if (clash.length) { left.push({ line: r.line, why: "clash", what: `${what}${await clashWith(db, clash[0]!)}` }); continue; }
    const players: { person_id: string | null; name: string }[] = [];
    let byName2 = org.by === "name";
    for (const p of r.players) {
      const f = await find(p, { names: true });
      if (f?.by === "name") byName2 = true;
      if (f?.id === org.id || players.some((x) => (f && x.person_id === f.id) || (!f && !x.person_id && x.name === p.name))) continue;
      players.push({ person_id: f?.id ?? null, name: (f?.name ?? p.name).slice(0, 80) });
    }
    items.push({ key, line: r.line, court_id: court.id, court: court.name, location_id: court.location_id, starts_at: start.toISOString(), minutes: r.minutes, organiser_id: org.id, organiser: org.name,
      players: players.slice(0, 11), by_name: byName2, type: r.type ?? null });
  }
  return { items, left, past, already, unknownCourts: [...unknownCourts].map(([name, n]) => ({ name, bookings: n })) };
}
async function clashWith(db: Db | Trx, t: { kind: string; booking_id: string | null; session_id: string | null }): Promise<string> {
  if (t.booking_id) { const b = await db.selectFrom("booking").select("code").where("id", "=", t.booking_id).executeTakeFirst(); return b ? ` (${b.code})` : ""; }
  if (t.session_id) { const p = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").select("program.name").where("session.id", "=", t.session_id).executeTakeFirst(); return p ? ` (${p.name})` : ""; }
  return t.kind === "block" ? " (block)" : "";
}

/** Upcoming bookings there become bookings here, on the same court and time, with the same players: each takes its
 *  court time like any booking (the courts locked in id order, and the database refuses two on one court at once), so
 *  one that clashes with something here is listed and left. Money paid for them stays with the old system: nothing is
 *  owed here and nothing is refunded here, so cancelling one here gives nothing back (a refund, if any, is made there).
 *  Nobody is told: it's the booking they already have. */
export const moveBookings = defineAction({
  name: "move.bookings", version: 1, clubWide: true,
  input: z.object({ ...fileRef, courts: z.optional(z.record(z.string().check(z.maxLength(80)), z.string().check(z.maxLength(40)))) }),
  async plan(ctx, i) {
    for (const v of Object.values(i.courts ?? {})) if (v !== "skip" && !/^[0-9a-f-]{36}$/i.test(v)) throw new KumiError("error.not_found", { thing: both("thing.court") }, 404);
    const u = await uploadOf<MoveBooking>(ctx.db, i, "bookings"), from = systemName(u.system);
    const d = await bookingsPlan(ctx.db, u.rows, u.system, i.courts ?? {}, ctx.now);
    const tz = (await clubOf(ctx.db)).time_zone;
    const sorted = [...d.items].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const parts: Text[] = [d.items.length ? both("plan.move.bookings", { from, bookings: both("count.move_bookings", { count: d.items.length }), courts: both("count.move_courts", { count: new Set(d.items.map((x) => x.court_id)).size }),
      first: whenText(new Date(sorted[0]!.starts_at), tz), last: whenText(new Date(sorted.at(-1)!.starts_at), tz) }) : both("plan.move.bookings_nothing", { from }), u.from];
    if (d.items.length) parts.push(both("plan.move.bookings_money", { from }));
    if (d.unknownCourts.length) parts.push(both("plan.move.bookings_courts", { from, names: names(d.unknownCourts.map((c) => `${c.name} (${c.bookings})`)) }));
    for (const why of ["clash", "organiser", "twice"] as const) {
      const l = d.left.filter((x) => x.why === why);
      if (l.length) parts.push(both(`plan.move.bookings_left_${why}` as Key, { list: joined(l.map((x) => both("move.line_what", { line: x.line, what: x.what }))) }));
    }
    if (d.items.some((x) => x.by_name)) parts.push(both("plan.move.bookings_by_name"));
    if (d.past) parts.push(both("count.move_past", { count: d.past }));
    if (d.already) parts.push(both("count.move_already_bookings", { count: d.already }));
    if (d.items.length) parts.push(both("plan.move.nobody_told"));
    return { title: both("action.move.bookings"), summary: lines(parts), reads: [], ownerIds: [...new Set(d.items.map((x) => x.organiser_id))], moneyCents: 0, undo: { kind: "reversible" },
      details: { bookings: d.items.length, left: d.left.length, past: d.past, already: d.already, unknown_courts: d.unknownCourts } };
  },
  async apply(ctx, i) {
    const u = await uploadOf<MoveBooking>(ctx.trx, i, "bookings");
    const first = await bookingsPlan(ctx.trx, u.rows, u.system, i.courts ?? {}, ctx.now);
    if (!first.items.length) throw new KumiError("error.nothing_to_do");
    // The courts locked in id order (bookings.ts), then sorted out again: something booked here since is left alone.
    await lockCourts(ctx, [...new Set(first.items.map((x) => x.court_id))]);
    const d = await bookingsPlan(ctx.trx, u.rows, u.system, i.courts ?? {}, ctx.now);
    const policy = await currentPolicy(ctx.trx);
    for (const it of d.items) await bringBooking(ctx, it, u.system, policy.id);
    return { bookings: d.items.length, left: d.left.length };
  },
});
async function bringBooking(ctx: ApplyCtx, it: BookingItem, system: MoveSystem, policyId: string) {
  const start = new Date(it.starts_at), end = new Date(start.getTime() + it.minutes * 60_000), id = uuidv7(), from = systemName(system);
  await ctx.insert("booking", { id, code: await newCode(ctx.trx), location_id: it.location_id, organiser_id: it.organiser_id, status: "confirmed", source: "import", price_cents: 0, tax_cents: 0,
    quote: JSON.stringify({ from: system, line: it.line, type: it.type, paid_there: true }), policy_id: policyId, note: `${from}${it.type ? `: ${it.type}` : ""}`.slice(0, 200),
    invite_code: randomBytes(9).toString("base64url") });
  await ctx.insert("booking_player", { id: uuidv7(), booking_id: id, person_id: it.organiser_id, guest_name: null, share_cents: 0 });
  for (const p of it.players) await ctx.insert("booking_player", { id: uuidv7(), booking_id: id, person_id: p.person_id, guest_name: p.person_id ? null : p.name, share_cents: 0 });
  await insertTime(ctx, [{ id: uuidv7(), court_id: it.court_id, during: range(start, end), kind: "booking", booking_id: id }]);
  // Known by the old system's booking (its number, else its court and time): a newer file doesn't bring it twice. One
  // brought before and cancelled here since is this one now.
  const had = await ctx.trx.selectFrom("external_ref").select("entity_id").where("system", "=", system).where("entity", "=", "booking").where("external_id", "=", it.key).executeTakeFirst();
  if (had) await ctx.trx.updateTable("external_ref").set({ entity_id: id }).where("system", "=", system).where("entity", "=", "booking").where("external_id", "=", it.key).execute();
  else await ctx.trx.insertInto("external_ref").values({ entity: "booking", entity_id: id, system, external_id: it.key }).execute();
}

// ---- Program sign-ups ----
type SignupWhy = "who" | "date" | "full" | "past";
interface SignupItem { program_id: string; program: string; session_id: string | null; person_id: string; name: string }
async function programsPlan(db: Db | Trx, rows: MoveSignup[], system: MoveSystem, map: Record<string, string>, now: Date) {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const chosen = new Map(Object.entries(map).map(([k, v]) => [norm(k), v]));
  const find = await matcher(db, system, rows.map((r) => r.who));
  const out = { items: [] as SignupItem[], left: [] as { line: number; why: SignupWhy; what: string }[], unmapped: new Map<string, { name: string; people: number }>(), already: 0 };
  const programs = new Map<string, { id: string; name: string; sign_up: string; capacity: number; tz: string; sessions: { id: string; starts_at: Date; capacity: number | null }[] } | null>();
  const booked = new Map<string, number>();
  for (const r of rows) {
    const pick = chosen.get(norm(r.event));
    if (pick === "skip") continue;
    if (!pick) { const u = out.unmapped.get(norm(r.event)) ?? { name: r.event, people: 0 }; u.people++; out.unmapped.set(norm(r.event), u); continue; }
    if (!programs.has(pick)) {
      const p = await db.selectFrom("program").innerJoin("location", "location.id", "program.location_id").select(["program.id", "program.name", "program.sign_up", "program.capacity", "program.status", "location.time_zone"])
        .where("program.id", "=", pick).executeTakeFirst();
      const sessions = p ? await db.selectFrom("session").select(["id", "starts_at", "capacity_override"]).where("program_id", "=", p.id).where("status", "!=", "cancelled").orderBy("starts_at").execute() : [];
      programs.set(pick, p && p.status !== "cancelled" ? { id: p.id, name: p.name, sign_up: p.sign_up, capacity: p.capacity, tz: p.time_zone, sessions: sessions.map((s) => ({ id: s.id, starts_at: new Date(s.starts_at), capacity: s.capacity_override })) } : null);
    }
    const p = programs.get(pick);
    if (!p) throw new KumiError("error.not_found", { thing: both("thing.program") }, 404);
    const what = `${r.who.name}, ${p.name}${r.date ? ` ${r.date}` : ""}`;
    const here = await find(r.who, { names: true });
    if (!here) { out.left.push({ line: r.line, why: "who", what }); continue; }
    // A program signed up to per session: the session on that day (at that time, if there are two). The whole program:
    // while it has a session still to come.
    let session: { id: string; starts_at: Date; capacity: number | null } | null = null;
    if (p.sign_up === "per_session") {
      const on = p.sessions.filter((s) => r.date && localDate(s.starts_at, p.tz) === r.date);
      session = (r.start ? on.find((s) => { const q = localParts(s.starts_at, p.tz); return `${String(q.h).padStart(2, "0")}:${String(q.min).padStart(2, "0")}` === r.start; }) : undefined) ?? (on.length === 1 ? on[0]! : null);
      if (!session) { out.left.push({ line: r.line, why: "date", what }); continue; }
      if (session.starts_at <= now) { out.left.push({ line: r.line, why: "past", what }); continue; }
    } else if (!p.sessions.some((s) => s.starts_at > now)) { out.left.push({ line: r.line, why: "past", what }); continue; }
    const sid = session?.id ?? null, k = `${p.id}:${sid ?? ""}`;
    if (out.items.some((x) => x.program_id === p.id && x.session_id === sid && x.person_id === here.id)) continue;
    const on = await db.selectFrom("enrolment").select("id").where("program_id", "=", p.id).where("person_id", "=", here.id).where("status", "in", ["booked", "waitlisted"])
      .$if(Boolean(sid), (q) => q.where("session_id", "=", sid!)).$if(!sid, (q) => q.where("session_id", "is", null)).executeTakeFirst();
    if (on) { out.already++; continue; }
    if (!booked.has(k)) booked.set(k, Number((await db.selectFrom("enrolment").select(sql<string>`count(*)`.as("n")).where("program_id", "=", p.id).where("status", "=", "booked")
      .$if(Boolean(sid), (q) => q.where("session_id", "=", sid!)).$if(!sid, (q) => q.where("session_id", "is", null)).executeTakeFirstOrThrow()).n));
    if (booked.get(k)! >= (session?.capacity ?? p.capacity)) { out.left.push({ line: r.line, why: "full", what }); continue; }
    booked.set(k, booked.get(k)! + 1);
    out.items.push({ program_id: p.id, program: p.name, session_id: sid, person_id: here.id, name: here.name });
  }
  return out;
}

/** Sign-ups to events and programs there become places in the programs staff set up here (each event mapped to one).
 *  Paid there, so nothing is owed or refunded here: each place is marked paid in the old system. A line for someone who
 *  isn't a member here, a day with no session, a session that's passed or a program that's full is listed and left. */
export const movePrograms = defineAction({
  name: "move.programs", version: 1, clubWide: true,
  input: z.object({ ...fileRef, map: z.record(z.string().check(z.maxLength(120)), z.string().check(z.maxLength(40))) }),
  async plan(ctx, i) {
    for (const v of Object.values(i.map)) if (v !== "skip" && !/^[0-9a-f-]{36}$/i.test(v)) throw new KumiError("error.not_found", { thing: both("thing.program") }, 404);
    const u = await uploadOf<MoveSignup>(ctx.db, i, "programs"), from = systemName(u.system);
    const d = await programsPlan(ctx.db, u.rows, u.system, i.map, ctx.now);
    const progs = new Set(d.items.map((x) => x.program_id)).size;
    const parts: Text[] = [d.items.length ? both("plan.move.programs", { from, places: both("count.move_places", { count: d.items.length }), programs: both("count.move_programs", { count: progs }) })
      : both("plan.move.programs_nothing", { from }), u.from];
    if (d.items.length) parts.push(both("plan.move.programs_money", { from }));
    if (d.unmapped.size) parts.push(both("plan.move.programs_unmapped", { names: [...d.unmapped.values()].map((x) => `${x.name} (${x.people})`).join(", ") }));
    for (const why of ["who", "date", "past", "full"] as const) {
      const l = d.left.filter((x) => x.why === why);
      if (l.length) parts.push(both(`plan.move.programs_left_${why}` as Key, { list: joined(l.map((x) => both("move.line_what", { line: x.line, what: x.what }))) }));
    }
    if (d.already) parts.push(both("count.move_already_places", { count: d.already }));
    if (d.items.length) parts.push(both("plan.move.nobody_told"));
    return { title: both("action.move.programs"), summary: lines(parts), reads: [], ownerIds: [...new Set(d.items.map((x) => x.person_id))], moneyCents: 0, undo: { kind: "reversible" },
      details: { places: d.items.length, left: d.left.length, already: d.already, unmapped: [...d.unmapped.values()] } };
  },
  async apply(ctx, i) {
    const u = await uploadOf<MoveSignup>(ctx.trx, i, "programs");
    // One program's places at a time, locked, so a sign-up here meanwhile can't overfill it.
    const first = await programsPlan(ctx.trx, u.rows, u.system, i.map, ctx.now);
    if (!first.items.length) throw new KumiError("error.nothing_to_do");
    for (const id of [...new Set(first.items.map((x) => x.program_id))].sort()) await ctx.trx.selectFrom("program").select("id").where("id", "=", id).forUpdate().execute();
    const d = await programsPlan(ctx.trx, u.rows, u.system, i.map, ctx.now);
    for (const it of d.items)
      await ctx.insert("enrolment", { id: uuidv7(), program_id: it.program_id, session_id: it.session_id, person_id: it.person_id, status: "booked", price_cents: 0, paid_by: "comp",
        comp_note: `Paid in ${systemName(u.system)}` });
    return { places: d.items.length, left: d.left.length };
  },
});

// ---- What has come over, for the staff app and `openpadel moving-in` ----
/** The latest file of each kind from this system, the names in it staff map to plans, courts and programs here, and what
 *  has been brought in so far. Counts and names only of what's here; the files' rows never leave the server. */
export async function moveFilesStatus(db: Db | Trx, system: MoveSystem, l: "en" | "es") {
  const uploads = await db.selectFrom("move_upload").leftJoin("person", "person.id", "move_upload.uploaded_by")
    .select(["move_upload.id", "move_upload.kind", "move_upload.sha256", "move_upload.file_name", "move_upload.at", "move_upload.row_count", "move_upload.columns", "move_upload.problems", "move_upload.rows", "person.display_name as uploaded_by"])
    .where("move_upload.system", "=", system).orderBy("move_upload.at", "desc").execute();
  const latest = (k: MoveFileKind) => uploads.find((u) => u.kind === k);
  const count = (xs: string[]) => { const m = new Map<string, { name: string; count: number }>(); for (const x of xs) { const k = x.trim().toLowerCase(); const e = m.get(k) ?? { name: x.trim(), count: 0 }; e.count++; m.set(k, e); } return [...m.values()].sort((a, b) => b.count - a.count); };
  const people = latest("people"), bookings = latest("bookings"), programs = latest("programs");
  const pr = (people?.rows ?? []) as MovePerson[], br = (bookings?.rows ?? []) as MoveBooking[], sr = (programs?.rows ?? []) as MoveSignup[];
  const courts = await db.selectFrom("court").select(["id", "name"]).where("archived_at", "is", null).orderBy("sort").orderBy("name").execute();
  const show = (u: (typeof uploads)[number] | undefined) => u ? { id: u.id, sha256: u.sha256, file_name: u.file_name, at: u.at, rows: u.row_count, uploaded_by: u.uploaded_by,
    columns: u.columns as { what: string; name: string }[], problems: (u.problems as { line: number; text: Text }[]).slice(0, 50).map((p) => ({ line: p.line, text: p.text[l] })),
    lines_left: (u.problems as unknown[]).length } : null;
  const brought = await db.selectFrom("brought_credit").select([sql<string>`coalesce(sum(cents), 0)`.as("c"), sql<string>`count(*) FILTER (WHERE cents > 0)`.as("n")]).where("system", "=", system).executeTakeFirstOrThrow();
  const kept = await db.selectFrom("membership").select(sql<string>`count(*)`.as("n")).where("brought_from", "=", system).executeTakeFirstOrThrow();
  const booked = await db.selectFrom("external_ref").innerJoin("booking", (j) => j.on(sql<boolean>`booking.id::text = external_ref.entity_id`)).select(sql<string>`count(*)`.as("n"))
    .where("external_ref.system", "=", system).where("external_ref.entity", "=", "booking").where("booking.status", "!=", "cancelled").executeTakeFirstOrThrow();
  const places = await db.selectFrom("enrolment").select(sql<string>`count(*)`.as("n")).where("comp_note", "=", `Paid in ${systemName(system)}`).where("status", "=", "booked").executeTakeFirstOrThrow();
  const linked = await db.selectFrom("external_ref").select(sql<string>`count(*)`.as("n")).where("system", "=", system).where("entity", "=", "person").executeTakeFirstOrThrow();
  // The practice run's comparison: the latest files' people, memberships still running, credit and upcoming bookings,
  // beside what has come over here. Counts and totals only.
  const club = await clubOf(db), today = localDate(new Date(), club.time_zone), find = await matcher(db, system, pr);
  const once = new Map<string, MovePerson>();
  for (const r of pr) { const k = r.ext_id ? `i:${r.ext_id}` : `m:${r.email}`; if (!once.has(k)) once.set(k, r); }
  let here = 0, credit = 0;
  for (const r of once.values()) { if (await find(r)) here++; const b = r.credit ? parseBalance(r.credit, club.currency) : null; if (b && b.cents > 0 && b.currency === club.currency) credit += b.cents; }
  const running = new Set(pr.filter((r) => r.membership && !(r.membership.status && ENDED.test(r.membership.status)) && (!r.membership.until || r.membership.until >= today)).map((r) => r.ext_id ?? r.email)).size;
  const upcoming = br.filter((r) => r.date >= today).length;
  return {
    system, name: systemName(system),
    uploads: { people: show(people), bookings: show(bookings), programs: show(programs) },
    // What staff map: each membership, court and event the latest files name, with how many lines name it.
    memberships: count(pr.filter((r) => r.membership).map((r) => r.membership!.name)),
    has_credit: pr.some((r) => r.credit !== undefined),
    courts: count(br.map((r) => r.court)).map((c) => ({ ...c, court_id: courts.find((x) => normColumn(x.name) === normColumn(c.name))?.id ?? null })),
    events: count(sr.map((r) => r.event)),
    file: people ? { people: once.size, here, memberships: running, credit_cents: credit } : null, file_bookings: bookings ? upcoming : null,
    brought: { people_linked: Number(linked.n), credit_cents: Number(brought.c), credit_people: Number(brought.n), memberships: Number(kept.n), bookings: Number(booked.n), places: Number(places.n) },
  };
}
export type MoveFilesStatus = Awaited<ReturnType<typeof moveFilesStatus>>;
