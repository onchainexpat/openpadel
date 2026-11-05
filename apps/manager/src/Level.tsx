import { useEffect, useState } from "preact/hooks";
import { api, lang, t, clubTime } from "@kumi/ui";
import { usePreview } from "@kumi/ui";

type L = { person: { id: string; display_name: string }; rating: { level: string; provisional: boolean; floor: string | null; rated_games: number } | null;
  events: { at: string; kind: string; level_before: string | null; level_after: string; explanation: string }[] };

export function Level({ id }: { id: string }) {
  const [d, setD] = useState<L | null>(null), [level, setLevel] = useState(""), [floor, setFloor] = useState(""), [reason, setReason] = useState("");
  const load = () => api<L>(`/staff/people/${id}/level`).then(setD);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [id, lang.value]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const when = (iso: string) => clubTime(iso, { dateStyle: "medium" });
  return (
    <main>
      <h1>{t("ui.level_title", { name: d.person.display_name })}</h1>
      {d.rating && <section class="card"><p class="big">{d.rating.level}</p>
        <p class="meta">{t("ui.rated_games", { count: d.rating.rated_games })}{d.rating.provisional ? ` · ${t("ui.provisional")}` : ""}{d.rating.floor ? ` · ${t("ui.floor", { floor: d.rating.floor })}` : ""}</p></section>}
      {sheet}
      <form class="card" onSubmit={(e) => e.preventDefault()}>
        <label>{t("ui.note")}<input required value={reason} onInput={(e) => setReason(e.currentTarget.value)} /></label>
        <label>{t("ui.new_level")}<input type="number" step="0.01" min="0" max="7" value={level} onInput={(e) => setLevel(e.currentTarget.value)} /></label>
        <button disabled={!level || reason.trim().length < 3} onClick={() => preview("level.set", { person_id: id, level: Number(level), reason })}>{t("ui.change_level")}</button>
        <label>{t("ui.set_floor")}<input type="number" step="0.01" min="0" max="7" value={floor} onInput={(e) => setFloor(e.currentTarget.value)} /></label>
        <button disabled={!floor || reason.trim().length < 3} onClick={() => preview("level.set_floor", { person_id: id, floor: Number(floor), reason })}>{t("ui.set_floor")}</button>
      </form>
      <section class="card"><h2>{t("ui.history")}</h2>
        <ul class="plain">{d.events.map((e) => <li><span class="meta">{when(e.at)}</span> {e.explanation}</li>)}</ul></section>
    </main>
  );
}
