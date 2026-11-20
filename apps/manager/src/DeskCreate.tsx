// + Create's private lesson and open match, made at the desk, in the Schedule's side panel like a court booking
// (NewBooking.tsx). Each fills in what the members' app asks for and previews before anything changes:
// - A private lesson: a coach who gives lessons, a length from their rates, a free time on the day, and one to four
//   players. The coach's rate is the price for everyone (members and anyone else), taxed like a court; the court is
//   picked by itself and named in the preview (booking.create_lesson).
// - An open match: a court and time, a host (a member), the level band and who outside it may ask, rated or a
//   friendly, and the places the desk already knows. Others at the level join in the app and pay there; not full by
//   the deadline, it's cancelled and everyone paid back (booking.create with `open`).
// Either way the desk holds no card: places marked paid are paid now, and what's left is owed at the desk.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { formatLocale } from "@kumi/i18n/format";
import { Skeleton, api, dollars, lang, serverNow, t } from "@kumi/ui";
import { blank, freeUntil, partsOf, PlaceRow, startsOn, type NbCourt, type Place } from "./NewBooking.tsx";
import { MATCH_GENDERS } from "./genders.ts";

type Preview = (action: string, input: unknown) => Promise<void>;
type Coach = { id: string; name: string; rates: Record<string, number>; max_players: number };
const HALF = 30 * 60_000, ms = (iso: string) => new Date(iso).getTime();
const filled = (p: Place) => Boolean(p.person || p.text.trim());
/** The places as the server takes them: a member, a guest's name (a lesson only), or open; and Paid where it has a part. */
const sent = (places: Place[], parts: number[], members: boolean) => places.map((p, n) => ({
  ...(p.person ? { person_id: p.person.id } : !members && p.text.trim() ? { guest_name: p.text.trim() } : {}),
  ...(p.paid && (p.person || (!members && p.text.trim())) && (parts[n] ?? 0) > 0 ? { paid: true } : {}) }));
const whenIn = (tz: string) => (at: number) => new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(at));
/** Each place's part of a lesson, as lessons.ts lessonParts: the whole to the organiser, or the total shared out. */
const lessonParts = (total: number, split: boolean, players: number) => {
  const each = Math.floor(total / players);
  return Array.from({ length: players }, (_, n) => (!split ? (n === 0 ? total : 0) : n === 0 ? total - each * (players - 1) : each));
};

/** Paid how, for the places marked paid, and Mark all paid: the desk's money, only for those who take it. */
function PaidHow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <label>{t("ui.paid_how")}<select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
    {["cash", "terminal", "other"].map((k) => <option value={k}>{t(`paid_by.${k}` as Key)}</option>)}</select></label>;
}
function Notes({ note, playerNote, onNote, onPlayerNote, playerLabel }: { note: string; playerNote: string; onNote: (v: string) => void; onPlayerNote: (v: string) => void; playerLabel?: string }) {
  return <>
    <label>{t("ui.nb_staff_note")}<textarea rows={2} maxLength={200} value={note} onInput={(e) => onNote(e.currentTarget.value)} /></label>
    <label>{playerLabel ?? t("ui.nb_player_note")}<textarea rows={2} maxLength={200} value={playerNote} onInput={(e) => onPlayerNote(e.currentTarget.value)} /></label>
  </>;
}

