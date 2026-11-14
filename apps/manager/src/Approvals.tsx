// Approvals: every ask waiting for this person's yes, with who asked, what it changes and when the ask runs out; their
// own asks still waiting for someone else's; and the week's answers (apps/server/src/today.ts). A view: saying yes or
// no is the same as on Changes (/runs/:id/approve and /decline, with a second step when the change needs one). A role
// that doesn't read people sees each ask's title, not its summary, and no names.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, clubTime, dollars, lang, loadMe, needsStep, t, useBackCloses, useStepUp } from "@kumi/ui";
import { label } from "./words.ts";

type Ask = { id: string; action: string; title: string; summary: string | null; by: string | null; via: string; asked_at: string; expires_at: string; undo: string | null; money_cents?: number };
type Done = Ask & { outcome: "approved" | "declined" | "ended"; answered_by: string | null; answered_at: string | null; reason: string | null; ended: string | null };
type View = { people: boolean; waiting: Ask[]; mine: Ask[]; done: Done[] };

export function Approvals() {
  const [v, setV] = useState<View | null>(null), [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ kind: "approve" | "decline"; row: Ask } | null>(null), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  useBackCloses(Boolean(open), () => setOpen(null));
  const load = () => api<View>("/staff/approvals").then(setV).catch((e: ApiError) => setError(e.message));
  useEffect(() => { void load(); }, [lang.value]);
  const step = useStepUp();
  const answer = (kind: "approve" | "decline", row: Ask) => { setError(null); setReason(""); setOpen({ kind, row }); };
  const confirm = async () => {
    if (!open) return;
    setBusy(true);
    try {
      if (open.kind === "approve") await api(`/runs/${open.row.id}/approve`, {});
      else await api(`/runs/${open.row.id}/decline`, { reason: reason.trim() || undefined });
      // An approved change can change the person's own profile, language included.
      setOpen(null); await loadMe(); void load();
    } catch (e) {
      if (needsStep(e)) step.ask(() => void confirm());
      else { setError((e as ApiError).message); setOpen(null); void load(); }
    }
    finally { setBusy(false); }
  };

  if (error && !v) return <main class="card"><p class="error" role="alert">{error}</p></main>;
  if (!v) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const when = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
  const what = (a: Ask) => a.summary ?? a.title;
  const asked = (a: Ask) => (a.by ? t("ui.ask_by", { by: a.by, when: when(a.asked_at) }) : t("ui.ask_at", { when: when(a.asked_at) }));
  const card = (a: Ask, buttons: boolean) => (
    <li class="card ask" key={a.id}>
      <p class="meta">{asked(a)}</p>
      <p class="ask-what"><strong>{what(a)}</strong></p>
      {a.summary && a.title !== a.summary && <p class="meta">{a.title}</p>}
      <p class="meta">{t("ui.ask_expires", { when: when(a.expires_at) })}{a.money_cents ? <> · {t("ui.ask_amount", { amount: dollars(a.money_cents, lang.value) })}</> : null}
        {" · "}{t(a.undo && a.undo !== "none" ? "ui.ask_undoable" : "ui.ask_final")}</p>
      {buttons && <p><button class="primary small" onClick={() => answer("approve", a)}>{t("ui.approve")}</button> <button class="small" onClick={() => answer("decline", a)}>{t("ui.decline")}</button></p>}
    </li>
  );
  const asker = (a: Ask) => a.by ?? t("ui.ask_asker");
  return (
    <main>
      <div class="page-head"><h1>{label("ui.nav_approvals")}</h1><span class="count-chip" role="status">{t("count.approvals_waiting", { count: v.waiting.length })}</span></div>
      <p class="meta">{t("ui.approvals_lead")}</p>
      {error && <p class="error" role="alert">{error}</p>}
      {step.sheet && <div class="dock">{step.sheet}</div>}
      {open && !step.sheet && <div class="dock">
        <div class="card sheet" role="dialog" aria-modal="true">
          {open.kind === "approve" && <p>{t("ui.approve_sheet", { summary: what(open.row) })}</p>}
          {open.kind === "decline" && <>
            <p>{t("ui.decline_sheet", { by: asker(open.row), summary: what(open.row) })}</p>
            <label>{t("ui.decline_reason", { by: asker(open.row) })}<input value={reason} maxLength={300} onInput={(e) => setReason(e.currentTarget.value)} /></label>
          </>}
          <button class="primary" disabled={busy} onClick={confirm}>{t("ui.confirm")}</button> <button disabled={busy} onClick={() => setOpen(null)}>{t("ui.back")}</button>
        </div>
      </div>}
      <section aria-labelledby="ask-waiting"><h2 id="ask-waiting">{t("ui.changes_waiting")}</h2>
        {v.waiting.length === 0 ? <p class="card">{t("ui.approvals_none")}</p> : <ul class="plain">{v.waiting.map((a) => card(a, true))}</ul>}</section>
      {v.mine.length > 0 && <section aria-labelledby="ask-mine"><h2 id="ask-mine">{t("ui.approvals_mine")}</h2><ul class="plain">{v.mine.map((a) => card(a, false))}</ul></section>}
      {v.done.length > 0 && <section aria-labelledby="ask-done"><h2 id="ask-done">{t("ui.approvals_done")}</h2>
        <ul class="plain">{v.done.map((d) => (
          <li class="card ask done" key={d.id}>
            <p class="ask-what">{what(d)}</p>
            <p class="meta">{asked(d)} · <span class={`status ${d.outcome === "approved" ? "applied" : "failed"}`}>
              {d.outcome === "ended" ? d.ended : d.outcome === "approved" ? (d.answered_by ? t("ui.approved_by", { name: d.answered_by }) : t("ui.ask_approved"))
                : <>{t("ui.ask_declined")}{d.answered_by && <> {t("ui.declined_by", { name: d.answered_by })}</>}</>}</span>{d.reason ? `: ${d.reason}` : ""}</p>
          </li>))}</ul></section>}
    </main>
  );
}
