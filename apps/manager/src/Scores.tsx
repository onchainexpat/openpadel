// Scores from court bookings and open matches: the disputed ones first, for the club to keep, correct or set
// aside, then the last two weeks' with what each side said.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, lang, t, usePreview } from "@kumi/ui";

type Score = { id: string; status: string; rated: boolean; played_at: string; court: string; time_zone: string; sets: { a: number; b: number }[]; a: string[]; b: string[];
  answers: { answer: string; note: string | null; at: string; display_name: string | null }[] };

export function Scores() {
  const [rows, setRows] = useState<Score[] | null>(null);
  const load = () => api<Score[]>("/staff/scores").then(setRows);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { void load(); }, []);
  if (!rows) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const when = (s: Score) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: s.time_zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(s.played_at));
  return (
    <main>
      <h1>{t("ui.nav_scores")}</h1>
      {sheet}
      {rows.length === 0 && <p class="card">{t("ui.no_scores")}</p>}
      {rows.map((s) => (
        <section class="card">
          <p><strong>{s.a.join(" & ")} {s.sets.map((x) => `${x.a}-${x.b}`).join(" ")} {s.b.join(" & ")}</strong>{s.status === "disputed" && <> <span class="badge warn">{t("ui.disputed")}</span></>}</p>
          <p class="meta">{s.court} · {when(s)} · {t(s.rated ? "ui.match_rated" : "ui.match_friendly")} · {t(`ui.score_status_${s.status}` as Key)}</p>
          <ul class="plain">{s.answers.map((a) => <li class="meta">{a.display_name ?? "Kumi"}: {t(`ui.answer_${a.answer}` as Key)}{a.note ? ` ("${a.note}")` : ""}</li>)}</ul>
          {s.status === "disputed" && <Decide s={s} send={preview} />}
        </section>
      ))}
    </main>
  );
}

function Decide({ s, send }: { s: Score; send: (a: string, i: unknown) => Promise<void> }) {
  const [fixing, setFixing] = useState(false), [sets, setSets] = useState(s.sets.map((x) => [String(x.a), String(x.b)]).concat([["", ""]]).slice(0, 3));
  const filled = sets.filter(([a, b]) => a !== "" && b !== "").map(([a, b]) => ({ a: Number(a), b: Number(b) }));
  return <>
    <p><button class="small primary" onClick={() => send("result.resolve", { game_id: s.id, outcome: "keep" })}>{t("ui.keep_score")}</button>{" "}
      <button class="small" onClick={() => setFixing(!fixing)}>{t("ui.correct_score")}</button>{" "}
      <button class="small" onClick={() => send("result.resolve", { game_id: s.id, outcome: "set_aside" })}>{t("ui.set_aside_score")}</button></p>
    {fixing && <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("result.resolve", { game_id: s.id, outcome: "correct", sets: filled }); }}>
      {sets.map(([a, b], k) => <div class="court-row">
        <label>{t("ui.set_side", { n: k + 1, side: s.a.join(" & ") })}<input type="number" min={0} value={a} onInput={(e) => setSets(sets.map((x, j) => (j === k ? [e.currentTarget.value, x[1]!] : x)))} /></label>
        <label>{t("ui.set_side", { n: k + 1, side: s.b.join(" & ") })}<input type="number" min={0} value={b} onInput={(e) => setSets(sets.map((x, j) => (j === k ? [x[0]!, e.currentTarget.value] : x)))} /></label></div>)}
      <button disabled={!filled.length}>{t("ui.preview")}</button>
    </form>}
  </>;
}
