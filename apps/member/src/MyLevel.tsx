import { useEffect, useState } from "preact/hooks";
import { api, lang, me, t, usePreview, clubTime } from "@kumi/ui";
import type { Key } from "@kumi/i18n";

type Platform = { key: string; min: number; max: number; whole: boolean; conf: "reliability" | "matches" | "wpr" | "percent" | null; converts: boolean };
export type L = { rating: { level: string; provisional: boolean; floor: string | null; rated_games: number } | null; events: { at: string; explanation: string }[];
  self_adjust: { can: boolean; used: number; games: number; played: number; max: number; floor: number | null };
  review: { open: { created_at: string; note: string | null; kind: string; claim: { platform: string } | null } | null; next_at: string | null; every: number };
  // A starting level brought from another app (level_import.ts), and what they can still do with it.
  import: { at: string; level: number; platform: string; explanation: string } | null; can_remove: boolean; can_claim: boolean; games: number; line: number; platforms: Platform[] };

/** Their level on another app, as it shows there: the app, the number, and how sure the app says it is. With
 *  `name`, a parent brings their junior's, inside the junior's level on Family. */
export function BringLevel({ d, send, name }: { d: L; send: (input: Record<string, unknown>) => void; name?: string }) {
  const [key, setKey] = useState("playtomic"), [value, setValue] = useState(""), [conf, setConf] = useState("");
  const p = d.platforms.find((x) => x.key === key) ?? d.platforms[0]!;
  const confInput = p.conf === "wpr" ? { wpr: conf || undefined } : p.conf && conf !== "" ? { [p.conf]: Math.round(Number(conf)) } : {};
  const Wrap = name ? "div" : "section", H = name ? "h3" : "h2";
  return (
    <Wrap class={name ? undefined : "card"}>
      <H>{name ? t("ui.bring_level_title_for", { name }) : t("ui.bring_level_title")}</H>
      <p class="meta">{name ? t("ui.bring_level_help_for", { name, games: d.games, line: d.line.toFixed(2) }) : t("ui.bring_level_help", { games: d.games, line: d.line.toFixed(2) })}</p>
      <label>{t("ui.level_app")}<select value={key} onChange={(e) => { setKey(e.currentTarget.value); setConf(""); }}>
        {d.platforms.map((x) => <option value={x.key}>{t(`level_source.${x.key}` as Key)}</option>)}
      </select></label>
      <label>{t("ui.level_there")}<input type="number" inputMode="decimal" min={p.min} max={p.max} step={p.whole ? 1 : 0.01} value={value} onInput={(e) => setValue(e.currentTarget.value)} /></label>
      {p.conf === "wpr" ? <label>{t("ui.level_wpr_conf")}<select value={conf} onChange={(e) => setConf(e.currentTarget.value)}>
          <option value=""></option><option value="HC">{t("ui.wpr_hc")}</option><option value="LC">{t("ui.wpr_lc")}</option><option value="NC">{t("ui.wpr_nc")}</option></select></label>
        : p.conf && <label>{t(p.conf === "reliability" ? "ui.level_reliability" : p.conf === "matches" ? "ui.level_matches" : "ui.level_percent")}
          <input type="number" inputMode="numeric" min="0" max={p.conf === "matches" ? 100000 : 100} step="1" value={conf} onInput={(e) => setConf(e.currentTarget.value)} /></label>}
      <p class="meta">{t("ui.bring_level_no_photo")}</p>
      <button disabled={value === ""} onClick={() => send({ platform: key, value: Number(value.replace(",", ".")), ...confInput })}>{name ? t("ui.bring_level_send_for", { name }) : t("ui.bring_level_send")}</button>
    </Wrap>
  );
}

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
  const pid = me.value!.person.id, when = (iso: string) => clubTime(iso, { dateStyle: "medium" }), day = (iso: string) => clubTime(iso, { dateStyle: "long" });
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
      {d.import && <section class="card">
        <h2>{t("ui.level_started_from")}</h2>
        <p>{d.import.explanation}</p>
        {d.can_remove && <button class="small" onClick={() => preview("level.remove_import", { person_id: pid })}>{t("ui.remove_import")}</button>}
      </section>}
      {rv.open?.kind === "import" && rv.open.claim && <p class="card">{t("ui.level_import_waiting", { source: t(`level_source.${rv.open.claim.platform}` as Key), date: day(rv.open.created_at) })}</p>}
      {d.can_claim && !d.import && !rv.open && <BringLevel d={d} send={(input) => preview("level.claim", { person_id: pid, ...input })} />}
      <section class="card">
        <h2>{t("ui.review_title")}</h2>
        {rv.open?.kind === "import" && rv.open.claim ? <p class="meta">{t("ui.review_after_claim", { source: t(`level_source.${rv.open.claim.platform}` as Key) })}</p>
          : rv.open ? <p>{t("ui.review_waiting", { date: day(rv.open.created_at) })}</p>
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
