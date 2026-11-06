// Tournaments and leagues: enter with a friend, answer an invitation, see the next matches with their courts
// and times, enter or confirm a score, ask to move a match, and the group or league table.
import { useEffect, useState } from "preact/hooks";
import { api, clubTime, me, serverNow, t, usePreview } from "@kumi/ui";

type Fixture = { id: string; stage: string; group: number | null; round: number; a: string; b: string; a_id: string | null; b_id: string | null; status: string; court: string | null; starts_at: string | null; score: string; walkover: boolean; move_asked: string | null; game_id: string | null; game_status: string | null };
type Row = { entry: string; name: string; played: number; won: number; lost: number; points: number };
type Entry = { entry_id: string; program_id: string; program: string; kind: string; status: string; partner: string; invited_me: boolean; format: string | null; match_format: string | null;
  next: Fixture[]; played: Fixture[]; to_confirm: string[]; tables: { group: number | null; rows: Row[] }[] };
type Page = { entries: Entry[]; can_enter: { program_id: string; program: string; kind: string }[] };
type Friends = { friends: { id: string; display_name: string }[] };

export function Competitions() {
  const [d, setD] = useState<Page | null>(null), [friends, setFriends] = useState<Friends["friends"]>([]), [partner, setPartner] = useState<Record<string, string>>({});
  const [sets, setSets] = useState<Record<string, string>>({}), [note, setNote] = useState<Record<string, string>>({}), [why, setWhy] = useState<Record<string, string>>({});
  const load = () => api<Page>("/my/competitions").then(setD);
  const { preview, sheet } = usePreview(() => void load());
  useEffect(() => { void load(); api<Friends>("/my/friends").then((f) => setFriends(f.friends)).catch(() => {}); }, []);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const pid = me.value!.person.id;
  // "6-3 4-6 10-7", from this pair's side.
  const parse = (s: string) => s.trim().split(/\s+/).filter(Boolean).map((x) => { const [us, them] = x.split(/[-:]/).map(Number); return { us: us ?? 0, them: them ?? 0 }; });
  const started = (f: Fixture) => Boolean(f.starts_at) && new Date(f.starts_at!).getTime() <= serverNow();
  const line = (f: Fixture) => <>{f.a} <span class="meta">{t("ui.vs")}</span> {f.b}</>;

  return (
    <main>
      <h1>{t("ui.competitions")}</h1>
      {sheet}
      {d.can_enter.map((p) => (
        <section class="card">
          <h2>{p.program}</h2>
          <p>{t("ui.enter_with_partner_hint")}</p>
          {friends.length ? (
            <form onSubmit={(e) => { e.preventDefault(); if (partner[p.program_id]) preview("entry.invite", { program_id: p.program_id, person_id: pid, partner_id: partner[p.program_id] }); }}>
              <label>{t("ui.partner")}<select value={partner[p.program_id] ?? ""} onChange={(e) => setPartner({ ...partner, [p.program_id]: e.currentTarget.value })}>
                <option value="">{t("ui.choose")}</option>{friends.map((f) => <option value={f.id}>{f.display_name}</option>)}</select></label>
              <button class="primary" disabled={!partner[p.program_id]}>{t("action.entry.invite")}</button>
            </form>
          ) : <p class="meta"><a href="/friends">{t("ui.partner_needs_friend")}</a></p>}
        </section>
      ))}
      {d.entries.map((e) => (
        <section class="card">
          <h2>{e.program}</h2>
          {e.invited_me ? (
            <>
              <p>{t("ui.invited_by", { name: e.partner })}</p>
              <p><button class="primary" onClick={() => preview("entry.accept", { entry_id: e.entry_id, person_id: pid })}>{t("action.entry.accept")}</button>{" "}
                <button onClick={() => preview("entry.decline", { entry_id: e.entry_id, person_id: pid })}>{t("action.entry.decline")}</button></p>
            </>
          ) : <p class="meta">{e.status === "invited" ? t("ui.waiting_for_partner", { name: e.partner }) : t("ui.partner_is", { name: e.partner })}{e.match_format ? ` · ${t(`match_format.${e.match_format}` as "match_format.one_set")}` : ""}</p>}
          {e.next.length > 0 && <h3>{t("ui.next_matches")}</h3>}
          {e.next.map((f) => (
            <div class="game">
              <div>{line(f)}</div>
              <div class="meta">{f.starts_at ? `${f.court ?? ""} · ${clubTime(f.starts_at, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : f.status === "waiting" ? t("ui.match_waits") : t("ui.match_no_time")}</div>
              {f.game_status === "awaiting_confirmation" && !e.to_confirm.includes(f.game_id!) && <p class="meta">{t("ui.score_waiting_other_pair")}</p>}
              {e.to_confirm.includes(f.game_id ?? "") && (
                <p>
                  <button class="primary" onClick={() => preview("result.confirm", { game_id: f.game_id, person_id: pid })}>{t("action.result.confirm")}</button>{" "}
                  <input aria-label={t("ui.dispute_reason")} placeholder={t("ui.dispute_reason")} value={why[f.id] ?? ""} onInput={(x) => setWhy({ ...why, [f.id]: x.currentTarget.value })} />
                  <button disabled={(why[f.id] ?? "").trim().length < 3} onClick={() => preview("result.dispute", { game_id: f.game_id, person_id: pid, note: why[f.id] })}>{t("action.result.dispute")}</button>
                </p>
              )}
              {f.status === "ready" && !f.game_id && started(f) && (
                <form class="score" onSubmit={(x) => { x.preventDefault(); preview("fixture.enter", { fixture_id: f.id, person_id: pid, sets: parse(sets[f.id] ?? "") }); }}>
                  <label>{t("ui.your_score")}<input inputMode="numeric" placeholder="6-3 6-4" value={sets[f.id] ?? ""} onInput={(x) => setSets({ ...sets, [f.id]: x.currentTarget.value })} /></label>
                  <button class="small primary">{t("ui.enter_score")}</button>
                </form>
              )}
              {f.status !== "played" && !started(f) && (f.move_asked ? <p class="meta">{t("ui.move_asked")}</p> : (
                <details><summary>{t("action.fixture.ask_move")}</summary>
                  <form onSubmit={(x) => { x.preventDefault(); preview("fixture.ask_move", { fixture_id: f.id, person_id: pid, note: note[f.id] ?? "" }); }}>
                    <input aria-label={t("ui.move_why")} placeholder={t("ui.move_why")} value={note[f.id] ?? ""} onInput={(x) => setNote({ ...note, [f.id]: x.currentTarget.value })} />
                    <button class="small" aria-label={t("action.fixture.ask_move")} disabled={(note[f.id] ?? "").trim().length < 3}>{t("ui.send")}</button>
                  </form>
                </details>
              ))}
            </div>
          ))}
          {e.played.length > 0 && <><h3>{t("ui.results")}</h3><ul class="plain">{e.played.map((f) => <li>{line(f)} <strong>{f.walkover ? t("pub.walkover") : f.score}</strong></li>)}</ul></>}
          {e.tables.map((tb) => (
            <>
              <h3>{tb.group === null ? t("pub.table") : t("pub.group", { n: tb.group })}</h3>
              <table class="stack"><tbody>{tb.rows.map((r, k) => <tr><td>{k + 1}</td><td>{r.entry === e.entry_id ? <strong>{r.name}</strong> : r.name}</td><td>{t("ui.won_lost", { won: r.won, lost: r.lost })}</td>{tb.group === null && <td>{t("ui.points_count", { count: r.points })}</td>}</tr>)}</tbody></table>
            </>
          ))}
          {e.status !== "invited" || !e.invited_me ? <p><button class="small" onClick={() => preview("entry.withdraw", { entry_id: e.entry_id, person_id: pid })}>{t("action.entry.withdraw")}</button></p> : null}
        </section>
      ))}
      {!d.entries.length && !d.can_enter.length && <p class="card">{t("ui.no_competitions")}</p>}
    </main>
  );
}
