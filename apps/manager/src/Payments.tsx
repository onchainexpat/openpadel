// The Money page (/payments): today's takings, what's owed to the club, recent refunds and the credit members hold
// (apps/server/src/today.ts, /staff/money), Stripe's payouts to the club's bank (/staff/money/payouts, asked of Stripe
// on its own so the rest never waits on it), and where the club's card payments go (Stripe). Only the club's money
// people open it; names and links to people only for those who read people. A payment taken at the desk is the same
// record-payment action the Schedule and a program's roster use: its preview first, then confirm.
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, ApiError, clubTime, coversLocation, dollars, lang, mayDo, t, usePreview } from "@kumi/ui";
import { DeskPay } from "./DeskPay.tsx";
import { payAction } from "./money_pay.ts";
import { label } from "./words.ts";
import { nextPayout, payoutDay, type PayoutRow } from "./payouts.ts";
import { formatLocale } from "@kumi/i18n/format";

type P = { mode: "test" | "direct" | "connect"; live: boolean; account: { tail: string; charges_enabled: boolean; details_submitted: boolean } | null };
type Owed = { kind: "booking" | "place"; id: string; at: string; who: string | null; person_id: string | null; location_id: string; cents: number;
  code: string | null; court: string | null; program: string | null; program_id: string | null; session_id: string | null };
type Refund = { id: string; at: string; who: string | null; person_id: string | null; cents: number; to: string; status: string; what: { kind: string; name: string } | null };
type MoneyView = {
  now: string; time_zone: string; people: boolean;
  takings: { total_cents: number; last_week_cents: number };
  owed: { days: number; count: number; total_cents: number; rows: Owed[] };
  refunds: { days: number; week_days: number; week_count: number; week_cents: number; rows: Refund[] };
  credit: { cents: number; people: number; top: { person_id: string; name: string; cents: number }[] };
};

