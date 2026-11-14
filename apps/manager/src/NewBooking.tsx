// A court booked at the desk, from the Schedule (tapping free time, or + Create): the court, its start and end, the
// whole court or each player their part, up to four places in two teams (a member found by name, phone or email, or a
// guest's name), each place's price and whether it was just paid at the desk, and two notes: the staff's own and one the
// players see. Nothing changes here: the preview names the charge, who pays what and, each their part, the deadline.
// What a role sees follows the Schedule's rules: no people search for a role that can't read people (a guest's name
// only), and no prices, other price or "Mark paid" for one that doesn't take money at the desk.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { amountPattern, formatLocale, parseDollars } from "@kumi/i18n/format";
import { api, dollars, lang, serverNow, t } from "@kumi/ui";
import { courtSlots } from "./open_times.ts";

type Open = { opens: string; closes: string } | null;
export type NbCourt = { id: string; name: string; open: Open; items: { start: string; end: string }[] };
export type Person = { id: string; display_name: string };
export type Place = { person: Person | null; text: string; paid: boolean };
type Quoted = { total_cents: number; tax_cents: number; priced: boolean; member: string | null; split_deadline_hours?: number };
const HALF = 30 * 60_000, MAX_MINUTES = 480;
const ms = (iso: string) => new Date(iso).getTime();
export const blank = (): Place => ({ person: null, text: "", paid: false });

/** Each place's part of the court, as the server works it out (bookings.ts deskParts): the whole court is the
 *  organiser's; each their part is four equal parts, the organiser taking the odd cents. */
export function partsOf(price: number, split: boolean): number[] {
  if (!split) return [price, 0, 0, 0];
  const each = Math.floor(price / 4);
  return [price - each * 3, each, each, each];
}
/** Where a court is free from a start on: until the next thing on it, or its closing. */
export function freeUntil(c: NbCourt, start: string): number {
  const close = c.open ? ms(c.open.closes) : ms(start);
  return Math.min(close, ...c.items.filter((it) => ms(it.end) > ms(start)).map((it) => Math.max(ms(it.start), ms(start))));
}
/** The starts a court offers: every half hour it's open, still to come, with at least half an hour free after it. */
export function startsOn(c: NbCourt): string[] {
  return courtSlots(c.open).filter((s) => ms(s) > serverNow() && freeUntil(c, s) - ms(s) >= HALF);
}

