// A tournament or league: pair players, make the draw, put matches on the program's courts and times, enter
// scores and walkovers, and see the tables. Members ask to move a match; staff move it here.
import { useEffect, useState } from "preact/hooks";
import { api, clubTime, t, usePreview, clubMoment } from "@kumi/ui";

type Fixture = { id: string; stage: string; group: number | null; round: number; a: string; b: string; a_id: string | null; b_id: string | null; status: string; court: string | null; starts_at: string | null; score: string; walkover: boolean; move_asked: string | null; game_id: string | null; game_status: string | null };
type Row = { entry: string; name: string; played: number; won: number; lost: number; points: number; setsFor: number; setsAgainst: number; gamesFor: number; gamesAgainst: number };
type Page = { kind: "tournament" | "league"; name: string; public_names: boolean; public: boolean; competition: { format: string; match_format: string; match_minutes: number; status: string } | null;
  entries: { id: string; name: string; status: string; seed: number | null; group: number | null }[]; fixtures: Fixture[]; tables: { group: number | null; rows: Row[] }[];
  without_partner: { id: string; name: string }[]; courts: { id: string; name: string }[] };

export function Competition({ id }: { id: string }) {
  const [d, setD] = useState<Page | null>(null), [pa, setPa] = useState(""), [pb, setPb] = useState("");
  const [format, setFormat] = useState(""), [size, setSize] = useState(4), [mf, setMf] = useState("one_set"), [legs, setLegs] = useState(1);
  const [sets, setSets] = useState<Record<string, string>>({}), [court, setCourt] = useState<Record<string, string>>({}), [at, setAt] = useState<Record<string, string>>({});
  // The club's score can be final (after a dispute, say): the players can't dispute it again (fixture.score).
  const [final, setFinal] = useState<Record<string, boolean>>({});
  const load = () => api<Page>(`/staff/programs/${id}/competition`).then((x) => { setD(x); setFormat((f) => f || (x.kind === "league" ? "league" : "groups_knockout")); });
  const { preview, sheet } = usePreview(load);
  useEffect(() => { void load(); }, [id]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const parse = (s: string) => s.trim().split(/\s+/).filter(Boolean).map((x) => { const [a, b] = x.split(/[-:]/).map(Number); return { a: a ?? 0, b: b ?? 0 }; });
  const live = d.entries.filter((e) => e.status === "entered" || e.status === "invited");
  const when = (s: string) => clubTime(s, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const stages = [...new Set(d.fixtures.map((f) => `${f.stage}:${f.stage === "group" ? f.group : f.stage === "knockout" ? f.round : f.round}`))];
  const title = (k: string) => { const [stage, n] = k.split(":"); return stage === "group" ? t("pub.group", { n: Number(n) }) : t("ui.round", { n: Number(n) }); };

  return (
    <main>
      <h1>{d.name}</h1>
      {sheet}
      {d.public && <p><button class="small" onClick={() => preview("competition.public_names", { program_id: id, on: !d.public_names })}>{t(d.public_names ? "ui.public_names_off" : "ui.public_names_on")}</button></p>}
      <section class="card">
        <h2>{t("ui.pairs")}</h2>
        <ul class="plain">{live.map((e) => <li class="row"><span>{e.seed ? `${e.seed}. ` : ""}{e.name}{e.status === "invited" ? ` · ${t("ui.invited")}` : ""}{e.group ? ` · ${t("pub.group", { n: e.group })}` : ""}</span>
          <button class="small" onClick={() => preview("entry.withdraw", { entry_id: e.id })}>{t("action.entry.withdraw")}</button></li>)}</ul>
        {!d.competition && d.without_partner.length > 1 && (
          <form onSubmit={(e) => { e.preventDefault(); preview("entry.pair", { program_id: id, person_a: pa, person_b: pb }); }}>
            <label>{t("ui.player")}<select value={pa} onChange={(e) => setPa(e.currentTarget.value)}><option value="">{t("ui.choose")}</option>{d.without_partner.map((p) => <option value={p.id}>{p.name}</option>)}</select></label>
            <label>{t("ui.partner")}<select value={pb} onChange={(e) => setPb(e.currentTarget.value)}><option value="">{t("ui.choose")}</option>{d.without_partner.filter((p) => p.id !== pa).map((p) => <option value={p.id}>{p.name}</option>)}</select></label>
            <button disabled={!pa || !pb}>{t("action.entry.pair")}</button>
          </form>
        )}
        {d.without_partner.length > 0 && <p class="meta">{t("ui.without_partner", { names: d.without_partner.map((p) => p.name).join(", ") })}</p>}
      </section>
      {!d.competition ? (
        <form class="card" onSubmit={(e) => { e.preventDefault(); preview("competition.draw", { program_id: id, format, match_format: mf, ...(format === "groups_knockout" ? { group_size: size } : {}), ...(format === "league" ? { legs } : {}) }); }}>
          <h2>{t("action.competition.draw")}</h2>
          {d.kind === "tournament" && <label>{t("ui.competition_format")}<select value={format} onChange={(e) => setFormat(e.currentTarget.value)}>
            <option value="groups_knockout">{t("ui.groups_knockout")}</option><option value="knockout">{t("ui.knockout")}</option></select></label>}
          {format === "groups_knockout" && <label>{t("ui.group_size")}<select value={size} onChange={(e) => setSize(Number(e.currentTarget.value))}><option value={3}>3</option><option value={4}>4</option></select></label>}
          {format === "league" && <label>{t("ui.legs")}<select value={legs} onChange={(e) => setLegs(Number(e.currentTarget.value))}><option value={1}>{t("ui.legs_once")}</option><option value={2}>{t("ui.legs_twice")}</option></select></label>}
          <label>{t("ui.match_format")}<select value={mf} onChange={(e) => setMf(e.currentTarget.value)}>
            {["one_set", "pro_set", "best_of_three"].map((m) => <option value={m}>{t(`match_format.${m}` as "match_format.one_set")}</option>)}</select></label>
          <button class="primary">{t("action.competition.draw")}</button>
        </form>
      ) : (
        <p><button class="primary" onClick={() => preview("competition.schedule", { program_id: id })}>{t("action.competition.schedule")}</button>
          <span class="meta"> {t(`match_format.${d.competition.match_format}` as "match_format.one_set")}</span></p>
      )}
      {d.tables.map((tb) => (
        <section class="card"><h2>{tb.group === null ? t("pub.table") : t("pub.group", { n: tb.group })}</h2>
          <table class="stack"><thead><tr><th>#</th><th>{t("ui.pair")}</th><th>{t("ui.won_lost_head")}</th>{tb.group === null && <th>{t("ui.points")}</th>}<th>{t("ui.sets_games")}</th></tr></thead>
            <tbody>{tb.rows.map((r, k) => <tr><td>{k + 1}</td><td>{r.name}</td><td>{r.won}-{r.lost}</td>{tb.group === null && <td>{r.points}</td>}<td>{r.setsFor}-{r.setsAgainst} · {r.gamesFor}-{r.gamesAgainst}</td></tr>)}</tbody></table>
        </section>
      ))}
      {stages.map((k) => (
        <section class="card">
          <h2>{title(k)}</h2>
          {d.fixtures.filter((f) => `${f.stage}:${f.stage === "group" ? f.group : f.round}` === k && f.status !== "bye").map((f) => (
            <div class="game">
              <div>{f.a} <span class="meta">{t("ui.vs")}</span> {f.b} {f.score && <strong>{f.score}</strong>}{f.walkover && <strong> {t("pub.walkover")}</strong>}</div>
              <div class="meta">{f.starts_at ? `${f.court ?? ""} · ${when(f.starts_at)}` : f.status === "waiting" ? t("ui.match_waits") : t("ui.match_no_time")}
                {f.game_status === "awaiting_confirmation" ? ` · ${t("ui.score_waiting_other_pair")}` : f.game_status === "disputed" ? ` · ${t("ui.score_disputed")}` : ""}</div>
              {f.move_asked && <p class="meta">{t("ui.move_asked_note", { note: f.move_asked })}</p>}
              {(f.status === "ready" || f.status === "waiting") && d.courts.length > 0 && (
                <details><summary>{f.starts_at ? t("ui.move_match") : t("action.fixture.place")}</summary>
                  <form onSubmit={(e) => { e.preventDefault(); preview("fixture.place", { fixture_id: f.id, court_id: court[f.id] || d.courts[0]!.id, starts_at: clubMoment(at[f.id] ?? "") }); }}>
                    <label>{t("ui.court_label")}<select value={court[f.id] ?? d.courts[0]!.id} onChange={(e) => setCourt({ ...court, [f.id]: e.currentTarget.value })}>{d.courts.map((c) => <option value={c.id}>{c.name}</option>)}</select></label>
                    <label>{t("ui.starts")}<input type="datetime-local" required value={at[f.id] ?? ""} onInput={(e) => setAt({ ...at, [f.id]: e.currentTarget.value })} /></label>
                    <button class="small">{t("ui.save")}</button>
                  </form>
                </details>
              )}
              {f.status === "ready" && !f.game_id && (
                <div class="score">
                  <input inputMode="numeric" aria-label={t("ui.score")} placeholder="6-3" value={sets[f.id] ?? ""} onInput={(e) => setSets({ ...sets, [f.id]: e.currentTarget.value })} />
                  <label class="check"><input type="checkbox" checked={final[f.id] ?? false} onChange={(e) => setFinal({ ...final, [f.id]: e.currentTarget.checked })} /> {t("ui.score_final")}</label>
                  <button class="small" onClick={() => preview("fixture.score", { fixture_id: f.id, sets: parse(sets[f.id] ?? ""), final: final[f.id] ?? false })}>{t("ui.enter_score")}</button>
                  {f.a_id && <button class="small" onClick={() => preview("fixture.walkover", { fixture_id: f.id, given_by: f.a_id })}>{t("ui.walkover_by", { pair: f.a })}</button>}
                  {f.b_id && <button class="small" onClick={() => preview("fixture.walkover", { fixture_id: f.id, given_by: f.b_id })}>{t("ui.walkover_by", { pair: f.b })}</button>}
                </div>
              )}
              {(f.status === "played" || f.status === "walkover" || f.game_id) && (
                // A wrong result (a typo, a loss confirmed by mistake) taken back, with what it led to: the preview lists it all.
                <button class="small" onClick={() => preview("fixture.reopen", { fixture_id: f.id })}>{t("action.fixture.reopen")}</button>
              )}
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
