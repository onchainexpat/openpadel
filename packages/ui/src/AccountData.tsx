// A copy of someone's data, and deleting their account: on a member's own Profile, and on a person's page
// for the owner (when the member asks). Deleting shows first what still has to be cleared.
import { useState } from "preact/hooks";
import { useBackCloses } from "./back.ts";
import { api, ApiError, t } from "./state.ts";
import { needsStep, useStepUp } from "./Preview.tsx";

type Check = { blockers: { kind: string; text: string; how: string }[]; juniors: string[]; ends: string[] };
type Pending = { kind: "export" | "erase"; runId: string; summary: string; ask?: boolean };

export function AccountData({ personId, self, kid = false, onDeleted }: { personId: string; self: boolean; kid?: boolean; onDeleted: () => void }) {
  const [pending, setPending] = useState<Pending | null>(null), [blocked, setBlocked] = useState<Check["blockers"] | null>(null);
  const [note, setNote] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useBackCloses(Boolean(pending), () => setPending(null));
  // Deleting an account is a sensitive change: without a second step (someone who has one, or staff), the sheet to give it.
  const step = useStepUp();
  const guard = async (f: () => Promise<void>): Promise<void> => { setBusy(true); setError(null); setNote(null); try { await f(); } catch (e) { if (needsStep(e)) step.ask(() => void guard(f)); else setError(e instanceof ApiError ? e.message : (e as Error).message); } finally { setBusy(false); } };

  const ask = (kind: Pending["kind"]) => guard(async () => {
    setBlocked(null); setPending(null);
    if (kind === "erase") {
      const c = await api<Check>(`/my/privacy/check?person_id=${encodeURIComponent(personId)}`);
      if (c.blockers.length) { setBlocked(c.blockers); return; }
    }
    // First a look: one that needs the owner's yes is shown, and asked for only when the person says so (Preview.tsx).
    const p = await api<{ run_id: string; status: "planned" | "awaiting_approval" | "would_ask"; summary: string }>(`/actions/privacy.${kind}/plan?ask=hold`, { person_id: personId });
    if (p.status === "awaiting_approval") { setNote(`${p.summary} ${t("ui.sent_for_approval")}`); return; }
    setPending({ kind, runId: p.run_id, summary: p.summary, ask: p.status === "would_ask" });
  });
  const confirm = () => guard(async () => {
    const p = pending!;
    if (p.ask) {
      const a = await api<{ run_id: string; status: "planned" | "awaiting_approval"; summary: string }>(`/actions/privacy.${p.kind}/plan`, { person_id: personId });
      if (a.status === "awaiting_approval") { setPending(null); setNote(t("ui.sent_for_approval")); return; }
      setPending({ kind: p.kind, runId: a.run_id, summary: a.summary });   // no yes needed now: confirm it
      return;
    }
    const r = await api<{ result: { download?: string } }>(`/runs/${p.runId}/apply`, {}, { "idempotency-key": p.runId });
    setPending(null);
    if (p.kind === "export") { if (r.result.download) window.location.assign(r.result.download); setNote(t("ui.data_downloading")); }
    else onDeleted();
  });

  return (
    <section class="card">
      <h2>{t(self ? "ui.data_title" : "ui.data_title_for")}</h2>
      <p class="meta">{t(self ? "ui.data_help" : "ui.data_help_for")}</p>
      <div class="court-row"><button disabled={busy} onClick={() => ask("export")}>{t(self ? "ui.data_download" : "ui.data_download_for")}</button>
        {self && kid ? null : <button class="danger" disabled={busy} onClick={() => ask("erase")}>{t(self ? "ui.data_delete" : "ui.data_delete_for")}</button>}</div>
      {self && kid && <p class="meta">{t("ui.data_kid")}</p>}
      {blocked && <div class="sheet" role="status"><p>{t("ui.data_blocked")}</p><ul>{blocked.map((b) => <li>{b.text}: <span class="meta">{b.how}</span></li>)}</ul></div>}
      {pending && <div class="sheet" role="dialog" aria-modal="true"><p>{pending.summary}</p>
        {pending.ask && <p class="meta">{t("ui.would_ask")}</p>}
        <button class={pending.kind === "erase" ? "danger" : "primary"} disabled={busy} onClick={confirm}>{t(pending.ask ? "ui.ask_for_yes" : "ui.confirm")}</button> <button disabled={busy} onClick={() => setPending(null)}>{t("ui.back")}</button></div>}
      {step.sheet}
      {note && <p class="note" role="status">{note}</p>}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}
