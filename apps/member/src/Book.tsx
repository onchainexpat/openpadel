// Booking a court: pick a day and a length, see every start time (the taken ones struck through), choose a court
// by its price, and pay the whole court or only your part, and (paying your part) open it to other players as an
// open match. Paying the whole court, more courts the same day can be added and paid together. The Book button
// stays at the bottom of the screen and opens the usual preview; nothing changes before Confirm. Times are the
// club's, whatever the phone's clock says.
import { useEffect, useState } from "preact/hooks";
import { Skeleton, Icon, api, club, dollars, Illustration, lang, me, NewOnly, t, usePreview, serverNow } from "@kumi/ui";
import { PaySheet } from "./Pay.tsx";
import { weeklyLaterLine, type WeeklyLater } from "./weekly_later.ts";
import { formatLocale } from "@kumi/i18n/format";
import { startTimes } from "./book_times.ts";
import { CourtAlert } from "./Alerts.tsx";

type Options = { locations: { id: string; name: string; time_zone: string }[]; lengths: number[]; days_ahead: number; split_deadline_hours: number; weekly: boolean; weekly_max_weeks: number; same_day_cutoff_hours: number; free_cancel_hours: number; late_refund_percent: number };
type Free = { open: { opens: string; closes: string } | null; courts: { id: string; name: string; kind: string; starts: string[] }[] };
type Quote = { total_cents: number; tax_cents: number; priced: boolean; member: string | null };

const kindName = (k: string) => k === "indoor" ? t("ui.kind_indoor") : k === "outdoor" ? t("ui.kind_outdoor") : k === "covered_outdoor" ? t("ui.kind_covered_outdoor") : "";

