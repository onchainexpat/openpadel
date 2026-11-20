import { useEffect, useRef, useState } from "preact/hooks";
import { Skeleton, ApiError, api, t } from "@kumi/ui";
import { usePreview } from "@kumi/ui";

type Game = { id: string; court: string; status: string; odds_a: number; a: string[]; b: string[]; score: { a: number; b: number } | null };
type Draw = { format: "americano" | "mexicano" | "king_of_court"; rounds: number; points_per_game: number; round_minutes: number | null };
type Night = { draw: Draw | null; format: Draw["format"] | null; rounds: { round: number; games: Game[]; sat_out: string[] }[]; standings: { name: string; points: number; games: number; top: number }[]; next_round: number | null };
const MEXICANO_POINTS = [16, 21, 24, 32];

export function Night({ id }: { id: string }) {
  const [d, setD] = useState<Night | null>(null), [error, setError] = useState<string | null>(null), [rounds, setRounds] = useState(6), [points, setPoints] = useState(24), [minutes, setMinutes] = useState(12), [scores, setScores] = useState<Record<string, { a: string; b: string }>>({});
  // What's on the page is this night's: an answer for the one open before (a slow load, then another night opened) is dropped.
  const shown = useRef(id);
  const load = () => { const k = id; return api<Night>(`/staff/sessions/${k}/night`).then((x) => { if (shown.current === k) { setD(x); setError(null); } })
    .catch((e) => { if (shown.current === k) setError(e instanceof ApiError ? e.message : String(e)); }); };
  const { preview, sheet } = usePreview(load);
  // Another night opened: nothing of the last one (its rounds or its no) stays on the page while this one loads.
  useEffect(() => { shown.current = id; setD(null); setError(null); setScores({}); load(); }, [id]);
  // Nothing loaded yet: the no is the page. A refresh after a save that fails keeps what was read, with a notice.
  if (error && !d) return <main class="card"><p class="error" role="alert">{error}</p></main>;
  if (!d) return <Skeleton />;
  const score = (g: Game) => preview("game.score", { game_id: g.id, a: Number(scores[g.id]?.a ?? 0), b: Number(scores[g.id]?.b ?? 0) });
  const format = d.draw?.format ?? d.format ?? "americano";

  return (
    <main class="wide">
      <h1>{t("ui.rounds")}</h1>
      {sheet}
      {error && <p class="error" role="alert">{error}</p>}
      {d.draw && <p class="meta">{t("ui.night_format", { format: t(`format.${format}`), rounds: d.draw.rounds })}</p>}
      {!d.draw ? (
        <form class="card" onSubmit={(e) => { e.preventDefault(); preview("draw.generate", { session_id: id, rounds, ...(format === "king_of_court" ? { round_minutes: minutes } : { points_per_game: points }) }); }}>
          <p>{t("ui.no_rounds")} <span class="meta">{t(`format.${format}`)}</span></p>
          <label>{t("ui.rounds")}<input type="number" min="1" max="20" value={rounds} onInput={(e) => setRounds(Number(e.currentTarget.value))} /></label>
          {format === "mexicano" ? (
            <label>{t("ui.points")}<select value={points} onChange={(e) => setPoints(Number(e.currentTarget.value))}>{MEXICANO_POINTS.map((p) => <option value={p}>{p}</option>)}</select></label>
          ) : format === "king_of_court" ? (
            <label>{t("ui.round_minutes")}<input type="number" min="5" max="60" value={minutes} onInput={(e) => setMinutes(Number(e.currentTarget.value))} /></label>
          ) : (
            <label>{t("ui.points")}<input type="number" min="4" value={points} onInput={(e) => setPoints(Number(e.currentTarget.value))} /></label>
          )}
          <button class="primary">{t("ui.make_rounds")}</button>
        </form>
      ) : (
        <p>
          {d.next_round && <button class="primary" onClick={() => preview("draw.next_round", { session_id: id })}>{t("ui.next_round", { n: d.next_round })}</button>}{" "}
          <button onClick={() => preview("draw.repair", { session_id: id })}>{t("ui.repair")}</button>
        </p>
      )}
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
          {r.sat_out.length > 0 && <p class="meta">{t("ui.sat_out", { names: r.sat_out.join(", ") })}</p>}
        </section>
      ))}
      {d.standings.length > 0 && (
        <section class="card"><h2>{t("ui.standings")}</h2>
          <table><tbody>{d.standings.map((s, i) => <tr><td>{i + 1}</td><td>{s.name}</td><td>{s.points}</td>
            <td class="meta">{t("count.games", { count: s.games })}{format === "king_of_court" && s.top > 0 ? ` · ${t("ui.top_court_wins", { count: s.top })}` : ""}</td></tr>)}</tbody></table>
        </section>
      )}
    </main>
  );
}
