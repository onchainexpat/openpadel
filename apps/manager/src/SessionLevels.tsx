// Levels after a session: everyone who had a place, each with a new level to set (or left as it is), and one reason.
import { useEffect, useState } from "preact/hooks";
import { ApiError, api, lang, t, usePreview } from "@kumi/ui";

type S = { session: { id: string; name: string; when: string; started: boolean; status: string; program_id: string };
  players: { person_id: string; name: string; level: string | null; floor: string | null; provisional: boolean | null; came: boolean | null }[]; absent: number };

export function SessionLevels({ id }: { id: string }) {
  const [d, setD] = useState<S | null>(null), [error, setError] = useState<string | null>(null), [levels, setLevels] = useState<Record<string, string>>({}), [reason, setReason] = useState("");
  const load = () => api<S>(`/staff/sessions/${id}/levels`).then((x) => { setD(x); setLevels(Object.fromEntries(x.players.map((p) => [p.person_id, p.level ?? ""]))); setReason(""); setError(null); }).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [id, lang.value]);
  if (error) return <main class="card"><p class="error">{error}</p></main>;
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const submit = (e: Event) => {
    e.preventDefault();
    const rows = d.players.filter((p) => levels[p.person_id]).map((p) => ({ person_id: p.person_id, level: Number(levels[p.person_id]) }));
    preview("level.set_session", { session_id: id, reason: reason.trim(), levels: rows });
  };
  return (
    <main>
      <p><a href={`/programs/${d.session.program_id}`}>{d.session.name}</a></p>
      <h1>{t("ui.set_levels_title", { program: d.session.name, when: d.session.when })}</h1>
      <p class="meta">{t("ui.set_levels_help")}</p>
      {sheet}
      {!d.session.started && <p class="card">{t("error.session_not_started")}</p>}
      {d.absent > 0 && <p class="meta">{t("ui.levels_absent", { count: d.absent })}</p>}
      {!d.players.length ? <p class="card">{t("ui.no_players_session")}</p> : <form class="card" onSubmit={submit}>
        {d.players.map((p) => <label>{p.name}{" "}<span class="meta">{p.level ?? t("ui.no_level_yet")}{p.floor ? ` · ${t("ui.floor", { floor: p.floor })}` : ""}{p.came ? ` · ${t("ui.marked_came")}` : ""}</span>
          <input type="number" step="0.01" min="0" max="7" value={levels[p.person_id] ?? ""} onInput={(e) => setLevels({ ...levels, [p.person_id]: e.currentTarget.value })} /></label>)}
        <label>{t("ui.reason_for_them")}<input required value={reason} onInput={(e) => setReason(e.currentTarget.value)} /></label>
        <button class="primary" disabled={!d.session.started || reason.trim().length < 3}>{t("ui.levels_to_change")}</button>
      </form>}
    </main>
  );
}
