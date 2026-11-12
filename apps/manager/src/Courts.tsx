// The courts on one day, as the desk sees them: a column per court with the time down the side, what's on now
// and next, and the alerts that need someone. Drag a booking (or a program date) to another time or court, or
// drag its bottom edge to make it longer or shorter: every drop opens the preview before anything changes, and
// the same changes are on buttons and keys for anyone not dragging. Times are the location's, whatever the
// device's clock says.
import { useEffect, useRef, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import type { Key } from "@kumi/i18n";
import { amountPattern, parseDollars, formatLocale, weekOrder } from "@kumi/i18n/format";
import { api, club, coversLocation, dollars, lang, lazyPage, mayCreate, mayDo, me, t, usePreview, serverNow, useBackCloses } from "@kumi/ui";
import { courtSlots, lengthsFitting, spanOfCourts } from "./open_times.ts";
import { playtomicParts } from "./paid_line.ts";
import { dayStats, kindOf, type Kind } from "./day_stats.ts";
import { NARROW, useDrawer, useMedia } from "./drawer.ts";

// The desk's payment form comes when someone taps Record payment, so the first screen doesn't carry it.
const DeskPay = lazyPage(() => import("./DeskPay.tsx").then((m) => m.DeskPay));

type Empty = { id: string; name: string; open: boolean };
type Late = { name: string; minutes: number; at: string };
type Seat = { id: string; name: string; booker: boolean };
/** `who` and `players` on a Playtomic copy: who booked it and plays in it, from the club's archive, only for staff who
 *  read people (never a coach on their own, never a member whose account was deleted here). */
export type Item = { start: string; end: string; kind: string; booking_id?: string; code?: string; who?: string; price_cents?: number; paid_cents?: number; off_cents?: number; pt_cents?: number; balance_cents?: number; booking_kind?: string;
  open_match?: boolean; coach?: string | null; status?: string; players?: string[]; late?: Late[]; whole?: boolean; invite_code?: string | null; seats?: Seat[]; block_id?: string; series?: boolean; session_id?: string;
  program_id?: string; program_kind?: string | null; label?: string; empty_places?: Empty[] };
// `open`: that court's own hours that day (they can differ from the location's); null when it's closed all day.
export type Court = { id: string; name: string; kind: string; open: { opens: string; closes: string } | null; items: Item[] };
/** `money` false: a reader who doesn't see what members paid (a coach on their own lesson, a role the club made covering
 *  bookings only): the server leaves out each booking's price, paid, promo, Playtomic and balance, and the page shows
 *  no payment line, no Pay and no refund choices (the club's rule applies). */
export type Grid = { date: string; time_zone: string; open: { opens: string; closes: string } | null; now: string; today: string; money?: boolean; people?: boolean; courts: Court[] };
type Loc = { id: string; name: string; time_zone: string };
/** can_handle: false for one at another location than a desk kept to one (the server says so for each). */
type Alert = { event_id: string; kind: string; subject: string; body: string; link: string | null; at: string; can_handle?: boolean };
type Alerts = { open: Alert[]; handled: (Alert & { handled_at: string; handled_by: string })[] };
type Preview = (action: string, input: unknown) => Promise<void>;
/** Where a dragged (or keyed) item would go: a court, a start, and how long. */
type Target = { court: string; start: number; minutes: number };
const HALF = 30 * 60_000, SLOT = 44;   // one half hour is this many pixels tall
const ms = (iso: string) => new Date(iso).getTime();
const length = (it: Item) => Math.round((ms(it.end) - ms(it.start)) / 60_000);
// One item, wherever it is now: picked stays picked after it moves to another court.
export const keyOf = (it: Item, court: string) => it.booking_id ?? it.session_id ?? it.block_id ?? `${court}|${it.start}`;
const unpaid = (it: Item) => Math.max(0, (it.price_cents ?? 0) - (it.paid_cents ?? 0) - (it.off_cents ?? 0));
const isBooking = (it: Item) => Boolean(it.booking_id) && it.kind === "booking";

// The location on screen, for mayHere. A role kept to one location can look at the others, and only change its own.
let shown = "";
const mayHere = (action: string) => mayDo(action) && coversLocation(shown);
/** The location another page shows an item of (the Bookings list's side panel), for mayHere. */
export const showLocation = (id: string) => { shown = id; };

/** Every half hour the location is open that day, as instants: the same list for choosing a start or a block. */
export const daySlots = (g: Grid) => {
  const out: string[] = [];
  if (g.open) for (let s = ms(g.open.opens); s <= ms(g.open.closes); s += HALF) out.push(new Date(s).toISOString());
  return out;
};
/** Program dates are moved or made longer by those who edit programs. */
const seriesOk = () => { const roles = (me.value?.roles ?? []).map((r) => r.key); return roles.includes("owner") || roles.includes("manager") || (me.value?.can ?? []).includes("series.edit"); };
/** What can be moved, and what made longer or shorter: a confirmed booking (moved before it starts, its length changed
 *  until it ends), and a program date before it starts, for those who edit programs. */
export const canMove = (it: Item) => (isBooking(it) && it.status === "confirmed" && ms(it.start) > serverNow() && mayHere("booking.move")) || (Boolean(it.session_id) && seriesOk() && ms(it.start) > serverNow());
export const canResize = (it: Item) => (isBooking(it) && it.status === "confirmed" && ms(it.end) > serverNow() && mayHere("booking.extend")) || (Boolean(it.session_id) && seriesOk() && ms(it.start) > serverNow());
/** A program date on more than one court keeps its courts when moved: only its time changes. */
export const courtsOf = (g: Grid, it: Item) => g.courts.filter((c) => c.items.some((x) => it.session_id && x.session_id === it.session_id)).length;
/** A clock time in the location's time zone, in the reader's words. */
export const clockIn = (tz: string) => (iso: string | number) => new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function Courts() {
  const { query } = useLocation();
  // Opened at a day (and a location) from elsewhere: the Bookings list's "See the day".
  const [locs, setLocs] = useState<Loc[]>([]), [loc, setLoc] = useState(""), [date, setDate] = useState(/^\d{4}-\d{2}-\d{2}$/.test(String(query.date ?? "")) ? String(query.date) : ""), [g, setG] = useState<Grid | null>(null);
  const [form, setForm] = useState<{ court: Court; starts: string[]; until: string; weekly: boolean } | null>(null), [blocking, setBlocking] = useState(false);
  const [picked, setPicked] = useState<string | null>(null), [alerts, setAlerts] = useState<Alerts | null>(null), [done, setDone] = useState(0);
  // Create's panel, and choosing a court and a free time for a booking made from it (once, or every week).
  const [creating, setCreating] = useState(false), [choosing, setChoosing] = useState<"once" | "weekly" | null>(null);
  const narrow = useMedia(NARROW);
  // The side panel holds one thing at a time: what was picked on the grid, a booking or a block being made.
  const panel = Boolean(picked || form || blocking || choosing);
  const closePanel = () => { setPicked(null); setForm(null); setBlocking(false); setChoosing(null); };
  // The phone's back button closes what's open (the side panel or Create), not the page: one entry while anything is.
  useBackCloses(panel || creating, () => { setCreating(false); closePanel(); });
  shown = loc;
  const load = () => loc && api<Grid>(`/staff/grid?location_id=${loc}${date ? `&date=${date}` : ""}`).then((x) => { setG(x); if (!date) setDate(x.date); });
  const loadAlerts = () => api<Alerts>("/staff/alerts").then(setAlerts).catch(() => setAlerts(null));
  const { preview, sheet } = usePreview(() => { load(); loadAlerts(); setForm(null); setBlocking(false); setChoosing(null); setDone((n) => n + 1); });
  useEffect(() => { api<Loc[]>("/staff/locations").then((l) => { setLocs(l); setLoc((l.find((x) => x.id === query.location) ?? l.find((x) => coversLocation(x.id)) ?? l[0])?.id ?? ""); }); void loadAlerts(); }, []);
  useEffect(() => { load(); }, [loc, date]);
  // What was picked is gone (cancelled, unblocked, another day): the side panel closes rather than stay empty.
  useEffect(() => { if (picked && g && !g.courts.some((c) => c.items.some((it) => keyOf(it, c.id) === picked))) setPicked(null); }, [g, picked]);
  // Today, what's on now moves on its own: look again every minute.
  useEffect(() => {
    if (!g || g.date !== g.today) return;
    const id = setInterval(() => { load(); loadAlerts(); }, 60_000);
    return () => clearInterval(id);
  }, [g?.date, g?.today, loc]);
  if (!g) return <main class="card"><p>{t("ui.loading")}</p></main>;

  const clock = clockIn(g.time_zone);
  const today = g.date === g.today;
  const slots = daySlots(g);
  const gaps = (c: Court) => {
    if (!c.open) return [];
    const out: { from: string; to: string }[] = [];
    let cursor = ms(c.open.opens);
    for (const it of [...c.items].sort((a, b) => ms(a.start) - ms(b.start))) {
      if (ms(it.start) > cursor) out.push({ from: new Date(cursor).toISOString(), to: it.start });
      cursor = Math.max(cursor, ms(it.end));
    }
    if (cursor < ms(c.open.closes)) out.push({ from: new Date(cursor).toISOString(), to: c.open.closes });
    return out.filter((x) => ms(x.to) - ms(x.from) >= HALF && new Date(x.to) > new Date(serverNow()));
  };
  const shift = (days: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); setDate(d.toISOString().slice(0, 10)); };
  const drop = (it: Item, from: Court, to: Target) => {
    const minutes = length(it), startsAt = new Date(to.start).toISOString();
    if (it.booking_id) return to.minutes !== minutes ? preview("booking.extend", { booking_id: it.booking_id, minutes: to.minutes })
      : preview("booking.move", { booking_id: it.booking_id, court_id: to.court, starts_at: startsAt });
    if (it.session_id) return preview("series.edit", { session_id: it.session_id, scope: "this", ...(to.minutes !== minutes ? { minutes: to.minutes } : { starts_at: startsAt }),
      ...(to.court !== from.id ? { court_ids: [to.court] } : {}) });
  };
  // Tapping free time books it at the desk, from that half hour (in the side panel, the day still in view).
  const book = (c: Court, at: number, weekly = false) => {
    if (!mayHere("booking.create")) return;
    const gap = gaps(c).find((x) => ms(x.from) <= at && at < ms(x.to));
    if (!gap) return;
    const starts = slots.filter((s) => ms(s) >= Math.max(at, ms(gap.from)) && ms(s) + HALF <= ms(gap.to) && new Date(s) > new Date(serverNow()));
    if (starts.length) { closePanel(); setForm({ court: c, starts, until: gap.to, weekly }); }
  };
  const pick = (k: string) => { const again = k === picked; closePanel(); if (!again) setPicked(k); };
  const sel = g.courts.flatMap((c) => c.items.map((it) => ({ it, c }))).find((x) => keyOf(x.it, x.c.id) === picked) ?? null;
  const stats = dayStats(g.courts);
  // What + Create offers this person: each choice their roles allow, opening the flow that already makes it.
  const choices = createChoices(Boolean(g.open), (once) => { setCreating(false); closePanel(); setChoosing(once ? "once" : "weekly"); },
    () => { setCreating(false); closePanel(); setBlocking(true); });
  const playtomic = Boolean(me.value?.playtomic) || g.courts.some((c) => c.items.some((it) => it.kind === "mirror"));

  return (
    <main class="today">
      <div class="sched-bar">
        <h1>{t("ui.nav_day_schedule")}</h1>
        {locs.length > 1 && <select class="sched-loc" aria-label={t("ui.location")} value={loc} onChange={(e) => { setLoc(e.currentTarget.value); setDate(""); }}>{locs.map((l) => <option value={l.id}>{l.name}</option>)}</select>}
        <div class="day-nav">
          <button type="button" onClick={() => shift(-1)} aria-label={t("ui.day_before")}>‹</button>
          <button type="button" onClick={() => setDate(g.today)} aria-current={today ? "date" : undefined}>{t("ui.today_button")}</button>
          <button type="button" onClick={() => shift(1)} aria-label={t("ui.day_after")}>›</button>
        </div>
        <input type="date" class="sched-date" aria-label={t("ui.day")} value={date} onInput={(e) => setDate(e.currentTarget.value)} />
        {date && <span class="sched-day">{new Intl.DateTimeFormat(formatLocale(lang.value), { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}</span>}
        <span class="occ-chip" role="status">{t("ui.occupancy_day", { percent: stats.percent })} · {t("count.bookings", { count: stats.bookings })}</span>
        {choices.some((x) => x.items.some((i) => !i.soon)) && <button type="button" class="primary sched-create" aria-haspopup="dialog" onClick={() => { closePanel(); setCreating(true); }}>
          <span aria-hidden="true">+</span> {t("ui.create")}</button>}
      </div>
      <p class="meta">{g.open ? t("ui.open_from_to", { from: clock(g.open.opens), to: clock(g.open.closes) }) : t("ui.closed_this_day")}</p>
      <Legend playtomic={playtomic} />

      <div class="sched-layout">
        <div class="sched-grid">
          <TimeGrid g={g} clock={clock} picked={picked} onPick={pick} canMove={canMove} canResize={canResize}
            courtFixed={(it) => courtsOf(g, it) > 1} onDrop={drop} onFree={(c, at) => book(c, at)} />
          <p class="meta">{t("ui.today_hint")}</p>
        </div>
        <div class="sched-side">
          {panel && <SidePanel narrow={narrow} onClose={closePanel}>
            {sel && <Details key={`${picked}|${sel.c.id}|${sel.it.start}|${sel.it.end}`} it={sel.it} court={sel.c} g={g} clock={clock} slots={slots} preview={preview} canMove={canMove(sel.it)} canResize={canResize(sel.it)}
              courtFixed={courtsOf(g, sel.it) > 1} />}
            {choosing && <CourtPicker courts={g.courts} gaps={gaps} clock={clock} onPick={(c, at) => book(c, at, choosing === "weekly")} />}
            {form && <DeskBooking key={`${form.court.id}|${form.starts[0]}|${form.weekly}`} court={form.court} starts={form.starts} until={form.until} weekly={form.weekly} clock={clock} preview={preview} onClose={closePanel} />}
            {blocking && <BlockForm courts={g.courts} g={g} slots={slots} clock={clock} preview={preview} />}
          </SidePanel>}
          {today && alerts && (alerts.open.length > 0 || alerts.handled.length > 0 || mayDo("alert.handle")) && <AlertList a={alerts} clock={clock} preview={preview} />}
          {today && <NowNext g={g} clock={clock} />}
        </div>
      </div>
      {(mayHere("court.block_repeat_edit") || mayHere("court.block_repeat_end")) && <SeriesList loc={loc} courts={g.courts} stamp={done} preview={preview} />}
      {creating && <CreatePanel choices={choices} where={[locs.find((l) => l.id === loc)?.name, date && new Intl.DateTimeFormat(formatLocale(lang.value), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))].filter(Boolean).join(" · ")}
        onClose={() => setCreating(false)} />}
      {sheet}
    </main>
  );
}

type Choice = { key: string; href?: string; go?: () => void; soon?: boolean };
/** + Create's choices, grouped as staff from other club software know them. Each is shown only to someone whose roles
 *  allow it here, and opens the flow that already makes it: a program's form (clinics, courses, events, leagues), the
 *  desk's booking (once, or every week for a member), and the block form. A kind with no staff flow yet is shown as
 *  coming soon to those who book courts. */
function createChoices(open: boolean, booking: (once: boolean) => void, block: () => void): { group: string; items: Choice[] }[] {
  const here = coversLocation(shown);
  const programs = mayCreate("program.create"), desk = here && mayCreate("booking.create"), courts = open && desk;
  const groups: { group: string; items: (Choice | false)[] }[] = [
    { group: "learning", items: [
      desk && { key: "lesson", soon: true },
      programs && { key: "clinic", href: "/programs?new=clinic" },
      programs && { key: "course", href: "/programs?new=course" }] },
    { group: "play", items: [
      desk && { key: "open_match", soon: true },
      programs && { key: "event", href: "/programs?new=social" },
      programs && { key: "league", href: "/programs?new=league" }] },
    { group: "courts", items: [
      courts && { key: "booking", go: () => booking(true) },
      courts && mayCreate("booking.repeat") && { key: "weekly", go: () => booking(false) }] },
    { group: "closures", items: [
      open && here && mayCreate("court.block") && { key: "block", go: block }] },
  ];
  return groups.map((x) => ({ group: x.group, items: x.items.filter((i): i is Choice => Boolean(i)) })).filter((x) => x.items.length > 0);
}

/** The panel + Create opens over the page: what can be added, by group. Nothing is made here: each choice opens its
 *  own form, which previews before anything changes. */
function CreatePanel({ choices, where, onClose }: { choices: { group: string; items: Choice[] }[]; where: string; onClose: () => void }) {
  const ref = useDrawer<HTMLElement>(true, onClose, true);
  return <>
    <div class="scrim" onClick={onClose} />
    <section ref={ref} class="drawer create-panel" role="dialog" aria-modal="true" aria-labelledby="create-title" aria-describedby="create-help">
      <div class="drawer-head">
        <div><h2 id="create-title">{t("ui.create_title")}</h2><p id="create-help" class="meta">{where ? `${where}. ` : ""}{t("ui.create_help")}</p></div>
        <button type="button" class="icon" onClick={onClose} aria-label={t("ui.close")}>×</button>
      </div>
      {choices.map((x) => <div class="create-group">
        <h3>{t(`ui.create_${x.group}` as Key)}</h3>
        <ul class="create-list">{x.items.map((i) => <li>
          {i.soon ? <div class="create-item off" aria-disabled="true"><span><strong>{t(`ui.create_${i.key}` as Key)}</strong><span class="meta">{t(`ui.create_${i.key}_help` as Key)}</span></span><span class="badge muted">{t("ui.coming_soon")}</span></div>
            : i.href ? <a class="create-item" href={i.href} onClick={onClose}><span><strong>{t(`ui.create_${i.key}` as Key)}</strong><span class="meta">{t(`ui.create_${i.key}_help` as Key)}</span></span><span aria-hidden="true">›</span></a>
            : <button type="button" class="create-item" onClick={i.go}><span><strong>{t(`ui.create_${i.key}` as Key)}</strong><span class="meta">{t(`ui.create_${i.key}_help` as Key)}</span></span><span aria-hidden="true">›</span></button>}
        </li>)}</ul>
      </div>)}
    </section>
  </>;
}

/** The side panel: what was picked on the grid, or a booking or block being made, beside the day on a wide screen and
 *  over it on a phone. */
export function SidePanel({ narrow, onClose, children }: { narrow: boolean; onClose: () => void; children: any }) {
  const ref = useDrawer<HTMLDivElement>(true, onClose, narrow);
  return <>
    {narrow && <div class="scrim" onClick={onClose} />}
    <div ref={ref} class={`side-panel${narrow ? " drawer" : ""}`} role={narrow ? "dialog" : "region"} aria-modal={narrow ? "true" : undefined} aria-label={t("ui.side_panel")} tabIndex={-1}>
      <div class="side-close"><button type="button" class="icon" onClick={onClose} aria-label={t("ui.close")}>×</button></div>
      {children}
    </div>
  </>;
}

/** The legend: what each colour on the grid is, in words. */
const kindWords = (k: Kind) => t(`ui.kind_${k}` as Key);
function Legend({ playtomic }: { playtomic: boolean }) {
  const kinds: Kind[] = ["booking", "open_match", "learning", "event", "blocked", ...(playtomic ? ["playtomic" as const] : [])];
  return <ul class="legend" aria-label={t("ui.legend")}>{kinds.map((k) => <li><span class={`swatch k-${k}`} aria-hidden="true" />{kindWords(k)}</li>)}</ul>;
}

/** Making a booking from + Create: each court's free time that day, to choose from. */
function CourtPicker({ courts, gaps, clock, onPick }: { courts: Court[]; gaps: (c: Court) => { from: string; to: string }[]; clock: (s: string) => string; onPick: (c: Court, at: number) => void }) {
  return (
    <section>
      <h2>{t("ui.pick_court_time")}</h2>
      <ul class="plain">{courts.map((c) => { const free = gaps(c); return (
        <li><strong>{c.name}</strong>
          {free.length ? <div class="chips">{free.map((x) => <button type="button" class="chip" onClick={() => onPick(c, ms(x.from))}>{t("ui.free_from_to", { from: clock(x.from), to: clock(x.to) })}</button>)}</div>
            : <p class="meta">{t("ui.no_free_time")}</p>}
        </li>); })}</ul>
    </section>
  );
}

/** What needs someone: each staff alert once, until one of the staff marks it handled. */
function AlertList({ a, clock, preview }: { a: Alerts; clock: (s: string) => string; preview: Preview }) {
  return (
    <section class="card alerts">
      <h2>{t("ui.alerts_title")}{a.open.length > 0 && <span class="badge warn">{a.open.length}</span>}</h2>
      {a.open.length === 0 ? <p class="meta">{t("ui.alerts_none")}</p> : (
        <ul class="plain">{a.open.map((x) => (
          <li><strong>{x.subject}</strong><p class="meta">{x.body}</p>
            <div class="row"><span class="meta">{clock(x.at)}</span>
              {/* The Playtomic wallets alert is done only on the move-in page, by saying they're at zero (brought_in.ts). */}
              {x.kind === "playtomic_wallets_staff" ? <span><a href={x.link ?? "/playtomic/move-in"}>{t("ui.alert_wallets_go")}</a></span>
                : <span>{x.link && <a href={x.link}>{t("ui.open")}</a>}{" "}
                  {mayDo("alert.handle") && x.can_handle !== false && <button class="small" onClick={() => preview("alert.handle", { event_id: x.event_id, kind: x.kind })}>{t("ui.alert_handled_button")}</button>}</span>}</div>
          </li>))}</ul>
      )}
      {a.handled.length > 0 && <details><summary class="meta">{t("count.alerts_handled", { count: a.handled.length })}</summary>
        <ul class="plain">{a.handled.map((x) => <li class="meta">{x.handled_by ? t("ui.alert_handled_by", { subject: x.subject, name: x.handled_by, time: clock(x.handled_at) })
          : t("ui.alert_closed", { subject: x.subject, time: clock(x.handled_at) })}</li>)}</ul></details>}
    </section>
  );
}

/** Who and what an item is, in a few words: the organiser (and coach), a program's or a block's name, and who booked a
 *  Playtomic copy when the server says (only to those who read people). */
const labelOf = (it: Item) => it.booking_id ? (it.kind === "hold" ? t("ui.being_paid") : [it.who, it.booking_kind === "lesson" && it.coach ? t("ui.lesson_with", { coach: it.coach }) : ""].filter(Boolean).join(" · "))
  : [it.kind === "mirror" ? it.who ?? "" : "", it.label ?? "", it.series ? t("ui.repeats_weekly") : ""].filter(Boolean).join(" · ");
/** A clock time in the location's time zone, as a club writes it: "18:00", and "24:00" for midnight at the end of the day. */
const clubTime = (iso: string, tz: string, end = false) => {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return end && s === "00:00" ? "24:00" : s;
};
/** The kind of anything but a plain court booking, in words on the block, so colour is never the only sign. */
const tagOf = (it: Item) => {
  const k = kindOf(it);
  if (k === "booking" || k === "hold") return "";
  if (it.kind === "session") return it.program_kind ? t(`kind.${it.program_kind}` as Key) : "";
  if (k === "learning") return t("ui.kind_lesson");
  if (k === "open_match") return t("ui.kind_open_match");
  if (k === "playtomic") return "";   // its label already says Playtomic
  return t("ui.kind_blocked");
};
const dayName = (w: number) => new Intl.DateTimeFormat(formatLocale(lang.value), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));

