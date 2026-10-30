// Open matches: the Play page lists them (soonest first), and each has its own page to join, ask the
// host, pay a held place, say you can't make it or are running late, or (for the host) answer requests,
// save places for friends (each has added the other), share the link and mark who didn't come.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, dollars, lang, me, shortTime, t, usePreview } from "@kumi/ui";
import { PaySheet } from "./Pay.tsx";

export type Match = {
  id: string; court: string; location: string; time_zone: string; start: string; end: string; host: string | null; host_is_me: boolean; open: boolean; cancelled: boolean; rated: boolean; listed: boolean;
  level_min: string; level_max: string; outside_band: "ask" | "closed"; note: string | null; share_cents: number; spots_left: number; my_level: number | null;
  players: { id?: string; name: string | null; level: number | null; host: boolean; paying: boolean; saved: boolean; leaving: boolean; no_show?: boolean; record?: Rec }[];
  can: "join" | "ask" | "closed" | null; started: boolean; late_window: boolean; no_show_window: boolean;
  me: { pending_payment_id: string | null; held_until: string | null; leaving: boolean; saved: boolean } | null; request: { id: string; status: string } | null;
  requests: { id: string; display_name: string; level: number | null; note: string | null; record: Rec }[]; invite_code: string | null;
  result: { id: string; status: string; sets: { a: number; b: number }[]; a: string[]; b: string[]; confirm_by: string | null; rated: boolean; my_side: "a" | "b" | null; can_confirm: boolean; can_dispute: boolean } | null;
  teams: { a: { name: string }[]; b: { name: string }[]; odds: string } | null; can_score: boolean; four: { person_id: string; name: string }[];
  stakes: { now: number; win: number; lose: number } | null;
};
type Rec = { no_shows: number; late_leaves: number };
/** "1 no-show, 2 late cancellations (90 days)", or nothing for a clean record. */
const recText = (r?: Rec) => (r && (r.no_shows || r.late_leaves) ? t("ui.player_record", { no_shows: r.no_shows, late: r.late_leaves }) : "");
const band = (m: Match) => `${Number(m.level_min).toFixed(2)}-${Number(m.level_max).toFixed(2)}`;
const lv = (n: number | null) => (n === null ? t("ui.no_level_yet") : n.toFixed(2));
const when = (m: Match, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: m.time_zone, ...opts }).format(new Date(m.start));

