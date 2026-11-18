import { useEffect, useState } from "preact/hooks";
import { api, lang, t, clubTime } from "@kumi/ui";
import { usePreview } from "@kumi/ui";
import type { Key } from "@kumi/i18n";
import { ClaimAnswer, type StaffClaim } from "./LevelClaim.tsx";

type Platform = { key: string; min: number; max: number; whole: boolean; conf: "reliability" | "matches" | "wpr" | "percent" | null; converts: boolean };
type L = { person: { id: string; display_name: string }; rating: { level: string; provisional: boolean; floor: string | null; rated_games: number } | null;
  events: { at: string; kind: string; level_before: string | null; level_after: string; explanation: string }[];
  // A starting level from another app (level_import.ts): the one standing, and whether one can still come in.
  import: { at: string; level: number; platform: string; explanation: string; claim_id: string | null } | null; can_remove: boolean; can_claim: boolean; games: number; platforms: Platform[];
  // Every level the player brought (level_claims.ts), answered here as in the Levels queue.
  claims: StaffClaim[] };

/** What staff saw in the player's app, or looked up: it starts their level, provisional, while they're new here. */
function ImportForm({ d, send }: { d: L; send: (input: Record<string, unknown>) => void }) {
  const [key, setKey] = useState("playtomic"), [value, setValue] = useState(""), [conf, setConf] = useState(""), [how, setHow] = useState("staff_seen"), [kumi, setKumi] = useState("");
  const p = d.platforms.find((x) => x.key === key) ?? d.platforms[0]!;
  const confInput = p.conf === "wpr" ? { wpr: conf || undefined } : p.conf && conf !== "" ? { [p.conf]: Math.round(Number(conf)) } : {};
  return (
    <form class="card" onSubmit={(e) => e.preventDefault()}>
      <h2>{t("ui.level_import_title")}</h2>
      <p class="meta">{t("ui.level_import_help", { games: d.games })}</p>
      <label>{t("ui.level_app")}<select value={key} onChange={(e) => { setKey(e.currentTarget.value); setConf(""); }}>
        {d.platforms.map((x) => <option value={x.key}>{t(`level_source.${x.key}` as Key)}</option>)}
      </select></label>
      <label>{t("ui.level_there")}<input type="number" inputMode="decimal" min={p.min} max={p.max} step={p.whole ? 1 : 0.01} value={value} onInput={(e) => setValue(e.currentTarget.value)} /></label>
      {p.conf === "wpr" ? <label>{t("ui.level_wpr_conf")}<select value={conf} onChange={(e) => setConf(e.currentTarget.value)}>
          <option value=""></option><option value="HC">{t("ui.wpr_hc")}</option><option value="LC">{t("ui.wpr_lc")}</option><option value="NC">{t("ui.wpr_nc")}</option></select></label>
        : p.conf && <label>{t(p.conf === "reliability" ? "ui.level_reliability" : p.conf === "matches" ? "ui.level_matches" : "ui.level_percent")}
          <input type="number" inputMode="numeric" min="0" max={p.conf === "matches" ? 100000 : 100} step="1" value={conf} onInput={(e) => setConf(e.currentTarget.value)} /></label>}
      <label>{t("ui.level_import_how")}<select value={how} onChange={(e) => setHow(e.currentTarget.value)}>
        <option value="staff_seen">{t("ui.level_import_seen")}</option><option value="public_lookup">{t("ui.level_import_lookup")}</option></select></label>
      <label>{t("ui.level_import_kumi")}<input type="number" inputMode="decimal" min="0" max="7" step="0.01" value={kumi} onInput={(e) => setKumi(e.currentTarget.value)} /></label>
      <p class="meta">{t("ui.level_import_kumi_help")}</p>
      <button type="button" disabled={value === "" || (!p.converts && kumi === "")}
        onClick={() => send({ platform: key, value: Number(value.replace(",", ".")), evidence: how, ...confInput, ...(kumi !== "" ? { start_level: Number(kumi.replace(",", ".")) } : {}) })}>{t("ui.level_import_record")}</button>
    </form>
  );
}

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
      {d.import && <section class="card"><h2>{t("ui.level_import_from")}</h2><p>{d.import.explanation}</p>
        {d.can_remove && !d.import.claim_id && <button class="small" onClick={() => preview("level.remove_import", { person_id: id })}>{t("ui.remove_import")}</button>}</section>}
      {d.claims.length > 0 && <section class="card"><h2>{t("ui.level_claims_staff")}</h2>
        <ul class="plain">{d.claims.map((c) => <li key={c.id}><strong>{t(`level_source.${c.platform}` as Key)}</strong> <span class="meta">{t(`ui.claim_status.${c.status}` as Key)}</span>
          <ClaimAnswer c={c} preview={preview} day={when} open={d.can_claim || c.status === "waiting"} /></li>)}</ul></section>}
      {d.can_claim && !d.import && <ImportForm d={d} send={(input) => preview("level.import", { person_id: id, ...input })} />}
      <section class="card"><h2>{t("ui.history")}</h2>
        <ul class="plain">{d.events.map((e) => <li><span class="meta">{when(e.at)}</span> {e.explanation}</li>)}</ul></section>
    </main>
  );
}
