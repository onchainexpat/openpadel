import { useEffect, useState } from "preact/hooks";
import { api, ApiError, lang, me, t, usePreview, clubTime } from "@kumi/ui";
import type { Key } from "@kumi/i18n";
import { moveOf } from "./level_moves.ts";

type Platform = { key: string; min: number; max: number; whole: boolean; conf: "reliability" | "matches" | "wpr" | "percent" | null; converts: boolean; self: boolean };
/** A level brought from another app (level_claims.ts), as the player and staff see it. */
export type Claim = { id: string; platform: string; shown: string; start_level: number | null; status: "waiting" | "standing" | "confirmed" | "rejected"; is_start: boolean;
  profile_url: string | null; proof: "none" | "kept" | "deleted"; answer: string | null; created_at: string; can_remove: boolean };
export type L = { rating: { level: string; provisional: boolean; floor: string | null; floor_since?: string | null; rated_games: number } | null;
  events: { at: string; kind: string; level_before: string | null; level_after: string; explanation: string }[];
  self_adjust: { can: boolean; used: number; games: number; played: number; max: number; floor: number | null };
  review: { open: { created_at: string; note: string | null; kind: string; claim: { platform: string } | null } | null; next_at: string | null; every: number };
  // A starting level brought from another app (level_import.ts), every level brought (claims), and what they can still do.
  import: { at: string; level: number; platform: string; explanation: string; claim_id: string | null } | null; can_remove: boolean; can_claim: boolean; games: number; line: number;
  platforms: Platform[]; claims: Claim[] };

/** Where the number is in the other app: a phone with a profile page, the level and how sure the app is marked. Drawn
 *  plainly, like no app in particular; the words under it say where to look in that app. */
function WhereToLook({ p }: { p: Platform }) {
  const label = t("ui.level_where_picture");
  return (
    <figure class="level-where">
      <svg viewBox="0 0 120 190" width="96" height="152" role="img" aria-label={label}>
        <rect x="4" y="4" width="112" height="182" rx="16" fill="var(--card)" stroke="var(--line)" stroke-width="3" />
        <circle cx="60" cy="40" r="14" fill="var(--line)" />
        <rect x="32" y="62" width="56" height="7" rx="3.5" fill="var(--line)" />
        <rect x="20" y="84" width="80" height="34" rx="8" fill="none" stroke="var(--brand)" stroke-width="3" />
        <text x="60" y="106" text-anchor="middle" font-size="13" font-weight="700" fill="var(--brand-ink)">{t("ui.level_picture_level")}</text>
        {p.conf && <><rect x="28" y="128" width="64" height="18" rx="9" fill="none" stroke="var(--brand)" stroke-width="2" stroke-dasharray="4 3" />
          <text x="60" y="141" text-anchor="middle" font-size="9" fill="var(--brand-ink)">{t("ui.level_picture_sure")}</text></>}
        <rect x="32" y="158" width="56" height="6" rx="3" fill="var(--line)" />
      </svg>
      <figcaption><strong>{t("ui.level_where_title")}</strong><br />{t(`ui.level_where.${p.key}` as Key)}</figcaption>
    </figure>
  );
}

/** A screenshot as base64 for the server (it checks what the file is from its first bytes). */
const asBase64 = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, "")); r.onerror = () => no(r.error); r.readAsDataURL(f); });

/** Their level on another app, as it shows there: the app, the number, how sure the app says it is, and if they like a
 *  link to their profile there and a screenshot. With `name`, a parent brings their junior's, inside the junior's level
 *  on Family. Apps they already brought aren't offered again. */
