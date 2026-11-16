import { useEffect, useState } from "preact/hooks";
import { api, clubTime, dollars, lang, mayDo, me, t, usePreview } from "@kumi/ui";

type Benefit = { name: string; people: number };
type Upload = { id: string; sha256: string; file_name: string | null; at: string; rows: number; uploaded_by: string | null; erased: number; wallet_columns: { ref: string; name: string }[]; problems: { line: number; text: string }[]; benefits: Benefit[] };
type Status = { has_keys: boolean; players: number; players_read_at: string | null; players_wanted_at: string | null; players_error: string | null;
  credit_cents: number; credit_people: number; wallets_brought_at: string | null; wallets_zeroed_at: string | null; wallets_zeroing_at: string | null; memberships: number; cap_needed: boolean;
  benefits: Benefit[]; upload: Upload | null; plans: { id: string; name: string; join_in_app: boolean }[] };

/** Moving in from Playtomic, the money side (brought_in.ts): wallets into club credit, memberships carried over, from
 *  Playtomic itself (its players as last read) or the club's customer export as the server read it. The owner, and a
 *  manager who asks the owner. */
export function MoveIn() {
  const [s, setS] = useState<Status | null>(null), [from, setFrom] = useState<"playtomic" | "file">("playtomic");
  const [map, setMap] = useState<Record<string, string>>({}), [off, setOff] = useState<Record<string, boolean>>({}), [takeBack, setTakeBack] = useState(false), [cap, setCap] = useState("");
  const load = () => api<Status>("/staff/move-in").then((x) => { setS(x); if (!x.players_read_at && x.upload) setFrom("file"); });
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  // Built-in roles: the owner and managers; a club's own roles, by what they may do.
  const allowed = me.value?.can ? mayDo("credit.bring_in") || mayDo("membership.bring_in") : (me.value?.roles ?? []).some((r) => r.key === "owner" || r.key === "manager");
  if (!allowed) return <main class="card"><p>{t("ui.not_for_your_role")}</p></main>;
  if (!s) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const fmt = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
  const pick = async (e: Event) => {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (f) await preview("playtomic.upload", { csv: await f.text(), file_name: f.name.slice(0, 200) });
  };
  const u = s.upload;
  const src = from === "file" && u ? { source: "file", upload_id: u.id, sha256: u.sha256 } : { source: "playtomic" };
  const ready = from === "file" ? Boolean(u) : Boolean(s.players_read_at);
  const benefits = from === "file" ? (u?.benefits ?? []) : s.benefits;
  const columns = from === "file" && u ? u.wallet_columns.filter((c) => !off[c.ref]).map((c) => c.ref) : undefined;
  const reading = s.players_wanted_at && (!s.players_read_at || s.players_read_at < s.players_wanted_at);
  return (
    <main>
      <p><a href="/settings/moving-in">{t("ui.moving_link")}</a> · <a href="/playtomic">{t("ui.mirror_title")}</a></p>
      <h1>{t("ui.movein_title")}</h1>
      <section class="card"><p>{t("ui.movein_intro")}</p></section>
      {sheet}
      <section class="card">
        <h2>{t("ui.movein_from")}</h2>
        {s.has_keys ? <>
          <p>{reading ? t("ui.movein_reading", { when: fmt(s.players_wanted_at!) }) : s.players_read_at ? t("ui.movein_read", { when: fmt(s.players_read_at), count: s.players }) : t("ui.movein_not_read")}</p>
          {s.players_error && <p class="error" role="alert">{t("ui.movein_read_failed", { error: s.players_error })}</p>}
          {!reading && <button onClick={() => preview("playtomic.read_players", {})}>{t("ui.movein_read_now")}</button>}
        </> : <p class="meta">{t("ui.movein_no_keys")}</p>}
        <label>{t("ui.movein_file")}<input type="file" accept=".csv,text/csv" onChange={pick} /></label>
        {u && <p>{t("ui.movein_upload_read", { name: u.file_name ?? "CSV", when: fmt(u.at), by: u.uploaded_by ?? "-", players: t("count.movein_rows", { count: u.rows }) })}</p>}
        {u && u.erased > 0 && <p class="meta">{t("plan.movein_erased", { count: u.erased })}</p>}
        {u && u.problems.length > 0 && <><p class="meta">{t("count.lines_skipped", { count: u.problems.length })}</p><ul class="meta">{u.problems.slice(0, 20).map((p) => <li>{p.text}</li>)}</ul></>}
        {s.players_read_at && u && <fieldset class="choices"><legend>{t("ui.movein_use")}</legend>
          <label><input type="radio" name="from" checked={from === "playtomic"} onChange={() => setFrom("playtomic")} /> {t("ui.movein_use_playtomic")}</label>
          <label><input type="radio" name="from" checked={from === "file"} onChange={() => setFrom("file")} /> {t("ui.movein_use_file")}</label>
        </fieldset>}
      </section>

      <section class="card">
        <h2>{t("ui.movein_wallets")}</h2>
        <p class="meta">{t("ui.movein_wallets_help")}</p>
        {s.wallets_brought_at && <p>{t("ui.movein_credit_so_far", { amount: dollars(s.credit_cents, lang.value), people: t("count.people", { count: s.credit_people }) })}</p>}
        {s.wallets_zeroed_at ? <p class="note">{t("ui.movein_zeroed", { when: fmt(s.wallets_zeroed_at) })}</p> : <>
          {from === "file" && u && u.wallet_columns.length > 0 && <fieldset class="choices"><legend>{t("ui.movein_columns")}</legend>
            {u.wallet_columns.map((c) => <label><input type="checkbox" checked={!off[c.ref]} onChange={(e) => { const on = e.currentTarget.checked; setOff((o) => ({ ...o, [c.ref]: !on })); }} /> {c.name}</label>)}
          </fieldset>}
          {/* Once the wallets are being emptied in Playtomic, a run only brings credit in (brought_in.ts). */}
          {s.wallets_zeroing_at ? <p class="note">{t("ui.movein_zeroing", { when: fmt(s.wallets_zeroing_at) })}</p> : <>
            <label class="check"><input type="checkbox" checked={takeBack} onChange={(e) => setTakeBack(e.currentTarget.checked)} /> {t("ui.movein_take_back")}</label>
            <p class="meta">{t("ui.movein_take_back_help")}</p>
          </>}
          {s.cap_needed && <label>{t("ui.movein_cap")}<input type="number" min="1" step="1" inputMode="numeric" value={cap} onInput={(e) => setCap(e.currentTarget.value)} />
            <span class="meta">{t("ui.movein_cap_help")}</span></label>}
          <button class="primary" disabled={!ready || (s.cap_needed && !(Number(cap) > 0))} onClick={() => preview("credit.bring_in", { ...src, ...(columns ? { columns } : {}), take_back: Boolean(takeBack && !s.wallets_zeroing_at),
            ...(s.cap_needed ? { cap: Math.round(Number(cap)) } : {}) })}>{t("ui.preview")}</button>
          {s.wallets_brought_at && <div class="note">
            {!s.wallets_zeroing_at && <><p>{t("ui.movein_zeroing_help")}</p><button onClick={() => preview("credit.brought_zeroing", {})}>{t("ui.movein_zeroing_start")}</button></>}
            <p>{t("ui.movein_zero_help")}</p>
            <button onClick={() => preview("credit.brought_zeroed", {})}>{t("ui.movein_zero_done")}</button></div>}
        </>}
      </section>

      <section class="card">
        <h2>{t("ui.movein_memberships")}</h2>
        <p class="meta">{t("ui.movein_memberships_help")}</p>
        {s.memberships > 0 && <p>{t("count.movein_kept", { count: s.memberships })}</p>}
        {benefits.length === 0 ? <p class="meta">{t("ui.movein_no_benefits")}</p> : <ul class="plain">{benefits.map((b) => (
          <li class="row"><span>{b.name} <span class="meta">{t("count.people", { count: b.people })}</span></span>
            {/* Each pick saves on its own, however quickly the next follows. */}
            <select aria-label={t("ui.movein_plan_for", { name: b.name })} value={map[b.name] ?? ""} onChange={(e) => { const v = e.currentTarget.value; setMap((m) => ({ ...m, [b.name]: v })); }}>
              <option value="">{t("ui.movein_choose_plan")}</option>
              {s.plans.map((p) => <option value={p.id}>{p.name}</option>)}
              <option value="skip">{t("ui.movein_leave_out")}</option>
            </select></li>))}</ul>}
        <button class="primary" disabled={!ready || !benefits.length} onClick={() => preview("membership.bring_in", { ...src, map: Object.fromEntries(Object.entries(map).filter(([, v]) => v)) })}>{t("ui.preview")}</button>
      </section>
    </main>
  );
}