/** The parts of the grid's hours a court is closed: before it opens and after it closes, or all of it. */
function closedBands(c: Court, from: number, to: number) {
  if (!c.open) return [{ from, to }];
  return [{ from, to: Math.min(ms(c.open.opens), to) }, { from: Math.max(ms(c.open.closes), from), to }].filter((b) => b.to > b.from);
}

/** On each court: what's on now, and what starts next, with money owed and any word about running late. */
function NowNext({ g, clock }: { g: Grid; clock: (s: string) => string }) {
  const now = serverNow();
  return (
    <section class="card">
      <h2>{t("ui.now_next")}</h2>
      <ul class="plain">{g.courts.map((c) => {
        const live = c.items.filter((it) => it.kind !== "hold");
        const cur = live.find((it) => ms(it.start) <= now && now < ms(it.end));
        const next = live.filter((it) => ms(it.start) > now).sort((a, b) => ms(a.start) - ms(b.start))[0];
        return (
          <li><strong>{c.name}</strong>
            <div>{cur ? t("ui.now_on", { who: labelOf(cur), until: clock(cur.end) }) : t("ui.now_free")}
              {cur && isBooking(cur) && g.money !== false && unpaid(cur) > 0 && <span class="badge warn">{t("ui.unpaid_amount", { amount: dollars(unpaid(cur), lang.value) })}</span>}</div>
            {[cur, next].flatMap((it) => it?.late ?? []).map((l) => <div class="note">{t("ui.late_note", { name: l.name || t("ui.player"), minutes: l.minutes })}</div>)}
            <div class="meta">{next ? t("ui.next_on", { who: labelOf(next), at: clock(next.start) }) : t("ui.next_none")}</div>
          </li>
        );
      })}</ul>
    </section>
  );
}

