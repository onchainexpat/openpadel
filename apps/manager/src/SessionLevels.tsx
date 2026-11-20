// Levels after a session (a coach's level check): everyone who had a place, each with what they were, a new level to
// set with −/+ 0.1 (or left as it is), and one reason, picked from a few or written. The footer counts the changes;
// saving opens the preview first, as every change does.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { Skeleton, ApiError, api, lang, t, usePreview } from "@kumi/ui";
import { changedRows, isChange, LEVEL_REASONS, stepLevel } from "./level_check.ts";

type S = { session: { id: string; name: string; when: string; started: boolean; status: string; program_id: string };
  players: { person_id: string; name: string; level: string | null; floor: string | null; provisional: boolean | null; came: boolean | null }[]; absent: number };

export function SessionLevels({ id }: { id: string }) {
  const [d, setD] = useState<S | null>(null), [error, setError] = useState<string | null>(null), [levels, setLevels] = useState<Record<string, string>>({}), [reason, setReason] = useState("");
  // What's on the page is this date's: an answer for the one open before (a slow load, then another opened) is dropped.
  const shown = useRef(id);
  const load = () => { const k = id; return api<S>(`/staff/sessions/${k}/levels`).then((x) => { if (shown.current !== k) return; setD(x); setLevels(Object.fromEntries(x.players.map((p) => [p.person_id, p.level ?? ""]))); setReason(""); setError(null); })
    .catch((e) => { if (shown.current === k) setError(e instanceof ApiError ? e.message : String(e)); }); };
  const { preview, sheet } = usePreview(load);
  // Another date opened: nothing of the last one (its players, levels or its no) stays while this one loads.
  useEffect(() => { shown.current = id; setD(null); setError(null); setLevels({}); setReason(""); }, [id]);
  useEffect(() => { load(); }, [id, lang.value]);
  // Nothing loaded yet: the no is the page. A refresh after a save that fails keeps what was read, with a notice.
  if (error && !d) return <main class="card"><p class="error" role="alert">{error}</p></main>;
  if (!d) return <Skeleton />;
  const rows = changedRows(d.players, levels), n = rows.length;
  const submit = (e: Event) => {
    e.preventDefault();
    if (n) preview("level.set_session", { session_id: id, reason: reason.trim(), levels: rows });
  };
  // A reason chip puts its words in the reason (still theirs to change); Other leaves it to them.
  const words = (k: string) => t(`ui.level_reason_${k}` as Key);
  const picked = LEVEL_REASONS.find((k) => k !== "other" && reason === words(k)) ?? (reason.trim() ? "other" : null);
  return (
    <main>
      <p><a href={`/programs/${d.session.program_id}`}>{d.session.name}</a></p>
      <h1>{t("ui.set_levels_title", { program: d.session.name, when: d.session.when })}</h1>
      <p class="meta">{t("ui.set_levels_help")} {t("ui.set_levels_floor_help")}</p>
      {sheet}
      {error && <p class="error" role="alert">{error}</p>}
      {!d.session.started && <p class="card">{t("error.session_not_started")}</p>}
      {d.absent > 0 && <p class="meta">{t("ui.levels_absent", { count: d.absent })}</p>}
      {!d.players.length ? <p class="card">{t("ui.no_players_session")}</p> : <form class="card level-check" onSubmit={submit}>
        <fieldset class="reason-chips"><legend>{t("ui.level_reason_pick")}</legend>
          <p class="chips">{LEVEL_REASONS.map((k) => <button type="button" class={`chip${picked === k ? " on" : ""}`} aria-pressed={picked === k}
            onClick={() => { if (k === "other") { setReason(""); document.getElementById("level-reason")?.focus(); } else setReason(words(k)); }}>{t(`ui.level_reason_chip_${k}` as Key)}</button>)}</p>
        </fieldset>
        <label>{t("ui.reason_for_them")}<input id="level-reason" required maxLength={300} value={reason} onInput={(e) => setReason(e.currentTarget.value)} /></label>
        <ul class="plain level-rows">{d.players.map((p) => {
          const v = levels[p.person_id] ?? "", moved = isChange(v, p.level);
          const set = (x: string) => setLevels({ ...levels, [p.person_id]: x });
          return <li class="row level-row">
            <span><strong>{p.name}</strong><br /><span class="meta">{[p.level ? t("ui.level_was", { level: p.level }) : t("ui.no_level_yet"), p.floor ? t("ui.floor", { floor: p.floor }) : null,
              p.provisional ? t("ui.person_chip_provisional") : null, p.came ? t("ui.marked_came") : null].filter(Boolean).join(" · ")}</span></span>
            <span class="stepper">
              <button type="button" class="small" aria-label={t("ui.level_lower", { name: p.name })} disabled={!v && !p.level} onClick={() => set(stepLevel(v, p.level, -0.1, p.floor))}>−</button>
              <input type="number" step="0.01" min={p.floor ?? "0"} max="7" inputMode="decimal" class={moved ? "moved" : undefined} aria-label={t("ui.level_new_for", { name: p.name })}
                value={v} onInput={(e) => set(e.currentTarget.value)} />
              <button type="button" class="small" aria-label={t("ui.level_raise", { name: p.name })} disabled={!v && !p.level} onClick={() => set(stepLevel(v, p.level, 0.1, p.floor))}>+</button>
            </span>
          </li>;
        })}</ul>
        <div class="level-foot">
          <p class="meta" role="status">{n ? t("count.level_check_summary", { count: n }) : t("ui.level_check_none")}</p>
          <button class="primary" disabled={!d.session.started || !n || reason.trim().length < 3}>{n ? t("count.level_check_save", { count: n }) : t("ui.level_check_nothing")}</button>
        </div>
      </form>}
    </main>
  );
}
