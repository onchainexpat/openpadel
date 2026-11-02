// The courts on one day, as the desk sees them: a column per court with the time down the side, what's on now
// and next, and the alerts that need someone. Drag a booking (or a program date) to another time or court, or
// drag its bottom edge to make it longer or shorter: every drop opens the preview before anything changes, and
// the same changes are on buttons and keys for anyone not dragging. Times are the location's, whatever the
// device's clock says.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, club, dollars, lang, mayDo, me, t, usePreview } from "@kumi/ui";

type Empty = { id: string; name: string; open: boolean };
type Late = { name: string; minutes: number; at: string };
type Seat = { id: string; name: string; booker: boolean };
type Item = { start: string; end: string; kind: string; booking_id?: string; code?: string; who?: string; price_cents?: number; paid_cents?: number; balance_cents?: number; booking_kind?: string;
  coach?: string | null; status?: string; players?: string[]; late?: Late[]; whole?: boolean; invite_code?: string | null; seats?: Seat[]; block_id?: string; series?: boolean; session_id?: string; program_id?: string; label?: string; empty_places?: Empty[] };
// `open`: that court's own hours that day (they can differ from the location's); null when it's closed all day.
type Court = { id: string; name: string; kind: string; open: { opens: string; closes: string } | null; items: Item[] };
type Grid = { date: string; time_zone: string; open: { opens: string; closes: string } | null; now: string; today: string; courts: Court[] };
type Loc = { id: string; name: string; time_zone: string };
type Alert = { event_id: string; kind: string; subject: string; body: string; link: string | null; at: string };
type Alerts = { open: Alert[]; handled: (Alert & { handled_at: string; handled_by: string })[] };
type Preview = (action: string, input: unknown) => Promise<void>;
/** Where a dragged (or keyed) item would go: a court, a start, and how long. */
type Target = { court: string; start: number; minutes: number };
const HALF = 30 * 60_000, SLOT = 44;   // one half hour is this many pixels tall
const ms = (iso: string) => new Date(iso).getTime();
const length = (it: Item) => Math.round((ms(it.end) - ms(it.start)) / 60_000);
// One item, wherever it is now: picked stays picked after it moves to another court.
const keyOf = (it: Item, court: string) => it.booking_id ?? it.session_id ?? it.block_id ?? `${court}|${it.start}`;
const unpaid = (it: Item) => Math.max(0, (it.price_cents ?? 0) - (it.paid_cents ?? 0));
const isBooking = (it: Item) => Boolean(it.booking_id) && it.kind === "booking";