export function Payments() {
  const [m, setM] = useState<MoneyView | null>(null), [mError, setMError] = useState<string | null>(null), [paying, setPaying] = useState<string | null>(null);
  const loadMoney = () => api<MoneyView>("/staff/money").then((v) => { setM(v); setMError(null); }).catch((e: ApiError) => setMError(e.message));
  const { preview, sheet } = usePreview(() => { void loadMoney(); });
  useEffect(() => { void loadMoney(); }, [lang.value]);
  const money = (c: number) => dollars(c, lang.value);
  const at = (iso: string) => clubTime(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }, m?.time_zone);
  const who = (name: string | null, id: string | null) => (id ? <a href={`/people/${id}`}>{name}</a> : name ?? "");

  return (
    <main class="wide money">
      <div class="page-head"><h1>{label("ui.nav_payments")}</h1></div>
      <p class="meta">{t("ui.money_lead")}</p>
      {mError && !m && <p class="error" role="alert">{mError}</p>}
      {!m && !mError && <p>{t("ui.loading")}</p>}
      {m && <>
        <div class="money-tiles">
          <section class="card money-tile"><h2>{t("ui.money_today")}</h2><p class="today-total num">{money(m.takings.total_cents)}</p>
            <p class="meta">{t("ui.today_takings_vs", { amount: money(m.takings.last_week_cents) })}</p></section>
          <section class="card money-tile"><h2>{t("ui.money_owed")}</h2><p class="today-total num">{money(m.owed.total_cents)}</p>
            <p class="meta">{t("count.money_owed", { count: m.owed.count, days: m.owed.days })}</p></section>
          <section class="card money-tile"><h2>{t("ui.money_credit")}</h2><p class="today-total num">{money(m.credit.cents)}</p>
            <p class="meta">{t("count.money_credit_people", { count: m.credit.people })}</p></section>
          <section class="card money-tile"><h2>{t("ui.money_refunds", { days: m.refunds.week_days })}</h2><p class="today-total num">{money(m.refunds.week_cents)}</p>
            <p class="meta">{t("count.money_refunds", { count: m.refunds.week_count })}</p></section>
        </div>

        <section class="card" aria-labelledby="money-owed">
          <h2 id="money-owed">{t("ui.money_owed")}</h2>
          <p class="meta">{t("ui.money_owed_help", { days: m.owed.days })}</p>
          {m.owed.rows.length === 0 ? <p class="meta">{t("ui.money_owed_none")}</p> : <div class="table-scroll"><table class="stack">
            <thead><tr><th>{t("ui.col_when")}</th>{m.people && <th>{t("ui.col_who")}</th>}<th>{t("ui.col_what")}</th><th>{t("ui.col_owed")}</th><th /></tr></thead>
            <tbody>{m.owed.rows.map((x) => {
              const may = payAction(x, x.cents, "cash", mayDo, coversLocation), key = `${x.kind}:${x.id}`;
              return <Fragment key={key}>
                <tr><td data-label={t("ui.col_when")}>{at(x.at)}</td>
                  {m.people && <td data-label={t("ui.col_who")}>{who(x.who, x.person_id)}</td>}
                  <td data-label={t("ui.col_what")}>{x.kind === "booking" ? `${x.court} · ${x.code}` : x.session_id ? <a href={`/sessions/${x.session_id}`}>{x.program}</a> : x.program}</td>
                  <td data-label={t("ui.col_owed")} class="num">{money(x.cents)}</td>
                  <td>{may && paying !== key && <button class="small" onClick={() => setPaying(key)}>{t("ui.record_payment")}</button>}</td></tr>
                {paying === key && <tr><td colSpan={m.people ? 5 : 4}>
                  <DeskPay owed={x.cents} label={t("ui.unpaid_amount", { amount: money(x.cents) })} onCancel={() => setPaying(null)}
                    send={(cents, method) => { const p = payAction(x, cents, method, mayDo, coversLocation); setPaying(null); if (p) void preview(p.action, p.input); }} /></td></tr>}
              </Fragment>;
            })}</tbody>
          </table></div>}
          {m.owed.count > m.owed.rows.length && <p class="meta">{t("count.money_owed_shown", { count: m.owed.rows.length })}</p>}
          <p><a href="/bookings?status=unpaid">{t("ui.money_owed_all")}</a></p>
        </section>

        <section class="card" aria-labelledby="money-refunds">
          <h2 id="money-refunds">{t("ui.money_refunds_title")}</h2>
          <p class="meta">{t("ui.money_refunds_help", { days: m.refunds.days })}</p>
          {m.refunds.rows.length === 0 ? <p class="meta">{t("ui.money_refunds_none", { days: m.refunds.days })}</p> : <div class="table-scroll"><table class="stack">
            <thead><tr><th>{t("ui.col_when")}</th>{m.people && <th>{t("ui.col_who")}</th>}<th>{t("ui.col_what")}</th><th>{t("ui.col_amount")}</th><th>{t("ui.col_goes_to")}</th><th>{t("ui.col_status")}</th></tr></thead>
            <tbody>{m.refunds.rows.map((r) => <tr key={r.id}><td data-label={t("ui.col_when")}>{at(r.at)}</td>
              {m.people && <td data-label={t("ui.col_who")}>{who(r.who, r.person_id)}</td>}
              <td data-label={t("ui.col_what")}>{r.what?.name ?? ""}</td>
              <td data-label={t("ui.col_amount")} class="num">{money(r.cents)}</td>
              <td data-label={t("ui.col_goes_to")}>{t(`ui.refund_goes_${r.to}` as Key)}</td>
              <td data-label={t("ui.col_status")}><span class={`pill pill-refund-${r.status}`}>{t(`ui.refund_state_${r.status}` as Key)}</span></td></tr>)}</tbody>
          </table></div>}
        </section>

        <Payouts />

        <section class="card" aria-labelledby="money-credit">
          <h2 id="money-credit">{t("ui.money_credit")}</h2>
          <p class="meta">{t("ui.money_credit_help")}</p>
          {m.credit.people === 0 ? <p class="meta">{t("ui.money_credit_none")}</p> : <>
            <p><strong class="num">{money(m.credit.cents)}</strong> · {t("count.money_credit_people", { count: m.credit.people })}</p>
            {m.credit.top.length > 0 && <ul class="plain since-list">{m.credit.top.map((h) => <li key={h.person_id}>
              <span class="meta num">{money(h.cents)}</span><a href={`/people/${h.person_id}`}>{h.name}</a></li>)}</ul>}
            {m.people && m.credit.people > m.credit.top.length && <p class="meta">{t("count.money_credit_more", { count: m.credit.people - m.credit.top.length })}</p>}
          </>}
        </section>
      </>}
      <StripeCard />
      {sheet}
    </main>
  );
}

type PayoutView = { provider: "test" | "stripe"; connected: boolean; unavailable: boolean; bank: { name: string | null; last4: string } | null; payouts: PayoutRow[] };

/** When Stripe sends the club's money to its bank: the next one on its way, then the latest, each with the day it's
 *  due, its amount and where it stands. */
