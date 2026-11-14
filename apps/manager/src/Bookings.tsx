// Bookings as a list, for staff who look for one booking among many (as they do in other club software): a location's
// bookings over some days with their kind, where each was made and how it stands, filtered and a page at a time; and its
// weekly courts. A row opens the same side panel as the Schedule, with the same buttons. The server decides what each
// reader sees (reads.ts): names only for those who read people, what's owed only for money readers, and a coach on
// their own sees their own lessons.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { formatLocale } from "@kumi/i18n/format";
import { api, coversLocation, dollars, EmptyState, lang, mayCreate, me, t, useBackCloses, usePreview } from "@kumi/ui";
import { Details, SidePanel, canMove, canResize, clockIn, courtsOf, daySlots, keyOf, showLocation, type Court, type Grid, type Item } from "./Courts.tsx";
import { Pager, Tabs } from "./lists.tsx";
import { BOOKING_COLUMNS, ordered, type BookingColumn } from "./presets.ts";
import { label, preset } from "./words.ts";

type Loc = { id: string; name: string; time_zone: string };
type Row = { key: string; date: string; starts_at: string; ends_at: string; minutes: number; court_id: string; court: string; type: "court" | "lesson" | "open_match" | "program" | "playtomic";
  program_kind?: string | null; made_in: "app" | "desk" | "playtomic" | "club"; status: "upcoming" | "in_progress" | "done" | "cancelled"; owed_cents?: number; who: string | null; person_id?: string | null;
  more: number; label?: string; code?: string; booking_id?: string; program_id?: string };
type List = { from: string; to: string; today: string; time_zone: string; money: boolean; people: boolean; total: number; page: number; pages: number; rows: Row[] };
type Weekly = { money: boolean; people: boolean; total: number; rows: { id: string; weekday: number; starts: string; minutes: number; court: string; first_date: string; last_date: string;
  made_in: "app" | "desk"; status: "active" | "paused"; who: string | null; person_id: string | null; price_cents?: number | null; owed_cents?: number }[] };

const TYPES = ["court", "lesson", "open_match", "program", "playtomic"] as const;
const STATES = ["upcoming", "in_progress", "done", "cancelled", "unpaid"] as const;
const MADE = ["app", "desk", "playtomic"] as const, MAX_DAYS = 62;
const shiftDay = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
const dayWords = (d: string, o: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) => new Intl.DateTimeFormat(formatLocale(lang.value), { ...o, timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));

