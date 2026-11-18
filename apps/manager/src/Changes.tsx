// Changes: the audit log (apps/server/src/changes.ts). What waits for this person's yes first, then every change,
// newest first, 50 at a time with "Show more", narrowed by who made it and its area. Each says who made it and how it
// came in (the app, an assistant on /mcp, setup, a job); "Details" opens it beside the list: the plan as it was shown,
// what it charged, exactly what it changed, its reference, and Undo, or why it can't be undone. Undo previews first.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, ApiError, dollars, lang, loadMe, needsStep, t, clubTime, useBackCloses, useStepUp } from "@kumi/ui";
import { SidePanel } from "./Courts.tsx";
import { viaWords } from "./made_via.ts";

type Change = { id: string; action: string; area: string; status: string; ended?: string | null; by: string; via: string; summary: string | null; at: string;
  can_answer: boolean; can_undo: boolean; undo_why: string | null; approved_by: string | null; declined_by: string | null; reason: string | null };
type Value = string | number | boolean | null;
type Detail = Change & { yeses?: string[]; title: string; lines: string[]; charge: { label: string; cents: number | null }[]; charge_how: string | null; undo_until: string | null;
  said: string | null; fields: { entity: string; op: "insert" | "update"; field: string; before: Value; after: Value }[]; more: number };
/** A sheet open on one change: undo it, or say yes or no to what someone asked for. */
type Open = { kind: "undo"; runId: string; summary: string; askFor?: string } | { kind: "approve" | "decline"; row: Change };

const PAGE = 50;
const WHO = ["people", "assistants", "club"] as const;
const AREAS = ["bookings", "courts", "programs", "members", "memberships", "money", "messages", "levels", "coaches", "settings"] as const;
const when = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
/** Who made it and how it came in: "Robin Hale · in the app". */
const byline = (r: Change) => { const v = viaWords(r.via); return v ? `${r.by} · ${t(`ui.made_via_${v.word}`, v.params)}` : r.by; };