export function Book() {
  // "Start a match" on Play: this same page, with paying my part and opening it to others chosen for each time picked.
  const [startMatch] = useState(() => new URLSearchParams(location.search).get("start") === "match");
  // From a "court is free" message: its location and day (/book?location=...&date=...).
  const [asked] = useState(() => new URLSearchParams(location.search));
  const [o, setO] = useState<Options | null>(null), [loc, setLoc] = useState(""), [minutes, setMinutes] = useState(90);
  const [day, setDay] = useState(() => /^\d{4}-\d{2}-\d{2}$/.test(asked.get("date") ?? "") ? asked.get("date")! : "");
  const [free, setFree] = useState<Free | null>(null), [pick, setPick] = useState<{ start: string; courts: Free["courts"] } | null>(null), [court, setCourt] = useState("");
  const [q, setQ] = useState<Quote | null>(null), [pay, setPay] = useState<"whole" | "split">("whole"), [players, setPlayers] = useState(4);
  // Each free court's price at the chosen time, for its card (the chosen one's quote is `q`, as before).
  const [prices, setPrices] = useState<Record<string, Quote>>({});
  // The same court every week (when the club allows it): the first week paid now, the card saved for the rest.
  const [weekly, setWeekly] = useState(false), [weeks, setWeeks] = useState(4);
  const [provider, setProvider] = useState("test"), [paying, setPaying] = useState<{ id: string; cents: number; later?: WeeklyLater | null } | null>(null), [done, setDone] = useState(false);
  // An open match: the level band (around my own level to start with), and who else may join.
  const [open, setOpen] = useState(startMatch), [myLevel, setMyLevel] = useState<number | null>(null), [matchId, setMatchId] = useState<string | null>(null);
  const [om, setOm] = useState({ min: "3.00", max: "4.00", ask: true, rated: true, listed: true, gender: "" as "" | "mixed" | "women" | "men" });
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
    api<Options>("/booking-options").then((x) => { setO(x); const want = asked.get("location"); setLoc(x.locations.some((l) => l.id === want) ? want! : x.locations[0]?.id ?? ""); setMinutes(x.lengths.includes(90) ? 90 : x.lengths[0]!); });
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
  // The chosen court's quote: cleared when the court changes, and a late answer for another court is dropped, so the
  // Book bar never shows one court with another's price.
  useEffect(() => {
    setQ(null);
    if (!court || !pick) return;
    let live = true;
    api<Quote>(`/quote?court_id=${court}&starts_at=${encodeURIComponent(pick.start)}&minutes=${minutes}`).then((x) => { if (live) setQ(x); }).catch(() => {});
    return () => { live = false; };
  }, [court, pick?.start]);
  useEffect(() => {
    setPrices({});
    if (!pick) return;
    let live = true;
    void Promise.all(pick.courts.map((c) => api<Quote>(`/quote?court_id=${c.id}&starts_at=${encodeURIComponent(pick.start)}&minutes=${minutes}`).then((x) => [c.id, x] as const).catch(() => null)))
      .then((all) => { if (live) setPrices(Object.fromEntries(all.filter((x): x is readonly [string, Quote] => x !== null))); });
    return () => { live = false; };
  }, [pick?.start, pick?.courts.length]);
  if (!o) return <Skeleton />;

  // Every start time with the courts free then (less the courts already added, at those times).
  const ms = (iso: string) => new Date(iso).getTime();
  const clash = (id: string, s: string) => cart.some((x) => x.court === id && ms(s) < ms(x.start) + x.minutes * 60_000 && ms(x.start) < ms(s) + minutes * 60_000);
  // Every start time of the day (the taken ones too, to strike through), each with the courts free then.
  const slots = free ? startTimes(free, minutes, serverNow()).map((s) => ({ start: s, courts: free.courts.filter((c) => c.starts.includes(s) && !clash(c.id, s)) })) : [];
  const times = slots.filter((x) => x.courts.length);
  const each = q ? Math.floor(q.total_cents / players) : 0, mine = q ? q.total_cents - each * (players - 1) : 0;
  // Past the deadline for sharing the cost, only a same-day open match can still be shared, until its cutoff.
  const ahead = pick ? new Date(pick.start).getTime() - serverNow() : 0;
  const canSplit = pick ? ahead > o.split_deadline_hours * 3600_000 : false, sameDay = pick ? !canSplit && ahead > o.same_day_cutoff_hours * 3600_000 : false;
  const choose = (x: { start: string; courts: Free["courts"] }) => {
    setPick(x); setCourt(x.courts.length === 1 ? x.courts[0]!.id : ""); setQ(null); setPay("whole");
    if (!startMatch) return;
    // Starting a match: my part, four players, open to others; past the sharing deadline, a same-day open match if it can still be one.
    const left = new Date(x.start).getTime() - serverNow();
    if (left > o!.split_deadline_hours * 3600_000 || left > o!.same_day_cutoff_hours * 3600_000) { setPay("split"); setPlayers(4); setOpen(true); }
  };
  const opened = open && pay === "split" && players === 4;
  const add = () => { setCart([...cart, { court, name: pick!.courts.find((c) => c.id === court)!.name, start: pick!.start, minutes, cents: q!.total_cents }]); setPick(null); setQ(null); };
  const bookCart = () => cart.length === 1
    ? preview("booking.request", { court_id: cart[0]!.court, starts_at: cart[0]!.start, minutes: cart[0]!.minutes, pay: "whole", person_id: me.value!.person.id })
    : preview("booking.request_courts", { courts: cart.map((x) => ({ court_id: x.court, starts_at: x.start, minutes: x.minutes })), person_id: me.value!.person.id });
  const book = () => weekly && pay === "whole" ? preview("booking.repeat_request", { court_id: court, starts_at: pick!.start, minutes, weeks, person_id: me.value!.person.id }) : preview("booking.request", { court_id: court, starts_at: pick!.start, minutes, pay, ...(pay === "split" ? { players } : {}), person_id: me.value!.person.id,
    ...(opened ? { open: { level_min: Number(om.min), level_max: Number(om.max), outside_band: om.ask ? "ask" : "closed", rated: om.rated, listed: om.listed, ...(om.gender ? { gender: om.gender } : {}) } } : {}) });
  const chosen = pick?.courts.find((c) => c.id === court);
  // Ready to book: a court with its price, and not adding to courts already chosen (those are booked together above).
  const ready = Boolean(pick && court && q?.priced && !cart.length);
  const sameDayOn = sameDay && pay === "split";

  if (done) return <main class="card done"><Illustration name="youre-in" size="s" /><h1>{t("ui.booked")}</h1><p>{matchId ? <a href={`/match/${matchId}`}>{t("ui.see_your_match")}</a> : <a href="/places">{t("ui.see_my_bookings")}</a>}</p></main>;
  return (
    <main class={ready ? "book has-bar" : "book"}>
      <h1>{t("ui.book_title")}</h1>
      <p class="meta lede">{t("ui.book_lede")}</p>
      {startMatch && <p class="note">{t("ui.start_match_book")}</p>}
      {sheet}
      {paying && <PaySheet paymentId={paying.id} amountCents={paying.cents} name={t("ui.court_booking")} detail={weeklyLaterLine(paying.later)} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); setDone(true); }} />}
      {paying && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => { await api(`/dev/payments/${paying.id}/settle`, {}); setPaying(null); setDone(true); }}>{t("ui.pay_test")}</button></p>}
      {o.locations.length > 1 && <label>{t("ui.location")}<select value={loc} onChange={(e) => { setLoc(e.currentTarget.value); setDay(""); }}>{o.locations.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>}
      <div class="days" role="group" aria-label={t("ui.day")}>{days.map((d) => {
        const at = `${d}T12:00:00Z`, f = (x: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: "UTC", ...x }).format(new Date(at));
        return <button type="button" class={d === day ? "day on" : "day"} aria-pressed={d === day} aria-label={f({ weekday: "long", day: "numeric", month: "long" })} onClick={() => setDay(d)}>
          <span>{f({ weekday: "short" })}</span><strong>{f({ day: "numeric" })}</strong><span>{f({ month: "short" })}</span></button>;
      })}</div>
      {o.lengths.length > 1 && <div class="seg-buttons" role="group" aria-label={t("ui.length")}>{o.lengths.map((m) => <button type="button" class={m === minutes ? "on" : undefined} aria-pressed={m === minutes} onClick={() => setMinutes(m)}>{t("ui.minutes", { count: m })}</button>)}</div>}
      {cart.length > 0 && <section class="card">
        <h2>{t("ui.courts_chosen")}</h2>
        <ul class="plain">{cart.map((x, k) => <li class="row"><span class="facts-line"><span class="fact"><Icon name="map-pin" />{x.name}</span><span class="fact"><Icon name="clock" />{fmt(x.start, { hour: "numeric", minute: "2-digit" })} · {t("ui.minutes", { count: x.minutes })}</span><span class="fact"><Icon name="tag" />{dollars(x.cents, lang.value)}</span></span>
          <button class="small" onClick={() => setCart(cart.filter((_, j) => j !== k))}>{t("ui.remove")}</button></li>)}</ul>
        <p class="meta">{t(o.late_refund_percent ? "ui.cancel_rule" : "ui.cancel_rule_none", { hours: t("count.hours", { count: o.free_cancel_hours }), percent: o.late_refund_percent })}</p>
        <NewOnly><button class="primary" onClick={bookCart}><Icon name="calendar-plus" />{cart.length === 1 ? t("ui.book_now") : t("ui.book_courts", { count: cart.length, amount: dollars(cartTotal, lang.value) })}</button></NewOnly>
      </section>}
      {free && !free.open && <p class="card">{t("ui.closed_this_day")}</p>}
      {free?.open && !times.length && <p class="card">{t("ui.no_free_times")}</p>}
      {times.length > 0 && <section aria-labelledby="times-title">
        <div class="section-head"><h2 id="times-title">{t("ui.book_start_time")}</h2><span class="meta">{t("ui.taken_struck")}</span></div>
        <div class="times" role="group" aria-labelledby="times-title">{slots.map((x) => {
          const label = fmt(x.start, { hour: "numeric", minute: "2-digit" }), on = pick?.start === x.start;
          return x.courts.length ? <button type="button" class={on ? "time on" : "time"} aria-pressed={on} onClick={() => choose(x)}>{label}</button>
            : <button type="button" class="time taken" disabled aria-label={t("ui.time_taken", { time: label })}><s>{label}</s></button>;
        })}</div>
      </section>}
      {pick && (
        <section aria-labelledby="courts-title">
          <h2 id="courts-title">{t("ui.free_at", { time: fmt(pick.start, { hour: "numeric", minute: "2-digit" }), length: t("ui.minutes", { count: minutes }) })}</h2>
          <div class="courts" role="group" aria-labelledby="courts-title">{pick.courts.map((c) => {
            const p = prices[c.id], on = c.id === court;
            return <button type="button" class={on ? "court on" : "court"} aria-pressed={on} onClick={() => setCourt(c.id)}>
              <span class="court-name"><strong>{c.name}</strong>{kindName(c.kind) && <span class="meta">{kindName(c.kind)}</span>}</span>
              <span class="court-price">{p ? (p.priced ? <><strong>{dollars(p.total_cents, lang.value)}</strong>{p.member && <span class="meta">{t("ui.member_price", { plan: p.member })}</span>}</> : <span class="meta">{t("error.no_price")}</span>) : "…"}</span>
            </button>;
          })}</div>
          {court && q && (q.priced ? <div class="card card-form">
            <p><strong>{chosen?.name}</strong> · <strong>{dollars(q.total_cents, lang.value)}</strong>{q.tax_cents ? <span class="meta"> · {t("ui.tax_included", { amount: dollars(q.tax_cents, lang.value), tax: club.value?.tax_label || t("ui.tax_word").toLowerCase() })}</span> : null}{q.member ? <span class="meta"> · {t("ui.member_price", { plan: q.member })}</span> : null}</p>
            {cart.length > 0 ? <button class="primary" onClick={add}>{t("ui.add_this_court")}</button> : <>
            {(canSplit || sameDay) && <fieldset>
              <legend>{t("ui.who_pays")}</legend>
              <div class="seg-buttons" role="group" aria-label={t("ui.who_pays")}>
                <button type="button" class={pay === "whole" ? "on" : undefined} aria-pressed={pay === "whole"} onClick={() => setPay("whole")}>{t("ui.pay_whole_short")}</button>
                {canSplit && <button type="button" class={pay === "split" ? "on" : undefined} aria-pressed={pay === "split"} onClick={() => setPay("split")}>{t("ui.pay_split_short")}</button>}
                {sameDay && <button type="button" class={sameDayOn ? "on" : undefined} aria-pressed={sameDayOn} onClick={() => { setPay("split"); setPlayers(4); setOpen(true); }}>{t("ui.pay_same_day_short")}</button>}
              </div>
            </fieldset>}
            {pay === "whole" && <p class="meta">{t("ui.pay_whole", { amount: dollars(q.total_cents, lang.value) })}</p>}
            {sameDayOn && <p class="meta">{t("ui.open_same_day")}</p>}
            {o.weekly && pay === "whole" && <>
              <label class="check"><input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.currentTarget.checked)} /> {t("ui.every_week")}</label>
              {weekly && <label>{t("ui.how_many_weeks")}<select value={weeks} onChange={(e) => setWeeks(Number(e.currentTarget.value))}>
                {Array.from({ length: o.weekly_max_weeks - 1 }, (_, k) => k + 2).map((n) => <option value={n}>{t("count.weeks", { count: n })}</option>)}</select></label>}
              {weekly && <p class="meta">{t("ui.weekly_member_hint", { hours: t("count.hours", { count: o.split_deadline_hours }) })}</p>}
            </>}
            {pay === "split" && <>
              {canSplit && <div class="chips" role="group" aria-label={t("ui.sharing")}>{[2, 4].map((n) => <button type="button" class={n === players ? "chip on" : "chip"} aria-pressed={n === players} onClick={() => setPlayers(n)}>{t("count.players", { count: n })}</button>)}</div>}
              <p class="meta">{t(opened ? "ui.open_explain" : "ui.split_explain", { mine: dollars(mine, lang.value), each: dollars(each, lang.value), hours: t("count.hours", { count: sameDay ? o.same_day_cutoff_hours : o.split_deadline_hours }) })}</p>
              {players === 4 && canSplit && <label class="check"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.currentTarget.checked)} /> {t("ui.open_to_others")}</label>}
              {opened && <fieldset>
                <legend>{t("ui.match_band", { level: myLevel === null ? t("ui.no_level_yet") : myLevel.toFixed(2) })}</legend>
                <div class="court-row"><label>{t("ui.from")}<input type="number" min={0.5} max={7} step={0.25} value={om.min} onInput={(e) => setOm({ ...om, min: e.currentTarget.value })} /></label>
                  <label>{t("ui.to")}<input type="number" min={0.5} max={7} step={0.25} value={om.max} onInput={(e) => setOm({ ...om, max: e.currentTarget.value })} /></label></div>
                <label class="check"><input type="checkbox" checked={om.ask} onChange={(e) => setOm({ ...om, ask: e.currentTarget.checked })} /> {t("ui.outside_can_ask")}</label>
                <label class="check"><input type="checkbox" checked={om.rated} onChange={(e) => setOm({ ...om, rated: e.currentTarget.checked })} /> {t("ui.match_counts")}</label>
                <label class="check"><input type="checkbox" checked={om.listed} onChange={(e) => setOm({ ...om, listed: e.currentTarget.checked })} /> {t("ui.list_on_play")}</label>
                <label>{t("ui.gender")}<select value={om.gender} onChange={(e) => setOm({ ...om, gender: e.currentTarget.value as typeof om.gender })}><option value="">{t("ui.gender_any")}</option>
                  {(["mixed", "women", "men"] as const).map((g) => <option value={g}>{t(`gender.${g}`)}</option>)}</select></label>
                <p class="meta">{t("ui.gender_hint")}</p>
              </fieldset>}
            </>}
            <p class="meta">{t(o.late_refund_percent ? "ui.cancel_rule" : "ui.cancel_rule_none", { hours: t("count.hours", { count: o.free_cancel_hours }), percent: o.late_refund_percent })}</p>
            {pay === "whole" && !weekly && <NewOnly quiet><button class="link" onClick={add}>{t("ui.add_another_court")}</button></NewOnly>}
            </>}
          </div> : <p class="meta">{t("error.no_price")}</p>)}
        </section>
      )}
      {/* Priority alert: tell me when a court frees up on this day, for a start in a window I pick. */}
      {free?.open && loc && day && <CourtAlert location={loc} date={day} tz={tz} open={free.open}
        dayLabel={new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T12:00:00Z`))} />}
      {/* The Book button, at the bottom of the screen above the tabs, with what it books. */}
      {ready && <div class="book-bar">
        <span class="book-bar-what"><strong>{fmt(pick!.start, { weekday: "short", day: "numeric", month: "short" })}, {fmt(pick!.start, { hour: "numeric", minute: "2-digit" })}</strong>
          <span>{chosen?.name} · {t("ui.minutes", { count: minutes })} · {pay === "whole" ? dollars(q!.total_cents, lang.value) : t("ui.your_part_now", { amount: dollars(mine, lang.value) })}</span></span>
        <NewOnly><button class="primary" onClick={book}><Icon name="calendar-plus" />{t("ui.book_now")}</button></NewOnly>
      </div>}
    </main>
  );
}