export function DeskLesson({ loc, date, tz, clock, money, people, may, preview, onClose }: { loc: string; date: string; tz: string; clock: (s: string | number) => string;
  money: boolean; people: boolean; may: (action: string) => boolean; preview: Preview; onClose: () => void }) {
  const [coaches, setCoaches] = useState<Coach[] | null>(null), [deadline, setDeadline] = useState(24);
  const [f, setF] = useState({ coach: "", minutes: 0, day: date, start: "", players: 1, split: false, method: "cash", note: "", playerNote: "" });
  const [times, setTimes] = useState<string[] | null>(null), [places, setPlaces] = useState<Place[]>([blank(), blank(), blank(), blank()]);
  useEffect(() => { api<{ coaches: Coach[]; split_deadline_hours: number }>("/staff/lesson-coaches").then((x) => { setCoaches(x.coaches); setDeadline(x.split_deadline_hours);
    const c = x.coaches[0]; if (c) setF((was) => ({ ...was, coach: c.id, minutes: lengthsOf(c)[0] ?? 0 })); }).catch(() => setCoaches([])); }, []);
  const coach = coaches?.find((c) => c.id === f.coach);
  useEffect(() => {
    setTimes(null);
    if (!f.coach || !f.minutes || !f.day) return;
    api<{ times: string[] }>(`/staff/lesson-times?coach_id=${f.coach}&date=${f.day}&minutes=${f.minutes}&location_id=${loc}`)
      .then((x) => { const ts = x.times.filter((s) => ms(s) > serverNow()); setTimes(ts); setF((was) => ({ ...was, start: ts.includes(was.start) ? was.start : ts[0] ?? "" })); }).catch(() => setTimes([]));
  }, [f.coach, f.minutes, f.day, loc]);
  if (!coaches) return <Skeleton shape="rows" rows={3} />;
  if (!coaches.length) return <section><h2>{t("ui.dc_lesson_title")}</h2><p class="meta">{t("ui.dc_no_coaches")}</p><button type="button" class="link" onClick={onClose}>{t("ui.cancel")}</button></section>;

  const total = coach?.rates[String(f.minutes)] ?? 0, max = Math.min(4, coach?.max_players ?? 1), players = Math.min(f.players, max);
  const inTime = f.start ? ms(f.start) - deadline * 3600_000 > serverNow() : false, org = places[0]!;
  const split = f.split && players > 1 && inTime;
  const parts = lessonParts(total, split, players), takesMoney = money && may("booking.record_payment");
  const set = (n: number, p: Partial<Place>) => setPlaces(places.map((x, k) => (k === n ? { ...x, ...p } : x)));
  const submit = (e: Event) => {
    e.preventDefault();
    const s = sent(places.slice(0, players), parts, false);
    void preview("booking.create_lesson", { coach_id: f.coach, starts_at: f.start, minutes: f.minutes, location_id: loc, pay: split ? "split" : "whole", places: s,
      ...(s.some((p) => p.paid) ? { paid_method: f.method } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}), ...(f.playerNote.trim() ? { player_note: f.playerNote.trim() } : {}) });
  };
  return (
    <form class="card card-form nb" onSubmit={submit} aria-labelledby="dc-lesson-title">
      <h2 id="dc-lesson-title">{t("ui.dc_lesson_title")}</h2>
      <div class="nb-when">
        <label>{t("ui.dc_coach")}<select value={f.coach} onChange={(e) => { const c = coaches.find((x) => x.id === e.currentTarget.value)!; setF({ ...f, coach: c.id, minutes: lengthsOf(c).includes(f.minutes) ? f.minutes : lengthsOf(c)[0] ?? 0 }); }}>
          {coaches.map((c) => <option value={c.id}>{c.name}</option>)}</select></label>
        <label>{t("ui.dc_length")}<select value={String(f.minutes)} onChange={(e) => setF({ ...f, minutes: Number(e.currentTarget.value) })}>
          {coach && lengthsOf(coach).map((m) => <option value={String(m)}>{money ? `${t("ui.minutes", { count: m })} · ${dollars(coach.rates[String(m)]!, lang.value)}` : t("ui.minutes", { count: m })}</option>)}</select></label>
      </div>
      <div class="nb-when">
        <label>{t("ui.day")}<input type="date" value={f.day} onInput={(e) => setF({ ...f, day: e.currentTarget.value })} /></label>
        <label>{t("ui.starts")}<select value={f.start} disabled={!times?.length} onChange={(e) => setF({ ...f, start: e.currentTarget.value })}>
          {(times ?? []).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      </div>
      {times === null ? <Skeleton shape="line" /> : !times.length ? <p class="note">{t("ui.dc_no_times")}</p> : <p class="meta">{t("ui.dc_court_auto")}</p>}

      <fieldset class="nb-pay"><legend>{t("ui.nb_payment")}</legend>
        <p class="dc-label" id="dc-players">{t("ui.dc_players_count")}</p>
        <div class="seg-toggle" role="group" aria-labelledby="dc-players">
          {[1, 2, 3, 4].filter((n) => n <= max).map((n) => <button type="button" aria-pressed={players === n} aria-label={t("count.players", { count: n })} onClick={() => setF({ ...f, players: n })}>{n}</button>)}
        </div>
        {players > 1 && <div class="seg-toggle" role="group" aria-label={t("ui.nb_who_pays")}>
          <button type="button" aria-pressed={!split} onClick={() => setF({ ...f, split: false })}>{t("ui.dc_whole_lesson")}</button>
          <button type="button" aria-pressed={split} disabled={!inTime} onClick={() => setF({ ...f, split: true })}>{t("ui.nb_split")}</button>
        </div>}
        {players > 1 && <p class="meta">{!inTime && f.start ? t("ui.nb_split_late", { count: deadline }) : split ? t("ui.nb_split_note", { when: whenIn(tz)(ms(f.start) - deadline * 3600_000) }) : t("ui.dc_lesson_whole_note")}</p>}
        {split && !org.person && <p class="note">{t("ui.nb_split_member")}</p>}
        {money && total > 0 && <p>{t("ui.dc_lesson_price")} <strong>{dollars(total, lang.value)}</strong> <span class="meta">{t("ui.dc_same_price")}</span></p>}
      </fieldset>

      <fieldset class="nb-players"><legend>{t("ui.players_title")}</legend>
        {takesMoney && <p><button type="button" class="small" onClick={() => setPlaces(places.map((p, n) => ({ ...p, paid: n < players && filled(p) && (parts[n] ?? 0) > 0 })))}>{t("ui.nb_mark_all")}</button></p>}
        {places.slice(0, players).map((p, n) => <PlaceRow n={n} p={p} people={people} price={money ? parts[n]! : null} paidOk={takesMoney}
          taken={places.flatMap((x, k) => (k !== n && x.person ? [x.person.id] : []))} onChange={(x) => set(n, x)} />)}
        {split && <p class="meta">{t("ui.dc_lesson_open_help")}</p>}
        {takesMoney && places.slice(0, players).some((p, n) => p.paid && filled(p) && (parts[n] ?? 0) > 0) && <PaidHow value={f.method} onChange={(v) => setF({ ...f, method: v })} />}
      </fieldset>
      <Notes note={f.note} playerNote={f.playerNote} onNote={(v) => setF({ ...f, note: v })} onPlayerNote={(v) => setF({ ...f, playerNote: v })} />
      <button class="primary" disabled={!f.start || !f.minutes || !filled(org) || (split && !org.person)}>{t("ui.preview")}</button>
      <button type="button" class="link" onClick={onClose}>{t("ui.cancel")}</button>
    </form>
  );
}
const lengthsOf = (c: Coach) => Object.keys(c.rates).map(Number).sort((a, b) => a - b);

