// Booking a court: pick a day and a length, see when courts are free, choose one, and pay the whole court
// or only your part. Times are the club's, whatever the phone's clock says.
import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, me, t, usePreview } from "@kumi/ui";
import { PaySheet } from "./Pay.tsx";

type Options = { locations: { id: string; name: string; time_zone: string }[]; lengths: number[]; days_ahead: number; split_deadline_hours: number; free_cancel_hours: number; late_refund_percent: number };
type Free = { open: { opens: string; closes: string } | null; courts: { id: string; name: string; kind: string; starts: string[] }[] };
type Quote = { total_cents: number; tax_cents: number; priced: boolean };

export function Book() {
  const [o, setO] = useState<Options | null>(null), [loc, setLoc] = useState(""), [day, setDay] = useState(""), [minutes, setMinutes] = useState(90);
  const [free, setFree] = useState<Free | null>(null), [pick, setPick] = useState<{ start: string; courts: Free["courts"] } | null>(null), [court, setCourt] = useState("");
  const [q, setQ] = useState<Quote | null>(null), [pay, setPay] = useState<"whole" | "split">("whole"), [players, setPlayers] = useState(4);
  const [provider, setProvider] = useState("test"), [paying, setPaying] = useState<{ id: string; cents: number } | null>(null), [done, setDone] = useState(false);
  const place = o?.locations.find((l) => l.id === loc), tz = place?.time_zone ?? "UTC";
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: tz, ...opts }).format(new Date(iso));
  const { preview, sheet } = usePreview((r?: { payment_id?: string }) => { if (r?.payment_id) setPaying({ id: r.payment_id, cents: pay === "whole" ? q!.total_cents : mine }); });

  useEffect(() => {
    api<Options>("/booking-options").then((x) => { setO(x); setLoc(x.locations[0]?.id ?? ""); setMinutes(x.lengths.includes(90) ? 90 : x.lengths[0]!); });
    api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {});
  }, []);
  // The next days, in the club's time.
  const days: string[] = [];
  if (o && place) { const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); for (let k = 0; k < Math.min(o.days_ahead, 14); k++) { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + k); days.push(d.toISOString().slice(0, 10)); } }
  useEffect(() => { if (days.length && !day) setDay(days[0]!); }, [o, loc]);
  useEffect(() => { if (loc && day) { setPick(null); setQ(null); api<Free>(`/availability?location_id=${loc}&date=${day}&minutes=${minutes}`).then(setFree); } }, [loc, day, minutes]);
  useEffect(() => { if (court && pick) api<Quote>(`/quote?court_id=${court}&starts_at=${encodeURIComponent(pick.start)}&minutes=${minutes}`).then(setQ); }, [court, pick?.start]);
  if (!o) return <main class="card"><p>{t("ui.loading")}</p></main>;

  // Every start time with the courts free then.
  const times = [...new Set(free?.courts.flatMap((c) => c.starts) ?? [])].sort().map((s) => ({ start: s, courts: free!.courts.filter((c) => c.starts.includes(s)) }));
  const each = q ? Math.floor(q.total_cents / players) : 0, mine = q ? q.total_cents - each * (players - 1) : 0;
  const canSplit = pick ? new Date(pick.start).getTime() - Date.now() > o.split_deadline_hours * 3600_000 : false;
  const choose = (x: { start: string; courts: Free["courts"] }) => { setPick(x); setCourt(x.courts.length === 1 ? x.courts[0]!.id : ""); setQ(null); setPay("whole"); };
  const book = () => preview("booking.request", { court_id: court, starts_at: pick!.start, minutes, pay, ...(pay === "split" ? { players } : {}), person_id: me.value!.person.id });

  if (done) return <main class="card"><h1>{t("ui.booked")}</h1><p><a href="/places">{t("ui.see_my_bookings")}</a></p></main>;
  return (
    <main>
      <h1>{t("ui.book_title")}</h1>
      {sheet}
      {paying && <PaySheet paymentId={paying.id} amountCents={paying.cents} name={t("ui.court_booking")} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); setDone(true); }} />}
      {paying && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => { await api(`/dev/payments/${paying.id}/settle`, {}); setPaying(null); setDone(true); }}>{t("ui.pay_test")}</button></p>}
      <section class="card card-form">
        {o.locations.length > 1 && <label>{t("ui.location")}<select value={loc} onChange={(e) => { setLoc(e.currentTarget.value); setDay(""); }}>{o.locations.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>}
        <div class="chips" role="group" aria-label={t("ui.day")}>{days.map((d) => <button type="button" class={d === day ? "chip on" : "chip"} onClick={() => setDay(d)}>{fmt(`${d}T12:00:00Z`, { weekday: "short", day: "numeric", timeZone: "UTC" })}</button>)}</div>
        <div class="chips" role="group" aria-label={t("ui.length")}>{o.lengths.map((m) => <button type="button" class={m === minutes ? "chip on" : "chip"} onClick={() => setMinutes(m)}>{t("ui.minutes", { count: m })}</button>)}</div>
      </section>
      {free && !free.open && <p class="card">{t("ui.closed_this_day")}</p>}
      {free?.open && !times.length && <p class="card">{t("ui.no_free_times")}</p>}
      {!pick && times.length > 0 && <section class="card"><div class="chips">{times.map((x) => <button type="button" class="chip" onClick={() => choose(x)}>{fmt(x.start, { hour: "numeric", minute: "2-digit" })}</button>)}</div></section>}
      {pick && (
        <section class="card card-form">
          <h2>{fmt(pick.start, { weekday: "long", day: "numeric", month: "long" })}, {fmt(pick.start, { hour: "numeric", minute: "2-digit" })} · {t("ui.minutes", { count: minutes })}</h2>
          {pick.courts.length > 1 && <div class="chips" role="group" aria-label={t("ui.which_court")}>{pick.courts.map((c) => <button type="button" class={c.id === court ? "chip on" : "chip"} onClick={() => setCourt(c.id)}>{c.name}</button>)}</div>}
          {court && q && (q.priced ? <>
            <p><strong>{dollars(q.total_cents, lang.value)}</strong>{q.tax_cents ? <span class="meta"> · {t("ui.tax_included", { amount: dollars(q.tax_cents, lang.value) })}</span> : null}</p>
            <label class="check"><input type="radio" name="pay" checked={pay === "whole"} onChange={() => setPay("whole")} /> {t("ui.pay_whole", { amount: dollars(q.total_cents, lang.value) })}</label>
            {canSplit && <label class="check"><input type="radio" name="pay" checked={pay === "split"} onChange={() => setPay("split")} /> {t("ui.pay_split")}</label>}
            {pay === "split" && <>
              <div class="chips" role="group" aria-label={t("ui.sharing")}>{[2, 4].map((n) => <button type="button" class={n === players ? "chip on" : "chip"} onClick={() => setPlayers(n)}>{t("count.players", { count: n })}</button>)}</div>
              <p class="meta">{t("ui.split_explain", { mine: dollars(mine, lang.value), each: dollars(each, lang.value), hours: t("count.hours", { count: o.split_deadline_hours }) })}</p>
            </>}
            <p class="meta">{t(o.late_refund_percent ? "ui.cancel_rule" : "ui.cancel_rule_none", { hours: t("count.hours", { count: o.free_cancel_hours }), percent: o.late_refund_percent })}</p>
            <button class="primary" onClick={book}>{t("ui.book_now")}</button>{" "}
          </> : <p class="meta">{t("error.no_price")}</p>)}
          <button class="link" onClick={() => setPick(null)}>{t("ui.other_time")}</button>
        </section>
      )}
    </main>
  );
}