export function BringLevel({ d, send, name, forId }: { d: L; send: (input: Record<string, unknown>) => void; name?: string; forId?: string }) {
  const used = new Set(d.claims.filter((c) => c.status !== "rejected").map((c) => c.platform));
  const offered = d.platforms.filter((x) => !used.has(x.key));
  const [key, setKey] = useState(offered[0]?.key ?? "playtomic"), [value, setValue] = useState(""), [conf, setConf] = useState(""), [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const p = offered.find((x) => x.key === key) ?? offered[0];
  if (!p) return null;
  const confInput = p.conf === "wpr" ? { wpr: conf || undefined } : p.conf && conf !== "" ? { [p.conf]: Math.round(Number(conf)) } : {};
  const Wrap = name ? "div" : "section", H = name ? "h3" : "h2";
  const go = async () => {
    setBusy(true); setError(null);
    try {
      // The screenshot goes first, sealed on the server; the change names it.
      const proof = file ? (await api<{ proof_id: string }>(`/my/level/proof${forId ? `?for=${encodeURIComponent(forId)}` : ""}`, { data: await asBase64(file) })).proof_id : undefined;
      send({ platform: p.key, value: Number(value.replace(",", ".")), ...confInput, ...(url.trim() ? { profile_url: url.trim() } : {}), ...(proof ? { proof_id: proof } : {}) });
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Wrap class={name ? undefined : "card"}>
      <H>{name ? t("ui.bring_level_title_for", { name }) : t("ui.bring_level_title")}</H>
      <p class="meta">{name ? t("ui.bring_level_help_for", { name, games: d.games, line: d.line.toFixed(2) }) : t("ui.bring_level_help", { games: d.games, line: d.line.toFixed(2) })}</p>
      <label>{t("ui.level_app")}<select value={p.key} onChange={(e) => { setKey(e.currentTarget.value); setConf(""); }}>
        {offered.map((x) => <option value={x.key}>{t(`level_source.${x.key}` as Key)}</option>)}
      </select></label>
      <WhereToLook p={p} />
      <label>{t("ui.level_there")}<input type="number" inputMode="decimal" min={p.min} max={p.max} step={p.whole ? 1 : 0.01} value={value} onInput={(e) => setValue(e.currentTarget.value)} /></label>
      {p.conf === "wpr" ? <label>{t("ui.level_wpr_conf")}<select value={conf} onChange={(e) => setConf(e.currentTarget.value)}>
          <option value=""></option><option value="HC">{t("ui.wpr_hc")}</option><option value="LC">{t("ui.wpr_lc")}</option><option value="NC">{t("ui.wpr_nc")}</option></select></label>
        : p.conf && <label>{t(p.conf === "reliability" ? "ui.level_reliability" : p.conf === "matches" ? "ui.level_matches" : "ui.level_percent")}
          <input type="number" inputMode="numeric" min="0" max={p.conf === "matches" ? 100000 : 100} step="1" value={conf} onInput={(e) => setConf(e.currentTarget.value)} /></label>}
      <label>{t("ui.level_profile")}<input type="url" inputMode="url" maxLength={300} placeholder="https://" value={url} onInput={(e) => setUrl(e.currentTarget.value)} /></label>
      <label>{t("ui.level_proof")}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} /></label>
      <p class="meta">{t("ui.level_proof_help")}</p>
      {error && <p class="error" role="alert">{error}</p>}
      <button disabled={value === "" || busy} onClick={() => void go()}>{name ? t("ui.bring_level_send_for", { name }) : t("ui.bring_level_send")}</button>
    </Wrap>
  );
}

/** Every level brought from another app: which is the start, what waits for the club, what the club said, and taking
 *  one away while it still can be. */
export function ClaimsList({ d, remove, name }: { d: L; remove: (claimId: string) => void; name?: string }) {
  if (!d.claims.length) return null;
  const H = name ? "h3" : "h2";
  return (
    <>
      <H>{name ? t("ui.level_claims_title_for", { name }) : t("ui.level_claims_title")}</H>
      {d.claims.length > 1 && <p class="meta">{t("ui.claim_best_note")}</p>}
      <ul class="plain level-claims">{d.claims.map((c) => (
        <li class="row" key={c.id}>
          <span><strong>{t(`level_source.${c.platform}` as Key)}</strong> {c.shown}
            {" · "}<span class="meta">{c.start_level !== null ? t("ui.claim_starts_at", { level: c.start_level.toFixed(2) }) : t("ui.claim_no_start")}</span>
            <br /><span class={`tag${c.is_start ? " on" : ""}`}>{c.is_start ? t("ui.claim_is_start") : t(`ui.claim_status.${c.status}`)}</span>
            {c.proof !== "none" && <span class="meta"> · {t(`ui.claim_proof.${c.proof}`)}</span>}
            {c.profile_url && <> · <a href={c.profile_url} target="_blank" rel="noopener noreferrer nofollow">{t("ui.claim_profile")}</a></>}
            {c.answer && <><br /><span class="meta">{t("ui.claim_answer", { answer: c.answer })}</span></>}</span>
          {c.can_remove && <button class="small" onClick={() => remove(c.id)}>{t("ui.remove_import")}</button>}
        </li>))}</ul>
    </>
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
      {!d.rating ? <p class="card">{t("ui.level_not_yet")}</p> : <section class="card">
        {/* Settled once the model is sure enough of it; provisional (still settling) until then (levels.ts). */}
        <span class={`tag${d.rating.provisional ? "" : " on"}`}>{t(d.rating.provisional ? "ui.provisional" : "ui.level_settled")}</span>
        <p class="big">{d.rating.level}</p>
        <p class="meta">{t("ui.rated_games", { count: d.rating.rated_games })}</p>
        {/* A floor the club set: results can't take the level below it (levels.ts shownLevel). */}
        {d.rating.floor !== null && <p class="meta">{d.rating.floor_since ? t("ui.level_floor_since", { floor: d.rating.floor, date: day(d.rating.floor_since) }) : t("ui.level_floor_line", { floor: d.rating.floor })}</p>}
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
      {(d.import || d.claims.length > 0) && <section class="card">
        {d.import && <><h2>{t("ui.level_started_from")}</h2>
          <p>{d.import.explanation}</p>
          {/* One the player brought is taken away from the list below; one staff recorded, here. */}
          {d.can_remove && !d.import.claim_id && <button class="small" onClick={() => preview("level.remove_import", { person_id: pid })}>{t("ui.remove_import")}</button>}</>}
        <ClaimsList d={d} remove={(id) => preview("level.remove_claim", { claim_id: id })} />
      </section>}
      {rv.open?.kind === "import" && rv.open.claim && <p class="card">{t("ui.level_import_waiting", { source: t(`level_source.${rv.open.claim.platform}` as Key), date: day(rv.open.created_at) })}</p>}
      {d.can_claim && !(rv.open?.kind === "import") && <BringLevel d={d} send={(input) => preview("level.claim", { person_id: pid, ...input })} />}
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
      {d.events.length > 0 && <section class="card"><h2>{t("ui.history")}</h2><ul class="plain level-moves">{d.events.map((e) => {
        const mv = moveOf(e);
        return <li><span class="level-why"><span class="meta">{when(e.at)}</span> {e.explanation}</span>
          {mv && <span class={`level-move ${mv.kind}`}>{mv.kind === "floor" ? t("ui.level_move_floor") : mv.text}</span>}</li>;
      })}</ul></section>}
      <section class="card">
        <h2>{t("ui.level_how_title")}</h2>
        <ul class="level-how">
          <li>{t("ui.level_how_score")}</li>
          <li>{t("ui.level_how_odds")}</li>
          <li>{t("ui.level_how_new")}</li>
          <li>{t("ui.level_how_teams")}</li>
          <li>{t("ui.level_how_friendly")}</li>
        </ul>
      </section>
    </main>
  );
}
