// Changes: the audit log, for the people allowed to see it (changes.view: the owner, managers, support access). The
// list, newest first and a page at a time, filtered by who made the change and the area it falls in; and one change
// opened: the plan as it was shown, line by line, what it wrote (before and after, from its entity_change rows), its
// reference and how it came in, and, when it can't be undone, why. Under /staff/ like the staff app's other data, so
// the staff app's own /changes page loads as a page when it's opened or reloaded. Reads only.
import { Hono, type Context } from "hono";
import { sql } from "kysely";
import { both, t, productName, type Key, type Lang } from "@kumi/i18n";
import { AREAS, ASK_ENDED, areaOf, decide, KumiError, mayAnswer, undoReason, type Actor, type Db } from "@kumi/core";
import { seesChats } from "./chats.ts";

/** Who made a change, as the filter has it: a person in the apps, an assistant through /mcp, or the club's own
 *  software (setup, imports, the command line on the server, scheduled jobs, the Playtomic copy). */
export const WHO = ["people", "assistants", "club"] as const;
type Who = (typeof WHO)[number];
type Text = Partial<Record<Lang, string>>;
type StoredPlan = { title?: Text; summary?: Text; undo?: { kind?: string; note?: Text }; tells?: Text[];
  charge?: { lines?: { label?: Text; cents?: number | null }[]; how?: Text } };

/** A plan's consequences, one line each, as it was shown: its summary's sentences, and whom it tells. One line only
 *  when the summary is one sentence and it tells nobody (the screens then show the summary alone). */
export function planLines(plan: unknown, lang: Lang): string[] {
  const p = (plan ?? {}) as StoredPlan, summary = p.summary?.[lang]?.trim() ?? "";
  const seg = new Intl.Segmenter(lang === "es" ? "es" : "en", { granularity: "sentence" });
  const lines = summary ? [...seg.segment(summary)].map((s) => s.segment.trim()).filter(Boolean) : [];
  for (const x of p.tells ?? []) if (x?.[lang]) lines.push(x[lang]!);
  return lines;
}

/** The asker's own words, where the change has a field for them (a note, a reason, a message they typed). */
export function saidIn(input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  for (const k of ["note", "reason", "message"]) if (typeof i[k] === "string" && (i[k] as string).trim()) return (i[k] as string).trim().slice(0, 500);
  return null;
}