export function NewBooking({ courts, court, start, weekly, clock, tz, money, people, may, preview, onClose }: { courts: NbCourt[]; court: NbCourt; start: string; weekly: boolean;
  clock: (s: string | number) => string; tz: string; money: boolean; people: boolean; may: (action: string) => boolean; preview: (action: string, input: unknown) => Promise<void>; onClose: () => void }) {
  const firstEnd = (c: NbCourt, s: string) => { const room = Math.min(freeUntil(c, s) - ms(s), MAX_MINUTES * 60_000); return new Date(ms(s) + Math.min(90 * 60_000, Math.floor(room / HALF) * HALF)).toISOString(); };
  const [f, setF] = useState({ court: court.id, start, end: firstEnd(court, start), split: false, weekly, weeks: 8, price: "", method: "cash", note: "", playerNote: "" });
  const [places, setPlaces] = useState<Place[]>([blank(), blank(), blank(), blank()]);
  const [quoted, setQuoted] = useState<Quoted | null>(null);
  const c = courts.find((x) => x.id === f.court) ?? court, minutes = Math.round((ms(f.end) - ms(f.start)) / 60_000);
  const starts = startsOn(c), ends: string[] = [];
  for (let e = ms(f.start) + HALF; e <= Math.min(freeUntil(c, f.start), ms(f.start) + MAX_MINUTES * 60_000); e += HALF) ends.push(new Date(e).toISOString());
  const org = places[0]!;
  useEffect(() => {
    if (f.start && minutes > 0) api<Quoted>(`/staff/quote?court_id=${f.court}&starts_at=${encodeURIComponent(f.start)}&minutes=${minutes}${org.person ? `&person_id=${org.person.id}` : ""}`)
      .then(setQuoted).catch(() => setQuoted(null));
  }, [f.court, f.start, f.end, org.person?.id]);

  // Each their part: there must be time before the deadline, and a member as organiser (what's unpaid is theirs).
  const hours = quoted?.split_deadline_hours ?? 24, deadline = ms(f.start) - hours * 3600_000, inTime = deadline > serverNow();
  const split = f.split && inTime && !f.weekly;
  const takesMoney = money && may("booking.record_payment");
  const typed = f.price ? parseDollars(f.price) : null;
  const price = typed ?? quoted?.total_cents ?? 0, parts = partsOf(price, split);
  const pickCourt = (id: string) => { const n = courts.find((x) => x.id === id)!, s = startsOn(n), keep = s.includes(f.start) ? f.start : s.find((x) => ms(x) >= ms(f.start)) ?? s[0] ?? "";
    setF({ ...f, court: id, start: keep, end: keep ? firstEnd(n, keep) : "" }); };
  const pickStart = (s: string) => { const room = freeUntil(c, s); setF({ ...f, start: s, end: ms(f.end) > ms(s) && ms(f.end) <= room ? f.end : firstEnd(c, s) }); };
  const set = (n: number, p: Partial<Place>) => setPlaces(places.map((x, k) => (k === n ? { ...x, ...p } : x)));
  const filled = (p: Place) => Boolean(p.person || p.text.trim());
  const when = (at: number) => new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(at));

  const submit = (e: Event) => {
    e.preventDefault();
    const priceIn = takesMoney && typed !== null ? { price_cents: typed } : {};
    // The same court every week for a member (booking_series.ts): each week its own booking, owed at the desk.
    if (f.weekly && org.person) return void preview("booking.repeat", { court_id: f.court, starts_at: f.start, minutes, person_id: org.person.id, weeks: f.weeks, ...priceIn });
    const sent = places.map((p, n) => ({ ...(p.person ? { person_id: p.person.id } : p.text.trim() ? { guest_name: p.text.trim() } : {}), ...(p.paid && filled(p) && parts[n]! > 0 ? { paid: true } : {}) }));
    void preview("booking.create", { court_id: f.court, starts_at: f.start, minutes, pay: split ? "split" : "whole", places: sent, ...priceIn,
      ...(sent.some((p) => p.paid) ? { paid_method: f.method } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}), ...(f.playerNote.trim() ? { player_note: f.playerNote.trim() } : {}) });
  };

  const placeRow = (n: number) => <PlaceRow n={n} p={places[n]!} people={people} price={money ? parts[n]! : null} paidOk={takesMoney} taken={places.flatMap((x, k) => (k !== n && x.person ? [x.person.id] : []))}
    onChange={(p) => set(n, p)} />;
  return (
    <form class="card card-form nb" onSubmit={submit} aria-labelledby="nb-title">
      <h2 id="nb-title">{t("ui.nb_title")}</h2>
      <div class="nb-when">
        <label>{t("ui.court_label")}<select value={f.court} onChange={(e) => pickCourt(e.currentTarget.value)}>{courts.filter((x) => startsOn(x).length).map((x) => <option value={x.id}>{x.name}</option>)}</select></label>
        <label>{t("ui.starts")}<select value={f.start} onChange={(e) => pickStart(e.currentTarget.value)}>{starts.map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
        <label>{t("ui.ends")}<select value={f.end} onChange={(e) => setF({ ...f, end: e.currentTarget.value })}>{ends.map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      </div>
      {minutes > 0 && <p class="meta">{t("ui.minutes", { count: minutes })}</p>}

      {!f.weekly && <fieldset class="nb-pay"><legend>{t("ui.nb_payment")}</legend>
        <div class="seg-toggle" role="group" aria-label={t("ui.nb_who_pays")}>
          <button type="button" aria-pressed={!split} onClick={() => setF({ ...f, split: false })}>{t("ui.nb_whole")}</button>
          <button type="button" aria-pressed={split} disabled={!inTime} onClick={() => setF({ ...f, split: true })}>{t("ui.nb_split")}</button>
        </div>
        <p class="meta">{!inTime ? t("ui.nb_split_late", { count: hours }) : split ? t("ui.nb_split_note", { when: when(deadline) }) : t("ui.nb_whole_note")}</p>
        {split && !org.person && <p class="note">{t("ui.nb_split_member")}</p>}
        {money && quoted && <p>{t(split ? "ui.nb_each_price" : "ui.nb_court_price")} <strong>{dollars(split ? parts[1]! : price, lang.value)}</strong>
          {" "}<span class="meta">{typed !== null ? t("ui.nb_price_typed") : quoted.priced ? t("ui.quoted_price", { amount: dollars(quoted.total_cents, lang.value) }) : t("ui.no_price_then")}
            {quoted.member ? ` · ${t("ui.member_price", { plan: quoted.member })}` : ""}</span></p>}
        {takesMoney && <label>{t("ui.price_override")}<input inputMode="decimal" pattern={amountPattern()} title={t("ui.amount_format")} value={f.price}
          placeholder={quoted ? dollars(quoted.total_cents, lang.value) : ""} onInput={(e) => setF({ ...f, price: e.currentTarget.value })} /></label>}
      </fieldset>}

      <fieldset class="nb-players"><legend>{t("ui.players_title")}</legend>
        {takesMoney && !f.weekly && <p><button type="button" class="small" onClick={() => setPlaces(places.map((p, n) => ({ ...p, paid: filled(p) && parts[n]! > 0 })))}>{t("ui.nb_mark_all")}</button></p>}
        <div class="nb-team" role="group" aria-label={t("ui.nb_team_a")}><h3>{t("ui.nb_team_a")}</h3>{placeRow(0)}{!f.weekly && placeRow(1)}</div>
        {!f.weekly && <div class="nb-team" role="group" aria-label={t("ui.nb_team_b")}><h3>{t("ui.nb_team_b")}</h3>{placeRow(2)}{placeRow(3)}</div>}
        {!f.weekly && <p class="meta">{t(takesMoney ? "ui.nb_places_help" : "ui.nb_places_help_open")}</p>}
        {takesMoney && places.some((p, n) => p.paid && filled(p) && parts[n]! > 0) && !f.weekly && <label>{t("ui.paid_how")}<select value={f.method} onChange={(e) => setF({ ...f, method: e.currentTarget.value })}>
          {["cash", "terminal", "other"].map((k) => <option value={k}>{t(`paid_by.${k}` as Key)}</option>)}</select></label>}
      </fieldset>

      {org.person && may("booking.repeat") && <label class="check"><input type="checkbox" checked={f.weekly} onChange={(e) => setF({ ...f, weekly: e.currentTarget.checked })} /> {t("ui.every_week")}</label>}
      {!org.person && f.weekly && <p class="meta">{t("ui.weekly_needs_member")}</p>}
      {f.weekly && org.person && <label>{t("ui.how_many_weeks")}<input type="number" min="2" max="26" step="1" value={String(f.weeks)} onChange={(e) => setF({ ...f, weeks: Math.max(2, Math.min(26, Math.round(Number(e.currentTarget.value) || 8))) })} /></label>}

      {!f.weekly && <>
        <label>{t("ui.nb_staff_note")}<textarea rows={2} maxLength={200} value={f.note} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} /></label>
        <label>{t("ui.nb_player_note")}<textarea rows={2} maxLength={200} value={f.playerNote} onInput={(e) => setF({ ...f, playerNote: e.currentTarget.value })} /></label>
      </>}
      <button class="primary" disabled={!f.start || minutes <= 0 || !filled(org) || (split && !org.person) || (f.weekly && !org.person) || (typed === null && Boolean(f.price))}>{t("ui.preview")}</button>
      <button type="button" class="link" onClick={onClose}>{t("ui.cancel")}</button>
    </form>
  );
}