/** The facts of a match, the same on the list and on its page. */
function Facts({ m }: { m: Match }) {
  return <>
    <p><strong>{when(m, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</strong> · {m.court}, {m.location}</p>
    <p class="meta">{t("ui.levels_band", { band: band(m) })} · {t(m.rated ? "ui.match_rated" : "ui.match_friendly")} · {t("ui.place_price", { amount: dollars(m.share_cents, lang.value) })}</p>
    <ul class="plain">{m.players.map((p) => <li>{p.name}{p.level !== null ? ` · ${p.level.toFixed(2)}` : ""}{p.host ? ` · ${t("ui.host")}` : ""}{p.paying ? ` · ${t("ui.paying")}` : ""}
      {p.saved ? ` · ${t("ui.place_saved_for")}` : ""}{p.leaving ? ` · ${t("ui.cant_make_it_tag")}` : ""}{p.no_show ? ` · ${t("ui.didnt_come")}` : ""}
      {recText(p.record) && <span class="meta"> · {recText(p.record)}</span>}</li>)}
      {Array.from({ length: m.spots_left }, () => <li class="meta">{t("ui.open_place")}</li>)}</ul>
  </>;
}

export function Play() {
  const [rows, setRows] = useState<Match[] | null>(null);
  useEffect(() => { api<Match[]>("/open-matches").then(setRows); }, [lang.value]);
  if (!rows) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const level = rows[0]?.my_level;
  return (
    <main>
      <h1>{t("ui.nav_play")}</h1>
      {rows.length > 0 && <p class="meta">{t("ui.your_level_is", { level: lv(level ?? null) })}</p>}
      {rows.length === 0 && <p class="card">{t("ui.no_open_matches")}</p>}
      {rows.map((m) => (
        <section class="card">
          <Facts m={m} />
          <a href={`/match/${m.id}`}>{m.can === "join" ? t("ui.see_and_join") : m.can === "ask" ? t("ui.see_and_ask") : t("ui.see_match")}</a>
        </section>
      ))}
      <p class="meta">{t("ui.open_your_own")}</p>
      <p><a href="/friends">{t("ui.see_friends")}</a></p>
    </main>
  );
}

export function MatchPage({ id }: { id: string }) {
  const code = new URLSearchParams(location.search).get("code");
  const [m, setM] = useState<Match | null>(null), [error, setError] = useState<string | null>(null), [provider, setProvider] = useState("test");
  const [paying, setPaying] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const [q, setQ] = useState(""), [found, setFound] = useState<{ id: string; display_name: string }[]>([]);
  const find = async (v: string) => { setQ(v); setFound(v.trim().length > 1 ? await api(`/my/friends/find?q=${encodeURIComponent(v)}`) : []); };
  const load = () => api<Match>(`/matches/${id}${code ? `?code=${encodeURIComponent(code)}` : ""}`).then(setM).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  const { preview, sheet } = usePreview((r?: { payment_id?: string }) => { if (r?.payment_id) setPaying(r.payment_id); void load(); });
  useEffect(() => { void load(); api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {}); }, [id, lang.value]);
  if (error) return <main class="card"><p class="error">{error}</p></main>;
  if (!m) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const pid = me.value!.person.id, payNow = m.me?.pending_payment_id;
  const share = async () => { await navigator.clipboard?.writeText(`${location.origin}/join/${m.invite_code}`).catch(() => {}); setCopied(true); };
  return (
    <main>
      <h1>{m.host_is_me ? t("ui.your_match") : t("ui.match_by", { host: m.host ?? "" })}</h1>
      {sheet}
      {paying && <PaySheet paymentId={paying} amountCents={m.share_cents} name={m.court} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); void load(); }} />}
      {paying && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => { await api(`/dev/payments/${paying}/settle`, {}); setPaying(null); void load(); }}>{t("ui.pay_test")}</button></p>}
      <section class="card">
        <Facts m={m} />
        {m.note && <p>{m.note}</p>}
        {payNow && <div class="note"><p>{m.me!.held_until ? t("ui.pay_to_keep", { amount: dollars(m.share_cents, lang.value), time: shortTime(m.me!.held_until) })
          : t("ui.place_saved_for_you", { host: m.host ?? "", amount: dollars(m.share_cents, lang.value) })}</p>
          <button class="primary" onClick={() => setPaying(payNow)}>{t("ui.pay_now", { amount: dollars(m.share_cents, lang.value) })}</button></div>}
        {m.can === "join" && <button class="primary" onClick={() => preview("booking.join", { booking_id: m.id, person_id: pid })}>{t("ui.join_and_pay", { amount: dollars(m.share_cents, lang.value) })}</button>}
        {m.can === "ask" && (m.request?.status === "requested"
          ? <p class="meta">{t("ui.asked_waiting", { host: m.host ?? "" })} <button class="link" onClick={() => preview("booking.withdraw_ask", { request_id: m.request!.id })}>{t("ui.take_back")}</button></p>
          : <>
            <p class="meta">{t("ui.outside_band_can_ask", { level: lv(m.my_level), band: band(m) })}{m.request?.status === "declined" ? ` ${t("ui.host_said_no")}` : ""}</p>
            {m.request?.status !== "declined" && <button class="primary" onClick={() => preview("booking.ask", { booking_id: m.id, person_id: pid })}>{t("ui.ask_to_join")}</button>}
          </>)}
        {m.can === "closed" && <p class="meta">{t("ui.outside_band_closed", { level: lv(m.my_level), band: band(m) })}</p>}
        {m.cancelled ? <p class="meta">{t("ui.match_cancelled")}</p> : !m.open && !m.me && <p class="meta">{t("ui.match_closed")}</p>}
        {m.me && m.me.leaving && <p class="meta">{t("ui.you_cant_make_it")}</p>}
        {m.me && m.late_window && !m.me.leaving && <div class="chips" role="group" aria-label={t("ui.running_late")}><span class="meta">{t("ui.running_late")}:</span>
          {[5, 10, 15, 20].map((n) => <button type="button" class="chip" onClick={() => preview("booking.running_late", { booking_id: m.id, person_id: pid, minutes: n })}>{t("ui.minutes", { count: n })}</button>)}</div>}
        {m.me && !m.cancelled && !m.host_is_me && !m.me.leaving && !m.started && <p><button onClick={() => preview("booking.leave", { booking_id: m.id, person_id: pid })}>{t("ui.cant_make_it")}</button></p>}
      </section>
      <Result m={m} preview={preview} />
      {m.host_is_me && !m.cancelled && <section class="card">
        <h2>{t("ui.requests")}</h2>
        {m.requests.length === 0 ? <p class="meta">{t("ui.no_requests")}</p> : <ul class="plain">{m.requests.map((r) => (
          <li class="row"><span>{r.display_name} · {lv(r.level)}{recText(r.record) ? <span class="meta"> · {recText(r.record)}</span> : null}{r.note ? <><br /><span class="meta">{r.note}</span></> : null}</span>
            <span><button class="small primary" onClick={() => preview("booking.answer_ask", { request_id: r.id, approve: true })}>{t("ui.yes")}</button>{" "}
              <button class="small" onClick={() => preview("booking.answer_ask", { request_id: r.id, approve: false })}>{t("ui.no")}</button></span></li>))}</ul>}
        {m.invite_code && <p><button onClick={share}>{copied ? t("ui.link_copied") : t("ui.copy_match_link")}</button></p>}
      </section>}
      {m.host_is_me && m.open && m.spots_left > 0 && <section class="card card-form">
        <h2>{t("ui.save_place_title")}</h2>
        <p class="meta">{t("ui.save_place_hint")}</p>
        <label>{t("ui.search_friends")}<input type="search" value={q} onInput={(e) => find(e.currentTarget.value)} /></label>
        {found.length > 0 && <ul class="plain">{found.map((f) => <li class="row"><span>{f.display_name}</span>
          <button class="small" onClick={() => { setFound([]); setQ(""); void preview("booking.save_place", { booking_id: m.id, person_id: f.id }); }}>{t("ui.save_place")}</button></li>)}</ul>}
        {m.players.filter((p) => p.saved && p.id).map((p) => <p class="row"><span>{p.name} · {t("ui.place_saved_for")}</span>
          <button class="small" onClick={() => preview("booking.drop_saved_place", { booking_player_id: p.id })}>{t("ui.stop_saving")}</button></p>)}
        <p><a href="/friends">{t("ui.find_friends")}</a></p>
      </section>}
      {m.host_is_me && m.no_show_window && <section class="card">
        <h2>{t("ui.who_came")}</h2>
        <ul class="plain">{m.players.filter((p) => !p.host && p.id).map((p) => <li class="row"><span>{p.name}</span>
          {p.no_show ? <span class="meta">{t("ui.didnt_come")}</span> : <button class="small" onClick={() => preview("booking.mark_no_show", { booking_player_id: p.id })}>{t("ui.mark_didnt_come")}</button>}</li>)}</ul>
      </section>}
    </main>
  );
}

