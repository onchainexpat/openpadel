// Every change in the staff app: preview with the server's own words, then confirm.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, lang, lazyPage, t } from "./state.ts";
import { useBackCloses } from "./back.ts";
import { money } from "@kumi/i18n/format";

/** The sheet that gives a second step, or sets one up there and then (TwoFactor.tsx): loaded only when it's needed. */
const StepUp = lazyPage(() => import("./TwoFactor.tsx").then((m) => m.StepUp));
/** A sensitive change refused for want of a second step (actions.ts, requireStrongAuth). */
export const needsStep = (e: unknown): boolean => e instanceof ApiError && (e.code === "error.second_step_to_change" || e.code === "error.need_passkey");
/** For a screen whose change a second step can unblock: ask(retry) shows the sheet that gives it (or sets one up), and
 *  then tries the change again, so a refusal is never a dead end. */
export function useStepUp() {
  const [retry, setRetry] = useState<(() => void) | null>(null);
  useBackCloses(Boolean(retry), () => setRetry(null));
  const ask = (again: () => void) => setRetry(() => again);
  const sheet = retry ? <div class="card sheet" role="dialog" aria-modal="true">
    <StepUp onDone={() => { const again = retry; setRetry(null); again(); }} onCancel={() => setRetry(null)} /></div> : null;
  return { ask, sheet };
}

export type Pending = { runId: string; status: "planned" | "awaiting_approval" | "would_ask"; summary: string; action?: string; input?: unknown };

export function usePreview(onDone: (result?: any) => void) {
  const [pending, setPending] = useState<Pending | null>(null), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(null), 5000); return () => clearTimeout(id); }, [note]);
  // The phone's back button closes the preview, not the page under it.
  useBackCloses(Boolean(pending), () => setPending(null));
  const step = useStepUp();
  const preview = async (action: string, input: unknown) => {
    setError(null); setNote(null);
    try {
      // First a look: a change that needs someone else's yes is asked for only when the person says so (ask below).
      const p = await api<{ run_id: string; status: Pending["status"]; summary: string }>(`/actions/${action}/plan?ask=hold`, input);
      if (p.status === "awaiting_approval") { setNote(`${p.summary} ${t("ui.sent_for_approval")}`); onDone(); return; }
      setPending({ runId: p.run_id, status: p.status, summary: p.summary, action, input });
    } catch (e) {
      if (needsStep(e)) { step.ask(() => void preview(action, input)); return; }
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  const ask = async () => {
    if (!pending?.action) return;
    try {
      const p = await api<{ run_id: string; status: Pending["status"]; summary: string }>(`/actions/${pending.action}/plan`, pending.input);
      // Asked: it waits for a yes. If it no longer needs one (something changed since the first look), nothing has
      // happened yet: it's shown again, to confirm, rather than said to be done.
      if (p.status === "awaiting_approval") { setPending(null); setNote(t("ui.sent_for_approval")); onDone(); return; }
      setPending({ runId: p.run_id, status: p.status, summary: p.summary });
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setPending(null); }
  };
  const confirm = async () => {
    if (!pending) return;
    if (pending.status === "would_ask") return ask();
    try {
      const r = await api<{ result?: any }>(`/runs/${pending.runId}/apply`, {}, { "idempotency-key": pending.runId });
      setPending(null);
      // A kid's: sent to their parents to approve, or already paid on the family card (no card form to open).
      if (r.result?.asked_parent) { setNote(t("ui.kid_asked_parents")); onDone(); return; }
      const f = r.result?.family as { status: "paid" | "parent"; cents: number } | undefined;
      setNote(!f ? t("ui.done") : f.status === "paid" ? t("ui.kid_paid_family", { amount: dollars(f.cents, lang.value) }) : t("ui.kid_parent_pays"));
      onDone(r.result);
    }
    catch (e) {
      // Refused at confirm for want of a second step: give it, and confirm again.
      if (needsStep(e)) { step.ask(() => void confirm()); return; }
      setError(e instanceof ApiError ? e.message : String(e)); setPending(null);
    }
  };
  // Docked at the bottom of the screen: on a phone the button that asked for it may be far down the page.
  const sheet = (
    <div class="dock">
      {step.sheet}
      {pending && !step.sheet && <div class="card sheet" role="dialog" aria-modal="true"><p>{pending.summary}</p>
        {pending.status === "would_ask" && <p class="meta">{t("ui.would_ask")}</p>}
        <button class="primary" onClick={confirm}>{t(pending.status === "would_ask" ? "ui.ask_for_yes" : "ui.confirm")}</button> <button onClick={() => setPending(null)}>{t("ui.back")}</button></div>}
      {note && <p class="note" role="status" onClick={() => setNote(null)}>{note}</p>}
      {error && <p class="error" role="alert" onClick={() => setError(null)}>{error}</p>}
    </div>
  );
  return { preview, sheet };
}

export const dollars = (cents: number, lang: string) => money(cents, lang === "es" ? "es" : "en");