/** One place: a member found by name, phone or email (for a role that reads people), or what's typed as a guest's name;
 *  its part of the price, and Mark paid. */
export function PlaceRow({ n, p, people, price, paidOk, taken, onChange, membersOnly, first }: { n: number; p: Place; people: boolean; price: number | null; paidOk: boolean; taken: string[];
  onChange: (p: Partial<Place>) => void; membersOnly?: boolean; first?: string }) {
  const [found, setFound] = useState<Person[]>([]);
  const id = `nb-place-${n}`;
  const find = async (v: string) => {
    onChange(v.trim() ? { text: v } : { text: v, paid: false });
    if (!people) return;
    setFound(v.trim().length > 1 ? (await api<Person[]>(`/staff/people?q=${encodeURIComponent(v.trim())}`).catch(() => [])).filter((x) => !taken.includes(x.id)) : []);
  };
  const label = n === 0 ? first ?? t("ui.nb_organiser") : t("ui.nb_player_n", { n: n + 1 });
  return (
    <div class="nb-place">
      <div class="nb-who">
        <label for={id}>{label}</label>
        {p.person ? <p class="row"><strong>{p.person.display_name}</strong> <button type="button" class="link" onClick={() => onChange({ person: null, text: "", paid: false })}>{t("ui.change")}</button></p>
          : people ? <input id={id} type="search" maxLength={80} autocomplete="off" placeholder={t("ui.nb_find")} value={p.text} onInput={(e) => void find(e.currentTarget.value)} />
            : <input id={id} maxLength={80} autocomplete="off" placeholder={t("ui.nb_guest_name")} value={p.text} onInput={(e) => void find(e.currentTarget.value)} />}
        {!p.person && found.length > 0 && <ul class="plain nb-found">{found.slice(0, 6).map((x) => <li class="row"><span>{x.display_name}</span>
          <button type="button" class="small" onClick={() => { setFound([]); onChange({ person: x, text: "" }); }}>{t("ui.choose")}</button></li>)}</ul>}
        {!p.person && p.text.trim() && <span class="meta">{t(membersOnly ? "ui.dc_pick_member" : "ui.nb_as_guest")}</span>}
      </div>
      {price !== null && <span class="nb-price">{dollars(price, lang.value)}</span>}
      {paidOk && price !== null && price > 0 && <button type="button" class={`small nb-paid${p.paid ? " on" : ""}`} aria-pressed={p.paid} disabled={!p.person && (membersOnly || !p.text.trim())}
        onClick={() => onChange({ paid: !p.paid })}>{t(p.paid ? "ui.nb_paid" : "ui.nb_mark_paid")}</button>}
    </div>
  );
}
