import { useEffect, useState } from "preact/hooks";
import { api, clubTime, dollars, lang, mayDo, t, usePreview } from "@kumi/ui";

type Benefit = { name: string; people: number };
type Status = { has_keys: boolean; players: number; players_read_at: string | null; players_wanted_at: string | null; players_error: string | null;
  credit_cents: number; credit_people: number; wallets_brought_at: string | null; wallets_zeroed_at: string | null; memberships: number;
  benefits: Benefit[]; plans: { id: string; name: string; join_in_app: boolean }[] };
type FileRows = { rows: unknown[]; benefits: Benefit[]; problems: { line: number; text: string }[]; fatal?: string };

/** Moving in from Playtomic, the money side (brought_in.ts): wallets into club credit, memberships carried over, from
 *  Playtomic itself (its players as last read) or the club's customer export. The owner and managers. */
export function MoveIn() {
  const [s, setS] = useState<Status | null>(null), [file, setFile] = useState<FileRows | null>(null), [from, setFrom] = useState<"playtomic" | "file">("playtomic");
  const [map, setMap] = useState<Record<string, string>>({});
  const load = () => api<Status>("/staff/move-in").then((x) => { setS(x); if (!x.players_read_at) setFrom("file"); });
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  if (!s) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const fmt = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
  const pick = async (e: Event) => {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!f) return;
    const r = await api<FileRows>("/staff/move-in/file", { csv: await f.text() });
    setFile(r);
    if (!r.fatal) setFrom("file");
  };
  const src = from === "file" && file && !file.fatal ? { source: "file", players: file.rows } : { source: "playtomic" };
  const ready = from === "file" ? Boolean(file && !file.fatal && file.rows.length) : Boolean(s.players_read_at);
  const benefits = from === "file" ? (file?.benefits ?? []) : s.benefits;
  const reading = s.players_wanted_at && (!s.players_read_at || s.players_read_at < s.players_wanted_at);
  return (
    <main>
      <p><a href="/playtomic">{t("ui.mirror_title")}</a></p>
      <h1>{t("ui.movein_title")}</h1>
      <section class="card"><p>{t("ui.movein_intro")}</p></section>
      {sheet}
      <section class="card">
        <h2>{t("ui.movein_from")}</h2>
        {s.has_keys ? <>
          <p>{reading ? t("ui.movein_reading", { when: fmt(s.players_wanted_at!) }) : s.players_read_at ? t("ui.movein_read", { when: fmt(s.players_read_at), count: s.players }) : t("ui.movein_not_read")}</p>
          {s.players_error && <p class="error" role="alert">{t("ui.movein_read_failed", { error: s.players_error })}</p>}
          {!reading && mayDo("playtomic.read_players") && <button onClick={() => preview("playtomic.read_players", {})}>{t("ui.movein_read_now")}</button>}
        </> : <p class="meta">{t("ui.movein_no_keys")}</p>}
        <label>{t("ui.movein_file")}<input type="file" accept=".csv,text/csv" onChange={pick} /></label>
        {file?.fatal && <p class="error" role="alert">{file.fatal}</p>}
        {file && !file.fatal && <p>{t("count.movein_rows", { count: file.rows.length })}</p>}
        {file && file.problems.length > 0 && <><p class="meta">{t("count.lines_skipped", { count: file.problems.length })}</p><ul class="meta">{file.problems.slice(0, 20).map((p) => <li>{p.text}</li>)}</ul></>}
        {s.players_read_at && file && !file.fatal && <fieldset class="choices"><legend>{t("ui.movein_use")}</legend>
          <label><input type="radio" name="from" checked={from === "playtomic"} onChange={() => setFrom("playtomic")} /> {t("ui.movein_use_playtomic")}</label>
          <label><input type="radio" name="from" checked={from === "file"} onChange={() => setFrom("file")} /> {t("ui.movein_use_file")}</label>
        </fieldset>}
      </section>

      <section class="card">
        <h2>{t("ui.movein_wallets")}</h2>
        <p class="meta">{t("ui.movein_wallets_help")}</p>
        {s.wallets_brought_at && <p>{t("ui.movein_credit_so_far", { amount: dollars(s.credit_cents, lang.value), people: t("count.people", { count: s.credit_people }) })}</p>}
        {s.wallets_zeroed_at ? <p class="note">{t("ui.movein_zeroed", { when: fmt(s.wallets_zeroed_at) })}</p> : <>
          {mayDo("credit.bring_in") && <button class="primary" disabled={!ready} onClick={() => preview("credit.bring_in", src)}>{t("ui.preview")}</button>}
          {s.wallets_brought_at && <div class="note"><p>{t("ui.movein_zero_help")}</p>
            {mayDo("credit.brought_zeroed") && <button onClick={() => preview("credit.brought_zeroed", {})}>{t("ui.movein_zero_done")}</button>}</div>}
        </>}
      </section>

      <section class="card">
        <h2>{t("ui.movein_memberships")}</h2>
        <p class="meta">{t("ui.movein_memberships_help")}</p>
        {s.memberships > 0 && <p>{t("count.movein_kept", { count: s.memberships })}</p>}
        {benefits.length === 0 ? <p class="meta">{t("ui.movein_no_benefits")}</p> : <ul class="plain">{benefits.map((b) => (
          <li class="row"><span>{b.name} <span class="meta">{t("count.people", { count: b.people })}</span></span>
            <select aria-label={t("ui.movein_plan_for", { name: b.name })} value={map[b.name] ?? ""} onChange={(e) => setMap({ ...map, [b.name]: e.currentTarget.value })}>
              <option value="">{t("ui.movein_choose_plan")}</option>
              {s.plans.map((p) => <option value={p.id}>{p.name}</option>)}
              <option value="skip">{t("ui.movein_leave_out")}</option>
            </select></li>))}</ul>}
        {mayDo("membership.bring_in") && <button class="primary" disabled={!ready || !benefits.length} onClick={() => preview("membership.bring_in", { ...src, map: Object.fromEntries(Object.entries(map).filter(([, v]) => v)) })}>{t("ui.preview")}</button>}
      </section>
    </main>
  );
}