export function Bookings() {
  const [locs, setLocs] = useState<Loc[]>([]), [loc, setLoc] = useState(""), [tab, setTab] = useState<"all" | "weekly">("all");
  const [from, setFrom] = useState(""), [to, setTo] = useState(""), [type, setType] = useState(""), [status, setStatus] = useState(() => new URLSearchParams(location.search).get("status") ?? ""), [made, setMade] = useState(""), [page, setPage] = useState(1);
  const [list, setList] = useState<List | null>(null), [error, setError] = useState(""), [weekly, setWeekly] = useState<Weekly | null | false>(null);
  const [picked, setPicked] = useState<Row | null>(null), [g, setG] = useState<Grid | null>(null);
  // Only the latest answer is shown: a quick change of filter or page doesn't let an older one land after it.
  const seq = useRef(0);
  const exportQuery = () => new URLSearchParams({ location_id: loc, ...(from ? { from, to: to || from } : {}), ...(type ? { type } : {}), ...(status ? { status } : {}), ...(made ? { made_in: made } : {}) }).toString();
  const load = () => {
    if (!loc) return;
    const q = new URLSearchParams({ location_id: loc, ...(from ? { from, to: to || from } : {}), ...(type ? { type } : {}), ...(status ? { status } : {}), ...(made ? { made_in: made } : {}), page: String(page) });
    const n = ++seq.current;
    api<List>(`/staff/bookings?${q}`).then((x) => { if (n !== seq.current) return; setList(x); setError(""); if (!from) { setFrom(x.from); setTo(x.to); } })
      .catch((e) => { if (n === seq.current) setError((e as Error).message); });
  };
  // Weekly courts are members' own courts, not a coach's work: a coach on their own isn't offered them (the server says no).
  const coachOnly = !me.value?.areas && (me.value?.roles ?? []).every((r) => r.key === "coach" || r.key === "member");
  const loadWeekly = () => coachOnly ? setWeekly(false) : loc && api<Weekly>(`/staff/weekly-courts?location_id=${loc}`).then(setWeekly).catch(() => setWeekly(false));
  // The side panel shows the item as the Schedule has it now: the day's grid, read again after any change.
  const loadGrid = (r: Row) => api<Grid>(`/staff/grid?location_id=${loc}&date=${r.date}`).then(setG).catch(() => setG(null));
  const { preview, sheet } = usePreview(() => { load(); void loadWeekly(); if (picked) void loadGrid(picked); });
  useEffect(() => { api<Loc[]>("/staff/locations").then((l) => { setLocs(l); setLoc((l.find((x) => coversLocation(x.id)) ?? l[0])?.id ?? ""); }); }, []);
  // Another day, location or filter starts again at the first page.
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } if (page !== 1) setPage(1); else load(); }, [loc, from, to, type, status, made]);
  useEffect(load, [page]);
  useEffect(() => { setWeekly(null); void loadWeekly(); }, [loc]);
  showLocation(loc);

  const open = (r: Row) => { setPicked(r); setG(null); if (r.status !== "cancelled") void loadGrid(r); };
  const close = () => { setPicked(null); setG(null); };
  // The phone's back button closes the side panel, not the page.
  useBackCloses(Boolean(picked), close);
  // Days before and after keep the range's length: a day becomes the day before, a week the week before.
  const span = from && to ? Math.max(0, daysBetween(from, to)) : 0;
  const shift = (n: number) => { setFrom(shiftDay(from, n * (span + 1))); setTo(shiftDay(to || from, n * (span + 1))); };
  const filter = (label: string, value: string, set: (v: string) => void, options: [string, string][]) => (
    <label class={`filter-chip${value ? " on" : ""}`}><span>{label}</span>
      <select value={value} onChange={(e) => set(e.currentTarget.value)}><option value="">{t("ui.filter_all")}</option>{options.map(([v, w]) => <option value={v}>{w}</option>)}</select></label>
  );
  const money = list?.money ?? false;
  const stateOptions = STATES.filter((s) => s !== "unpaid" || money).map((s) => [s, t(`ui.booking_state_${s}` as Key)] as [string, string]);

  return (
    <main class="wide">
      <div class="page-head">
        <h1>{label("ui.nav_bookings")}</h1>
        {tab === "all" && list && <span class="count-chip" role="status">{t("count.bookings", { count: list.total })}</span>}
        {tab === "weekly" && weekly && <span class="count-chip" role="status">{t("count.weekly_courts", { count: weekly.total })}</span>}
        {locs.length > 1 && <select class="sched-loc" aria-label={t("ui.location")} value={loc} onChange={(e) => { setLoc(e.currentTarget.value); close(); }}>{locs.map((l) => <option value={l.id}>{l.name}</option>)}</select>}
        <span class="grow" />
        {/* The list as it's filtered now, as a spreadsheet: the server leaves out what this reader doesn't see on screen. */}
        {tab === "all" && list && list.total > 0 && <a class="button" href={`/staff/bookings.csv?${exportQuery()}`} download>{t("ui.export")}</a>}
        {/* The Schedule's + Create, over the first day shown. */}
        {loc && (mayCreate("booking.create") || mayCreate("program.create") || mayCreate("court.block")) && coversLocation(loc) &&
          <a class="button primary" href={`/courts?location=${loc}&create=1${from ? `&date=${from}` : ""}`}><span aria-hidden="true">+</span> {t("ui.create")}</a>}
      </div>
      {weekly !== false && <Tabs label={t("ui.bookings_lists")} tabs={[["all", t("ui.bookings_all")], ["weekly", t("ui.bookings_weekly")]]} on={tab} pick={(x) => { setTab(x as "all" | "weekly"); close(); }} id="bookings" />}

      {tab === "all" && <div role={weekly !== false ? "tabpanel" : undefined} tabIndex={weekly !== false ? 0 : undefined} id="bookings-panel-all" aria-labelledby={weekly !== false ? "bookings-tab-all" : undefined}>
        <div class="list-bar">
          <div class="day-nav">
            <button type="button" onClick={() => shift(-1)} aria-label={t(span ? "ui.days_before" : "ui.day_before")} disabled={!from}>‹</button>
            <button type="button" onClick={() => { if (list) { setFrom(list.today); setTo(list.today); } }} aria-current={list && from === list.today && to === list.today ? "date" : undefined}>{t("ui.today_button")}</button>
            <button type="button" onClick={() => shift(1)} aria-label={t(span ? "ui.days_after" : "ui.day_after")} disabled={!from}>›</button>
          </div>
          <label class="inline-field">{t("ui.from_day")}<input type="date" value={from} onInput={(e) => { const v = e.currentTarget.value; if (v) { setFrom(v); if (!to || to < v || to > shiftDay(v, MAX_DAYS)) setTo(v); } }} /></label>
          {/* Up to 62 days at once, as the server reads them. */}
          <label class="inline-field">{t("ui.to_day")}<input type="date" value={to} min={from} max={from ? shiftDay(from, MAX_DAYS) : undefined}
            onInput={(e) => { const v = e.currentTarget.value; if (v && v >= from && v <= shiftDay(from, MAX_DAYS)) setTo(v); }} /></label>
          {from && <span class="sched-day">{from === to ? dayWords(from, { weekday: "long", day: "numeric", month: "long" }) : t("ui.day_range", { from: dayWords(from), to: dayWords(to) })}</span>}
        </div>
        <div class="list-bar" role="group" aria-label={t("ui.filters")}>
          {filter(t("ui.filter_type"), type, setType, TYPES.map((x) => [x, t(`ui.list_type_${x}` as Key)]))}
          {filter(t("ui.filter_status"), status, setStatus, stateOptions)}
          {filter(t("ui.filter_made_in"), made, setMade, MADE.map((x) => [x, t(`ui.made_in_${x}` as Key)]))}
        </div>
        {error && <p class="error" role="alert">{error}</p>}
        {!list ? <p>{t("ui.loading")}</p> : list.rows.length === 0 ? <EmptyState art="no-bookings" size="s" class="meta">{t("ui.bookings_none")}</EmptyState> : <>
          <BookingTable list={list} onOpen={open} />
          <Pager page={list.page} pages={list.pages} go={setPage} shown={list.rows.length} total={list.total} per={25} />
          {list.rows.some((r) => r.type === "playtomic") && <p class="meta">{t("ui.playtomic_copies_note")}</p>}
        </>}
      </div>}

      {tab === "weekly" && weekly && <div role="tabpanel" tabIndex={0} id="bookings-panel-weekly" aria-labelledby="bookings-tab-weekly">
        {weekly.rows.length === 0 ? <p class="card meta">{t("ui.weekly_none")}</p> : <WeeklyTable w={weekly} />}
      </div>}

      {picked && <SidePanel narrow onClose={close}>
        <RowPanel row={picked} g={g} tz={list?.time_zone ?? ""} loc={loc} preview={preview} />
      </SidePanel>}
      {sheet}
    </main>
  );
}

