// Every change in the staff app: preview with the server's own words, then confirm.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, lang, t } from "./state.ts";

export type Pending = { runId: string; status: "planned" | "awaiting_approval"; summary: string };

export function usePreview(onDone: (result?: any) => void) {
  const [pending, setPending] = useState<Pending | null>(null), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(null), 5000); return () => clearTimeout(id); }, [note]);
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
    try {
      const r = await api<{ result?: any }>(`/runs/${pending.runId}/apply`, {}, { "idempotency-key": pending.runId });
      setPending(null);
      // A kid's: sent to their parents to approve, or already paid on the family card (no card form to open).
      if (r.result?.asked_parent) { setNote(t("ui.kid_asked_parents")); onDone(); return; }
      const f = r.result?.family as { status: "paid" | "parent"; cents: number } | undefined;
      setNote(!f ? t("ui.done") : f.status === "paid" ? t("ui.kid_paid_family", { amount: dollars(f.cents, lang.value) }) : t("ui.kid_parent_pays"));
      onDone(r.result);
    }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setPending(null); }
  };
  // Docked at the bottom of the screen: on a phone the button that asked for it may be far down the page.
  const sheet = (
    <div class="dock">
      {pending && <div class="card sheet" role="dialog" aria-modal="true"><p>{pending.summary}</p>
        <button class="primary" onClick={confirm}>{t("ui.confirm")}</button> <button onClick={() => setPending(null)}>{t("ui.cancel")}</button></div>}
      {note && <p class="note" role="status" onClick={() => setNote(null)}>{note}</p>}
      {error && <p class="error" role="alert" onClick={() => setError(null)}>{error}</p>}
    </div>
  );
  return { preview, sheet };
}

export const dollars = (cents: number, lang: string) => new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", { style: "currency", currency: "USD" }).format(cents / 100);
