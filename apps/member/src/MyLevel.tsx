import { useEffect, useState } from "preact/hooks";
import { api, lang, me, t, usePreview } from "@kumi/ui";

type L = { rating: { level: string; provisional: boolean; floor: string | null; rated_games: number } | null; events: { at: string; explanation: string }[];
  self_adjust: { can: boolean; used: number; games: number; played: number; max: number; floor: number | null };
  review: { open: { created_at: string; note: string | null } | null; next_at: string | null; every: number } };

/** The levels a new player can move to: round ones (every 0.05) up to `max` either way, never below a floor. */
function choices(level: number, max: number, floor: number | null): string[] {
  const out: string[] = [];
  for (let k = Math.ceil((level - max) * 20 - 1e-9); k <= Math.floor((level + max) * 20 + 1e-9); k++) {
    const v = Math.round(k * 5) / 100;
    if (Math.abs(v - level) > 1e-9 && v >= 0.5 && v <= 7 && (floor === null || v >= floor)) out.push(v.toFixed(2));
  }
  return out;
}

export function MyLevel() {
  const [d, setD] = useState<L | null>(null), [to, setTo] = useState(""), [note, setNote] = useState("");
  const load = () => api<L>("/my/level").then((x) => { setD(x); setTo(""); setNote(""); });
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const pid = me.value!.person.id, fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", o);
  const when = (iso: string) => fmt({ dateStyle: "medium" }).format(new Date(iso)), day = (iso: string) => fmt({ dateStyle: "long" }).format(new Date(iso));
  const sa = d.self_adjust, rv = d.review;
  return (
    <main>
      <h1>{t("ui.nav_level")}</h1>
      {sheet}
      {!d.rating ? <p class="card">{t("ui.level_not_yet")}</p> : <section class="card"><p class="big">{d.rating.level}</p>
        <p class="meta">{t("ui.rated_games", { count: d.rating.rated_games })}{d.rating.provisional ? ` · ${t("ui.provisional")}` : ""}</p>
        {sa.used > 0 && <p class="meta">{t("ui.self_adjusted", { amount: sa.used.toFixed(2) })}</p>}</section>}
      {d.rating && sa.can && <section class="card">
        <h2>{t("ui.self_adjust_title")}</h2>
        <p class="meta">{t("ui.self_adjust_help", { level: d.rating.level, max: sa.max.toFixed(2), games: sa.games, played: sa.played })}</p>
        <label>{t("ui.new_level")}<select value={to} onChange={(e) => setTo(e.currentTarget.value)}>
          <option value="">{d.rating.level}</option>
          {choices(Number(d.rating.level), sa.max, sa.floor).map((v) => <option value={v}>{v}</option>)}
        </select></label>
        <button disabled={!to} onClick={() => preview("level.self_adjust", { person_id: pid, level: Number(to) })}>{t("ui.move_my_level")}</button>
      </section>}
      <section class="card">
        <h2>{t("ui.review_title")}</h2>
        {rv.open ? <p>{t("ui.review_waiting", { date: day(rv.open.created_at) })}</p>
          : rv.next_at ? <p class="meta">{t("ui.review_next", { date: day(rv.next_at) })}</p>
          : <>
            <p class="meta">{t("ui.review_help", { count: rv.every })}</p>
            <label>{t("ui.review_note")}<textarea maxLength={500} value={note} onInput={(e) => setNote(e.currentTarget.value)} /></label>
            <button onClick={() => preview("level.request_review", { person_id: pid, ...(note.trim() ? { note: note.trim() } : {}) })}>{t("ui.ask_review")}</button>
          </>}
      </section>
      {d.events.length > 0 && <section class="card"><h2>{t("ui.history")}</h2><ul class="plain">{d.events.map((e) => <li><span class="meta">{when(e.at)}</span> {e.explanation}</li>)}</ul></section>}
    </main>
  );
}
