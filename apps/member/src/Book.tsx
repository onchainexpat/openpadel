// Booking a court: pick a day and a length, see when courts are free, choose one, and pay the whole court
// or only your part, and (paying your part) open it to other players as an open match. Paying the whole
// court, more courts the same day can be added and paid together. Times are the club's, whatever the
// phone's clock says.
import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, me, NewOnly, t, usePreview, serverNow } from "@kumi/ui";
import { PaySheet } from "./Pay.tsx";
import { weeklyLaterLine, type WeeklyLater } from "./weekly_later.ts";
import { formatLocale } from "@kumi/i18n/format";

type Options = { locations: { id: string; name: string; time_zone: string }[]; lengths: number[]; days_ahead: number; split_deadline_hours: number; weekly: boolean; weekly_max_weeks: number; same_day_cutoff_hours: number; free_cancel_hours: number; late_refund_percent: number };
type Free = { open: { opens: string; closes: string } | null; courts: { id: string; name: string; kind: string; starts: string[] }[] };
type Quote = { total_cents: number; tax_cents: number; priced: boolean; member: string | null };

export function Book() {
  const [o, setO] = useState<Options | null>(null), [loc, setLoc] = useState(""), [day, setDay] = useState(""), [minutes, setMinutes] = useState(90);
  const [free, setFree] = useState<Free | null>(null), [pick, setPick] = useState<{ start: string; courts: Free["courts"] } | null>(null), [court, setCourt] = useState("");
  const [q, setQ] = useState<Quote | null>(null), [pay, setPay] = useState<"whole" | "split">("whole"), [players, setPlayers] = useState(4);
  // The same court every week (when the club allows it): the first week paid now, the card saved for the rest.
  const [weekly, setWeekly] = useState(false), [weeks, setWeeks] = useState(4);
  const [provider, setProvider] = useState("test"), [paying, setPaying] = useState<{ id: string; cents: number; later?: WeeklyLater | null } | null>(null), [done, setDone] = useState(false);
  // An open match: the level band (around my own level to start with), and who else may join.
  const [open, setOpen] = useState(false), [myLevel, setMyLevel] = useState<number | null>(null), [matchId, setMatchId] = useState<string | null>(null);
  const [om, setOm] = useState({ min: "3.00", max: "4.00", ask: true, rated: true, listed: true });
  // Courts added to pay together (the same day, whole courts).
  const [cart, setCart] = useState<{ court: string; name: string; start: string; minutes: number; cents: number }[]>([]);
  const cartTotal = cart.reduce((n, x) => n + x.cents, 0);
  const place = o?.locations.find((l) => l.id === loc), tz = place?.time_zone ?? "UTC";
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: tz, ...opts }).format(new Date(iso));
  const { preview, sheet } = usePreview((r?: { payment_id?: string; booking_id?: string; total_cents?: number; later?: WeeklyLater }) => {
    if (r?.payment_id) setPaying({ id: r.payment_id, cents: r.total_cents ?? (cart.length ? cartTotal : pay === "whole" ? q!.total_cents : mine), later: r.later ?? null });
    setMatchId(open && r?.booking_id ? r.booking_id : null);
  });

  useEffect(() => {
    api<Options>("/booking-options").then((x) => { setO(x); setLoc(x.locations[0]?.id ?? ""); setMinutes(x.lengths.includes(90) ? 90 : x.lengths[0]!); });
    api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {});
    api<{ rating: { level: string } | null }>("/my/level").then((r) => {
      if (!r.rating) return;
      // Half a level either side, out to the nearest quarter: 2.39 gives 1.75 to 3.00.
      const l = Number(r.rating.level), clamp = (x: number) => Math.min(7, Math.max(0.5, x)).toFixed(2);
      setMyLevel(l); setOm((o) => ({ ...o, min: clamp(Math.floor((l - 0.5) * 4) / 4), max: clamp(Math.ceil((l + 0.5) * 4) / 4) }));
    }).catch(() => {});
  }, []);
  // The next days, in the club's time.
  const days: string[] = [];
  if (o && place) { const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(serverNow())); for (let k = 0; k < Math.min(o.days_ahead, 60); k++) { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + k); days.push(d.toISOString().slice(0, 10)); } }
  useEffect(() => { if (days.length && !day) setDay(days[0]!); }, [o, loc]);
  useEffect(() => { setCart([]); }, [loc, day]);
  useEffect(() => { if (loc && day) { setPick(null); setQ(null); api<Free>(`/availability?location_id=${loc}&date=${day}&minutes=${minutes}`).then(setFree); } }, [loc, day, minutes]);
  useEffect(() => { if (court && pick) api<Quote>(`/quote?court_id=${court}&starts_at=${encodeURIComponent(pick.start)}&minutes=${minutes}`).then(setQ); }, [court, pick?.start]);
  if (!o) return <main class="card"><p>{t("ui.loading")}</p></main>;

  // Every start time with the courts free then.
  // Every start time with the courts free then (less the courts already added, at those times).
  const ms = (iso: string) => new Date(iso).getTime();
  const clash = (id: string, s: string) => cart.some((x) => x.court === id && ms(s) < ms(x.start) + x.minutes * 60_000 && ms(x.start) < ms(s) + minutes * 60_000);
  const times = [...new Set(free?.courts.flatMap((c) => c.starts) ?? [])].sort().map((s) => ({ start: s, courts: free!.courts.filter((c) => c.starts.includes(s) && !clash(c.id, s)) })).filter((x) => x.courts.length);
  const each = q ? Math.floor(q.total_cents / players) : 0, mine = q ? q.total_cents - each * (players - 1) : 0;
  // Past the deadline for sharing the cost, only a same-day open match can still be shared, until its cutoff.
  const ahead = pick ? new Date(pick.start).getTime() - serverNow() : 0;
  const canSplit = pick ? ahead > o.split_deadline_hours * 3600_000 : false, sameDay = pick ? !canSplit && ahead > o.same_day_cutoff_hours * 3600_000 : false;
  const choose = (x: { start: string; courts: Free["courts"] }) => { setPick(x); setCourt(x.courts.length === 1 ? x.courts[0]!.id : ""); setQ(null); setPay("whole"); };
  const opened = open && pay === "split" && players === 4;
  const add = () => { setCart([...cart, { court, name: pick!.courts.find((c) => c.id === court)!.name, start: pick!.start, minutes, cents: q!.total_cents }]); setPick(null); setQ(null); };
  const bookCart = () => cart.length === 1
    ? preview("booking.request", { court_id: cart[0]!.court, starts_at: cart[0]!.start, minutes: cart[0]!.minutes, pay: "whole", person_id: me.value!.person.id })
    : preview("booking.request_courts", { courts: cart.map((x) => ({ court_id: x.court, starts_at: x.start, minutes: x.minutes })), person_id: me.value!.person.id });
  const book = () => weekly && pay === "whole" ? preview("booking.repeat_request", { court_id: court, starts_at: pick!.start, minutes, weeks, person_id: me.value!.person.id }) : preview("booking.request", { court_id: court, starts_at: pick!.start, minutes, pay, ...(pay === "split" ? { players } : {}), person_id: me.value!.person.id,
    ...(opened ? { open: { level_min: Number(om.min), level_max: Number(om.max), outside_band: om.ask ? "ask" : "closed", rated: om.rated, listed: om.listed } } : {}) });

  if (done) return <main class="card"><h1>{t("ui.booked")}</h1><p>{matchId ? <a href={`/match/${matchId}`}>{t("ui.see_your_match")}</a> : <a href="/places">{t("ui.see_my_bookings")}</a>}</p></main>;
  return (
    <main>
      <h1>{t("ui.book_title")}</h1>
      {sheet}
      {paying && <PaySheet paymentId={paying.id} amountCents={paying.cents} name={t("ui.court_booking")} detail={weeklyLaterLine(paying.later)} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); setDone(true); }} />}
      {paying && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => { await api(`/dev/payments/${paying.id}/settle`, {}); setPaying(null); setDone(true); }}>{t("ui.pay_test")}</button></p>}
      <section class="card card-form">
        {o.locations.length > 1 && <label>{t("ui.location")}<select value={loc} onChange={(e) => { setLoc(e.currentTarget.value); setDay(""); }}>{o.locations.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>}
        <div class="chips scroll" role="group" aria-label={t("ui.day")}>{days.map((d) => <button type="button" class={d === day ? "chip on" : "chip"} onClick={() => setDay(d)}>{fmt(`${d}T12:00:00Z`, { weekday: "short", day: "numeric", timeZone: "UTC" })}</button>)}</div>
        <div class="chips" role="group" aria-label={t("ui.length")}>{o.lengths.map((m) => <button type="button" class={m === minutes ? "chip on" : "chip"} onClick={() => setMinutes(m)}>{t("ui.minutes", { count: m })}</button>)}</div>
      </section>
      {cart.length > 0 && <section class="card">
        <h2>{t("ui.courts_chosen")}</h2>
        <ul class="plain">{cart.map((x, k) => <li class="row"><span>{x.name} · {fmt(x.start, { hour: "numeric", minute: "2-digit" })} · {t("ui.minutes", { count: x.minutes })} · {dollars(x.cents, lang.value)}</span>
          <button class="small" onClick={() => setCart(cart.filter((_, j) => j !== k))}>{t("ui.remove")}</button></li>)}</ul>
        <p class="meta">{t(o.late_refund_percent ? "ui.cancel_rule" : "ui.cancel_rule_none", { hours: t("count.hours", { count: o.free_cancel_hours }), percent: o.late_refund_percent })}</p>
        <NewOnly><button class="primary" onClick={bookCart}>{cart.length === 1 ? t("ui.book_now") : t("ui.book_courts", { count: cart.length, amount: dollars(cartTotal, lang.value) })}</button></NewOnly>
      </section>}
      {free && !free.open && <p class="card">{t("ui.closed_this_day")}</p>}
      {free?.open && !times.length && <p class="card">{t("ui.no_free_times")}</p>}
      {!pick && times.length > 0 && <section class="card"><div class="chips">{times.map((x) => <button type="button" class="chip" onClick={() => choose(x)}>{fmt(x.start, { hour: "numeric", minute: "2-digit" })}</button>)}</div></section>}
      {pick && (
        <section class="card card-form">
          <h2>{fmt(pick.start, { weekday: "long", day: "numeric", month: "long" })}, {fmt(pick.start, { hour: "numeric", minute: "2-digit" })} · {t("ui.minutes", { count: minutes })}</h2>
          {pick.courts.length > 1 && <div class="chips" role="group" aria-label={t("ui.which_court")}>{pick.courts.map((c) => <button type="button" class={c.id === court ? "chip on" : "chip"} onClick={() => setCourt(c.id)}>{c.name}</button>)}</div>}
          {court && q && (q.priced ? <>
            <p><strong>{dollars(q.total_cents, lang.value)}</strong>{q.tax_cents ? <span class="meta"> · {t("ui.tax_included", { amount: dollars(q.tax_cents, lang.value) })}</span> : null}{q.member ? <span class="meta"> · {t("ui.member_price", { plan: q.member })}</span> : null}</p>
            {cart.length > 0 ? <button class="primary" onClick={add}>{t("ui.add_this_court")}</button> : <>
            <label class="check"><input type="radio" name="pay" checked={pay === "whole"} onChange={() => setPay("whole")} /> {t("ui.pay_whole", { amount: dollars(q.total_cents, lang.value) })}</label>
            {canSplit && <label class="check"><input type="radio" name="pay" checked={pay === "split"} onChange={() => setPay("split")} /> {t("ui.pay_split")}</label>}
            {o.weekly && pay === "whole" && <>
              <label class="check"><input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.currentTarget.checked)} /> {t("ui.every_week")}</label>
              {weekly && <label>{t("ui.how_many_weeks")}<select value={weeks} onChange={(e) => setWeeks(Number(e.currentTarget.value))}>
                {Array.from({ length: o.weekly_max_weeks - 1 }, (_, k) => k + 2).map((n) => <option value={n}>{t("count.weeks", { count: n })}</option>)}</select></label>}
              {weekly && <p class="meta">{t("ui.weekly_member_hint", { hours: t("count.hours", { count: o.split_deadline_hours }) })}</p>}
            </>}
            {sameDay && <label class="check"><input type="radio" name="pay" checked={pay === "split"} onChange={() => { setPay("split"); setPlayers(4); setOpen(true); }} /> {t("ui.open_same_day")}</label>}
            {pay === "split" && <>
              {canSplit && <div class="chips" role="group" aria-label={t("ui.sharing")}>{[2, 4].map((n) => <button type="button" class={n === players ? "chip on" : "chip"} onClick={() => setPlayers(n)}>{t("count.players", { count: n })}</button>)}</div>}
              <p class="meta">{t(opened ? "ui.open_explain" : "ui.split_explain", { mine: dollars(mine, lang.value), each: dollars(each, lang.value), hours: t("count.hours", { count: sameDay ? o.same_day_cutoff_hours : o.split_deadline_hours }) })}</p>
              {players === 4 && canSplit && <label class="check"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.currentTarget.checked)} /> {t("ui.open_to_others")}</label>}
              {opened && <fieldset>
                <legend>{t("ui.match_band", { level: myLevel === null ? t("ui.no_level_yet") : myLevel.toFixed(2) })}</legend>
                <div class="court-row"><label>{t("ui.from")}<input type="number" min={0.5} max={7} step={0.25} value={om.min} onInput={(e) => setOm({ ...om, min: e.currentTarget.value })} /></label>
                  <label>{t("ui.to")}<input type="number" min={0.5} max={7} step={0.25} value={om.max} onInput={(e) => setOm({ ...om, max: e.currentTarget.value })} /></label></div>
                <label class="check"><input type="checkbox" checked={om.ask} onChange={(e) => setOm({ ...om, ask: e.currentTarget.checked })} /> {t("ui.outside_can_ask")}</label>
                <label class="check"><input type="checkbox" checked={om.rated} onChange={(e) => setOm({ ...om, rated: e.currentTarget.checked })} /> {t("ui.match_counts")}</label>
                <label class="check"><input type="checkbox" checked={om.listed} onChange={(e) => setOm({ ...om, listed: e.currentTarget.checked })} /> {t("ui.list_on_play")}</label>
              </fieldset>}
            </>}
            <p class="meta">{t(o.late_refund_percent ? "ui.cancel_rule" : "ui.cancel_rule_none", { hours: t("count.hours", { count: o.free_cancel_hours }), percent: o.late_refund_percent })}</p>
            <NewOnly><button class="primary" onClick={book}>{t("ui.book_now")}</button>{" "}
            {pay === "whole" && !weekly && <button class="link" onClick={add}>{t("ui.add_another_court")}</button>}</NewOnly>
            </>}
          </> : <p class="meta">{t("error.no_price")}</p>)}
          <button class="link" onClick={() => setPick(null)}>{t("ui.other_time")}</button>
        </section>
      )}
    </main>
  );
}
