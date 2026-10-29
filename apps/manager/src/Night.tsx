import { useEffect, useState } from "preact/hooks";
import { api, t } from "./state.ts";
import { usePreview } from "./Preview.tsx";

type Game = { id: string; court: string; status: string; odds_a: number; a: string[]; b: string[]; score: { a: number; b: number } | null };
type Night = { draw: { rounds: number; points_per_game: number } | null; rounds: { round: number; games: Game[] }[]; standings: { name: string; points: number; games: number }[] };

export function Night({ id }: { id: string }) {
  const [d, setD] = useState<Night | null>(null), [rounds, setRounds] = useState(6), [points, setPoints] = useState(24), [scores, setScores] = useState<Record<string, { a: string; b: string }>>({});
  const load = () => api<Night>(`/staff/sessions/${id}/night`).then(setD);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [id]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const score = (g: Game) => preview("game.score", { game_id: g.id, a: Number(scores[g.id]?.a ?? 0), b: Number(scores[g.id]?.b ?? 0) });

  return (
    <main>
      <h1>{t("ui.rounds")}</h1>
      {sheet}
      {!d.draw ? (
        <form class="card" onSubmit={(e) => { e.preventDefault(); preview("draw.generate", { session_id: id, rounds, points_per_game: points }); }}>
          <p>{t("ui.no_rounds")}</p>
          <label>{t("ui.rounds")}<input type="number" min="1" max="20" value={rounds} onInput={(e) => setRounds(Number(e.currentTarget.value))} /></label>
          <label>{t("ui.points")}<input type="number" min="4" value={points} onInput={(e) => setPoints(Number(e.currentTarget.value))} /></label>
          <button class="primary">{t("ui.make_rounds")}</button>
        </form>
      ) : <button onClick={() => preview("draw.repair", { session_id: id })}>{t("ui.repair")}</button>}
      {d.rounds.map((r) => (
        <section class="card">
          <h2>{t("ui.round", { n: r.round })}</h2>
          {r.games.map((g) => (
            <div class="game">
              <div class="meta">{g.court} · {t("ui.odds", { a: g.odds_a, b: 100 - g.odds_a })}</div>
              <div>{g.a.join(" + ")} <span class="meta">{t("ui.vs")}</span> {g.b.join(" + ")}</div>
              {g.score ? <div><strong>{g.score.a} : {g.score.b}</strong></div> : (
                <div class="score">
                  <input inputMode="numeric" aria-label="A" value={scores[g.id]?.a ?? ""} onInput={(e) => setScores({ ...scores, [g.id]: { a: e.currentTarget.value, b: scores[g.id]?.b ?? "" } })} />
                  <input inputMode="numeric" aria-label="B" value={scores[g.id]?.b ?? ""} onInput={(e) => setScores({ ...scores, [g.id]: { a: scores[g.id]?.a ?? "", b: e.currentTarget.value } })} />
                  <button class="small" onClick={() => score(g)}>{t("ui.enter_score")}</button>
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
      {d.standings.length > 0 && (
        <section class="card"><h2>{t("ui.standings")}</h2>
          <table><tbody>{d.standings.map((s, i) => <tr><td>{i + 1}</td><td>{s.name}</td><td>{s.points}</td><td class="meta">{s.games} {t("ui.games_played")}</td></tr>)}</tbody></table>
        </section>
      )}
    </main>
  );
}
