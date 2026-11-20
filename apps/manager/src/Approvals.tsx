// Approvals: every ask waiting for this person's yes, with who asked, how it came in (the app, an assistant on /mcp) and
// how long ago, what it changes (each consequence a line, where the plan has several), the asker's own words where the
// change has a field for them, and when the ask runs out; their own asks still waiting for someone else's; and, on the
// other tab, today's answers (apps/server/src/today.ts). A change the club's second-yes rule covers says how many yeses
// it needs and who has said yes so far; whoever said yes first sees it with the asks waiting for someone else. A view: saying yes or
// no is the same as on Changes (/runs/:id/approve and /decline, with a second step when the change needs one). A role
// that doesn't read people sees each ask's title, not its summary, and no names.
import { useEffect, useState } from "preact/hooks";
import { Skeleton, api, ApiError, clubTime, dollars, lang, loadMe, needsStep, serverNow, t, useBackCloses, useStepUp } from "@kumi/ui";
import { formatLocale } from "@kumi/i18n/format";
import { label } from "./words.ts";
import { Tabs } from "./lists.tsx";
import { agoParts, viaWords } from "./made_via.ts";

type Ask = { id: string; action: string; title: string; summary: string | null; by: string | null; via: string; asked_at: string; expires_at: string; undo: string | null; money_cents?: number;
  lines: string[]; said: string | null; needed: number; yeses: { name: string | null; at: string; me: boolean }[]; stuck?: boolean };
type Done = Ask & { outcome: "approved" | "declined" | "ended"; answered_by: string | null; answered_at: string | null; reason: string | null; ended: string | null };
type View = { people: boolean; waiting: Ask[]; mine: Ask[]; done: Done[] };

export function Approvals() {
  const [v, setV] = useState<View | null>(null), [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ kind: "approve" | "decline"; row: Ask } | null>(null), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"waiting" | "done">("waiting"), [note, setNote] = useState<string | null>(null);
  useBackCloses(Boolean(open), () => setOpen(null));
  const load = () => api<View>("/staff/approvals").then(setV).catch((e: ApiError) => setError(e.message));
  useEffect(() => { void load(); }, [lang.value]);
  const step = useStepUp();
  const answer = (kind: "approve" | "decline", row: Ask) => { setError(null); setReason(""); setOpen({ kind, row }); };
  const confirm = async () => {
    if (!open) return;
    setBusy(true);
    try {
      setNote(null);
      if (open.kind === "approve") {
        // The first of two yeses: it's kept, and the change waits for someone else's.
        const r = await api<{ yes_waiting?: { yeses: number; needed: number } }>(`/runs/${open.row.id}/approve`, {});
        if (r.yes_waiting) setNote(t("ui.yes_recorded"));
      }
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
  if (!v) return <Skeleton />;
  const when = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
  const what = (a: Ask) => a.summary ?? a.title;
  // Who asked and how (the app, an assistant on /mcp), and how long ago: the exact time on hover.
  const ago = (iso: string) => { const p = agoParts(iso, serverNow()); return p ? new Intl.RelativeTimeFormat(formatLocale(lang.value), { numeric: "auto" }).format(...p) : t("ui.ago_just_now"); };
  const asked = (a: Ask) => {
    const v = viaWords(a.via), who = a.by ? t("ui.ask_by", { by: a.by, when: ago(a.asked_at) }) : t("ui.ask_at", { when: ago(a.asked_at) });
    return v ? `${who} · ${t(`ui.made_via_${v.word}`, v.params)}` : who;
  };
  // "Needs 2 yeses · Jordan said yes · you'd be the second yes": only for a change that needs two.
  const yesLine = (a: Ask, answering: boolean) => {
    if (a.needed < 2) return null;
    const others = a.yeses.filter((y) => !y.me && y.name).map((y) => y.name!), mine = a.yeses.some((y) => y.me);
    const parts = [a.yeses.length ? t("count.yeses_of", { count: a.yeses.length, needed: a.needed }) : t("count.yeses_needed", { count: a.needed })];
    if (others.length) parts.push(t("count.yes_from", { count: others.length, names: others.join(", ") }));
    if (mine) parts.push(t("ui.yes_from_you"));
    if (answering && a.yeses.length === a.needed - 1) parts.push(t("ui.yes_you_second"));
    return <><p class="meta yes-line">{parts.join(" · ")}</p>{a.stuck && <p class="error">{t("ui.yes_stuck")}</p>}</>;
  };
  const card = (a: Ask, buttons: boolean) => (
    <li class="card ask" key={a.id}>
      <p class="meta" title={when(a.asked_at)}>{asked(a)}</p>
      {/* Several consequences: a line each, under the change's name. One: its summary. */}
      {a.lines.length > 1 ? <><p class="ask-what"><strong>{a.title}</strong></p><ul>{a.lines.map((l) => <li>{l}</li>)}</ul></>
        : <><p class="ask-what"><strong>{what(a)}</strong></p>{a.summary && a.title !== a.summary && <p class="meta">{a.title}</p>}</>}
      {a.said && <p class="meta">{t("ui.change_said", { words: a.said })}</p>}
      {yesLine(a, buttons)}
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
      {note && <p class="note" role="status">{note}</p>}
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
      {/* What waits (theirs to answer, then their own asks) and the week's answers, a tab each; each tab's list is the same as before. */}
      <Tabs label={t("ui.approvals_lists")} tabs={[["waiting", `${t("ui.changes_waiting")} · ${v.waiting.length}`], ["done", `${t("ui.approvals_done")} · ${v.done.length}`]]} on={tab} pick={(k) => setTab(k as "waiting" | "done")} id="approvals" />
      {tab === "waiting" && <div role="tabpanel" tabIndex={0} id="approvals-panel-waiting" aria-labelledby="approvals-tab-waiting">
        {v.waiting.length === 0 ? <p class="card">{t("ui.approvals_none")}</p> : <ul class="plain">{v.waiting.map((a) => card(a, true))}</ul>}
        {v.mine.length > 0 && <section aria-labelledby="ask-mine"><h2 id="ask-mine">{t("ui.approvals_mine")}</h2><ul class="plain">{v.mine.map((a) => card(a, false))}</ul></section>}
      </div>}
      {tab === "done" && <div role="tabpanel" tabIndex={0} id="approvals-panel-done" aria-labelledby="approvals-tab-done">
        {v.done.length === 0 ? <p class="card meta">{t("ui.approvals_done_none")}</p> : <ul class="plain">{v.done.map((d) => (
          <li class="card ask done" key={d.id}>
            <p class="ask-what">{what(d)}</p>
            {yesLine(d, false)}
            <p class="meta" title={when(d.asked_at)}>{asked(d)} · <span class={`status ${d.outcome === "approved" ? "applied" : "failed"}`}>
              {d.outcome === "ended" ? d.ended : d.outcome === "approved" ? (d.answered_by ? t("ui.approved_by", { name: d.answered_by }) : t("ui.ask_approved"))
                : <>{t("ui.ask_declined")}{d.answered_by && <> {t("ui.declined_by", { name: d.answered_by })}</>}</>}</span>{d.reason ? `: ${d.reason}` : ""}</p>
          </li>))}</ul>}
      </div>}
    </main>
  );
}