const pillOf = (s: Row["status"]) => <span class={`pill pill-${s}`}>{t(`ui.booking_state_${s}` as Key)}</span>;
/** Each column's heading; their order is the club's "Coming from" preset's (presets.ts). */
const HEAD: Record<BookingColumn, "ui.date_and_time" | "ui.length" | "ui.players_col" | "ui.court_label" | "ui.filter_type" | "ui.filter_made_in" | "ui.filter_status"> = {
  when: "ui.date_and_time", length: "ui.length", players: "ui.players_col", court: "ui.court_label", type: "ui.filter_type", made_in: "ui.filter_made_in", status: "ui.filter_status" };
function BookingTable({ list, onOpen }: { list: List; onOpen: (r: Row) => void }) {
  const cols = ordered(preset().bookingColumns, BOOKING_COLUMNS);
  const when = (iso: string) => new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: list.time_zone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const kind = (r: Row) => r.type === "program" && r.program_kind ? t(`kind.${r.program_kind}` as Key) : t(`ui.list_type_${r.type}` as Key);
  // Who: the organiser and how many more (for those who read people), a program's name and its places, a Playtomic
  // copy's kind when nobody is named; otherwise how many play.
  const who = (r: Row) => r.type === "program" ? <><strong>{r.label}</strong> <span class="meta">{t("count.signed_up", { count: r.more })}</span></>
    : r.who ? <>{r.person_id ? <a href={`/people/${r.person_id}`} onClick={(e) => e.stopPropagation()}>{r.who}</a> : <strong>{r.who}</strong>}{r.more > 0 && <span class="meta"> +{r.more}</span>}</>
    : r.type === "playtomic" ? <span class="meta">{r.label}</span> : <span class="meta">{t("count.players", { count: r.more + 1 })}</span>;
  return (
    <div class="table-scroll table-box">
      <table class="data">
        <caption class="sr-only">{t("ui.bookings_all")}</caption>
        <thead><tr>{cols.map((c) => <th scope="col">{t(HEAD[c])}</th>)}</tr></thead>
        <tbody>{list.rows.map((r) => {
          const cell: Record<BookingColumn, any> = {
            when: <td><button type="button" class="link row-open" onClick={(e) => { e.stopPropagation(); onOpen(r); }} aria-haspopup="dialog">{when(r.starts_at)}</button></td>,
            length: <td>{t("ui.minutes", { count: r.minutes })}</td>,
            players: <td class="wrap">{who(r)}</td>,
            court: <td>{r.court}</td>,
            type: <td><span class={`kind-dot k-${r.type === "program" ? (r.program_kind === "clinic" || r.program_kind === "course" ? "learning" : "event") : r.type === "lesson" ? "learning" : r.type === "court" ? "booking" : r.type}`} aria-hidden="true" /><span class="cap">{kind(r)}</span></td>,
            made_in: <td>{t(`ui.made_in_${r.made_in}` as Key)}</td>,
            status: <td>{pillOf(r.status)}{(r.owed_cents ?? 0) > 0 && <> <span class="pill-unpaid">{t("ui.unpaid_pill")} · {dollars(r.owed_cents!, lang.value)}</span></>}</td>,
          };
          return <tr class="clickable" onClick={() => onOpen(r)}>{cols.map((c) => cell[c])}</tr>;
        })}</tbody>
      </table>
    </div>
  );
}