function Payouts() {
  const [d, setD] = useState<PayoutView | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<PayoutView>("/staff/money/payouts").then(setD).catch((e: ApiError) => setError(e.message)); }, [lang.value]);
  const day = (x: string) => payoutDay(x, formatLocale(lang.value));
  const next = d ? nextPayout(d.payouts) : null;
  return (
    <section class="card" aria-labelledby="money-payouts">
      <h2 id="money-payouts">{t("ui.money_payouts")}</h2>
      <p class="meta">{t("ui.money_payouts_help")}{d?.bank ? <> {t("ui.money_payouts_bank", { last4: d.bank.last4 })}</> : null}</p>
      {error && <p class="error" role="alert">{error}</p>}
      {!d && !error && <p class="meta">{t("ui.loading")}</p>}
      {d && (d.provider === "test" && !d.payouts.length ? <p class="meta">{t("ui.money_payouts_test")}</p>
        : d.unavailable ? <p class="meta">{t("ui.money_payouts_unavailable")}</p>
        : !d.connected ? <p class="meta">{t("ui.money_payouts_not_connected")}</p>
        : !d.payouts.length ? <p class="meta">{t("ui.money_payouts_none")}</p> : <>
          {next && <p><strong>{t("ui.money_payout_next", { amount: dollars(next.amount_cents, lang.value), day: day(next.arrives_on) })}</strong></p>}
          <div class="table-scroll"><table class="stack">
            <thead><tr><th>{t("ui.col_arrives")}</th><th>{t("ui.col_amount")}</th><th>{t("ui.col_status")}</th></tr></thead>
            <tbody>{d.payouts.map((p) => <tr key={p.id}><td data-label={t("ui.col_arrives")}>{day(p.arrives_on)}</td>
              <td data-label={t("ui.col_amount")} class="num">{dollars(p.amount_cents, lang.value)}</td>
              <td data-label={t("ui.col_status")}><span class={`pill pill-payout-${p.status}`}>{t(`ui.payout_state_${p.status}` as Key)}</span></td></tr>)}</tbody>
          </table></div>
        </>)}
    </section>
  );
}

/** Where the club's card payments go. Hosted Kumi: "Connect with Stripe", then Stripe's own setup pages. */
function StripeCard() {
  const [d, setD] = useState<P | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  const load = () => api<P>("/staff/payments").then(setD);
  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ url?: string; awaiting_approval?: string }>("/staff/payments/connect", {});
      if (r.url) { location.href = r.url; return; }
      setNote(t("ui.sent_for_approval"));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    setBusy(false);
  };
  useEffect(() => {
    // Back from Stripe: "return" when the person finished or left setup, "refresh" when the link ran out.
    const back = new URLSearchParams(location.search).get("stripe");
    if (back) history.replaceState(null, "", "/payments");
    if (back === "refresh") { void connect(); return; }
    (back === "return" ? api("/staff/payments/refresh", {}).catch(() => {}) : Promise.resolve()).then(load);
  }, []);
  // Stripe has the details and is checking them: the server asks Stripe every 30 seconds, so look again.
  const checking = Boolean(d?.account?.details_submitted && !d.account.charges_enabled);
  useEffect(() => {
    if (!checking) return;
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [checking]);
  if (!d) return null;
  const a = d.account;
  // Not taking card payments yet: setting that up comes first on the page.
  return (
    <section class={`card money-stripe${d.mode === "connect" && !a?.charges_enabled ? " setup" : ""}`} aria-labelledby="money-stripe">
      <h2 id="money-stripe">{t("ui.payments_title")}</h2>
      {d.mode === "test" && <p>{t("ui.payments_test")}</p>}
      {d.mode === "direct" && <p>{t("ui.payments_direct")}</p>}
      {d.mode === "connect" && !a && <>
        <p>{t("ui.payments_connect_intro")}</p>
        <ul>{(["ui.payments_point_money", "ui.payments_point_fees", "ui.payments_point_refunds"] as const).map((k) => <li>{t(k)}</li>)}</ul>
        <p class="meta">{t("ui.payments_who")}</p>
        <button class="primary" disabled={busy} onClick={connect}>{t("ui.payments_connect")}</button>
      </>}
      {d.mode === "connect" && checking && <>
        <p>{t("ui.payments_checking", { tail: a!.tail })}</p>
        <p class="meta">{t("ui.payments_checking_more")}</p>
        <button disabled={busy} onClick={connect}>{t("ui.payments_continue")}</button>
      </>}
      {d.mode === "connect" && a && !a.charges_enabled && !a.details_submitted && <>
        <p>{t("ui.payments_finish", { tail: a.tail })}</p>
        <button class="primary" disabled={busy} onClick={connect}>{t("ui.payments_continue")}</button>
      </>}
      {d.mode === "connect" && a?.charges_enabled && <>
        <p>{t("ui.payments_ready", { tail: a.tail })}</p>
        <p><a href="https://dashboard.stripe.com/" target="_blank" rel="noopener">{t("ui.payments_dashboard")}</a></p>
      </>}
      {d.mode !== "test" && !d.live && <p class="meta">{t("ui.payments_test_mode")}</p>}
      {note && <p class="note" role="status">{note}</p>}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}