export function Courts() {
  const [locs, setLocs] = useState<Loc[]>([]), [loc, setLoc] = useState(""), [date, setDate] = useState(""), [g, setG] = useState<Grid | null>(null);
  const [form, setForm] = useState<{ court: Court; starts: string[] } | null>(null), [blocking, setBlocking] = useState(false);
  const [picked, setPicked] = useState<string | null>(null), [alerts, setAlerts] = useState<Alerts | null>(null), [done, setDone] = useState(0);
  const load = () => loc && api<Grid>(`/staff/grid?location_id=${loc}${date ? `&date=${date}` : ""}`).then((x) => { setG(x); if (!date) setDate(x.date); });
  const loadAlerts = () => api<Alerts>("/staff/alerts").then(setAlerts).catch(() => setAlerts(null));
  const { preview, sheet } = usePreview(() => { load(); loadAlerts(); setForm(null); setBlocking(false); setDone((n) => n + 1); });
  useEffect(() => { api<Loc[]>("/staff/locations").then((l) => { setLocs(l); setLoc(l[0]?.id ?? ""); }); void loadAlerts(); }, []);
  useEffect(() => { load(); }, [loc, date]);
  // Today, what's on now moves on its own: look again every minute.
  useEffect(() => {
    if (!g || g.date !== g.today) return;
    const id = setInterval(() => { load(); loadAlerts(); }, 60_000);
    return () => clearInterval(id);
  }, [g?.date, g?.today, loc]);
  if (!g) return <main class="card"><p>{t("ui.loading")}</p></main>;

  const clock = (iso: string | number) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: g.time_zone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const today = g.date === g.today;
  // Every half hour the location is open, as instants: the same list for choosing a start or a block.
  const slots: string[] = [];
  if (g.open) for (let s = ms(g.open.opens); s <= ms(g.open.closes); s += HALF) slots.push(new Date(s).toISOString());
  const gaps = (c: Court) => {
    if (!c.open) return [];
    const out: { from: string; to: string }[] = [];
    let cursor = ms(c.open.opens);
    for (const it of [...c.items].sort((a, b) => ms(a.start) - ms(b.start))) {
      if (ms(it.start) > cursor) out.push({ from: new Date(cursor).toISOString(), to: it.start });
      cursor = Math.max(cursor, ms(it.end));
    }
    if (cursor < ms(c.open.closes)) out.push({ from: new Date(cursor).toISOString(), to: c.open.closes });
    return out.filter((x) => ms(x.to) - ms(x.from) >= HALF && new Date(x.to) > new Date());
  };
  const shift = (days: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); setDate(d.toISOString().slice(0, 10)); };
  const roles = (me.value?.roles ?? []).map((r) => r.key);
  const seriesOk = roles.includes("owner") || roles.includes("manager") || (me.value?.can ?? []).includes("series.edit");
  // What can be moved, and what made longer or shorter: a confirmed booking (moved before it starts, its length
  // changed until it ends), and a program date before it starts, for those who edit programs.
  const canMove = (it: Item) => (isBooking(it) && it.status === "confirmed" && ms(it.start) > Date.now() && mayDo("booking.move")) || (Boolean(it.session_id) && seriesOk && ms(it.start) > Date.now());
  const canResize = (it: Item) => (isBooking(it) && it.status === "confirmed" && ms(it.end) > Date.now() && mayDo("booking.extend")) || (Boolean(it.session_id) && seriesOk && ms(it.start) > Date.now());
  // A program date on more than one court keeps its courts when moved: only its time changes.
  const courtsOf = (it: Item) => g.courts.filter((c) => c.items.some((x) => it.session_id && x.session_id === it.session_id)).length;
  const drop = (it: Item, from: Court, to: Target) => {
    const minutes = length(it), startsAt = new Date(to.start).toISOString();
    if (it.booking_id) return to.minutes !== minutes ? preview("booking.extend", { booking_id: it.booking_id, minutes: to.minutes })
      : preview("booking.move", { booking_id: it.booking_id, court_id: to.court, starts_at: startsAt });
    if (it.session_id) return preview("series.edit", { session_id: it.session_id, scope: "this", ...(to.minutes !== minutes ? { minutes: to.minutes } : { starts_at: startsAt }),
      ...(to.court !== from.id ? { court_ids: [to.court] } : {}) });
  };
  // Tapping free time books it at the desk, from that half hour.
  const book = (c: Court, at: number) => {
    if (!mayDo("booking.create")) return;
    const gap = gaps(c).find((x) => ms(x.from) <= at && at < ms(x.to));
    if (!gap) return;
    const starts = slots.filter((s) => ms(s) >= Math.max(at, ms(gap.from)) && ms(s) + HALF <= ms(gap.to) && new Date(s) > new Date());
    if (starts.length) setForm({ court: c, starts });
  };
  const sel = g.courts.flatMap((c) => c.items.map((it) => ({ it, c }))).find((x) => keyOf(x.it, x.c.id) === picked) ?? null;

  return (
    <main class="today">
      <h1>{t("ui.courts")}</h1>
      <section class="card card-form">
        {locs.length > 1 && <label>{t("ui.location")}<select value={loc} onChange={(e) => { setLoc(e.currentTarget.value); setDate(""); }}>{locs.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>}
        <div class="court-row">
          <button type="button" class="small" onClick={() => shift(-1)} aria-label={t("ui.day_before")}>‹</button>
          <input type="date" aria-label={t("ui.day")} value={date} onInput={(e) => setDate(e.currentTarget.value)} />
          {date && <span class="meta">{new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}</span>}
          <button type="button" class="small" onClick={() => shift(1)} aria-label={t("ui.day_after")}>›</button>
          {!today && <button type="button" class="small" onClick={() => setDate(g.today)}>{t("ui.today_button")}</button>}
        </div>
        {!g.open && <p class="meta">{t("ui.closed_this_day")}</p>}
        {g.open && <p class="meta">{t("ui.open_from_to", { from: clock(g.open.opens), to: clock(g.open.closes) })}</p>}
      </section>

      {today && alerts && (alerts.open.length > 0 || alerts.handled.length > 0 || mayDo("alert.handle")) && <AlertList a={alerts} clock={clock} preview={preview} />}
      {today && <NowNext g={g} clock={clock} />}
      <TimeGrid g={g} clock={clock} picked={picked} onPick={(k) => setPicked(k === picked ? null : k)} canMove={canMove} canResize={canResize}
        courtFixed={(it) => courtsOf(it) > 1} onDrop={drop} onFree={book} />
      <p class="meta">{t("ui.today_hint")}</p>
      {sel && <Details key={`${picked}|${sel.c.id}|${sel.it.start}|${sel.it.end}`} it={sel.it} court={sel.c} g={g} clock={clock} slots={slots} preview={preview} canMove={canMove(sel.it)} canResize={canResize(sel.it)}
        courtFixed={courtsOf(sel.it) > 1} onClose={() => setPicked(null)} />}
      {g.open && mayDo("court.block") && <button onClick={() => setBlocking(!blocking)}>{t("ui.block_courts")}</button>}
      {form && <DeskBooking court={form.court} starts={form.starts} clock={clock} preview={preview} onClose={() => setForm(null)} />}
      {blocking && <BlockForm courts={g.courts} g={g} slots={slots} clock={clock} preview={preview} />}
      {(mayDo("court.block_repeat_edit") || mayDo("court.block_repeat_end")) && <SeriesList loc={loc} courts={g.courts} stamp={done} preview={preview} />}
      {sheet}
    </main>
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
            <div class="row"><span class="meta">{clock(x.at)}</span><span>{x.link && <a href={x.link}>{t("ui.open")}</a>}{" "}
              {mayDo("alert.handle") && <button class="small" onClick={() => preview("alert.handle", { event_id: x.event_id, kind: x.kind })}>{t("ui.alert_handled_button")}</button>}</span></div>
          </li>))}</ul>
      )}
      {a.handled.length > 0 && <details><summary class="meta">{t("count.alerts_handled", { count: a.handled.length })}</summary>
        <ul class="plain">{a.handled.map((x) => <li class="meta">{x.handled_by ? t("ui.alert_handled_by", { subject: x.subject, name: x.handled_by, time: clock(x.handled_at) })
          : t("ui.alert_closed", { subject: x.subject, time: clock(x.handled_at) })}</li>)}</ul></details>}
    </section>
  );
}