type Quoted = { total_cents: number; priced: boolean; split_deadline_hours?: number; same_day_cutoff_hours?: number };
const LEVELS = Array.from({ length: 14 }, (_, n) => (n + 1) / 2);   // 0.5 to 7, as the members' app offers a band

export function DeskMatch({ courts, court, start, tz, clock, money, people, may, preview, onClose }: { courts: NbCourt[]; court: NbCourt; start: string; tz: string;
  clock: (s: string | number) => string; money: boolean; people: boolean; may: (action: string) => boolean; preview: Preview; onClose: () => void }) {
  const firstEnd = (c: NbCourt, s: string) => new Date(ms(s) + Math.min(90 * 60_000, Math.floor((freeUntil(c, s) - ms(s)) / HALF) * HALF)).toISOString();
  const [f, setF] = useState({ court: court.id, start, end: firstEnd(court, start), min: 2.5, max: 3.5, outside: "ask", rated: true, listed: true, method: "cash", note: "", matchNote: "", gender: "" });
  const [places, setPlaces] = useState<Place[]>([blank(), blank(), blank(), blank()]), [quoted, setQuoted] = useState<Quoted | null>(null);
  const c = courts.find((x) => x.id === f.court) ?? court, minutes = Math.round((ms(f.end) - ms(f.start)) / 60_000), org = places[0]!;
  const ends: string[] = [];
  for (let e = ms(f.start) + HALF; e <= Math.min(freeUntil(c, f.start), ms(f.start) + 8 * 3600_000); e += HALF) ends.push(new Date(e).toISOString());
  useEffect(() => {
    if (f.start && minutes > 0) api<Quoted>(`/staff/quote?court_id=${f.court}&starts_at=${encodeURIComponent(f.start)}&minutes=${minutes}${org.person ? `&person_id=${org.person.id}` : ""}`)
      .then(setQuoted).catch(() => setQuoted(null));
  }, [f.court, f.start, f.end, org.person?.id]);
  if (!people) return <section><h2>{t("ui.dc_match_title")}</h2><p class="meta">{t("ui.dc_match_people")}</p><button type="button" class="link" onClick={onClose}>{t("ui.cancel")}</button></section>;

  const price = quoted?.total_cents ?? 0, parts = partsOf(price, true), takesMoney = money && may("booking.record_payment");
  // Not full by its deadline it's off: the club's "pay my part" deadline, or, opened after it, the same-day cutoff.
  const split = (quoted?.split_deadline_hours ?? 24) * 3600_000, cut = (quoted?.same_day_cutoff_hours ?? 2) * 3600_000, ahead = ms(f.start) - serverNow();
  const deadline = ahead > split ? ms(f.start) - split : ms(f.start) - cut, tooLate = ahead <= cut;
  const pickCourt = (id: string) => { const n = courts.find((x) => x.id === id)!, s = startsOn(n), keep = s.includes(f.start) ? f.start : s.find((x) => ms(x) >= ms(f.start)) ?? s[0] ?? "";
    setF({ ...f, court: id, start: keep, end: keep ? firstEnd(n, keep) : "" }); };
  const pickStart = (s: string) => setF({ ...f, start: s, end: ms(f.end) > ms(s) && ms(f.end) <= freeUntil(c, s) ? f.end : firstEnd(c, s) });
  const set = (n: number, p: Partial<Place>) => setPlaces(places.map((x, k) => (k === n ? { ...x, ...p } : x)));
  const submit = (e: Event) => {
    e.preventDefault();
    const s = sent(places, parts, true);
    void preview("booking.create", { court_id: f.court, starts_at: f.start, minutes, pay: "split", places: s, ...(s.some((p) => p.paid) ? { paid_method: f.method } : {}),
      ...(f.note.trim() ? { note: f.note.trim() } : {}),
      open: { level_min: f.min, level_max: f.max, outside_band: f.outside, rated: f.rated, listed: f.listed, ...(f.matchNote.trim() ? { note: f.matchNote.trim() } : {}), ...(f.gender ? { gender: f.gender } : {}) } });
  };
  const level = (v: number) => v.toFixed(1);
  return (
    <form class="card card-form nb" onSubmit={submit} aria-labelledby="dc-match-title">
      <h2 id="dc-match-title">{t("ui.dc_match_title")}</h2>
      <div class="nb-when">
        <label>{t("ui.court_label")}<select value={f.court} onChange={(e) => pickCourt(e.currentTarget.value)}>{courts.filter((x) => startsOn(x).length).map((x) => <option value={x.id}>{x.name}</option>)}</select></label>
        <label>{t("ui.starts")}<select value={f.start} onChange={(e) => pickStart(e.currentTarget.value)}>{startsOn(c).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
        <label>{t("ui.ends")}<select value={f.end} onChange={(e) => setF({ ...f, end: e.currentTarget.value })}>{ends.map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      </div>
      {minutes > 0 && <p class="meta">{t("ui.minutes", { count: minutes })}</p>}

      <fieldset class="nb-pay"><legend>{t("ui.dc_level_band")}</legend>
        <div class="nb-when">
          <label>{t("ui.dc_level_from")}<select value={String(f.min)} onChange={(e) => { const v = Number(e.currentTarget.value); setF({ ...f, min: v, max: Math.max(v, f.max) }); }}>
            {LEVELS.map((v) => <option value={String(v)}>{level(v)}</option>)}</select></label>
          <label>{t("ui.dc_level_to")}<select value={String(f.max)} onChange={(e) => { const v = Number(e.currentTarget.value); setF({ ...f, max: v, min: Math.min(v, f.min) }); }}>
            {LEVELS.map((v) => <option value={String(v)}>{level(v)}</option>)}</select></label>
        </div>
        <label>{t("ui.dc_outside")}<select value={f.outside} onChange={(e) => setF({ ...f, outside: e.currentTarget.value })}>
          <option value="ask">{t("ui.dc_outside_ask")}</option><option value="closed">{t("ui.dc_outside_closed")}</option></select></label>
        <div class="seg-toggle" role="group" aria-label={t("ui.dc_counts")}>
          <button type="button" aria-pressed={f.rated} onClick={() => setF({ ...f, rated: true })}>{t("ui.dc_rated")}</button>
          <button type="button" aria-pressed={!f.rated} onClick={() => setF({ ...f, rated: false })}>{t("ui.dc_friendly")}</button>
        </div>
        <label class="check"><input type="checkbox" checked={f.listed} onChange={(e) => setF({ ...f, listed: e.currentTarget.checked })} /> {t("ui.dc_listed")}</label>
        <label>{t("ui.gender")}<select value={f.gender} onChange={(e) => setF({ ...f, gender: e.currentTarget.value })}><option value="">{t("ui.gender_any")}</option>
          {MATCH_GENDERS.map((g) => <option value={g}>{t(`gender.${g}` as Key)}</option>)}</select></label>
        <p class="meta">{t("ui.gender_hint")}</p>
      </fieldset>

      <fieldset class="nb-pay"><legend>{t("ui.nb_payment")}</legend>
        {money && quoted && <p>{t("ui.nb_each_price")} <strong>{dollars(parts[1]!, lang.value)}</strong> <span class="meta">{quoted.priced ? t("ui.quoted_price", { amount: dollars(price, lang.value) }) : t("ui.no_price_then")}</span></p>}
        <p class="meta">{tooLate ? t("ui.dc_match_late", { count: Math.round(cut / 3600_000) }) : t("ui.dc_match_deadline", { when: whenIn(tz)(deadline) })}</p>
      </fieldset>

      <fieldset class="nb-players"><legend>{t("ui.players_title")}</legend>
        {takesMoney && <p><button type="button" class="small" onClick={() => setPlaces(places.map((p, n) => ({ ...p, paid: Boolean(p.person) && (parts[n] ?? 0) > 0 })))}>{t("ui.nb_mark_all")}</button></p>}
        <div class="nb-team" role="group" aria-label={t("ui.nb_team_a")}><h3>{t("ui.nb_team_a")}</h3>
          {[0, 1].map((n) => <PlaceRow n={n} p={places[n]!} people membersOnly first={t("ui.dc_host")} price={money ? parts[n]! : null} paidOk={takesMoney}
            taken={places.flatMap((x, k) => (k !== n && x.person ? [x.person.id] : []))} onChange={(x) => set(n, x)} />)}</div>
        <div class="nb-team" role="group" aria-label={t("ui.nb_team_b")}><h3>{t("ui.nb_team_b")}</h3>
          {[2, 3].map((n) => <PlaceRow n={n} p={places[n]!} people membersOnly price={money ? parts[n]! : null} paidOk={takesMoney}
            taken={places.flatMap((x, k) => (k !== n && x.person ? [x.person.id] : []))} onChange={(x) => set(n, x)} />)}</div>
        <p class="meta">{t("ui.dc_match_places_help")}</p>
        {takesMoney && places.some((p, n) => p.paid && p.person && (parts[n] ?? 0) > 0) && <PaidHow value={f.method} onChange={(v) => setF({ ...f, method: v })} />}
      </fieldset>
      <Notes note={f.note} playerNote={f.matchNote} onNote={(v) => setF({ ...f, note: v })} onPlayerNote={(v) => setF({ ...f, matchNote: v })} playerLabel={t("ui.dc_match_note")} />
      <button class="primary" disabled={!f.start || minutes <= 0 || !org.person || tooLate}>{t("ui.preview")}</button>
      <button type="button" class="link" onClick={onClose}>{t("ui.cancel")}</button>
    </form>
  );
}
