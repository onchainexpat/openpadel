import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, ApiError, lang, loadMe, t } from "./state.ts";

type Change = { id: string; action: string; status: string; by: string; via: string; summary: string | null; at: string };

export function Changes() {
  const [rows, setRows] = useState<Change[] | null>(null), [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ runId: string; summary: string } | null>(null);
  const load = () => api<Change[]>("/changes").then(setRows).catch((e: ApiError) => setError(e.message));
  useEffect(() => { load(); }, [lang.value]);

  const previewUndo = async (id: string) => {
    setError(null);
    try { const p = await api<{ run_id: string; summary: string }>("/actions/action.undo/plan", { run_id: id }); setUndo({ runId: p.run_id, summary: p.summary }); }
    catch (e) { setError((e as ApiError).message); }
  };
  const confirmUndo = async () => {
    if (!undo) return;
    // An undo can change the person's own profile, language included, so reload them first.
    try { await api(`/runs/${undo.runId}/apply`, {}, { "idempotency-key": undo.runId }); setUndo(null); await loadMe(); load(); }
    catch (e) { setError((e as ApiError).message); setUndo(null); }
  };
  const when = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

  if (error && !rows) return <main class="card"><p class="error" role="alert">{error}</p></main>;
  if (!rows) return <main class="card"><p>{t("ui.loading")}</p></main>;
  return (
    <main>
      <h1>{t("ui.nav_changes")}</h1>
      {error && <p class="error" role="alert">{error}</p>}
      {undo && (
        <div class="card sheet" role="dialog" aria-modal="true">
          <p>{undo.summary}</p>
          <button class="primary" onClick={confirmUndo}>{t("ui.confirm")}</button> <button onClick={() => setUndo(null)}>{t("ui.cancel")}</button>
        </div>
      )}
      {rows.length === 0 && <p>{t("ui.changes_empty")}</p>}
      <ul class="changes">
        {rows.map((r) => (
          <li key={r.id} class="card">
            <div class="summary">{r.summary ?? r.action}</div>
            <div class="meta">{r.by} · {when(r.at)} · <span class={`status ${r.status}`}>{t(`ui.status_${r.status}` as Key)}</span></div>
            {r.status === "applied" && r.action !== "action.undo" && r.action !== "club.setup" && <button class="small" onClick={() => previewUndo(r.id)}>{t("ui.undo")}</button>}
          </li>
        ))}
      </ul>
    </main>
  );
}