/** Who and what an item is, in a few words: the organiser (and coach), a program's or a block's name. */
const labelOf = (it: Item) => it.booking_id ? (it.kind === "hold" ? t("ui.being_paid") : [it.who, it.booking_kind === "lesson" && it.coach ? t("ui.lesson_with", { coach: it.coach }) : ""].filter(Boolean).join(" · "))
  : [it.label ?? "", it.series ? t("ui.repeats_weekly") : ""].filter(Boolean).join(" · ");
/** A clock time in the location's time zone, as a club writes it: "18:00", and "24:00" for midnight at the end of the day. */
const clubTime = (iso: string, tz: string, end = false) => {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return end && s === "00:00" ? "24:00" : s;
};
const dayName = (w: number) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** The parts of the grid's hours a court is closed: before it opens and after it closes, or all of it. */
function closedBands(c: Court, from: number, to: number) {
  if (!c.open) return [{ from, to }];
  return [{ from, to: Math.min(ms(c.open.opens), to) }, { from: Math.max(ms(c.open.closes), from), to }].filter((b) => b.to > b.from);
}

/** On each court: what's on now, and what starts next, with money owed and any word about running late. */
function NowNext({ g, clock }: { g: Grid; clock: (s: string) => string }) {
  const now = Date.now();
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
              {cur && isBooking(cur) && unpaid(cur) > 0 && <span class="badge warn">{t("ui.unpaid_amount", { amount: dollars(unpaid(cur), lang.value) })}</span>}</div>
            {[cur, next].flatMap((it) => it?.late ?? []).map((l) => <div class="note">{t("ui.late_note", { name: l.name, minutes: l.minutes })}</div>)}
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
    if (e.key === "Escape") { setDrag(null); return; }
    if (e.key === "Enter" && drag && !drag.pointer) { e.preventDefault(); finish(); return; }
    if (e.shiftKey && resize && (e.key === "ArrowUp" || e.key === "ArrowDown")) { mode = "resize"; to = { ...cur.orig, minutes: Math.max(30, to.minutes + (e.key === "ArrowDown" ? 30 : -30)) }; }
    else if (move && (e.key === "ArrowUp" || e.key === "ArrowDown")) { mode = "move"; to = { ...to, minutes: cur.orig.minutes, start: clampStart(to.start + (e.key === "ArrowDown" ? HALF : -HALF), cur.orig.minutes) }; }
    else if (move && !courtFixed(it) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { mode = "move"; to = { ...to, minutes: cur.orig.minutes, court: g.courts[Math.min(g.courts.length - 1, Math.max(0, at + (e.key === "ArrowRight" ? 1 : -1)))]!.id }; }
    else return;
    e.preventDefault();
    setDrag({ ...cur, mode, to });
  };
  const nowLine = g.date === g.today ? Date.now() : null;

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
              const kind = it.booking_id ? (it.kind === "hold" ? "hold" : it.booking_kind === "lesson" ? "lesson" : "booking") : it.kind;
              return (
                <div class={`tg-item k-${kind}${picked === k ? " sel" : ""}${drag?.it === it ? " dragging" : ""}`} style={`top:${top}px;height:${h}px`}>
                  <button type="button" class="tg-face" aria-pressed={picked === k} onClick={() => onPick(k)} onKeyDown={(e) => keys(e, it, c)}>
                    <span class="tg-time">{clock(it.start)} - {clock(it.end)}</span>
                    <span class="tg-who">{labelOf(it)}</span>
                    {isBooking(it) && unpaid(it) > 0 && <span class="badge warn">{dollars(unpaid(it), lang.value)}</span>}
                    {(it.late?.length ?? 0) > 0 && <span class="badge">{t("ui.late_note", { name: it.late![0]!.name, minutes: it.late![0]!.minutes })}</span>}
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

/** The item picked: who's playing, what's paid, and every change for it on buttons. */
function Details({ it, court, g, clock, slots, preview, canMove, canResize, courtFixed, onClose }: { it: Item; court: Court; g: Grid; clock: (s: string | number) => string; slots: string[];
  preview: Preview; canMove: boolean; canResize: boolean; courtFixed: boolean; onClose: () => void }) {
  const [changing, setChanging] = useState(false), card = useRef<HTMLElement>(null);
  // On a phone the grid is long: bring what was picked into view.
  useEffect(() => { card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, []);
  return (
    <section class="card" ref={card}>
      <div class="row"><h2>{clock(it.start)} - {clock(it.end)} · {court.name}</h2><button class="small" onClick={onClose}>{t("ui.close")}</button></div>
      <p>{labelOf(it)}{it.code ? ` · ${it.code}` : ""}</p>
      {(it.players?.length ?? 0) > 0 && <p class="meta">{t("ui.today_players", { names: it.players!.join(", ") })}</p>}
      {isBooking(it) && <p class="meta">{unpaid(it) > 0 ? t("ui.unpaid_amount", { amount: dollars(unpaid(it), lang.value) }) : t("ui.today_paid", { amount: dollars(it.paid_cents ?? 0, lang.value) })}</p>}
      {it.late?.map((l) => <p class="note">{t("ui.late_note", { name: l.name, minutes: l.minutes })} · {clock(l.at)}</p>)}
      <div class="chips">
        {isBooking(it) && unpaid(it) > 0 && mayDo("booking.record_payment") && <button class="small" onClick={() => preview("booking.record_payment", { booking_id: it.booking_id, cents: unpaid(it), method: "cash" })}>{t("ui.record_cash")}</button>}
        {(canMove || canResize) && <button class="small" onClick={() => setChanging(!changing)}>{t("ui.move_or_resize")}</button>}
        {isBooking(it) && mayDo("booking.cancel") && <button class="small" onClick={() => preview("booking.cancel", { booking_id: it.booking_id })}>{t("ui.cancel_booking")}</button>}
        {it.block_id && !it.series && mayDo("court.unblock") && <button class="small" onClick={() => preview("court.unblock", { block_id: it.block_id })}>{t("ui.unblock")}</button>}
        {it.block_id && it.series && mayDo("court.block_repeat_end") && <>
          <button class="small" onClick={() => preview("court.block_repeat_end", { block_id: it.block_id, scope: "this" })}>{t("ui.open_this_date")}</button>
          <button class="small" onClick={() => preview("court.block_repeat_end", { block_id: it.block_id, scope: "following" })}>{t("ui.end_from_here")}</button>
          <button class="small" onClick={() => preview("court.block_repeat_end", { block_id: it.block_id, scope: "all" })}>{t("ui.end_series")}</button>
        </>}
        {it.block_id && it.series && mayDo("court.block_repeat_edit") && ms(it.start) > Date.now() && <button class="small" onClick={() => setChanging(!changing)}>{t("ui.change_series")}</button>}
        {it.program_id && <a href={`/programs/${it.program_id}`}>{t("ui.open")}</a>}
      </div>
      {it.empty_places?.map((e) => <EmptyPlace e={e} preview={preview} />)}
      {it.whole && mayDo("booking.add_player") && <Players it={it} preview={preview} />}
      {changing && !it.series && <ChangeForm it={it} court={court} g={g} clock={clock} slots={slots} preview={preview} canMove={canMove} canResize={canResize} courtFixed={courtFixed} />}
      {changing && it.series && <SeriesChange it={it} g={g} slots={slots} clock={clock} preview={preview} />}
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
      <ul class="plain">{(it.seats ?? []).map((p) => <li class="row"><span>{p.name}{p.booker ? ` · ${t("ui.booker")}` : ""}</span>
        {!p.booker && mayDo("booking.remove_player") && <button type="button" class="small" onClick={() => preview("booking.remove_player", { booking_player_id: p.id })}>{t("ui.remove")}</button>}</li>)}</ul>
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
  const lengths = Array.from({ length: 16 }, (_, i) => (i + 1) * 30).filter((m) => !g.open || ms(f.start) + m * 60_000 <= ms(g.open.closes) || m === was);
  const starts = slots.filter((s) => new Date(s) > new Date() && (!g.open || ms(s) + f.minutes * 60_000 <= ms(g.open.closes)));
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
      {isBooking(it) && <label>{t("ui.refund_if_less")}<select value={f.refund} onChange={(e) => setF({ ...f, refund: e.currentTarget.value })}>
        <option value="rule">{t("ui.refund_by_rule")}</option><option value="full">{t("ui.refund_all")}</option><option value="none">{t("ui.refund_nothing_more")}</option></select></label>}
      {error && <p class="error" role="alert">{error}</p>}
      <button class="primary" disabled={!moved && !resized}>{t("ui.preview")}</button>
    </form>
  );
}

function DeskBooking({ court, starts, clock, preview, onClose }: { court: Court; starts: string[]; clock: (s: string) => string; preview: Preview; onClose: () => void }) {
  const [f, setF] = useState({ start: starts[0] ?? "", minutes: 90, guest: "", price: "" }), [person, setPerson] = useState<{ id: string; display_name: string } | null>(null);
  const [q, setQ] = useState(""), [found, setFound] = useState<{ id: string; display_name: string; email: string | null }[]>([]);
  const find = async (v: string) => { setQ(v); setFound(v.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(v)}`) : []); };
  // What the club's prices say it costs, as the start and length change; the desk can type another price.
  // A member's price when it's for a member.
  type Quoted = { total_cents: number; tax_cents: number; priced: boolean; member: string | null };
  const [quoted, setQuoted] = useState<Quoted | null>(null);
  useEffect(() => { if (f.start) api<Quoted>(`/staff/quote?court_id=${court.id}&starts_at=${encodeURIComponent(f.start)}&minutes=${f.minutes}${person ? `&person_id=${person.id}` : ""}`).then(setQuoted).catch(() => setQuoted(null)); }, [f.start, f.minutes, person?.id]);
  const submit = (e: Event) => {
    e.preventDefault();
    preview("booking.create", { court_id: court.id, starts_at: f.start, minutes: Number(f.minutes), ...(person ? { person_id: person.id } : { guest_name: f.guest }),
      ...(f.price ? { price_cents: Math.round(Number(f.price) * 100) } : {}) });
  };
  return (
    <form class="card card-form" onSubmit={submit}>
      <h2>{t("ui.book_court", { court: court.name })}</h2>
      <label>{t("ui.starts")}<select value={f.start} onChange={(e) => setF({ ...f, start: e.currentTarget.value })}>{starts.map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      <label>{t("ui.length")}<select value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.currentTarget.value) })}>{[60, 90, 120, 30, 150, 180].map((m) => <option value={m}>{t("ui.minutes", { count: m })}</option>)}</select></label>
      {person ? <p>{person.display_name} <button type="button" class="link" onClick={() => setPerson(null)}>{t("ui.change")}</button></p> : <>
        <label>{t("ui.search_person")}<input type="search" value={q} onInput={(e) => find(e.currentTarget.value)} /></label>
        {found.length > 0 && <ul class="plain">{found.slice(0, 6).map((p) => <li class="row"><span>{p.display_name}</span><button type="button" class="small" onClick={() => { setPerson(p); setFound([]); setQ(""); }}>{t("ui.choose")}</button></li>)}</ul>}
        <label>{t("ui.or_guest_name")}<input value={f.guest} onInput={(e) => setF({ ...f, guest: e.currentTarget.value })} /></label>
      </>}
      {quoted && <p class="meta">{quoted.priced ? t("ui.quoted_price", { amount: dollars(quoted.total_cents, lang.value) }) : t("ui.no_price_then")}{quoted.member ? ` · ${t("ui.member_price", { plan: quoted.member })}` : ""}</p>}
      <label>{t("ui.price_override")}<input inputMode="decimal" value={f.price} placeholder={quoted ? dollars(quoted.total_cents, lang.value) : ""} onInput={(e) => setF({ ...f, price: e.currentTarget.value })} /></label>
      <button class="primary" disabled={!f.start || (!person && !f.guest.trim())}>{t("ui.preview")}</button>
      <button type="button" class="link" onClick={onClose}>{t("ui.cancel")}</button>
    </form>
  );
}

/** A place a player gave up after the deadline: open it in the app, or give it to someone free. Leaving and
 *  refunding are separate: what the player gets back is the club's rule unless staff choose otherwise. */
function EmptyPlace({ e, preview }: { e: Empty; preview: Preview }) {
  const [refund, setRefund] = useState("rule"), [giving, setGiving] = useState(false);
  const [q, setQ] = useState(""), [found, setFound] = useState<{ id: string; display_name: string }[]>([]);
  const find = async (v: string) => { setQ(v); setFound(v.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(v)}`) : []); };
  return (
    <div class="note">
      <p>{t(e.open ? "ui.empty_place_open" : "ui.empty_place", { name: e.name })}</p>
      <label>{t("ui.refund_choice", { name: e.name })}<select value={refund} onChange={(x) => setRefund(x.currentTarget.value)}>
        <option value="rule">{t("ui.refund_by_rule")}</option><option value="full">{t("ui.refund_all")}</option><option value="none">{t("ui.refund_nothing_more")}</option></select></label>
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

function BlockForm({ courts, g, slots, clock, preview }: { courts: Court[]; g: Grid; slots: string[]; clock: (s: string) => string; preview: Preview }) {
  const [ids, setIds] = useState<string[]>([]), [f, setF] = useState({ from: slots[0] ?? "", to: slots.at(-1) ?? "", reason: "maintenance", note: "" });
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
      {courts.map((c) => <label class="check"><input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.currentTarget.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} /> {c.name}</label>)}
      <label>{t("ui.from")}<select value={f.from} onChange={(e) => setF({ ...f, from: e.currentTarget.value })}>{slots.slice(0, -1).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      <label>{t("ui.to")}<select value={f.to} onChange={(e) => setF({ ...f, to: e.currentTarget.value })}>{slots.slice(1).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      <label>{t("ui.reason")}<select value={f.reason} onChange={(e) => setF({ ...f, reason: e.currentTarget.value })}>{["maintenance", "fault", "resurfacing", "event", "other"].map((r) => <option value={r}>{t(`block.${r}` as Key)}</option>)}</select></label>
      <label>{t("ui.block_note")}<input value={f.note} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} /></label>
      <label class="check"><input type="checkbox" checked={rep.on} onChange={(e) => setRep({ ...rep, on: e.currentTarget.checked })} /> {t("ui.block_every_week")}</label>
      {rep.on && <>
        <fieldset><legend>{t("ui.block_on_days")}</legend>
          {WEEK.map((w) => <label class="check"><input type="checkbox" checked={rep.days.includes(w)} onChange={(e) => setRep({ ...rep, days: e.currentTarget.checked ? [...rep.days, w] : rep.days.filter((x) => x !== w) })} /> {dayName(w)}</label>)}
        </fieldset>
        <label>{t("ui.block_until")}<input type="date" min={g.date} value={rep.until} onInput={(e) => setRep({ ...rep, until: e.currentTarget.value })} /></label>
        <InTheWay way={rep.way} refund={rep.refund} onChange={(way, refund) => setRep({ ...rep, way, refund })} />
      </>}
      <button class="primary" disabled={!ids.length || (rep.on && !rep.days.length)}>{t("ui.preview")}</button>
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
const shortDay = (date: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
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
          <div class="row"><div><strong>{s.courts.map((c) => c.name).join(", ")}</strong> · {WEEK.filter((w) => s.weekdays.includes(w)).map(dayName).join(", ")} · {s.starts} - {s.ends}
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
      {!one && <fieldset><legend>{t("ui.block_on_days")}</legend>{WEEK.map((w) => <label class="check"><input type="checkbox" checked={f.days.includes(w)}
        onChange={(e) => setF({ ...f, days: e.currentTarget.checked ? [...f.days, w] : f.days.filter((x) => x !== w) })} /> {dayName(w)}</label>)}</fieldset>}
      <label>{t("ui.from")}<select value={f.starts} onChange={(e) => starts(e.currentTarget.value)}>{HALVES.slice(0, -1).map((h) => <option value={h}>{h}</option>)}</select></label>
      <label>{t("ui.to")}<select value={f.ends} onChange={(e) => setF({ ...f, ends: e.currentTarget.value })}>{HALVES.filter((h) => h > f.starts).map((h) => <option value={h}>{h}</option>)}</select></label>
      {!one && <><label class="check"><input type="checkbox" checked={f.noEnd} onChange={(e) => setF({ ...f, noEnd: e.currentTarget.checked })} /> {t("ui.series_no_end")}</label>
        {!f.noEnd && <label>{t("ui.series_until")}<input type="date" min={s.dates[0]!.date} value={f.until} onInput={(e) => setF({ ...f, until: e.currentTarget.value })} /></label>}</>}
      <label>{t("ui.reason")}<select value={f.reason} onChange={(e) => setF({ ...f, reason: e.currentTarget.value })}>{["maintenance", "fault", "resurfacing", "event", "other"].map((r) => <option value={r}>{t(`block.${r}` as Key)}</option>)}</select></label>
      <label>{t("ui.block_note")}<input value={f.note} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} /></label>
      <InTheWay way={f.way} refund={f.refund} onChange={(way, refund) => setF({ ...f, way, refund })} />
      {mayDo("court.block_repeat_edit") && <button class="primary" disabled={!Object.keys(change).length || !f.courts.length || (!one && !f.days.length) || (!one && !f.noEnd && !f.until)}>{t("ui.preview")}</button>}
      {mayDo("court.block_repeat_end") && <div class="chips">
        <button type="button" class="small" onClick={() => end("this")}>{t("ui.open_this_date")}</button>
        <button type="button" class="small" onClick={() => end("following")}>{t("ui.end_from_here")}</button>
        <button type="button" class="small" onClick={() => end("all")}>{t("ui.end_series")}</button></div>}
    </form>
  );
}
