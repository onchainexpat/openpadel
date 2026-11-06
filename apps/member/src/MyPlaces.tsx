import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, t, shortTime, usePreview, clubTime } from "@kumi/ui";
import { confirmPaid, PaySheet } from "./Pay.tsx";
import { weeklyLaterLine, type WeeklyLater } from "./weekly_later.ts";

type Place = { id: string; status: string; waitlist_position: number | null; name: string; price_cents: number; first_start: string | null; offer_expires_at: string | null; pending_payment_id: string | null; pending_cents: number | null; paid_cents: number; for_name: string | null };

/** What's been paid: all of it, or part of it so far (the rest at the desk or by card). */
const paidOf = (paid: number, price: number) => paid < price ? t("ui.paid_of", { paid: dollars(paid, lang.value), price: dollars(price, lang.value) }) : t("ui.you_paid", { amount: dollars(paid, lang.value) });

export function MyPlaces() {
  const [rows, setRows] = useState<Place[] | null>(null);
  const [provider, setProvider] = useState<string | null>(null), [ready, setReady] = useState(true), [paying, setPaying] = useState<Place | null>(null), [paid, setPaid] = useState(false);
  const load = () => api<Place[]>("/my/places").then(setRows);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  useEffect(() => {
    api<{ provider: string; ready: boolean }>("/payments/config").then((c) => { setProvider(c.provider); setReady(c.ready); }).catch(() => {});
    // Back from a bank's own check (only some cards need one): see whether the payment went through.
    const back = new URLSearchParams(location.search).get("paid");
    if (back) { history.replaceState(null, "", "/places"); confirmPaid(back).then((ok) => { setPaid(ok); load(); }); }
  }, []);
  const when = (iso: string | null) => (iso ? clubTime(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
  const payTest = async (id: string) => { await api(`/dev/payments/${id}/settle`, {}); load(); };
  return (
    <main>
      <h1>{t("ui.nav_my")}</h1>
      {sheet}
      {paid && <p class="note" role="status">{t("ui.pay_done")}</p>}
      {paying && <PaySheet paymentId={paying.pending_payment_id!} amountCents={paying.pending_cents ?? paying.price_cents} name={paying.name} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); setPaid(true); load(); }} />}
      <MyMembership />
      <MyBookings provider={provider} ready={ready} onPaid={() => setPaid(true)} />
      <MyWeekly />
      {rows?.length === 0 && <p>{t("ui.no_places")}</p>}
      <ul class="changes">{(rows ?? []).map((p) => (
        <li class="card" key={p.id}>
          <div class="summary">{p.name}{p.for_name ? <span class="meta"> · {t("ui.for_name", { name: p.for_name })}</span> : null}</div>
          <div class="meta">{when(p.first_start)} · {p.status === "booked" ? t("ui.youre_in") : t("ui.on_waitlist", { n: p.waitlist_position ?? 0 })}
            {p.paid_cents > 0 ? ` · ${paidOf(p.paid_cents, p.price_cents)}` : p.pending_payment_id ? ` · ${t("ui.pay_pending")}` : ""}</div>
          {p.offer_expires_at && <p class="note">{t("ui.offer_ends", { time: shortTime(p.offer_expires_at) })} <button class="small primary" onClick={() => preview("enrolment.accept_offer", { enrolment_id: p.id })}>{t("ui.take_place")}</button></p>}
          {p.pending_payment_id && provider === "stripe" && !ready && <p class="meta">{t("error.payments_not_set_up")}</p>}
          {p.pending_payment_id && provider === "stripe" && ready && <button class="small primary" onClick={() => setPaying(p)}>{t("ui.pay_now", { amount: dollars(p.pending_cents ?? p.price_cents, lang.value) })}</button>}
          {import.meta.env.DEV && p.pending_payment_id && provider === "test" && <button class="small" onClick={() => payTest(p.pending_payment_id!)}>{t("ui.pay_test")}</button>}
          {" "}<button class="small" onClick={() => preview("enrolment.leave", { enrolment_id: p.id })}>{t("ui.leave")}</button>
        </li>
      ))}</ul>
    </main>
  );
}

type Booking = { id: string; code: string; status: string; kind: string; coach: string | null; pay_mode: string; players: number; price_cents: number; invite_code: string | null; balance_cents: number; share_cents: number;
  court: string; location: string; time_zone: string; start: string; end: string; pending_payment_id: string | null; pending_cents: number | null; paid_cents: number; joined: number; mine: boolean; open_match_id: string | null;
  group_cents: number | null; for_name: string | null; weekly_later: WeeklyLater | null };

