// Open matches: the Play page lists them (soonest first), and each has its own page to join, ask the
// host, pay a held place, or (for the host) answer requests and share the link.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, dollars, lang, me, shortTime, t, usePreview } from "@kumi/ui";
import { PaySheet } from "./Pay.tsx";

export type Match = {
  id: string; court: string; location: string; time_zone: string; start: string; end: string; host: string | null; host_is_me: boolean; open: boolean; rated: boolean; listed: boolean;
  level_min: string; level_max: string; outside_band: "ask" | "closed"; note: string | null; share_cents: number; spots_left: number; my_level: number | null;
  players: { name: string | null; level: number | null; host: boolean; paying: boolean }[]; can: "join" | "ask" | "closed" | null;
  me: { pending_payment_id: string | null; held_until: string | null } | null; request: { id: string; status: string } | null;
  requests: { id: string; display_name: string; level: number | null; note: string | null }[]; invite_code: string | null;
};
const band = (m: Match) => `${Number(m.level_min).toFixed(2)}-${Number(m.level_max).toFixed(2)}`;
const lv = (n: number | null) => (n === null ? t("ui.no_level_yet") : n.toFixed(2));
const when = (m: Match, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: m.time_zone, ...opts }).format(new Date(m.start));

/** The facts of a match, the same on the list and on its page. */
function Facts({ m }: { m: Match }) {
  return <>
    <p><strong>{when(m, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</strong> · {m.court}, {m.location}</p>
    <p class="meta">{t("ui.levels_band", { band: band(m) })} · {t(m.rated ? "ui.match_rated" : "ui.match_friendly")} · {t("ui.place_price", { amount: dollars(m.share_cents, lang.value) })}</p>
    <ul class="plain">{m.players.map((p) => <li>{p.name}{p.level !== null ? ` · ${p.level.toFixed(2)}` : ""}{p.host ? ` · ${t("ui.host")}` : ""}{p.paying ? ` · ${t("ui.paying")}` : ""}</li>)}
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
    </main>
  );
}

export function MatchPage({ id }: { id: string }) {
  const code = new URLSearchParams(location.search).get("code");
  const [m, setM] = useState<Match | null>(null), [error, setError] = useState<string | null>(null), [provider, setProvider] = useState("test");
  const [paying, setPaying] = useState<string | null>(null), [copied, setCopied] = useState(false);
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
        {payNow && <div class="note"><p>{t("ui.pay_to_keep", { amount: dollars(m.share_cents, lang.value), time: m.me!.held_until ? shortTime(m.me!.held_until) : "" })}</p>
          <button class="primary" onClick={() => setPaying(payNow)}>{t("ui.pay_now", { amount: dollars(m.share_cents, lang.value) })}</button></div>}
        {m.can === "join" && <button class="primary" onClick={() => preview("booking.join", { booking_id: m.id, person_id: pid })}>{t("ui.join_and_pay", { amount: dollars(m.share_cents, lang.value) })}</button>}
        {m.can === "ask" && (m.request?.status === "requested"
          ? <p class="meta">{t("ui.asked_waiting", { host: m.host ?? "" })} <button class="link" onClick={() => preview("booking.withdraw_ask", { request_id: m.request!.id })}>{t("ui.take_back")}</button></p>
          : <>
            <p class="meta">{t("ui.outside_band_can_ask", { level: lv(m.my_level), band: band(m) })}{m.request?.status === "declined" ? ` ${t("ui.host_said_no")}` : ""}</p>
            {m.request?.status !== "declined" && <button class="primary" onClick={() => preview("booking.ask", { booking_id: m.id, person_id: pid })}>{t("ui.ask_to_join")}</button>}
          </>)}
        {m.can === "closed" && <p class="meta">{t("ui.outside_band_closed", { level: lv(m.my_level), band: band(m) })}</p>}
        {!m.open && !m.me && <p class="meta">{t("ui.match_closed")}</p>}
      </section>
      {m.host_is_me && <section class="card">
        <h2>{t("ui.requests")}</h2>
        {m.requests.length === 0 ? <p class="meta">{t("ui.no_requests")}</p> : <ul class="plain">{m.requests.map((r) => (
          <li class="row"><span>{r.display_name} · {lv(r.level)}{r.note ? <><br /><span class="meta">{r.note}</span></> : null}</span>
            <span><button class="small primary" onClick={() => preview("booking.answer_ask", { request_id: r.id, approve: true })}>{t("ui.yes")}</button>{" "}
              <button class="small" onClick={() => preview("booking.answer_ask", { request_id: r.id, approve: false })}>{t("ui.no")}</button></span></li>))}</ul>}
        {m.invite_code && <p><button onClick={share}>{copied ? t("ui.link_copied") : t("ui.copy_match_link")}</button></p>}
      </section>}
    </main>
  );
}
