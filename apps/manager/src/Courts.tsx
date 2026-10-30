// The courts on one day: what holds each court and the free time between, with booking at the desk,
// blocking and cancelling. Times are the location's, whatever the device's clock says.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, dollars, lang, t, usePreview } from "@kumi/ui";

type Item = { start: string; end: string; kind: string; booking_id?: string; code?: string; who?: string; price_cents?: number; paid_cents?: number; block_id?: string; session_id?: string; program_id?: string; label?: string };
type Court = { id: string; name: string; kind: string; items: Item[] };
type Grid = { date: string; time_zone: string; open: { opens: string; closes: string } | null; courts: Court[] };
type Loc = { id: string; name: string; time_zone: string };
const HALF = 30 * 60_000;

export function Courts() {
  const [locs, setLocs] = useState<Loc[]>([]), [loc, setLoc] = useState(""), [date, setDate] = useState(""), [g, setG] = useState<Grid | null>(null);
  const [form, setForm] = useState<{ court: Court; starts: string[] } | null>(null), [blocking, setBlocking] = useState(false);
  const load = () => loc && api<Grid>(`/staff/grid?location_id=${loc}${date ? `&date=${date}` : ""}`).then((x) => { setG(x); if (!date) setDate(x.date); });
  const { preview, sheet } = usePreview(() => { load(); setForm(null); setBlocking(false); });
  useEffect(() => { api<Loc[]>("/staff/locations").then((l) => { setLocs(l); setLoc(l[0]?.id ?? ""); }); }, []);
  useEffect(() => { load(); }, [loc, date]);
  if (!g) return <main class="card"><p>{t("ui.loading")}</p></main>;

  const clock = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: g.time_zone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  // Every half hour the location is open, as instants: the same list for choosing a start or a block.
  const slots: string[] = [];
  if (g.open) for (let s = new Date(g.open.opens).getTime(); s <= new Date(g.open.closes).getTime(); s += HALF) slots.push(new Date(s).toISOString());
  const gaps = (c: Court) => {
    if (!g.open) return [];
    const out: { from: string; to: string }[] = [];
    let cursor = new Date(g.open.opens).getTime();
    for (const it of [...c.items].sort((a, b) => +new Date(a.start) - +new Date(b.start))) {
      if (new Date(it.start).getTime() > cursor) out.push({ from: new Date(cursor).toISOString(), to: it.start });
      cursor = Math.max(cursor, new Date(it.end).getTime());
    }
    if (cursor < new Date(g.open.closes).getTime()) out.push({ from: new Date(cursor).toISOString(), to: g.open.closes });
    return out.filter((x) => new Date(x.to).getTime() - new Date(x.from).getTime() >= HALF && new Date(x.to) > new Date());
  };
  const shift = (days: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); setDate(d.toISOString().slice(0, 10)); };

  return (
    <main>
      <h1>{t("ui.courts")}</h1>
      <section class="card card-form">
        {locs.length > 1 && <label>{t("ui.location")}<select value={loc} onChange={(e) => { setLoc(e.currentTarget.value); setDate(""); }}>{locs.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>}
        <div class="court-row">
          <button type="button" class="small" onClick={() => shift(-1)} aria-label={t("ui.day_before")}>‹</button>
          <input type="date" aria-label={t("ui.day")} value={date} onInput={(e) => setDate(e.currentTarget.value)} />
          <button type="button" class="small" onClick={() => shift(1)} aria-label={t("ui.day_after")}>›</button>
        </div>
        {!g.open && <p class="meta">{t("ui.closed_this_day")}</p>}
        {g.open && <p class="meta">{t("ui.open_from_to", { from: clock(g.open.opens), to: clock(g.open.closes) })}</p>}
      </section>

      {g.courts.map((c) => (
        <section class="card">
          <h2>{c.name}</h2>
          <ul class="plain">
            {[...c.items.map((it) => ({ at: it.start, el: (
              <li class="row"><span><strong>{clock(it.start)} - {clock(it.end)}</strong> {it.booking_id ? `${it.who} · ${it.code}` : it.kind === "hold" ? t("ui.being_paid") : it.label}
                {it.booking_id && it.kind === "booking" && (it.price_cents ?? 0) > (it.paid_cents ?? 0) && <span class="meta"> · {t("ui.unpaid_amount", { amount: dollars((it.price_cents ?? 0) - (it.paid_cents ?? 0), lang.value) })}</span>}</span>
                <span>
                {it.booking_id && it.kind === "booking" && (it.price_cents ?? 0) > (it.paid_cents ?? 0) && <button class="small" onClick={() => preview("booking.record_payment", { booking_id: it.booking_id, cents: (it.price_cents ?? 0) - (it.paid_cents ?? 0), method: "cash" })}>{t("ui.record_cash")}</button>}{" "}
                {it.booking_id && it.kind === "booking" && <button class="small" onClick={() => preview("booking.cancel", { booking_id: it.booking_id })}>{t("ui.cancel_booking")}</button>}
                </span>
                {it.block_id && <button class="small" onClick={() => preview("court.unblock", { block_id: it.block_id })}>{t("ui.unblock")}</button>}
                {it.program_id && <a href={`/programs/${it.program_id}`}>{t("ui.open")}</a>}
              </li>) })),
            ...gaps(c).map((gap) => ({ at: gap.from, el: (
              <li class="row"><span class="meta">{t("ui.free_from_to", { from: clock(gap.from), to: clock(gap.to) })}</span>
                <button class="small" onClick={() => setForm({ court: c, starts: slots.filter((s) => s >= gap.from && new Date(s).getTime() + HALF <= new Date(gap.to).getTime() && new Date(s) > new Date()) })}>{t("ui.book_here")}</button>
              </li>) }))].sort((a, b) => +new Date(a.at) - +new Date(b.at)).map((x) => x.el)}
          </ul>
        </section>
      ))}
      {g.open && <button onClick={() => setBlocking(!blocking)}>{t("ui.block_courts")}</button>}
      {form && <DeskBooking court={form.court} starts={form.starts} clock={clock} preview={preview} onClose={() => setForm(null)} />}
      {blocking && <BlockForm courts={g.courts} slots={slots} clock={clock} preview={preview} />}
      {sheet}
    </main>
  );
}