/** My court bookings: when and where, what I paid or still owe, the link for the others, and cancelling. */
function MyBookings({ provider, ready, onPaid }: { provider: string | null; ready: boolean; onPaid: () => void }) {
  const [rows, setRows] = useState<Booking[]>([]), [paying, setPaying] = useState<Booking | null>(null), [copied, setCopied] = useState<string | null>(null);
  const load = () => api<Booking[]>("/my/bookings").then(setRows).catch(() => {});
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  if (!rows.length) return null;
  const when = (b: Booking) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: b.time_zone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(b.start));
  const link = (b: Booking) => `${location.origin}/join/${b.invite_code}`;
  const share = async (b: Booking) => {
    const url = link(b);
    if (navigator.share) { try { await navigator.share({ title: t("ui.court_booking"), url }); return; } catch { /* closed: fall back to copying */ } }
    await navigator.clipboard?.writeText(url).catch(() => {}); setCopied(b.id);
  };
  return (
    <section>
      <h2>{t("ui.my_courts")}</h2>
      {sheet}
      {paying && <PaySheet paymentId={paying.pending_payment_id!} amountCents={paying.group_cents ?? paying.pending_cents ?? paying.share_cents} name={t("ui.court_booking")} detail={weeklyLaterLine(paying.weekly_later)} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); onPaid(); load(); }} />}
      <ul class="changes">{rows.map((b) => (
        <li class="card" key={b.id}>
          <div class="summary">{b.kind === "lesson" ? `${t("ui.lesson_with", { coach: b.coach ?? "" })} · ` : ""}{b.court} · {when(b)}{b.for_name ? <span class="meta"> · {t("ui.for_name", { name: b.for_name })}</span> : null}</div>
          <div class="meta">{b.code} · {b.location}{b.status === "held" ? ` · ${t("ui.being_paid")}` : ""}{b.paid_cents > 0 ? ` · ${paidOf(b.paid_cents, b.share_cents)}` : ""}
            {b.pay_mode === "split" ? ` · ${t("count.joined", { count: b.joined, total: b.players })}` : ""}</div>
          {b.balance_cents > 0 && b.mine && <p class="error">{t("ui.still_owed", { amount: dollars(b.balance_cents, lang.value) })}</p>}
          {weeklyLaterLine(b.weekly_later) && <p class="meta">{weeklyLaterLine(b.weekly_later)}</p>}
          {b.pending_payment_id && provider === "stripe" && ready && <button class="small primary" onClick={() => setPaying(b)}>{t("ui.pay_now", { amount: dollars(b.group_cents ?? b.pending_cents ?? b.share_cents, lang.value) })}</button>}
          {import.meta.env.DEV && b.pending_payment_id && provider === "test" && <button class="small" onClick={async () => { await api(`/dev/payments/${b.pending_payment_id}/settle`, {}); load(); }}>{t("ui.pay_test")}</button>}
          {b.open_match_id ? <><a class="small" href={`/match/${b.open_match_id}`}>{t("ui.see_match")}</a>{" "}</>
            : b.kind === "court" && b.status === "confirmed" && <><a class="small" href={`/match/${b.id}`}>{t("ui.players_and_score")}</a>{" "}</>}
          {b.invite_code && <><button class="small" onClick={() => share(b)}>{t("ui.invite_others")}</button>{copied === b.id && <span class="meta"> {t("ui.link_copied")}</span>}</>}
          {" "}<a class="small" href={`/my/bookings/${b.id}/calendar.ics`} download={`${b.code}.ics`}>{t("ui.add_calendar")}</a>
          {b.mine && b.status === "confirmed" && <>{" "}<button class="small" onClick={() => preview("booking.cancel", { booking_id: b.id })}>{t("ui.cancel_booking_member")}</button></>}
        </li>
      ))}</ul>
    </section>
  );
}

/** My weekly courts (the same court every week): each week from today, and cancelling this week and the rest. */
function MyWeekly() {
  type Weekly = typeof import("@kumi/ui/weekly");
  const [series, setSeries] = useState<import("@kumi/ui/weekly").WeeklyCourt[]>([]), [ui, setUi] = useState<Weekly | null>(null);
  // Its screen is fetched only for someone who has one, so the first screen doesn't carry it.
  const load = () => api<import("@kumi/ui/weekly").WeeklyCourt[]>("/my/series").then(async (s) => { setSeries(s); if (s.length && !ui) setUi(await import("@kumi/ui/weekly")); }).catch(() => {});
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  return ui ? <>{sheet}<ui.WeeklyCourts series={series} preview={preview} /></> : null;
}

type Membership = { name: string; status: string; days_ahead: number | null; member_prices: boolean };
/** My membership and what it gives me, when I have one; the rest is on its own page. */
function MyMembership() {
  const [m, setM] = useState<Membership | null>(null);
  useEffect(() => { api<{ membership: Membership | null }>("/my/membership").then((r) => setM(r.membership)).catch(() => {}); }, []);
  if (!m) return null;
  return (
    <section class="card">
      <h2>{t("ui.your_membership", { name: m.name })}</h2>
      {m.status === "past_due" && <p class="note">{t("ui.renewal_declined_short")}</p>}
      <ul>
        {m.member_prices && <li>{t("ui.perk_prices")}</li>}
        {m.days_ahead && <li>{t("ui.perk_window", { count: m.days_ahead })}</li>}
      </ul>
      <a href="/membership">{t("ui.see_membership")}</a>
    </section>
  );
}