/** Fields never shown in what a change wrote: keys, row bookkeeping, and ids (the summary names what they point at). */
const HIDDEN = /(^id$|^version$|^updated_at$|_id$|_ids$|_hash$|_sealed$|token|secret|password)/;
const MAX_FIELDS = 40;
const shown = (v: unknown): string | number | boolean | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length > 200 ? `${v.slice(0, 199)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  const s = JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What one change wrote, field by field: a row it changed shows each field that moved, a row it added each field it
 *  set. At most MAX_FIELDS lines; `more` counts the rest. */
export function fieldChanges(rows: { entity: string; op: string; before: unknown; after: unknown }[]) {
  const out: { entity: string; op: "insert" | "update"; field: string; before: ReturnType<typeof shown>; after: ReturnType<typeof shown> }[] = [];
  let more = 0;
  for (const r of rows) {
    const before = (r.before ?? {}) as Record<string, unknown>, after = (r.after ?? {}) as Record<string, unknown>;
    const op = r.op === "insert" ? "insert" : "update";
    for (const k of Object.keys(after)) {
      if (HIDDEN.test(k)) continue;
      if (op === "update" ? same(before[k], after[k]) : after[k] === null || after[k] === undefined || k === "created_at") continue;
      if (out.length >= MAX_FIELDS) { more++; continue; }
      out.push({ entity: r.entity, op, field: k, before: op === "update" ? shown(before[k]) : null, after: shown(after[k]) });
    }
  }
  return { fields: out, more };
}

/** Why a change that went through can't be undone, in words; null when it can (or never went through). */
function undoWhy(r: { status: string; action: string; undo_kind: string; undo_until: Date | null; plan: unknown }, lang: Lang, now: Date): string | null {
  if (r.status !== "applied") return null;
  const note = (r.plan as StoredPlan | null)?.undo?.note;
  if (r.action === "action.undo") return t(lang, "error.cannot_undo", { reason: t(lang, "reason.undo_final") });
  if (r.undo_kind === "none" || r.action === "club.setup") {
    const reason = note?.en && note?.es ? undoReason({ en: note.en, es: note.es })[lang] : t(lang, "reason.no_way_back");
    return t(lang, "error.cannot_undo", { reason });
  }
  if (r.undo_until && r.undo_until.getTime() <= now.getTime()) return t(lang, "error.undo_expired");
  return null;
}

export function changeRoutes(db: Db, actor: (c: Context<any>) => Actor, lang: (c: Context<any>) => Lang, now: () => Date) {
  const app = new Hono();
  const allowed = async (a: Actor) => {
    const d = await decide(db, "changes.view", { personId: a.personId, at: now() });
    if (d.mode !== "allow") throw new KumiError("error.staff_only", {}, 403);
    // Chats are the players' and the club's: someone who can't read them (support access on its own, a coach on their
    // own) doesn't read their reports and stops here either, which name who reported whom.
    return { chats: a.personId ? await seesChats(db, a.personId) : false };
  };
  const base = () => db.selectFrom("action_run").leftJoin("person", "person.id", "action_run.actor_person_id").leftJoin("support_grant", "support_grant.id", "action_run.support_grant_id")
    .leftJoin("person as approver", "approver.id", "action_run.approved_by")
    .select(["action_run.id", "action_run.action", "action_run.status", "action_run.plan", "action_run.input", "action_run.location_id", "action_run.actor_person_id", "action_run.error", "action_run.via",
      "action_run.created_at", "action_run.applied_at", "action_run.undo_kind", "action_run.undo_until", "person.display_name", "support_grant.name as support_name", "approver.display_name as approver_name"]);
  type Row = Awaited<ReturnType<ReturnType<typeof base>["execute"]>>[number];
  // A change made under support access says so, with the name the owner gave.
  const by = (r: Row, l: Lang) => (r.support_name ? t(l, "ui.support_by", { name: r.support_name }) : r.display_name ?? productName());
  const declinedBy = async (r: Row) => {
    const e = r.error as { code?: string; params?: { by?: string } } | null;
    if (e?.code !== "error.declined" || !e.params?.by) return null;
    return (await db.selectFrom("person").select("display_name").where("id", "=", e.params.by).executeTakeFirst())?.display_name ?? "";
  };
  /** A change as the list shows it. */
  const view = async (r: Row, l: Lang, me: string | null) => {
    const waiting = r.status === "awaiting_approval", declined = await declinedBy(r);
    const why = undoWhy(r, l, now());
    return { id: r.id, action: r.action, area: areaOf(r.action), status: declined !== null ? "declined" : r.status, by: by(r, l), support: Boolean(r.support_name), via: r.via,
      summary: (r.plan as StoredPlan | null)?.summary?.[l] ?? null, at: r.applied_at ?? r.created_at,
      // Undo is offered only where it can work: a change that kept a way back, still in time. Receipts, alerts,
      // deletions and money sent can't be put back, so the screen doesn't offer to; it says why instead.
      can_undo: r.status === "applied" && why === null, undo_why: why,
      can_answer: waiting && await mayAnswer(db, r, me, now()), approved_by: r.approver_name ?? null, declined_by: declined,
      reason: declined !== null ? (r.error as { params?: { reason?: string | null } }).params?.reason ?? null : null,
      // Why an ask ended without a yes, in words (done meanwhile by another change, out of date).
      ended: r.status === "failed" && ASK_ENDED.has((r.error as { code?: string } | null)?.code ?? "") && (r.error as { code: string }).code !== "error.declined"
        ? t(l, (r.error as { code: string }).code as Key, {}) : null };
  };

  // The list: newest first, `limit` at a time (50 unless asked, at most 200), the next page from `before` (the last
  // id shown). `who` and `type` (an area, as the role editor groups actions) narrow it.
  app.get("/staff/changes", async (c) => {
    const a = actor(c), { chats } = await allowed(a), l = lang(c);
    const limit = Math.min(200, Math.max(1, Math.floor(Number(c.req.query("limit") ?? 50)) || 50));
    const before = c.req.query("before"), who = c.req.query("who") as Who | undefined, type = c.req.query("type");
    if (before && !/^[0-9a-f-]{36}$/i.test(before)) throw new KumiError("error.invalid_input", { details: "before" }, 400);
    if (who && !WHO.includes(who)) throw new KumiError("error.invalid_input", { details: "who" }, 400);
    const area = type ? AREAS.find((x) => x.key === type) : undefined;
    if (type && !area) throw new KumiError("error.invalid_input", { details: "type" }, 400);
    const head = sql<string>`split_part(action_run.action, '.', 1)`;
    const rows = await base()
      .$if(!chats, (q) => q.where("action_run.action", "not like", "chat.%"))
      .$if(Boolean(before), (q) => q.where("action_run.id", "<", before!))
      .$if(who === "people", (q) => q.where("action_run.actor_person_id", "is not", null).where("action_run.via", "not like", "mcp:%"))
      .$if(who === "assistants", (q) => q.where("action_run.via", "like", "mcp:%"))
      .$if(who === "club", (q) => q.where("action_run.actor_person_id", "is", null))
      // Settings is where every action no other area claims falls (areaOf), so it's "none of the others".
      .$if(Boolean(area && area.key !== "settings"), (q) => q.where(head, "in", area!.prefixes))
      .$if(area?.key === "settings", (q) => q.where(head, "not in", AREAS.filter((x) => x.key !== "settings").flatMap((x) => x.prefixes)))
      .orderBy("action_run.id", "desc").limit(limit).execute();
    const out = [];
    for (const r of rows) out.push(await view(r, l, a.personId));
    return c.json(out);
  });

  // One change opened: the list's line, and the plan line by line, what it charged, what it wrote, and the asker's
  // own words where the change has a field for them.
  app.get("/staff/changes/:id", async (c) => {
    const a = actor(c), { chats } = await allowed(a), l = lang(c), id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new KumiError("error.not_found", { thing: both("thing.change") }, 404);
    const r = await base().where("action_run.id", "=", id).executeTakeFirst();
    if (!r || (!chats && r.action.startsWith("chat."))) throw new KumiError("error.not_found", { thing: both("thing.change") }, 404);
    const p = (r.plan ?? {}) as StoredPlan;
    const wrote = await db.selectFrom("entity_change").select(["entity", "op", "before", "after"]).where("action_run_id", "=", id).orderBy("id").execute();
    const charge = (p.charge?.lines ?? []).filter((x) => x.label?.[l]).map((x) => ({ label: x.label![l]!, cents: x.cents ?? null }));
    return c.json({ ...await view(r, l, a.personId), title: p.title?.[l] ?? r.action, lines: planLines(p, l), charge, charge_how: p.charge?.how?.[l] ?? null,
      undo_kind: r.undo_kind, undo_until: r.undo_until, asked_at: r.created_at, said: saidIn(r.input), ...fieldChanges(wrote) });
  });
  return app;
}