/** The score: fair teams before it's played, the form to enter it, and then confirming or disputing it. */
function Result({ m, preview }: { m: Match; preview: (a: string, i: unknown) => Promise<void> }) {
  const pid = me.value!.person.id, others = m.four.filter((p) => p.person_id !== pid);
  const [partner, setPartner] = useState(""), [sets, setSets] = useState([["", ""], ["", ""], ["", ""]]), [note, setNote] = useState(""), [disputing, setDisputing] = useState(false);
  const pair = (names: string[]) => names.join(" & ");
  const r = m.result;
  if (!r && !m.can_score && !m.teams && !m.stakes) return null;
  const filled = sets.filter(([us, them]) => us !== "" && them !== "").map(([us, them]) => ({ us: Number(us), them: Number(them) }));
  return (
    <section class="card card-form">
      <h2>{t("ui.score")}</h2>
      {!r && m.teams && <p class="meta">{t("ui.fair_teams", { a: pair(m.teams.a.map((p) => p.name)), b: pair(m.teams.b.map((p) => p.name)), odds: m.teams.odds })}</p>}
      {!r && m.stakes && <p class="meta">{t("ui.level_stakes", { now: m.stakes.now.toFixed(2), win: m.stakes.win.toFixed(2), lose: m.stakes.lose.toFixed(2) })}</p>}
      {r && <>
        <p><strong>{pair(r.a)} {r.sets.map((s) => `${s.a}-${s.b}`).join(" ")} {pair(r.b)}</strong></p>
        <p class="meta">{r.status === "awaiting_confirmation" ? t("ui.score_waiting", { names: pair(r.b), time: r.confirm_by ? shortTime(r.confirm_by) : "" })
          : r.status === "confirmed" ? t(r.rated ? "ui.score_confirmed_rated" : "ui.score_confirmed_friendly") : t("ui.score_disputed")}
          {r.status === "confirmed" && r.rated && <> <a href="/level">{t("ui.see_my_level")}</a></>}</p>
        {r.can_confirm && <button class="primary" onClick={() => preview("result.confirm", { game_id: r.id, person_id: pid })}>{t("ui.confirm_score")}</button>}{" "}
        {r.can_dispute && !disputing && <button onClick={() => setDisputing(true)}>{t("ui.dispute_score")}</button>}
        {disputing && r.can_dispute && <>
          <label>{t("ui.dispute_why")}<input value={note} maxLength={300} onInput={(e) => setNote(e.currentTarget.value)} /></label>
          <button disabled={note.trim().length < 3} onClick={() => preview("result.dispute", { game_id: r.id, person_id: pid, note: note.trim() })}>{t("ui.preview")}</button>
        </>}
      </>}
      {!r && m.can_score && <>
        <label>{t("ui.played_with")}<select value={partner} onChange={(e) => setPartner(e.currentTarget.value)}><option value="">{t("ui.choose")}</option>
          {others.map((p) => <option value={p.person_id}>{p.name}</option>)}</select></label>
        {sets.map(([us, them], k) => <div class="court-row" role="group" aria-label={t("ui.set_n", { n: k + 1 })}>
          <label>{t("ui.set_us", { n: k + 1 })}<input type="number" min={0} max={99} inputMode="numeric" value={us} onInput={(e) => setSets(sets.map((x, j) => (j === k ? [e.currentTarget.value, x[1]!] : x)))} /></label>
          <label>{t("ui.set_them", { n: k + 1 })}<input type="number" min={0} max={99} inputMode="numeric" value={them} onInput={(e) => setSets(sets.map((x, j) => (j === k ? [x[0]!, e.currentTarget.value] : x)))} /></label></div>)}
        <button class="primary" disabled={!partner || !filled.length} onClick={() => preview("result.enter", { booking_id: m.id, person_id: pid, partner_id: partner, sets: filled })}>{t("ui.preview")}</button>
      </>}
    </section>
  );
}