function DeskBooking({ court, starts, clock, preview, onClose }: { court: Court; starts: string[]; clock: (s: string) => string; preview: (a: string, i: unknown) => Promise<void>; onClose: () => void }) {
  const [f, setF] = useState({ start: starts[0] ?? "", minutes: 90, guest: "", price: "" }), [person, setPerson] = useState<{ id: string; display_name: string } | null>(null);
  const [q, setQ] = useState(""), [found, setFound] = useState<{ id: string; display_name: string; email: string | null }[]>([]);
  const find = async (v: string) => { setQ(v); setFound(v.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(v)}`) : []); };
  // What the club's prices say it costs, as the start and length change; the desk can type another price.
  const [quoted, setQuoted] = useState<{ total_cents: number; tax_cents: number; priced: boolean } | null>(null);
  useEffect(() => { if (f.start) api<{ total_cents: number; tax_cents: number; priced: boolean }>(`/staff/quote?court_id=${court.id}&starts_at=${encodeURIComponent(f.start)}&minutes=${f.minutes}`).then(setQuoted).catch(() => setQuoted(null)); }, [f.start, f.minutes]);
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
      {quoted && <p class="meta">{quoted.priced ? t("ui.quoted_price", { amount: dollars(quoted.total_cents, lang.value) }) : t("ui.no_price_then")}</p>}
      <label>{t("ui.price_override")}<input inputMode="decimal" value={f.price} placeholder={quoted ? dollars(quoted.total_cents, lang.value) : ""} onInput={(e) => setF({ ...f, price: e.currentTarget.value })} /></label>
      <button class="primary" disabled={!f.start || (!person && !f.guest.trim())}>{t("ui.preview")}</button>
      <button type="button" class="link" onClick={onClose}>{t("ui.cancel")}</button>
    </form>
  );
}

function BlockForm({ courts, slots, clock, preview }: { courts: Court[]; slots: string[]; clock: (s: string) => string; preview: (a: string, i: unknown) => Promise<void> }) {
  const [ids, setIds] = useState<string[]>([]), [f, setF] = useState({ from: slots[0] ?? "", to: slots.at(-1) ?? "", reason: "maintenance", note: "" });
  return (
    <form class="card card-form" onSubmit={(e) => { e.preventDefault(); preview("court.block", { court_ids: ids, starts_at: f.from, ends_at: f.to, reason: f.reason, note: f.note || undefined }); }}>
      <h2>{t("ui.block_courts")}</h2>
      {courts.map((c) => <label class="check"><input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.currentTarget.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} /> {c.name}</label>)}
      <label>{t("ui.from")}<select value={f.from} onChange={(e) => setF({ ...f, from: e.currentTarget.value })}>{slots.slice(0, -1).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      <label>{t("ui.to")}<select value={f.to} onChange={(e) => setF({ ...f, to: e.currentTarget.value })}>{slots.slice(1).map((s) => <option value={s}>{clock(s)}</option>)}</select></label>
      <label>{t("ui.reason")}<select value={f.reason} onChange={(e) => setF({ ...f, reason: e.currentTarget.value })}>{["maintenance", "fault", "resurfacing", "event", "other"].map((r) => <option value={r}>{t(`block.${r}` as Key)}</option>)}</select></label>
      <label>{t("ui.block_note")}<input value={f.note} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} /></label>
      <button class="primary" disabled={!ids.length}>{t("ui.preview")}</button>
    </form>
  );
}