function WeeklyTable({ w }: { w: Weekly }) {
  const day = (n: number) => new Intl.DateTimeFormat(formatLocale(lang.value), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + n)));
  const time = (hhmm: string) => new Intl.DateTimeFormat(formatLocale(lang.value), { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(`2026-01-04T${hhmm}:00Z`));
  return (
    <div class="table-scroll table-box">
      <table class="data">
        <caption class="sr-only">{t("ui.bookings_weekly")}</caption>
        <thead><tr><th scope="col">{t("ui.every")}</th><th scope="col">{t("ui.court_label")}</th><th scope="col">{t("ui.players_col")}</th><th scope="col">{t("ui.started")}</th>
          <th scope="col">{t("ui.runs_until")}</th>{w.money && <th scope="col">{t("ui.price")}</th>}<th scope="col">{t("ui.filter_status")}</th></tr></thead>
        <tbody>{w.rows.map((r) => (
          <tr>
            <td><strong>{day(r.weekday)} · {time(r.starts)}</strong> <span class="meta">{t("ui.minutes", { count: r.minutes })}</span></td>
            <td>{r.court}</td>
            <td>{r.who ? (r.person_id ? <a href={`/people/${r.person_id}`}>{r.who}</a> : r.who) : <span class="meta">{t("ui.name_not_shown")}</span>}</td>
            <td>{dayWords(r.first_date, { day: "numeric", month: "short", year: "numeric" })}</td>
            <td>{dayWords(r.last_date, { day: "numeric", month: "short", year: "numeric" })}</td>
            {w.money && <td>{r.price_cents != null ? dollars(r.price_cents, lang.value) : ""}</td>}
            <td><span class={`pill pill-${r.status === "paused" ? "paused" : "upcoming"}`}>{t(r.status === "paused" ? "ui.weekly_paused" : "ui.weekly_active")}</span>
              {(r.owed_cents ?? 0) > 0 && <> <span class="pill-unpaid">{t("ui.unpaid_pill")} · {dollars(r.owed_cents!, lang.value)}</span></>}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

/** A row's side panel: the item as the Schedule shows it, with its buttons; a cancelled booking (no longer on the day)
 *  says what it was. */
function RowPanel({ row, g, tz, loc, preview }: { row: Row; g: Grid | null; tz: string; loc: string; preview: (action: string, input: unknown) => Promise<void> }) {
  const sel = g?.courts.flatMap((c) => c.items.map((it) => ({ it, c }))).find((x) => keyOf(x.it, x.c.id) === row.key) ?? null;
  const day = <p><a href={`/courts?date=${row.date}&location=${loc}`}>{t("ui.see_day_schedule")}</a></p>;
  if (sel && g) {
    const clock = clockIn(g.time_zone), it: Item = sel.it, court: Court = sel.c;
    return <><Details key={`${row.key}|${it.start}|${it.end}`} it={it} court={court} g={g} clock={clock} slots={daySlots(g)} preview={preview} canMove={canMove(it)} canResize={canResize(it)}
      courtFixed={courtsOf(g, it) > 1} />{day}</>;
  }
  if (row.status !== "cancelled" && !g) return <p>{t("ui.loading")}</p>;
  const clock = clockIn(tz);
  return (
    <section>
      <span class="kind-tag k-booking">{t(`ui.list_type_${row.type}` as Key)}</span>
      <h2>{clock(row.starts_at)} - {clock(row.ends_at)} · {row.court}</h2>
      <p>{[row.who, row.code].filter(Boolean).join(" · ")}</p>
      <p>{pillOf(row.status)}</p>
      {row.person_id && <p><a href={`/people/${row.person_id}`}>{t("ui.open_person")}</a></p>}
      {day}
    </section>
  );
}
