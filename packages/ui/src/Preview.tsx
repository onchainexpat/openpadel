// Every change in the staff app: preview with the server's own words, then confirm.
import { useState } from "preact/hooks";
import { api, ApiError, t } from "./state.ts";

export type Pending = { runId: string; status: "planned" | "awaiting_approval"; summary: string };

export function usePreview(onDone: () => void) {
  const [pending, setPending] = useState<Pending | null>(null), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  const preview = async (action: string, input: unknown) => {
    setError(null); setNote(null);
    try {
      const p = await api<{ run_id: string; status: Pending["status"]; summary: string }>(`/actions/${action}/plan`, input);
      if (p.status === "awaiting_approval") { setNote(`${p.summary} ${t("ui.sent_for_approval")}`); onDone(); return; }
      setPending({ runId: p.run_id, status: p.status, summary: p.summary });
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };
  const confirm = async () => {
    if (!pending) return;
    try { await api(`/runs/${pending.runId}/apply`, {}, { "idempotency-key": pending.runId }); setPending(null); setNote(t("ui.done")); onDone(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setPending(null); }
  };
  const sheet = (
    <>
      {pending && <div class="card sheet" role="dialog" aria-modal="true"><p>{pending.summary}</p>
        <button class="primary" onClick={confirm}>{t("ui.confirm")}</button> <button onClick={() => setPending(null)}>{t("ui.cancel")}</button></div>}
      {note && <p class="note" role="status">{note}</p>}
      {error && <p class="error" role="alert">{error}</p>}
    </>
  );
  return { preview, sheet };
}

export const dollars = (cents: number, lang: string) => new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", { style: "currency", currency: "USD" }).format(cents / 100);
