import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, ApiError, lang, loadMe, t } from "@kumi/ui";

type Change = { id: string; action: string; status: string; by: string; via: string; summary: string | null; at: string;
  can_answer: boolean; approved_by: string | null; declined_by: string | null; reason: string | null };
/** A sheet open on one change: undo it, or say yes or no to what someone asked for. */
type Open = { kind: "undo"; runId: string; summary: string } | { kind: "approve" | "decline"; row: Change };

export function Changes() {
  const [rows, setRows] = useState<Change[] | null>(null), [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const load = () => api<Change[]>("/staff/changes").then(setRows).catch((e: ApiError) => setError(e.message));
  useEffect(() => { load(); }, [lang.value]);

  const previewUndo = async (id: string) => {
    setError(null);
    try { const p = await api<{ run_id: string; summary: string }>("/actions/action.undo/plan", { run_id: id }); setOpen({ kind: "undo", runId: p.run_id, summary: p.summary }); }
    catch (e) { setError((e as ApiError).message); }
  };
  const answer = (kind: "approve" | "decline", row: Change) => { setError(null); setReason(""); setOpen({ kind, row }); };
  const confirm = async () => {
    if (!open) return;
    setBusy(true);
    try {
      // An undo or an approved change can change the person's own profile, language included, so reload them first.
      if (open.kind === "undo") await api(`/runs/${open.runId}/apply`, {}, { "idempotency-key": open.runId });
      else if (open.kind === "approve") await api(`/runs/${open.row.id}/approve`, {});
      else await api(`/runs/${open.row.id}/decline`, { reason: reason.trim() || undefined });
      setOpen(null); await loadMe(); load();
    } catch (e) { setError((e as ApiError).message); setOpen(null); }
    finally { setBusy(false); }
  };
  const when = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

  if (error && !rows) return <main class="card"><p class="error" role="alert">{error}</p></main>;
  if (!rows) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const waiting = rows.filter((r) => r.can_answer), rest = rows.filter((r) => !r.can_answer);
  const row = (r: Change) => (
    <li key={r.id} class="card">
      <div class="summary">{r.summary ?? r.action}</div>
      <div class="meta">{r.by} · {when(r.at)} · <span class={`status ${r.status}`}>{t(`ui.status_${r.status}` as Key)}</span>
        {r.approved_by && <> · {t("ui.approved_by", { name: r.approved_by })}</>}
        {r.declined_by && <> · {t("ui.declined_by", { name: r.declined_by })}{r.reason ? `: ${r.reason}` : ""}</>}</div>
      {r.can_answer && <p><button class="primary small" onClick={() => answer("approve", r)}>{t("ui.approve")}</button> <button class="small" onClick={() => answer("decline", r)}>{t("ui.decline")}</button></p>}
      {r.status === "applied" && r.action !== "action.undo" && r.action !== "club.setup" && <button class="small" onClick={() => previewUndo(r.id)}>{t("ui.undo")}</button>}
    </li>
  );
  return (
    <main>
      <h1>{t("ui.nav_changes")}</h1>
      {error && <p class="error" role="alert">{error}</p>}
      {/* Docked at the bottom of the screen, as every preview is: the button that opened it may be far down the list. */}
      {open && <div class="dock">
        <div class="card sheet" role="dialog" aria-modal="true">
          {open.kind === "undo" && <p>{open.summary}</p>}
          {open.kind === "approve" && <p>{t("ui.approve_sheet", { summary: open.row.summary ?? open.row.action })}</p>}
          {open.kind === "decline" && <>
            <p>{t("ui.decline_sheet", { by: open.row.by, summary: open.row.summary ?? open.row.action })}</p>
            <label>{t("ui.decline_reason", { by: open.row.by })}<input value={reason} maxLength={300} onInput={(e) => setReason(e.currentTarget.value)} /></label>
          </>}
          <button class="primary" disabled={busy} onClick={confirm}>{t("ui.confirm")}</button> <button disabled={busy} onClick={() => setOpen(null)}>{t("ui.cancel")}</button>
        </div>
      </div>}
      {waiting.length > 0 && <section><h2>{t("ui.changes_waiting")}</h2><ul class="changes">{waiting.map(row)}</ul></section>}
      {rows.length === 0 && <p>{t("ui.changes_empty")}</p>}
      <ul class="changes">{rest.map(row)}</ul>
    </main>
  );
}
