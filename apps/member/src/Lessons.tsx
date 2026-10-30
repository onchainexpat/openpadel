// Private lessons: the coaches who take them, then a coach's free times on a day for a length, then who plays
// and who pays (all of it, or each player their part), and pay. Times are the club's; a time is only offered
// when the coach gives lessons then and a court is free. Loaded only when opened, to keep the app small.
import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, me, t, usePreview } from "@kumi/ui";
import { PaySheet } from "./Pay.tsx";

type Coach = { id: string; name: string; bio: string | null; level_min: string | null; level_max: string | null; languages: string[]; rates: Record<string, number>; photo: string | null; max_players: number };
type Data = { coaches: Coach[]; time_zone: string; split_deadline_hours: number; free_cancel_hours: number; late_refund_percent: number };
type Time = { start: string; location_id: string; court_ids: string[] };

const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
function Face({ c }: { c: Coach }) {
  return c.photo ? <img class="face" src={c.photo} alt="" loading="lazy" /> : <span class="face" aria-hidden="true">{initials(c.name)}</span>;
}

export function Lessons() {
  const [d, setD] = useState<Data | null>(null), [coach, setCoach] = useState<Coach | null>(null), [minutes, setMinutes] = useState(60), [day, setDay] = useState("");
  const [times, setTimes] = useState<Time[] | null>(null), [daysAhead, setDaysAhead] = useState(14), [pick, setPick] = useState<Time | null>(null);
  const [players, setPlayers] = useState(1), [pay, setPay] = useState<"whole" | "split">("whole");
  const [provider, setProvider] = useState("test"), [paying, setPaying] = useState<{ id: string; cents: number } | null>(null), [done, setDone] = useState(false);
  const { preview, sheet } = usePreview((r?: { payment_id?: string; total_cents?: number }) => { if (r?.payment_id) setPaying({ id: r.payment_id, cents: r.total_cents ?? 0 }); });
  useEffect(() => {
    api<Data>("/my/lessons/coaches").then(setD).catch(() => setD({ coaches: [], time_zone: "UTC", split_deadline_hours: 24, free_cancel_hours: 24, late_refund_percent: 0 }));
    api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {});
  }, []);
  // The first day the coach can be booked, once one is chosen (the club's today).
  useEffect(() => { if (coach && !day && d) setDay(new Intl.DateTimeFormat("en-CA", { timeZone: d.time_zone }).format(new Date())); }, [coach?.id]);
  useEffect(() => { if (coach && day) { setPick(null); setTimes(null); api<{ times: Time[]; days_ahead: number }>(`/my/lessons/times?coach_id=${coach.id}&date=${day}&minutes=${minutes}`).then((r) => { setTimes(r.times); setDaysAhead(r.days_ahead); }); } }, [coach?.id, day, minutes]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const zone = d.time_zone;
  const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: zone, ...o }).format(new Date(iso));
  const money = (c: number) => dollars(c, lang.value);
  const rateList = (c: Coach) => Object.entries(c.rates).sort((a, b) => Number(a[0]) - Number(b[0])).map(([m, cents]) => t("ui.lesson_rate", { minutes: t("ui.minutes", { count: Number(m) }), price: money(cents) })).join(" · ");
  const langs = (c: Coach) => c.languages.map((x) => t(x === "es" ? "ui.lang_es" : "ui.lang_en")).join(", ");
  if (done) return <main class="card"><h1>{t("ui.lesson_booked")}</h1><p><a href="/places">{t("ui.see_my_bookings")}</a></p></main>;

  if (!coach) return (
    <main>
      <h1>{t("ui.lessons_title")}</h1>
      {!d.coaches.length && <p class="card">{t("ui.lessons_none")}</p>}
      <ul class="changes">{d.coaches.map((c) => (
        <li class="card coach-card" key={c.id}>
          <Face c={c} />
          <div>
            <div class="summary">{c.name}</div>
            {c.bio && <p>{c.bio}</p>}
            <p class="meta">{[c.level_min && c.level_max ? t("ui.coach_levels", { min: c.level_min, max: c.level_max }) : "", t("ui.coach_languages", { langs: langs(c) })].filter(Boolean).join(" · ")}</p>
            <p class="meta">{rateList(c)}</p>
            <button class="primary" onClick={() => { setCoach(c); setMinutes(Number(Object.keys(c.rates).sort((a, b) => Number(a) - Number(b))[0])); setPlayers(1); setPay("whole"); }}>{t("ui.book_lesson")}</button>
          </div>
        </li>))}</ul>
    </main>
  );

  // The next days, in the club's time, up to how far ahead this member may book.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date()), days: string[] = [];
  for (let k = 0; k < Math.min(daysAhead, 30); k++) { const x = new Date(`${today}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); days.push(x.toISOString().slice(0, 10)); }
  const price = coach.rates[String(minutes)] ?? 0, each = Math.floor(price / Math.max(players, 1)), mine = price - each * (players - 1);
  const canSplit = players > 1 && pick ? new Date(pick.start).getTime() - Date.now() > d.split_deadline_hours * 3600_000 : false;
  const book = () => preview("lesson.request", { coach_id: coach.id, starts_at: pick!.start, minutes, court_id: pick!.court_ids[0], pay: canSplit ? pay : "whole", players, person_id: me.value!.person.id });
  return (
    <main>
      {sheet}
      {paying && <PaySheet paymentId={paying.id} amountCents={paying.cents} name={t("ui.private_lesson")} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); setDone(true); }} />}
      {paying && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => { await api(`/dev/payments/${paying.id}/settle`, {}); setPaying(null); setDone(true); }}>{t("ui.pay_test")}</button></p>}
      <p><button class="link" onClick={() => { setCoach(null); setDay(""); setTimes(null); }}>{t("ui.back_to_coaches")}</button></p>
      <section class="card coach-card"><Face c={coach} /><div><h1>{t("ui.lesson_with", { coach: coach.name })}</h1><p class="meta">{rateList(coach)}</p></div></section>
      <section class="card card-form">
        <div class="chips" role="group" aria-label={t("ui.length")}>{Object.keys(coach.rates).map(Number).sort((a, b) => a - b).map((m) =>
          <button type="button" class={m === minutes ? "chip on" : "chip"} onClick={() => setMinutes(m)}>{t("ui.minutes", { count: m })}</button>)}</div>
        <div class="chips scroll" role="group" aria-label={t("ui.day")}>{days.map((x) => <button type="button" class={x === day ? "chip on" : "chip"} onClick={() => setDay(x)}>{fmt(`${x}T12:00:00Z`, { weekday: "short", day: "numeric", timeZone: "UTC" })}</button>)}</div>
      </section>
      {times && !times.length && <p class="card">{t("ui.no_lesson_times", { coach: coach.name })}</p>}
      {times && times.length > 0 && !pick && <section class="card"><div class="chips">{times.map((x) => <button type="button" class="chip" onClick={() => { setPick(x); setPay("whole"); }}>{fmt(x.start, { hour: "numeric", minute: "2-digit" })}</button>)}</div></section>}
      {pick && (
        <section class="card card-form">
          <h2>{fmt(pick.start, { weekday: "long", day: "numeric", month: "long" })}, {fmt(pick.start, { hour: "numeric", minute: "2-digit" })} · {t("ui.minutes", { count: minutes })}</h2>
          <p><strong>{t("ui.lesson_price", { amount: money(price) })}</strong></p>
          {coach.max_players > 1 && <>
            <p class="meta">{t("ui.how_many_play")}</p>
            <div class="chips" role="group" aria-label={t("ui.how_many_play")}>{Array.from({ length: coach.max_players }, (_, k) => k + 1).map((n) =>
              <button type="button" class={n === players ? "chip on" : "chip"} onClick={() => { setPlayers(n); if (n === 1) setPay("whole"); }}>{t("count.players", { count: n })}</button>)}</div>
          </>}
          {canSplit && <>
            <label class="check"><input type="radio" name="lpay" checked={pay === "whole"} onChange={() => setPay("whole")} /> {t("ui.lesson_pay_whole", { amount: money(price) })}</label>
            <label class="check"><input type="radio" name="lpay" checked={pay === "split"} onChange={() => setPay("split")} /> {t("ui.lesson_pay_split", { each: money(each) })}</label>
            {pay === "split" && <p class="meta">{t("ui.lesson_split_explain", { mine: money(mine), hours: t("count.hours", { count: d.split_deadline_hours }) })}</p>}
          </>}
          <p class="meta">{t(d.late_refund_percent ? "ui.cancel_rule" : "ui.cancel_rule_none", { hours: t("count.hours", { count: d.free_cancel_hours }), percent: d.late_refund_percent })}</p>
          <button class="primary" onClick={book}>{t("ui.book_the_lesson")}</button>{" "}
          <button class="link" onClick={() => setPick(null)}>{t("ui.other_time")}</button>
        </section>
      )}
    </main>
  );
}