/** The day as a grid: courts across, time down. Each booking can be dragged by its handle to another time or
 *  court, or by its bottom edge to another length; arrow keys do the same on the one picked. */
function TimeGrid({ g, clock, picked, onPick, canMove, canResize, courtFixed, onDrop, onFree }: { g: Grid; clock: (s: string | number) => string; picked: string | null;
  onPick: (k: string) => void; canMove: (it: Item) => boolean; canResize: (it: Item) => boolean; courtFixed: (it: Item) => boolean; onDrop: (it: Item, from: Court, to: Target) => void;
  onFree: (c: Court, at: number) => void }) {
  const cols = useRef<(HTMLDivElement | null)[]>([]);
  const [drag, setDrag] = useState<{ it: Item; from: Court; mode: "move" | "resize"; y0: number; orig: Target; to: Target; pointer: boolean } | null>(null);
  // The hours shown: opening to closing, stretched to anything outside them that day.
  const all = g.courts.flatMap((c) => c.items);
  const first = Math.min(...[g.open ? ms(g.open.opens) : Infinity, ...all.map((it) => ms(it.start))]);
  const last = Math.max(...[g.open ? ms(g.open.closes) : -Infinity, ...all.map((it) => ms(it.end))]);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return null;
  const from = Math.floor(first / HALF) * HALF, rows = Math.ceil((last - from) / HALF);
  const y = (at: number) => ((at - from) / HALF) * SLOT;
  const clampStart = (start: number, minutes: number) => Math.min(Math.max(start, from), from + rows * HALF - minutes * 60_000);

  const begin = (e: PointerEvent, it: Item, c: Court, mode: "move" | "resize") => {
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const orig = { court: c.id, start: ms(it.start), minutes: length(it) };
    setDrag({ it, from: c, mode, y0: e.clientY, orig, to: orig, pointer: true });
  };
  const follow = (e: PointerEvent) => {
    if (!drag?.pointer) return;
    const steps = Math.round((e.clientY - drag.y0) / SLOT);
    if (drag.mode === "resize") { setDrag({ ...drag, to: { ...drag.orig, minutes: Math.max(30, drag.orig.minutes + steps * 30) } }); return; }
    let court = drag.orig.court;
    if (!courtFixed(drag.it)) {
      const i = cols.current.findIndex((el) => { if (!el) return false; const r = el.getBoundingClientRect(); return e.clientX >= r.left && e.clientX < r.right; });
      if (i >= 0) court = g.courts[i]!.id;
    }
    setDrag({ ...drag, to: { court, minutes: drag.orig.minutes, start: clampStart(drag.orig.start + steps * HALF, drag.orig.minutes) } });
  };
  const finish = () => {
    const d = drag;
    setDrag(null);
    if (d && (d.to.court !== d.orig.court || d.to.start !== d.orig.start || d.to.minutes !== d.orig.minutes)) onDrop(d.it, d.from, d.to);
  };
  // The same, from the keyboard, on the item picked: arrows move it, Shift with up or down changes its length.
  const keys = (e: KeyboardEvent, it: Item, c: Court) => {
    const move = canMove(it), resize = canResize(it);
    if (!move && !resize) return;
    const orig = { court: c.id, start: ms(it.start), minutes: length(it) };
    const cur = drag && !drag.pointer && drag.it === it ? drag : { it, from: c, mode: "move" as const, y0: 0, orig, to: orig, pointer: false };
    const at = g.courts.findIndex((x) => x.id === cur.to.court);
    let to = cur.to, mode: "move" | "resize" = cur.mode;
    // Esc puts back an item being moved by keys, and only that: the side panel stays open.
    if (e.key === "Escape") { if (drag) { e.preventDefault(); setDrag(null); } return; }
    if (e.key === "Enter" && drag && !drag.pointer) { e.preventDefault(); finish(); return; }
    if (e.shiftKey && resize && (e.key === "ArrowUp" || e.key === "ArrowDown")) { mode = "resize"; to = { ...cur.orig, minutes: Math.max(30, to.minutes + (e.key === "ArrowDown" ? 30 : -30)) }; }
    else if (move && (e.key === "ArrowUp" || e.key === "ArrowDown")) { mode = "move"; to = { ...to, minutes: cur.orig.minutes, start: clampStart(to.start + (e.key === "ArrowDown" ? HALF : -HALF), cur.orig.minutes) }; }
    else if (move && !courtFixed(it) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { mode = "move"; to = { ...to, minutes: cur.orig.minutes, court: g.courts[Math.min(g.courts.length - 1, Math.max(0, at + (e.key === "ArrowRight" ? 1 : -1)))]!.id }; }
    else return;
    e.preventDefault();
    setDrag({ ...cur, mode, to });
  };
  const nowLine = g.date === g.today ? serverNow() : null;

  return (
    <div class="tgrid" style={`--slot:${SLOT}px`}>
      <div class="tg-times" aria-hidden="true">
        <div class="tg-head" />
        <div class="tg-body" style={`height:${rows * SLOT}px`}>
          {Array.from({ length: rows }, (_, i) => (from + i * HALF) % 3600_000 === 0 || i === 0
            ? <span class="tg-hour" style={`top:${i * SLOT}px`}>{clock(from + i * HALF)}</span> : null)}
        </div>
      </div>
      {g.courts.map((c, ci) => (
        <div class="tg-col">
          <div class="tg-head">{c.name}</div>
          <div class="tg-body tg-lines" ref={(el) => { cols.current[ci] = el; }} style={`height:${rows * SLOT}px`}
            onClick={(e) => { if (e.target !== e.currentTarget) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onFree(c, from + Math.floor((e.clientY - r.top) / SLOT) * HALF); }}>
            {nowLine !== null && nowLine >= from && nowLine <= from + rows * HALF && <div class="tg-now" style={`top:${y(nowLine)}px`} />}
            {/* Times this court is closed (its own hours can differ from the location's), shaded. */}
            {closedBands(c, from, from + rows * HALF).map((b) => <div class="tg-closed" aria-hidden="true" style={`top:${y(b.from)}px;height:${y(b.to) - y(b.from)}px`} />)}
            {c.items.map((it) => {
              const k = keyOf(it, c.id), top = y(ms(it.start)), h = Math.max(SLOT / 2, y(ms(it.end)) - top - 2);
              const kind = kindOf(it), tag = tagOf(it);
              return (
                <div class={`tg-item k-${kind}${picked === k ? " sel" : ""}${drag?.it === it ? " dragging" : ""}`} style={`top:${top}px;height:${h}px`}>
                  <button type="button" class="tg-face" aria-pressed={picked === k} onClick={() => onPick(k)} onKeyDown={(e) => keys(e, it, c)}>
                    <span class="tg-time">{clock(it.start)} - {clock(it.end)}</span>
                    <span class="tg-who">{labelOf(it)}</span>
                    {tag && <span class="tg-kind">{tag}</span>}
                    {/* Owed money is for those who see what members paid (the server sends none to anyone else). */}
                    {g.money !== false && isBooking(it) && unpaid(it) > 0 && <span class="pill-unpaid">{t("ui.unpaid_pill")} · {dollars(unpaid(it), lang.value)}</span>}
                    {(it.late?.length ?? 0) > 0 && <span class="badge">{t("ui.late_note", { name: it.late![0]!.name || t("ui.player"), minutes: it.late![0]!.minutes })}</span>}
                  </button>
                  {canMove(it) && <span class="tg-grip" aria-hidden="true" title={t("ui.drag_handle")} onPointerDown={(e) => begin(e, it, c, "move")} onPointerMove={follow} onPointerUp={finish} onPointerCancel={() => setDrag(null)}>⠿</span>}
                  {canResize(it) && <span class="tg-resize" aria-hidden="true" onPointerDown={(e) => begin(e, it, c, "resize")} onPointerMove={follow} onPointerUp={finish} onPointerCancel={() => setDrag(null)} />}
                </div>
              );
            })}
            {drag && drag.to.court === c.id && <div class="tg-ghost" style={`top:${y(drag.to.start)}px;height:${Math.max(SLOT / 2, (drag.to.minutes * 60_000 / HALF) * SLOT - 2)}px`}>
              {clock(drag.to.start)} - {clock(drag.to.start + drag.to.minutes * 60_000)}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The front desk and up choose what goes back when they cancel a paid booking (booking.cancel's refund). */
const deskUp = () => (me.value?.roles ?? []).some((r) => ["owner", "manager", "front_desk"].includes(r.key));
/** The item picked: who's playing, what's paid, and every change for it on buttons. */
export function Details({ it, court, g, clock, slots, preview, canMove, canResize, courtFixed }: { it: Item; court: Court; g: Grid; clock: (s: string | number) => string; slots: string[];
  preview: Preview; canMove: boolean; canResize: boolean; courtFixed: boolean }) {
  const [changing, setChanging] = useState(false), [paying, setPaying] = useState(false), [cancelling, setCancelling] = useState(false);
  // Paid in Playtomic: said, with what's still owed here (time added here) beside it.
  const pt = playtomicParts({ paid: it.paid_cents ?? 0, pt: it.pt_cents ?? 0, owed: unpaid(it) });
  const kind = kindOf(it);
  return (
    <section>
      <span class={`kind-tag k-${kind}`}>{tagOf(it) || kindWords(kind)}</span>
      <h2>{clock(it.start)} - {clock(it.end)} · {court.name}</h2>
      <p>{labelOf(it)}{it.code ? ` · ${it.code}` : ""}</p>
      {(it.players?.length ?? 0) > 0 && <p class="meta">{t("ui.today_players", { names: it.players!.join(", ") })}</p>}
      {isBooking(it) && g.money !== false && <p class="meta">{pt ? pt.map((x) => t(x.key, { amount: dollars(x.cents, lang.value) })).join(" · ")
        : unpaid(it) > 0 ? t("ui.unpaid_amount", { amount: dollars(unpaid(it), lang.value) }) : (it.off_cents ?? 0) > 0 ? t("ui.paid_off", { amount: dollars(it.paid_cents ?? 0, lang.value), off: dollars(it.off_cents ?? 0, lang.value) })
        : t("ui.today_paid", { amount: dollars(it.paid_cents ?? 0, lang.value) })}</p>}
      {it.late?.map((l) => <p class="note">{t("ui.late_note", { name: l.name || t("ui.player"), minutes: l.minutes })} · {clock(l.at)}</p>)}
      <div class="chips">
        {isBooking(it) && g.money !== false && unpaid(it) > 0 && mayHere("booking.record_payment") && <button class="small" onClick={() => setPaying(!paying)}>{t("ui.record_payment")}</button>}
        {(canMove || canResize) && <button class="small" onClick={() => setChanging(!changing)}>{t("ui.move_or_resize")}</button>}
        {isBooking(it) && mayHere("booking.cancel") && <button class="small" onClick={() => (it.paid_cents ?? 0) > 0 && deskUp() ? setCancelling(!cancelling) : preview("booking.cancel", { booking_id: it.booking_id })}>{t((it.paid_cents ?? 0) > 0 && deskUp() ? "ui.cancel_booking_choose" : "ui.cancel_booking")}</button>}
        {it.block_id && !it.series && mayHere("court.unblock") && <button class="small" onClick={() => preview("court.unblock", { block_id: it.block_id })}>{t("ui.unblock")}</button>}
        {it.block_id && it.series && mayHere("court.block_repeat_end") && <>
          <button class="small" onClick={() => preview("court.block_repeat_end", { block_id: it.block_id, scope: "this" })}>{t("ui.open_this_date")}</button>
          <button class="small" onClick={() => preview("court.block_repeat_end", { block_id: it.block_id, scope: "following" })}>{t("ui.end_from_here")}</button>
          <button class="small" onClick={() => preview("court.block_repeat_end", { block_id: it.block_id, scope: "all" })}>{t("ui.end_series")}</button>
        </>}
        {it.block_id && it.series && mayHere("court.block_repeat_edit") && ms(it.start) > serverNow() && <button class="small" onClick={() => setChanging(!changing)}>{t("ui.change_series")}</button>}
        {it.program_id && <a href={`/programs/${it.program_id}`}>{t("ui.open")}</a>}
      </div>
      {cancelling && <form class="card card-form" onSubmit={(e) => { e.preventDefault(); preview("booking.cancel", { booking_id: it.booking_id, refund: ((e.currentTarget as HTMLFormElement).elements.namedItem("refund") as HTMLSelectElement).value }); }}>
        <label>{t("ui.refund")}<select name="refund"><option value="rule">{t("ui.refund_by_rule")}</option><option value="full">{t("ui.refund_everything")}</option><option value="none">{t("ui.refund_nothing")}</option><option value="credit">{t("ui.refund_as_credit")}</option></select></label>
        <button class="small primary">{t("ui.cancel_booking")}</button></form>}
      {paying && isBooking(it) && unpaid(it) > 0 && <DeskPay key={`${it.booking_id}-${unpaid(it)}`} owed={unpaid(it)} label={t("ui.unpaid_amount", { amount: dollars(unpaid(it), lang.value) })}
        onCancel={() => setPaying(false)} send={(cents, method) => { setPaying(false); preview("booking.record_payment", { booking_id: it.booking_id, cents, method }); }} />}
      {it.empty_places?.map((e) => <EmptyPlace e={e} preview={preview} money={g.money !== false} />)}
      {it.whole && mayHere("booking.add_player") && <Players it={it} preview={preview} />}
      {changing && !it.series && <ChangeForm it={it} court={court} g={g} clock={clock} slots={slots} preview={preview} canMove={canMove} canResize={canResize} courtFixed={courtFixed} />}
      {changing && it.series && <SeriesChange it={it} g={g} slots={court.open ? courtSlots(court.open) : slots} clock={clock} preview={preview} />}
    </section>
  );
}

/** The players on a member's court paid in full: the desk names them (anyone, by search), or takes one off. Nobody
 *  named pays, and taking someone off moves no money. */
function Players({ it, preview }: { it: Item; preview: Preview }) {
  const [q, setQ] = useState(""), [found, setFound] = useState<{ id: string; display_name: string }[]>([]), [copied, setCopied] = useState(false);
  const find = async (v: string) => { setQ(v); setFound(v.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(v)}`) : []); };
  // The players link opens in the members' app, at the members' address.
  const copy = async () => { await navigator.clipboard?.writeText(`${club.value?.member_url ?? location.origin}/join/${it.invite_code}`).catch(() => {}); setCopied(true); };
  return (
    <div class="card-form">
      <h3>{t("ui.players_title")}</h3>
      <ul class="plain">{(it.seats ?? []).map((p) => <li class="row"><span>{p.name || t("ui.player")}{p.booker ? ` · ${t("ui.booker")}` : ""}</span>
        {!p.booker && mayHere("booking.remove_player") && <button type="button" class="small" onClick={() => preview("booking.remove_player", { booking_player_id: p.id })}>{t("ui.remove")}</button>}</li>)}</ul>
      {it.invite_code && (it.seats?.length ?? 0) < 4 && <p><button type="button" class="small" onClick={copy}>{copied ? t("ui.link_copied") : t("ui.copy_players_link")}</button></p>}
      {(it.seats?.length ?? 0) < 4 && <>
        <label>{t("ui.add_player")}<input type="search" value={q} onInput={(e) => find(e.currentTarget.value)} /></label>
        {found.length > 0 && <ul class="plain">{found.slice(0, 6).map((p) => <li class="row"><span>{p.display_name}</span>
          <button type="button" class="small" onClick={() => { setFound([]); setQ(""); void preview("booking.add_player", { booking_id: it.booking_id, person_id: p.id }); }}>{t("ui.choose")}</button></li>)}</ul>}
      </>}
    </div>
  );
}

/** Moving or changing the length on buttons: a court, a start and a length, then the preview. */
function ChangeForm({ it, court, g, clock, slots, preview, canMove, canResize, courtFixed }: { it: Item; court: Court; g: Grid; clock: (s: string | number) => string; slots: string[];
  preview: Preview; canMove: boolean; canResize: boolean; courtFixed: boolean }) {
  const was = length(it), [f, setF] = useState({ court: court.id, start: new Date(it.start).toISOString(), minutes: was, reprice: false, refund: "rule" }), [error, setError] = useState("");
  const moved = f.court !== court.id || ms(f.start) !== ms(it.start), resized = f.minutes !== was;
  // The court it would be on: only the times that court is open that day.
  const open = g.courts.find((c) => c.id === f.court)?.open ?? null;
  const lengths = Array.from({ length: 16 }, (_, i) => (i + 1) * 30).filter((m) => (open && ms(f.start) + m * 60_000 <= ms(open.closes)) || m === was);
  const starts = courtSlots(open).filter((s) => new Date(s) > new Date(serverNow()) && ms(s) + f.minutes * 60_000 <= ms(open!.closes));
  const submit = (e: Event) => {
    e.preventDefault(); setError("");
    if (it.session_id) return void preview("series.edit", { session_id: it.session_id, scope: "this", ...(moved ? { starts_at: f.start } : {}), ...(resized ? { minutes: f.minutes } : {}),
      ...(f.court !== court.id ? { court_ids: [f.court] } : {}) });
    if (moved && resized) return setError(t("ui.change_one_thing"));
    if (moved) return void preview("booking.move", { booking_id: it.booking_id, court_id: f.court, starts_at: f.start, reprice: f.reprice || undefined, refund: f.refund });
    if (resized) return void preview("booking.extend", { booking_id: it.booking_id, minutes: f.minutes, refund: f.refund });
  };
  return (
    <form class="card-form" onSubmit={submit}>
      {canMove && !courtFixed && <label>{t("ui.court_label")}<select value={f.court} onChange={(e) => setF({ ...f, court: e.currentTarget.value })}>{g.courts.map((c) => <option value={c.id}>{c.name}</option>)}</select></label>}
      {canMove && <label>{t("ui.starts")}<select value={f.start} onChange={(e) => setF({ ...f, start: e.currentTarget.value })}>
        {!starts.includes(f.start) && <option value={f.start}>{clock(f.start)}</option>}{starts.map((s) => <option value={s}>{clock(s)}</option>)}</select></label>}
      {canResize && <label>{t("ui.length")}<select value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.currentTarget.value) })}>{lengths.map((m) => <option value={m}>{t("ui.minutes", { count: m })}</option>)}</select></label>}
      {isBooking(it) && it.booking_kind !== "lesson" && canMove && <label class="check"><input type="checkbox" checked={f.reprice} onChange={(e) => setF({ ...f, reprice: e.currentTarget.checked })} /> {t("ui.reprice")}</label>}
      {isBooking(it) && g.money !== false && <label>{t("ui.refund_if_less")}<select value={f.refund} onChange={(e) => setF({ ...f, refund: e.currentTarget.value })}>
        <option value="rule">{t("ui.refund_by_rule")}</option><option value="full">{t("ui.refund_all")}</option><option value="none">{t("ui.refund_nothing_more")}</option></select></label>}
      {error && <p class="error" role="alert">{error}</p>}
      <button class="primary" disabled={!moved && !resized}>{t("ui.preview")}</button>
    </form>
  );
}

function DeskBooking({ court, starts, until, weekly, clock, preview, onClose }: { court: Court; starts: string[]; until: string; weekly: boolean; clock: (s: string) => string; preview: Preview; onClose: () => void }) {
  // The lengths that fit before the court closes (or the next thing on it), from the start chosen.
  const fits = (start: string) => lengthsFitting(start, until);
  // Listed shortest first; the one chosen is 90 minutes when it fits, else the longest that does (as before).
  const usual = (start: string) => { const l = fits(start); return l.includes(90) ? 90 : l.filter((m) => m < 90).at(-1) ?? l[0] ?? 30; };
  // A weekly court from + Create starts with Every week ticked: it shows once a member is chosen.
  const [f, setF] = useState({ start: starts[0] ?? "", minutes: usual(starts[0] ?? ""), guest: "", price: "", weekly, weeks: 8 }), [person, setPerson] = useState<{ id: string; display_name: string } | null>(null);
  const [q, setQ] = useState(""), [found, setFound] = useState<{ id: string; display_name: string; email: string | null }[]>([]);
  const find = async (v: string) => { setQ(v); setFound(v.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(v)}`) : []); };
  // What the club's prices say it costs, as the start and length change; the desk can type another price.
  // A member's price when it's for a member.
  type Quoted = { total_cents: number; tax_cents: number; priced: boolean; member: string | null };
  const [quoted, setQuoted] = useState<Quoted | null>(null);
  useEffect(() => { if (f.start) api<Quoted>(`/staff/quote?court_id=${court.id}&starts_at=${encodeURIComponent(f.start)}&minutes=${f.minutes}${person ? `&person_id=${person.id}` : ""}`).then(setQuoted).catch(() => setQuoted(null)); }, [f.start, f.minutes, person?.id]);
  const submit = (e: Event) => {
    e.preventDefault();
    const price = f.price ? { price_cents: parseDollars(f.price) ?? NaN } : {};
    // The same court every week for a member (booking_series.ts): each week its own booking, owed at the desk.
    if (person && f.weekly) return void preview("booking.repeat", { court_id: court.id, starts_at: f.start, minutes: Number(f.minutes), person_id: person.id, weeks: f.weeks, ...price });
    preview("booking.create", { court_id: court.id, starts_at: f.start, minutes: Number(f.minutes), ...(person ? { person_id: person.id } : { guest_name: f.guest }), ...price });
  };
  return (
    <form class="card card-form" onSubmit={submit}>
      <h2>{t("ui.book_court", { court: court.name })}</h2>
      <label>{t("ui.starts")}<select value={f.start} onChange={(e) => { const start = e.currentTarget.value; setF({ ...f, start, minutes: fits(start).includes(f.minutes) ? f.minutes : usual(start) }); }}>
        {starts.filter((s) => fits(s).length).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      <label>{t("ui.length")}<select value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.currentTarget.value) })}>{fits(f.start).map((m) => <option value={m}>{t("ui.minutes", { count: m })}</option>)}</select></label>
      {person ? <p>{person.display_name} <button type="button" class="link" onClick={() => setPerson(null)}>{t("ui.change")}</button></p> : <>
        <label>{t("ui.search_person")}<input type="search" value={q} onInput={(e) => find(e.currentTarget.value)} /></label>
        {found.length > 0 && <ul class="plain">{found.slice(0, 6).map((p) => <li class="row"><span>{p.display_name}</span><button type="button" class="small" onClick={() => { setPerson(p); setFound([]); setQ(""); }}>{t("ui.choose")}</button></li>)}</ul>}
        <label>{t("ui.or_guest_name")}<input value={f.guest} onInput={(e) => setF({ ...f, guest: e.currentTarget.value })} /></label>
      </>}
      {quoted && <p class="meta">{quoted.priced ? t("ui.quoted_price", { amount: dollars(quoted.total_cents, lang.value) }) : t("ui.no_price_then")}{quoted.member ? ` · ${t("ui.member_price", { plan: quoted.member })}` : ""}</p>}
      <label>{t("ui.price_override")}<input inputMode="decimal" pattern={amountPattern()} title={t("ui.amount_format")} value={f.price} placeholder={quoted ? dollars(quoted.total_cents, lang.value) : ""} onInput={(e) => setF({ ...f, price: e.currentTarget.value })} /></label>
      {!person && weekly && <p class="meta">{t("ui.weekly_needs_member")}</p>}
      {person && <label class="check"><input type="checkbox" checked={f.weekly} onChange={(e) => setF({ ...f, weekly: e.currentTarget.checked })} /> {t("ui.every_week")}</label>}
      {person && f.weekly && <label>{t("ui.how_many_weeks")}<input type="number" min="2" max="26" step="1" value={String(f.weeks)} onChange={(e) => setF({ ...f, weeks: Math.max(2, Math.min(26, Math.round(Number(e.currentTarget.value) || 8))) })} /></label>}
      <button class="primary" disabled={!f.start || (!person && !f.guest.trim())}>{t("ui.preview")}</button>
      <button type="button" class="link" onClick={onClose}>{t("ui.cancel")}</button>
    </form>
  );
}

/** A place a player gave up after the deadline: open it in the app, or give it to someone free. Leaving and
 *  refunding are separate: what the player gets back is the club's rule unless staff choose otherwise. */
function EmptyPlace({ e, preview, money }: { e: Empty; preview: Preview; money: boolean }) {
  const [refund, setRefund] = useState("rule"), [giving, setGiving] = useState(false);
  const [q, setQ] = useState(""), [found, setFound] = useState<{ id: string; display_name: string }[]>([]);
  const find = async (v: string) => { setQ(v); setFound(v.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(v)}`) : []); };
  return (
    <div class="note">
      <p>{t(e.open ? "ui.empty_place_open" : "ui.empty_place", { name: e.name || t("ui.player") })}</p>
      {money && <label>{t("ui.refund_choice", { name: e.name || t("ui.player") })}<select value={refund} onChange={(x) => setRefund(x.currentTarget.value)}>
        <option value="rule">{t("ui.refund_by_rule")}</option><option value="full">{t("ui.refund_all")}</option><option value="none">{t("ui.refund_nothing_more")}</option></select></label>}
      <p>{!e.open && <><button class="small" onClick={() => preview("booking.reopen_place", { booking_player_id: e.id, refund })}>{t("ui.open_in_app")}</button>{" "}</>}
        <button class="small" onClick={() => setGiving(!giving)}>{t("ui.give_free")}</button></p>
      {giving && <>
        <label>{t("ui.search_person")}<input type="search" value={q} onInput={(x) => find(x.currentTarget.value)} /></label>
        {found.length > 0 && <ul class="plain">{found.slice(0, 6).map((p) => <li class="row"><span>{p.display_name}</span>
          <button type="button" class="small" onClick={() => { setFound([]); setQ(""); void preview("booking.give_place", { booking_player_id: e.id, person_id: p.id, refund }); }}>{t("ui.choose")}</button></li>)}</ul>}
      </>}
    </div>
  );
}

function BlockForm({ courts, g, slots: daySlots, clock, preview }: { courts: Court[]; g: Grid; slots: string[]; clock: (s: string) => string; preview: Preview }) {
  const [ids, setIds] = useState<string[]>([]), [f, setF] = useState({ from: daySlots[0] ?? "", to: daySlots.at(-1) ?? "", reason: "maintenance", note: "" });
  // The times the chosen courts are open that day (the earliest opening to the latest closing); the location's day
  // until a court is chosen. A time kept from before a court was chosen moves into the new hours.
  const slots = ids.length ? courtSlots(spanOfCourts(courts.filter((c) => ids.includes(c.id)))) : daySlots;
  const pick = (next: string[]) => {
    setIds(next);
    const s = next.length ? courtSlots(spanOfCourts(courts.filter((c) => next.includes(c.id)))) : daySlots;
    if (s.length) setF({ ...f, from: s.includes(f.from) && f.from !== s.at(-1) ? f.from : s[0]!, to: s.includes(f.to) && f.to !== s[0] ? f.to : s.at(-1)! });
  };
  // Every week: on these weekdays from this date, until a date or with no end; bookings in the way stay, or are called off.
  const [rep, setRep] = useState({ on: false, days: [new Date(`${g.date}T12:00:00Z`).getUTCDay()], until: "", way: "keep", refund: "full" });
  const submit = (e: Event) => {
    e.preventDefault();
    if (!rep.on) return void preview("court.block", { court_ids: ids, starts_at: f.from, ends_at: f.to, reason: f.reason, note: f.note || undefined });
    preview("court.block_repeat", { court_ids: ids, weekdays: rep.days, starts: clubTime(f.from, g.time_zone), ends: clubTime(f.to, g.time_zone, true), from_date: g.date,
      ...(rep.until ? { until_date: rep.until } : {}), reason: f.reason, note: f.note || undefined, in_the_way: rep.way, ...(rep.way === "cancel" ? { refund: rep.refund } : {}) });
  };
  return (
    <form class="card card-form" onSubmit={submit}>
      <h2>{t("ui.block_courts")}</h2>
      {courts.map((c) => <label class="check"><input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => pick(e.currentTarget.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} /> {c.name}{!c.open ? ` (${t("ui.closed")})` : ""}</label>)}
      {ids.length > 0 && !slots.length && <p class="meta">{t("ui.courts_closed_day")}</p>}
      <label>{t("ui.from")}<select value={f.from} onChange={(e) => setF({ ...f, from: e.currentTarget.value })}>{slots.slice(0, -1).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      <label>{t("ui.to")}<select value={f.to} onChange={(e) => setF({ ...f, to: e.currentTarget.value })}>{slots.slice(1).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      <label>{t("ui.reason")}<select value={f.reason} onChange={(e) => setF({ ...f, reason: e.currentTarget.value })}>{["maintenance", "fault", "resurfacing", "event", "other"].map((r) => <option value={r}>{t(`block.${r}` as Key)}</option>)}</select></label>
      <label>{t("ui.block_note")}<input value={f.note} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} /></label>
      <label class="check"><input type="checkbox" checked={rep.on} onChange={(e) => setRep({ ...rep, on: e.currentTarget.checked })} /> {t("ui.block_every_week")}</label>
      {rep.on && <>
        <fieldset><legend>{t("ui.block_on_days")}</legend>
          {weekOrder().map((w) => <label class="check"><input type="checkbox" checked={rep.days.includes(w)} onChange={(e) => setRep({ ...rep, days: e.currentTarget.checked ? [...rep.days, w] : rep.days.filter((x) => x !== w) })} /> {dayName(w)}</label>)}
        </fieldset>
        <label>{t("ui.block_until")}<input type="date" min={g.date} value={rep.until} onInput={(e) => setRep({ ...rep, until: e.currentTarget.value })} /></label>
        <InTheWay way={rep.way} refund={rep.refund} onChange={(way, refund) => setRep({ ...rep, way, refund })} />
      </>}
      <button class="primary" disabled={!ids.length || !slots.length || ms(f.to) <= ms(f.from) || (rep.on && !rep.days.length)}>{t("ui.preview")}</button>
    </form>
  );
}

/** Bookings already where a repeating block goes: they stay (the block leaves that court then), or they're called off,
 *  with what their players get back chosen separately. */
function InTheWay({ way, refund, onChange }: { way: string; refund: string; onChange: (way: string, refund: string) => void }) {
  return <>
    <label>{t("ui.in_the_way")}<select value={way} onChange={(e) => onChange(e.currentTarget.value, refund)}>
      <option value="keep">{t("ui.in_the_way_keep")}</option><option value="cancel">{t("ui.in_the_way_cancel")}</option></select></label>
    {way === "cancel" && <label>{t("ui.in_the_way_refund")}<select value={refund} onChange={(e) => onChange(way, e.currentTarget.value)}>
      <option value="full">{t("ui.refund_all")}</option><option value="rule">{t("ui.refund_by_rule")}</option><option value="none">{t("ui.refund_nothing_more")}</option></select></label>}
  </>;
}

/** Changing a repeating block's times: this date, this and the following ones, or every date still to come. */
function SeriesChange({ it, g, slots, clock, preview }: { it: Item; g: Grid; slots: string[]; clock: (s: string) => string; preview: Preview }) {
  const near = (iso: string) => slots.find((s) => ms(s) === ms(iso)) ?? iso;
  const [f, setF] = useState({ from: near(it.start), to: near(it.end), scope: "this", way: "keep", refund: "full" });
  const submit = (e: Event) => {
    e.preventDefault();
    preview("court.block_repeat_edit", { block_id: it.block_id, scope: f.scope, starts: clubTime(f.from, g.time_zone), ends: clubTime(f.to, g.time_zone, true), in_the_way: f.way,
      ...(f.way === "cancel" ? { refund: f.refund } : {}) });
  };
  return (
    <form class="card-form" onSubmit={submit}>
      <label>{t("ui.from")}<select value={f.from} onChange={(e) => setF({ ...f, from: e.currentTarget.value })}>{slots.slice(0, -1).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      <label>{t("ui.to")}<select value={f.to} onChange={(e) => setF({ ...f, to: e.currentTarget.value })}>{slots.slice(1).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      <label>{t("ui.scope")}<select value={f.scope} onChange={(e) => setF({ ...f, scope: e.currentTarget.value })}>
        <option value="this">{t("ui.scope_this")}</option><option value="following">{t("ui.scope_following")}</option><option value="all">{t("ui.scope_all")}</option></select></label>
      <InTheWay way={f.way} refund={f.refund} onChange={(way, refund) => setF({ ...f, way, refund })} />
      <button class="primary">{t("ui.preview")}</button>
    </form>
  );
}

type Series = { id: string; courts: { id: string; name: string }[]; weekdays: number[]; starts: string; ends: string; from_date: string; until_date: string | null; reason: string;
  note: string | null; left: number; dates: { block_id: string; date: string }[] };
const shortDay = (date: string) => new Intl.DateTimeFormat(formatLocale(lang.value), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
/** Every half hour of a day as a club writes it, "00:00" to "24:00". */
const HALVES = Array.from({ length: 49 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

/** The location's repeating blocks: each pattern and its next date, to change (one date, from a date, or every date
 *  still to come) or end, without finding a date of it on the grid first. */
function SeriesList({ loc, courts, stamp, preview }: { loc: string; courts: Court[]; stamp: number; preview: Preview }) {
  const [list, setList] = useState<Series[] | null>(null), [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (loc) api<Series[]>(`/staff/block-series?location_id=${loc}`).then(setList).catch(() => setList(null)); }, [loc, stamp]);
  if (!list) return null;
  return (
    <section class="card">
      <h2>{t("ui.repeating_blocks")}</h2>
      {list.length === 0 ? <p class="meta">{t("ui.repeating_blocks_none")}</p> : <ul class="plain">{list.map((s) => (
        <li>
          <div class="row"><div><strong>{s.courts.map((c) => c.name).join(", ")}</strong> · {weekOrder().filter((w) => s.weekdays.includes(w)).map(dayName).join(", ")} · {s.starts} - {s.ends}
            <p class="meta">{t(`block.${s.reason}` as Key)}{s.note ? `: ${s.note}` : ""} · {s.until_date ? t("ui.series_span", { from: shortDay(s.from_date), until: shortDay(s.until_date) })
              : t("ui.series_span_open", { from: shortDay(s.from_date) })} · {t("ui.series_next", { date: shortDay(s.dates[0]!.date) })} · {t("count.series_dates_left", { count: s.left })}</p></div>
            <button class="small" onClick={() => setOpen(open === s.id ? null : s.id)}>{t(open === s.id ? "ui.close" : "ui.change")}</button></div>
          {open === s.id && <SeriesEdit key={s.id} s={s} courts={courts} preview={preview} />}
        </li>))}</ul>}
    </section>
  );
}

/** Changing a repeating block from the list: its courts, days, times, end date, reason and note, for one date, from a
 *  date on, or every date still to come; or ending it. Only what changed is sent, and the preview names any booking
 *  in the way, as when it was made. */
function SeriesEdit({ s, courts, preview }: { s: Series; courts: Court[]; preview: Preview }) {
  const [f, setF] = useState({ block: s.dates[0]!.block_id, scope: "following", courts: s.courts.map((c) => c.id), days: s.weekdays, starts: s.starts, ends: s.ends,
    noEnd: !s.until_date, until: s.until_date ?? "", reason: s.reason, note: s.note ?? "", way: "keep", refund: "full" });
  const same = (a: (string | number)[], b: (string | number)[]) => [...a].sort().join() === [...b].sort().join();
  const one = f.scope === "this", until = f.noEnd ? null : f.until || null, note = f.note.trim() || null;
  // A weekday or an end date is the pattern's, so it only changes from a date on (or for all of it).
  const change = {
    ...(same(f.courts, s.courts.map((c) => c.id)) ? {} : { court_ids: f.courts }),
    ...(!one && !same(f.days, s.weekdays) ? { weekdays: f.days } : {}),
    ...(f.starts !== s.starts ? { starts: f.starts } : {}), ...(f.ends !== s.ends ? { ends: f.ends } : {}),
    ...(!one && until !== s.until_date ? { until_date: until } : {}),
    ...(f.reason !== s.reason ? { reason: f.reason } : {}), ...(note !== s.note ? { note } : {}),
  };
  const submit = (e: Event) => { e.preventDefault(); void preview("court.block_repeat_edit", { block_id: f.block, scope: f.scope, ...change, in_the_way: f.way, ...(f.way === "cancel" ? { refund: f.refund } : {}) }); };
  const end = (scope: string) => preview("court.block_repeat_end", { block_id: f.block, scope });
  const starts = (v: string) => setF({ ...f, starts: v, ends: f.ends > v ? f.ends : HALVES[HALVES.indexOf(v) + 1]! });
  return (
    <form class="card-form" onSubmit={submit}>
      <label>{t("ui.series_date")}<select value={f.block} onChange={(e) => setF({ ...f, block: e.currentTarget.value })}>{s.dates.map((d) => <option value={d.block_id}>{shortDay(d.date)}</option>)}</select></label>
      <label>{t("ui.scope")}<select value={f.scope} onChange={(e) => setF({ ...f, scope: e.currentTarget.value })}>
        <option value="this">{t("ui.scope_this")}</option><option value="following">{t("ui.scope_following")}</option><option value="all">{t("ui.scope_all")}</option></select></label>
      <fieldset><legend>{t("ui.courts")}</legend>{courts.map((c) => <label class="check"><input type="checkbox" checked={f.courts.includes(c.id)}
        onChange={(e) => setF({ ...f, courts: e.currentTarget.checked ? [...f.courts, c.id] : f.courts.filter((x) => x !== c.id) })} /> {c.name}</label>)}</fieldset>
      {!one && <fieldset><legend>{t("ui.block_on_days")}</legend>{weekOrder().map((w) => <label class="check"><input type="checkbox" checked={f.days.includes(w)}
        onChange={(e) => setF({ ...f, days: e.currentTarget.checked ? [...f.days, w] : f.days.filter((x) => x !== w) })} /> {dayName(w)}</label>)}</fieldset>}
      <label>{t("ui.from")}<select value={f.starts} onChange={(e) => starts(e.currentTarget.value)}>{HALVES.slice(0, -1).map((h) => <option value={h}>{h}</option>)}</select></label>
      <label>{t("ui.to")}<select value={f.ends} onChange={(e) => setF({ ...f, ends: e.currentTarget.value })}>{HALVES.filter((h) => h > f.starts).map((h) => <option value={h}>{h}</option>)}</select></label>
      {!one && <><label class="check"><input type="checkbox" checked={f.noEnd} onChange={(e) => setF({ ...f, noEnd: e.currentTarget.checked })} /> {t("ui.series_no_end")}</label>
        {!f.noEnd && <label>{t("ui.series_until")}<input type="date" min={s.dates[0]!.date} value={f.until} onInput={(e) => setF({ ...f, until: e.currentTarget.value })} /></label>}</>}
      <label>{t("ui.reason")}<select value={f.reason} onChange={(e) => setF({ ...f, reason: e.currentTarget.value })}>{["maintenance", "fault", "resurfacing", "event", "other"].map((r) => <option value={r}>{t(`block.${r}` as Key)}</option>)}</select></label>
      <label>{t("ui.block_note")}<input value={f.note} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} /></label>
      <InTheWay way={f.way} refund={f.refund} onChange={(way, refund) => setF({ ...f, way, refund })} />
      {mayHere("court.block_repeat_edit") && <button class="primary" disabled={!Object.keys(change).length || !f.courts.length || (!one && !f.days.length) || (!one && !f.noEnd && !f.until)}>{t("ui.preview")}</button>}
      {mayHere("court.block_repeat_end") && <div class="chips">
        <button type="button" class="small" onClick={() => end("this")}>{t("ui.open_this_date")}</button>
        <button type="button" class="small" onClick={() => end("following")}>{t("ui.end_from_here")}</button>
        <button type="button" class="small" onClick={() => end("all")}>{t("ui.end_series")}</button></div>}
    </form>
  );
}
