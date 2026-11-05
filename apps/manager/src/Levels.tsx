// The level review queue: reviews players asked for, and levels that moved a lot. Each is answered by
// keeping the level or changing it with a reason (players who asked are told either way).
import { useEffect, useState } from "preact/hooks";
import { api, lang, t, usePreview, clubTime } from "@kumi/ui";

type Request = { id: string; person_id: string; name: string; note: string | null; created_at: string; level: string | null; provisional: boolean | null; rated_games: number | null };
type Move = { person_id: string; name: string; level: number; from: number; since: string };
type Q = { requests: Request[]; moves: Move[]; limit: number; days: number };

function Answer({ personId, name, level, children, preview }: { personId: string; name: string; level: string | null; children: preact.ComponentChildren; preview: (a: string, i: unknown) => void }) {
  const [to, setTo] = useState(""), [reason, setReason] = useState("");
  return (
    <li class="row"><span><a href={`/people/${personId}/level`}>{name}</a> <span class="badge">{level ?? t("ui.no_level_yet")}</span><br /><span class="meta">{children}</span></span>
      <form onSubmit={(e) => e.preventDefault()}>
        <label>{t("ui.reason_for_them")}<input value={reason} onInput={(e) => setReason(e.currentTarget.value)} /></label>
        <label>{t("ui.new_level")}<input type="number" step="0.01" min="0" max="7" value={to} onInput={(e) => setTo(e.currentTarget.value)} /></label>
        <button type="button" class="small" onClick={() => preview("level.answer_review", { person_id: personId, outcome: "keep", ...(reason.trim() ? { reason: reason.trim() } : {}) })}>{t("ui.keep_level")}</button>{" "}
        <button type="button" class="small" disabled={!to || reason.trim().length < 3} onClick={() => preview("level.answer_review", { person_id: personId, outcome: "change", level: Number(to), reason: reason.trim() })}>{t("ui.change_level_to")}</button>
      </form>
    </li>
  );
}

export function Levels() {
  const [q, setQ] = useState<Q | null>(null);
  const load = () => api<Q>("/staff/levels").then(setQ);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  if (!q) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const day = (iso: string) => clubTime(iso, { dateStyle: "medium" });
  return (
    <main>
      <h1>{t("ui.levels_queue")}</h1>
      {sheet}
      <section class="card">
        <h2>{t("ui.review_requests")}</h2>
        {!q.requests.length ? <p class="meta">{t("ui.queue_empty")}</p> : <ul class="plain">{q.requests.map((r) =>
          <Answer key={r.id} personId={r.person_id} name={r.name} level={r.level} preview={preview}>{t("ui.asked_on", { date: day(r.created_at) })}{r.note ? `: "${r.note}"` : ""}</Answer>)}</ul>}
      </section>
      <section class="card">
        <h2>{t("ui.big_moves", { limit: q.limit.toFixed(2), days: q.days })}</h2>
        {!q.moves.length ? <p class="meta">{t("ui.queue_empty")}</p> : <ul class="plain">{q.moves.map((m) =>
          <Answer key={m.person_id} personId={m.person_id} name={m.name} level={m.level.toFixed(2)} preview={preview}>{t("ui.moved_from", { from: m.from.toFixed(2), level: m.level.toFixed(2), date: day(m.since) })}</Answer>)}</ul>}
      </section>
    </main>
  );
}