export function Changes() {
  const [rows, setRows] = useState<Change[] | null>(null), [more, setMore] = useState(false), [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState(""), [type, setType] = useState(""), [cards, setCards] = useState(false);
  const [open, setOpen] = useState<Open | null>(null), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<Detail | null>(null);
  useBackCloses(Boolean(open), () => setOpen(null));
  useBackCloses(Boolean(picked) && !open, () => setPicked(null));
  // Only the latest answer is shown: a quick change of filter doesn't let an older one land after it.
  const asked = useRef(0);
  const query = (before?: string) => `/staff/changes?${new URLSearchParams({ limit: String(PAGE), ...(who ? { who } : {}), ...(type ? { type } : {}), ...(cards ? { plugin_cards: "1" } : {}), ...(before ? { before } : {}) })}`;
  const load = () => {
    const n = ++asked.current;
    return api<Change[]>(query()).then((r) => { if (n === asked.current) { setRows(r); setMore(r.length === PAGE); } }).catch((e: ApiError) => setError(e.message));
  };
  const loadMore = () => {
    const last = rows?.[rows.length - 1];
    if (!last) return;
    const n = ++asked.current;
    api<Change[]>(query(last.id)).then((r) => { if (n === asked.current) { setRows((x) => [...(x ?? []), ...r]); setMore(r.length === PAGE); } }).catch((e: ApiError) => setError(e.message));
  };
  useEffect(() => { void load(); }, [lang.value, who, type, cards]);
  const details = (id: string) => { setError(null); api<Detail>(`/staff/changes/${id}`).then(setPicked).catch((e: ApiError) => setError(e.message)); };

  const previewUndo = async (id: string) => {
    setError(null); setPicked(null);
    // First a look: an undo that needs someone's yes is shown, and asked for only when the person says so.
    try {
      const p = await api<{ run_id: string; status: string; summary: string }>("/actions/action.undo/plan?ask=hold", { run_id: id });
      if (p.status === "awaiting_approval") { setNote(t("ui.sent_for_approval")); void load(); return; }
      setOpen({ kind: "undo", runId: p.run_id, summary: p.summary, ...(p.status === "would_ask" ? { askFor: id } : {}) });
    }
    catch (e) { setError((e as ApiError).message); }
  };
  const answer = (kind: "approve" | "decline", row: Change) => { setError(null); setReason(""); setOpen({ kind, row }); };
  const step = useStepUp();
  const confirm = async () => {
    if (!open) return;
    setBusy(true);
    try {
      // An undo or an approved change can change the person's own profile, language included, so reload them first.
      if (open.kind === "undo" && open.askFor) {
        const a = await api<{ run_id: string; status: string; summary: string }>("/actions/action.undo/plan", { run_id: open.askFor });
        if (a.status !== "awaiting_approval") { setOpen({ kind: "undo", runId: a.run_id, summary: a.summary }); return; }   // no yes needed now: confirm it
        setNote(t("ui.sent_for_approval"));
      }
      else if (open.kind === "undo") await api(`/runs/${open.runId}/apply`, {}, { "idempotency-key": open.runId });
      else if (open.kind === "approve") {
        // The first of two yeses (the club's second-yes rule): kept, and the change waits for someone else's.
        const r = await api<{ yes_waiting?: unknown }>(`/runs/${open.row.id}/approve`, {});
        if (r.yes_waiting) setNote(t("ui.yes_recorded"));
      }
      else await api(`/runs/${open.row.id}/decline`, { reason: reason.trim() || undefined });
      setOpen(null); await loadMe(); void load();
    } catch (e) {
      // Saying yes to (or undoing) a sensitive change needs a second step: give it (or set one up), then the same again.
      if (needsStep(e)) step.ask(() => void confirm());
      else { setError((e as ApiError).message); setOpen(null); }
    }
    finally { setBusy(false); }
  };
  const filter = (label: string, value: string, set: (v: string) => void, options: [string, string][]) => (
    <label class={`filter-chip${value ? " on" : ""}`}><span>{label}</span>
      <select value={value} onChange={(e) => set(e.currentTarget.value)}><option value="">{t("ui.filter_all")}</option>{options.map(([v, w]) => <option value={v}>{w}</option>)}</select></label>
  );

  if (error && !rows) return <main class="card"><p class="error" role="alert">{error}</p></main>;
  if (!rows) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const waiting = rows.filter((r) => r.can_answer), rest = rows.filter((r) => !r.can_answer);
  const row = (r: Change) => (
    <li key={r.id} class="card">
      <div class="summary">{r.summary ?? r.action}</div>
      <div class="meta">{byline(r)} · {when(r.at)} · <span class={`status ${r.status}`}>{t(`ui.status_${r.status}` as Key)}</span>
        {r.undo_why && <> · <span class="status">{t("ui.change_cant_undo")}</span></>}
        {r.approved_by && <> · {t("ui.approved_by", { name: r.approved_by })}</>}
        {r.declined_by && <> · {t("ui.declined_by", { name: r.declined_by })}{r.reason ? `: ${r.reason}` : ""}</>}
        {r.ended && <> · {r.ended}</>}</div>
      {r.can_answer && <p><button class="primary small" onClick={() => answer("approve", r)}>{t("ui.approve")}</button> <button class="small" onClick={() => answer("decline", r)}>{t("ui.decline")}</button></p>}
      <p>{r.can_undo && <><button class="small" onClick={() => previewUndo(r.id)}>{t("ui.undo")}</button> </>}
        <button class="small" aria-expanded={picked?.id === r.id} onClick={() => details(r.id)}>{t("ui.changes_details")}</button></p>
    </li>
  );
  return (
    <main>
      <h1>{t("ui.nav_changes")}</h1>
      {error && <p class="error" role="alert">{error}</p>}
      {note && <p class="note" role="status">{note}</p>}
      {/* Docked at the bottom of the screen, as every preview is: the button that opened it may be far down the list. */}
      {step.sheet && <div class="dock">{step.sheet}</div>}
      {open && !step.sheet && <div class="dock">
        <div class="card sheet" role="dialog" aria-modal="true">
          {open.kind === "undo" && <p>{open.summary}</p>}
          {open.kind === "undo" && open.askFor && <p class="meta">{t("ui.would_ask")}</p>}
          {open.kind === "approve" && <p>{t("ui.approve_sheet", { summary: open.row.summary ?? open.row.action })}</p>}
          {open.kind === "decline" && <>
            <p>{t("ui.decline_sheet", { by: open.row.by, summary: open.row.summary ?? open.row.action })}</p>
            <label>{t("ui.decline_reason", { by: open.row.by })}<input value={reason} maxLength={300} onInput={(e) => setReason(e.currentTarget.value)} /></label>
          </>}
          <button class="primary" disabled={busy} onClick={confirm}>{t(open.kind === "undo" && open.askFor ? "ui.ask_for_yes" : "ui.confirm")}</button> <button disabled={busy} onClick={() => setOpen(null)}>{t("ui.back")}</button>
        </div>
      </div>}
      <div class="list-bar" role="group" aria-label={t("ui.filters")}>
        {filter(t("ui.changes_filter_who"), who, setWho, WHO.map((x) => [x, t(`ui.changes_who_${x}`)]))}
        {filter(t("ui.filter_type"), type, setType, AREAS.map((x) => [x, t(`area.${x}`)]))}
        {/* A plugin's card updates (lights on at Court 1, many a day) stay in the log for undo, out of sight unless asked. */}
        <label class={`filter-chip check${cards ? " on" : ""}`}><input type="checkbox" checked={cards} onChange={(e) => setCards(e.currentTarget.checked)} /><span>{t("ui.changes_plugin_cards")}</span></label>
      </div>
      {waiting.length > 0 && <section><h2>{t("ui.changes_waiting")}</h2><ul class="changes">{waiting.map(row)}</ul></section>}
      {rows.length === 0 && <p>{t(who || type ? "ui.changes_none_match" : "ui.changes_empty")}</p>}
      <ul class="changes">{rest.map(row)}</ul>
      {more && <p><button type="button" onClick={loadMore}>{t("ui.changes_show_more")}</button></p>}
      {picked && <SidePanel narrow onClose={() => setPicked(null)}>
        <ChangeDetail d={picked} undo={() => previewUndo(picked.id)} />
      </SidePanel>}
    </main>
  );
}

/** A value from the change log, as staff read it: times on the club's clock, yes or no, "empty". */
function shown(v: Value): string {
  if (v === null || v === "") return t("ui.change_empty_value");
  if (typeof v === "boolean") return t(v ? "ui.yes" : "ui.no");
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return when(v);
  return String(v);
}
/** The thing a row of the change log is, in words where the app has them ("booking"), else its name. */
function thing(entity: string): string {
  const w = t(`thing.${entity}` as Key);
  return w === `thing.${entity}` ? entity.replace(/_/g, " ") : w;
}

/** One change opened beside the list. */
export function ChangeDetail({ d, undo }: { d: Detail; undo: () => void }) {
  return (
    <div class="change-detail">
      <div class="drawer-head"><div>
        <h2>{d.title}</h2>
        <p class="meta">{byline(d)} · {when(d.at)} · <span class={`status ${d.status}`}>{t(`ui.status_${d.status}` as Key)}</span></p>
        {/* Two yeses (the club's second-yes rule): both, in order; one: who approved it. */}
        {(d.yeses?.length ?? 0) > 1 ? <p class="meta">{t("count.yes_from", { count: d.yeses!.length, names: d.yeses!.join(", ") })}</p>
          : d.approved_by && <p class="meta">{t("ui.approved_by", { name: d.approved_by })}</p>}
        {d.declined_by && <p class="meta">{t("ui.declined_by", { name: d.declined_by })}{d.reason ? `: ${d.reason}` : ""}</p>}
        {d.ended && <p class="meta">{d.ended}</p>}
      </div></div>
      <section>
        <h3>{t("ui.change_plan_shown")}</h3>
        {d.lines.length > 1 ? <ol>{d.lines.map((l) => <li>{l}</li>)}</ol> : <p>{d.summary ?? d.title}</p>}
        {d.said && <p class="meta">{t("ui.change_said", { words: d.said })}</p>}
      </section>
      {d.charge.length > 0 && <section>
        <h3>{t("ui.change_charged")}</h3>
        <ul class="plain">{d.charge.map((c) => <li>{c.label}{c.cents !== null && <> · {dollars(c.cents, lang.value)}</>}</li>)}</ul>
        {d.charge_how && <p class="meta">{d.charge_how}</p>}
      </section>}
      <section>
        <h3>{t("ui.change_wrote")}</h3>
        {d.fields.length === 0 ? <p class="meta">{t("ui.change_wrote_nothing")}</p> : <div class="table-scroll"><table class="stack">
          <thead><tr><th>{t("ui.change_what")}</th><th>{t("ui.change_before")}</th><th>{t("ui.change_after")}</th></tr></thead>
          <tbody>{d.fields.map((f) => <tr>
            <td data-label={t("ui.change_what")}>{thing(f.entity)} · {f.field.replace(/_/g, " ")}</td>
            <td data-label={t("ui.change_before")}>{f.op === "insert" ? <span class="meta">{t("ui.change_not_there")}</span> : shown(f.before)}</td>
            <td data-label={t("ui.change_after")}>{shown(f.after)}</td></tr>)}</tbody>
        </table></div>}
        {d.more > 0 && <p class="meta">{t("ui.change_more_fields", { count: d.more })}</p>}
      </section>
      <section>
        {d.can_undo ? <>
          {d.undo_until && <p class="meta">{t("ui.change_undo_until", { when: when(d.undo_until) })}</p>}
          <button type="button" onClick={undo}>{t("ui.undo")}</button>
        </> : d.undo_why && <p class="meta">{d.undo_why}</p>}
        <p class="meta"><small>{t("ui.change_ref", { id: d.id })}</small></p>
      </section>
    </div>
  );
}
