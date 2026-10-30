// The club's settings: its details and branding, whether people can join by themselves, and its locations
// and courts. Every change goes through the preview, like everything else; only what changed is sent.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, club as clubSignal, lang, t, usePreview, type Club } from "@kumi/ui";

type Court = { id: string; location_id: string; name: string; kind: string; bookable: boolean; sort: number };
type Hours = { weekday: number; opens: string | null; closes: string | null };
type Special = { id: string; on_date: string; opens: string | null; closes: string | null; note: string | null };
type Price = { id: string; name: string; court_ids: string[] | null; weekdays: number[] | null; starts: string | null; ends: string | null; valid_from: string | null; valid_to: string | null; cents_per_hour: number; priority: number; plan_ids: string[] | null };
type Loc = { id: string; name: string; address: string | null; time_zone: string; courts: Court[]; hours: Hours[]; special_days: Special[]; prices: Price[] };
type Policy = { version_no: number; days_ahead: number; max_active: number; free_cancel_hours: number; late_refund_percent: number; split_deadline_hours: number; lengths: number[] };
type ClubRow = { name: string; legal_name: string | null; time_zone: string; languages: string[]; default_language: string; brand_colour: string; sign_up_open: boolean; court_bookings: boolean; tax_rate_bp: number; public_page: boolean; about: string | null };
type Plan = { id: string; name: string };
type S = { club: ClubRow; policy: Policy; plans: Plan[]; locations: Loc[] };
type Preview = (action: string, input: unknown) => Promise<void>;

const KINDS = ["indoor", "covered_outdoor", "outdoor"] as const;
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico", "America/Mexico_City", "Europe/Madrid"];
/** Only the fields that changed, so the preview names just those. */
function diff<T extends Record<string, unknown>>(before: T, after: T): Partial<T> {
  return Object.fromEntries(Object.entries(after).filter(([k, v]) => JSON.stringify(before[k] ?? null) !== JSON.stringify(v ?? null))) as Partial<T>;
}

export function Settings() {
  const [s, setS] = useState<S | null>(null), [note, setNote] = useState<string | null>(null);
  const load = async () => {
    setS(await api<S>("/staff/settings"));
    const c = await api<Club>("/club");   // a new name or colour shows straight away
    clubSignal.value = c; document.documentElement.style.setProperty("--brand", c.brand_colour);
  };
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, []);
  if (!s) return <main class="card"><p>{t("ui.loading")}</p></main>;
  // Send a change only if there is one.
  const send: Preview = async (action, input) => {
    const { court_id, location_id, ...rest } = input as Record<string, unknown>;
    if (!Object.keys(rest).length && (action.endsWith(".update") || action === "policy.set")) { setNote(t("error.nothing_changed")); return; }
    setNote(null); await preview(action, input);
  };
  return (
    <main>
      <h1>{t("ui.settings_title")}</h1>
      <ClubForm key={JSON.stringify(s.club)} c={s.club} send={send} />
      <BookingRules key={JSON.stringify(s.policy)} p={s.policy} send={send} />
      {s.locations.map((l) => <LocationCard key={JSON.stringify(l)} l={l} plans={s.plans} send={send} />)}
      <NewLocation tz={s.club.time_zone} send={send} />
      {note && <p class="note" role="status">{note}</p>}
      {sheet}
    </main>
  );
}

function ClubForm({ c, send }: { c: ClubRow; send: Preview }) {
  const start = { ...c, legal_name: c.legal_name ?? "", about: c.about ?? "" };
  const [f, setF] = useState(start);
  const set = (k: keyof ClubRow, v: unknown) => setF({ ...f, [k]: v });
  const toggleLang = (l: string, on: boolean) => set("languages", on ? [...new Set([...f.languages, l])].sort() : f.languages.filter((x) => x !== l));
  return (
    <form class="card card-form" onSubmit={(e) => { e.preventDefault(); send("club.update", diff(start, f)); }}>
      <h2>{t("ui.club_details")}</h2>
      <label>{t("ui.name")}<input required value={f.name} onInput={(e) => set("name", e.currentTarget.value)} /></label>
      <label>{t("ui.legal_name")}<input value={f.legal_name} onInput={(e) => set("legal_name", e.currentTarget.value)} /></label>
      <label>{t("ui.brand_color")}<input type="color" value={f.brand_colour} onInput={(e) => set("brand_colour", e.currentTarget.value)} /></label>
      <label>{t("ui.time_zone")}<input list="zones" required value={f.time_zone} onInput={(e) => set("time_zone", e.currentTarget.value)} /></label>
      <datalist id="zones">{ZONES.map((z) => <option value={z} />)}</datalist>
      <fieldset>
        <legend>{t("ui.languages")}</legend>
        {["en", "es"].map((l) => <label class="check"><input type="checkbox" checked={f.languages.includes(l)} onChange={(e) => toggleLang(l, e.currentTarget.checked)} /> {l === "es" ? "Español" : "English"}</label>)}
      </fieldset>
      <label>{t("ui.default_language")}<select value={f.default_language} onChange={(e) => set("default_language", e.currentTarget.value)}>
        {f.languages.map((l) => <option value={l}>{l === "es" ? "Español" : "English"}</option>)}</select></label>
      <label class="check"><input type="checkbox" checked={f.sign_up_open} onChange={(e) => set("sign_up_open", e.currentTarget.checked)} /> {t("ui.sign_up_open")}</label>
      <label class="check"><input type="checkbox" checked={f.court_bookings} onChange={(e) => set("court_bookings", e.currentTarget.checked)} /> {t("ui.court_bookings_on")}</label>
      <label class="check"><input type="checkbox" checked={f.public_page} onChange={(e) => set("public_page", e.currentTarget.checked)} /> {t("ui.public_page_on")}</label>
      {c.public_page && <p class="meta"><a href="/public" target="_blank" rel="noopener">{t("ui.see_public_page")}</a></p>}
      <label>{t("ui.about_club")}<textarea maxLength={600} rows={3} value={f.about ?? ""} onInput={(e) => set("about", e.currentTarget.value)} /></label>
      <label>{t("ui.tax_rate")}<input inputMode="decimal" value={String(f.tax_rate_bp / 100)} onChange={(e) => set("tax_rate_bp", Math.round(Number(e.currentTarget.value.replace(",", ".")) * 100) || 0)} /></label>
      <button class="primary">{t("ui.preview")}</button>
    </form>
  );
}

function LocationCard({ l, plans, send }: { l: Loc; plans: Plan[]; send: Preview }) {
  const start = { name: l.name, address: l.address ?? "", time_zone: l.time_zone };
  const [f, setF] = useState(start), [court, setCourt] = useState({ name: "", kind: "indoor" });
  return (
    <section class="card">
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("location.update", { location_id: l.id, ...diff(start, f) }); }}>
        <h2>{l.name}</h2>
        <label>{t("ui.name")}<input required value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
        <label>{t("ui.address")}<input value={f.address} onInput={(e) => setF({ ...f, address: e.currentTarget.value })} /></label>
        <label>{t("ui.time_zone")}<input list="zones" required value={f.time_zone} onInput={(e) => setF({ ...f, time_zone: e.currentTarget.value })} /></label>
        <button>{t("ui.preview")}</button>
      </form>
      <h3>{t("ui.courts")}</h3>
      <ul class="plain">{l.courts.map((c) => <CourtRow key={JSON.stringify(c)} c={c} send={send} />)}</ul>
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("court.create", { location_id: l.id, name: court.name, kind: court.kind }); }}>
        <label>{t("ui.add_court")}<input required placeholder={t("ui.name")} value={court.name} onInput={(e) => setCourt({ ...court, name: e.currentTarget.value })} /></label>
        <select value={court.kind} onChange={(e) => setCourt({ ...court, kind: e.currentTarget.value })}>{KINDS.map((k) => <option value={k}>{t(`ui.kind_${k}` as Key)}</option>)}</select>
        <button>{t("ui.preview")}</button>
      </form>
      <OpeningHours l={l} send={send} />
      <Prices l={l} plans={plans} send={send} />
    </section>
  );
}

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const dayName = (w: number) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));
/** A phone's time picker can't show 24:00, so closing at 00:00 means midnight at the end of the day. */
const closing = (v: string) => (v === "00:00" ? "24:00" : v);

function OpeningHours({ l, send }: { l: Loc; send: Preview }) {
  const [days, setDays] = useState(l.hours.map((h) => ({ ...h, closes: h.closes === "24:00" ? "00:00" : h.closes })));
  const [sp, setSp] = useState({ date: "", closed: true, opens: "09:00", closes: "14:00", note: "" });
  const set = (w: number, patch: Partial<Hours>) => setDays(days.map((d) => (d.weekday === w ? { ...d, ...patch } : d)));
  return (
    <>
      <h3>{t("ui.hours_title")}</h3>
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("hours.set", { location_id: l.id, days: days.filter((d) => d.opens && d.closes).map((d) => ({ weekday: d.weekday, opens: d.opens, closes: closing(d.closes!) })) }); }}>
        {ORDER.map((w) => { const d = days.find((x) => x.weekday === w)!; return (
          <div class="hours-row">
            <label class="check"><input type="checkbox" checked={Boolean(d.opens)} onChange={(e) => set(w, e.currentTarget.checked ? { opens: "08:00", closes: "22:00" } : { opens: null, closes: null })} /> {dayName(w)}</label>
            {d.opens ? <>
              <input type="time" step={1800} aria-label={t("ui.from")} value={d.opens} onInput={(e) => set(w, { opens: e.currentTarget.value })} />
              <input type="time" step={1800} aria-label={t("ui.to")} value={d.closes ?? ""} onInput={(e) => set(w, { closes: e.currentTarget.value })} />
            </> : <span class="meta">{t("ui.closed")}</span>}
          </div>); })}
        <button>{t("ui.preview")}</button>
      </form>
      <h3>{t("ui.special_days")}</h3>
      <ul class="plain">{l.special_days.map((x) => (
        <li class="row"><span>{x.on_date} · {x.opens ? `${x.opens} - ${x.closes}` : t("ui.closed")}{x.note ? ` · ${x.note}` : ""}</span>
          <button type="button" class="small" onClick={() => send("hours.exception_remove", { exception_id: x.id })}>{t("ui.remove")}</button></li>))}</ul>
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("hours.exception_set", { location_id: l.id, date: sp.date, ...(sp.closed ? {} : { opens: sp.opens, closes: closing(sp.closes) }), note: sp.note || undefined }); }}>
        <label>{t("ui.add_special_day")}<input type="date" required value={sp.date} onInput={(e) => setSp({ ...sp, date: e.currentTarget.value })} /></label>
        <label class="check"><input type="checkbox" checked={sp.closed} onChange={(e) => setSp({ ...sp, closed: e.currentTarget.checked })} /> {t("ui.closed_all_day")}</label>
        {!sp.closed && <div class="court-row">
          <input type="time" step={1800} aria-label={t("ui.from")} value={sp.opens} onInput={(e) => setSp({ ...sp, opens: e.currentTarget.value })} />
          <input type="time" step={1800} aria-label={t("ui.to")} value={sp.closes} onInput={(e) => setSp({ ...sp, closes: e.currentTarget.value })} /></div>}
        <label>{t("ui.block_note")}<input value={sp.note} onInput={(e) => setSp({ ...sp, note: e.currentTarget.value })} /></label>
        <button>{t("ui.preview")}</button>
      </form>
    </>
  );
}

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 0];
const usd = (cents: number) => new Intl.NumberFormat(lang.value === "es" ? "es-US" : "en-US", { style: "currency", currency: "USD" }).format(cents / 100);

function Prices({ l, plans, send }: { l: Loc; plans: Plan[]; send: Preview }) {
  const blank = { rule_id: "", name: "", dollars: "", days: [] as number[], allDay: true, starts: "17:00", ends: "22:00", valid_from: "", valid_to: "", courts: [] as string[], priority: 0, plans: [] as string[] };
  const [f, setF] = useState(blank);
  const edit = (r: Price) => setF({ rule_id: r.id, name: r.name, dollars: String(r.cents_per_hour / 100), days: r.weekdays ?? [], allDay: !r.starts, starts: r.starts ?? "17:00", ends: r.ends ?? "22:00",
    valid_from: r.valid_from ?? "", valid_to: r.valid_to ?? "", courts: r.court_ids ?? [], priority: r.priority, plans: r.plan_ids ?? [] });
  const describe = (r: Price) => [r.weekdays?.length ? r.weekdays.map(dayName).join(", ") : t("ui.every_day"), r.starts && `${r.starts} - ${r.ends}`,
    (r.valid_from || r.valid_to) && `${r.valid_from ?? ""} - ${r.valid_to ?? ""}`, r.court_ids && l.courts.filter((c) => r.court_ids!.includes(c.id)).map((c) => c.name).join(", "),
    r.plan_ids && t("ui.members_of", { plans: plans.filter((p) => r.plan_ids!.includes(p.id)).map((p) => p.name).join(", ") })].filter(Boolean).join(" · ");
  const toggle = (list: (number | string)[], v: number | string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <>
      <h3>{t("ui.prices_title")}</h3>
      {l.prices.length === 0 && <p class="meta">{t("ui.no_prices")}</p>}
      <ul class="plain">{l.prices.map((r) => (
        <li class="row"><span><strong>{r.name}</strong> {usd(r.cents_per_hour)}{t("ui.per_hour")}<br /><span class="meta">{describe(r)}{r.priority ? ` · ${t("ui.priority")} ${r.priority}` : ""}</span></span>
          <span><button type="button" class="small" onClick={() => edit(r)}>{t("ui.change")}</button> <button type="button" class="small" onClick={() => send("price.rule_remove", { rule_id: r.id })}>{t("ui.remove")}</button></span></li>))}</ul>
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("price.rule_set", { ...(f.rule_id ? { rule_id: f.rule_id } : {}), location_id: l.id, name: f.name,
        cents_per_hour: Math.round(Number(f.dollars.replace(",", ".")) * 100), weekdays: f.days.length ? f.days : null, starts: f.allDay ? null : f.starts, ends: f.allDay ? null : closing(f.ends),
        valid_from: f.valid_from || null, valid_to: f.valid_to || null, court_ids: f.courts.length ? f.courts : null, priority: Number(f.priority), plan_ids: f.plans.length ? f.plans : null }); }}>
        <label>{f.rule_id ? t("ui.change_price") : t("ui.add_price")}<input required placeholder={t("ui.price_name_hint")} value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
        <label>{t("ui.dollars_per_hour")}<input required inputMode="decimal" value={f.dollars} onInput={(e) => setF({ ...f, dollars: e.currentTarget.value })} /></label>
        <fieldset><legend>{t("ui.days_none_all")}</legend>{ALL_DAYS.map((w) => <label class="check inline"><input type="checkbox" checked={f.days.includes(w)} onChange={() => setF({ ...f, days: toggle(f.days, w) as number[] })} /> {dayName(w)}</label>)}</fieldset>
        <label class="check"><input type="checkbox" checked={f.allDay} onChange={(e) => setF({ ...f, allDay: e.currentTarget.checked })} /> {t("ui.all_day")}</label>
        {!f.allDay && <div class="court-row"><input type="time" step={1800} aria-label={t("ui.from")} value={f.starts} onInput={(e) => setF({ ...f, starts: e.currentTarget.value })} />
          <input type="time" step={1800} aria-label={t("ui.to")} value={f.ends} onInput={(e) => setF({ ...f, ends: e.currentTarget.value })} /></div>}
        <div class="court-row"><label>{t("ui.season_from")}<input type="date" value={f.valid_from} onInput={(e) => setF({ ...f, valid_from: e.currentTarget.value })} /></label>
          <label>{t("ui.season_to")}<input type="date" value={f.valid_to} onInput={(e) => setF({ ...f, valid_to: e.currentTarget.value })} /></label></div>
        {l.courts.length > 1 && <fieldset><legend>{t("ui.courts_none_all")}</legend>{l.courts.map((c) => <label class="check inline"><input type="checkbox" checked={f.courts.includes(c.id)} onChange={() => setF({ ...f, courts: toggle(f.courts, c.id) as string[] })} /> {c.name}</label>)}</fieldset>}
        {plans.length > 0 && <fieldset><legend>{t("ui.plans_none_all")}</legend>{plans.map((p) => <label class="check inline"><input type="checkbox" checked={f.plans.includes(p.id)} onChange={() => setF({ ...f, plans: toggle(f.plans, p.id) as string[] })} /> {p.name}</label>)}</fieldset>}
        <label>{t("ui.priority_hint")}<input type="number" min={0} max={99} value={f.priority} onInput={(e) => setF({ ...f, priority: Number(e.currentTarget.value) })} /></label>
        <button>{t("ui.preview")}</button> {f.rule_id && <button type="button" class="link" onClick={() => setF(blank)}>{t("ui.cancel")}</button>}
      </form>
    </>
  );
}

function BookingRules({ p, send }: { p: Policy; send: Preview }) {
  const [f, setF] = useState({ ...p });
  const num = (k: keyof Policy) => (e: Event) => setF({ ...f, [k]: Number((e.currentTarget as HTMLInputElement).value) });
  const changed = Object.fromEntries((["days_ahead", "max_active", "free_cancel_hours", "late_refund_percent", "split_deadline_hours", "lengths"] as const)
    .filter((k) => JSON.stringify(f[k]) !== JSON.stringify(p[k])).map((k) => [k, f[k]]));
  return (
    <form class="card card-form" onSubmit={(e) => { e.preventDefault(); send("policy.set", changed); }}>
      <h2>{t("ui.booking_rules")}</h2>
      <p class="meta">{t("ui.booking_rules_hint", { version: p.version_no })}</p>
      <label>{t("ui.days_ahead")}<input type="number" min={1} max={365} value={f.days_ahead} onInput={num("days_ahead")} /></label>
      <label>{t("ui.max_active")}<input type="number" min={1} max={50} value={f.max_active} onInput={num("max_active")} /></label>
      <label>{t("ui.free_cancel_hours")}<input type="number" min={0} max={720} value={f.free_cancel_hours} onInput={num("free_cancel_hours")} /></label>
      <label>{t("ui.late_refund_percent")}<input type="number" min={0} max={100} value={f.late_refund_percent} onInput={num("late_refund_percent")} /></label>
      <label>{t("ui.split_deadline_hours")}<input type="number" min={1} max={168} value={f.split_deadline_hours} onInput={num("split_deadline_hours")} /></label>
      <fieldset><legend>{t("ui.lengths")}</legend>{[60, 90, 120, 150, 180].map((m) => <label class="check inline"><input type="checkbox" checked={f.lengths.includes(m)}
        onChange={() => setF({ ...f, lengths: f.lengths.includes(m) ? f.lengths.filter((x) => x !== m) : [...f.lengths, m].sort((a, b) => a - b) })} /> {m}</label>)}</fieldset>
      <button class="primary">{t("ui.preview")}</button>
    </form>
  );
}

function CourtRow({ c, send }: { c: Court; send: Preview }) {
  const start = { name: c.name, kind: c.kind };
  const [f, setF] = useState(start);
  return (
    <li>
      <form class="court-row" onSubmit={(e) => { e.preventDefault(); send("court.update", { court_id: c.id, ...diff(start, f) }); }}>
        <input required aria-label={t("ui.name")} value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} />
        <select aria-label={t("ui.court_kind")} value={f.kind} onChange={(e) => setF({ ...f, kind: e.currentTarget.value })}>{KINDS.map((k) => <option value={k}>{t(`ui.kind_${k}` as Key)}</option>)}</select>
        <button class="small">{t("ui.save")}</button>
        <button type="button" class="small" onClick={() => send("court.archive", { court_id: c.id })}>{t("ui.archive")}</button>
      </form>
    </li>
  );
}

function NewLocation({ tz, send }: { tz: string; send: Preview }) {
  const [open, setOpen] = useState(false), [f, setF] = useState({ name: "", address: "", time_zone: tz });
  if (!open) return <button onClick={() => setOpen(true)}>{t("ui.add_location")}</button>;
  return (
    <form class="card card-form" onSubmit={(e) => { e.preventDefault(); send("location.create", { name: f.name, time_zone: f.time_zone, address: f.address || undefined }); }}>
      <h2>{t("ui.add_location")}</h2>
      <label>{t("ui.name")}<input required value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
      <label>{t("ui.address")}<input value={f.address} onInput={(e) => setF({ ...f, address: e.currentTarget.value })} /></label>
      <label>{t("ui.time_zone")}<input list="zones" required value={f.time_zone} onInput={(e) => setF({ ...f, time_zone: e.currentTarget.value })} /></label>
      <button class="primary">{t("ui.preview")}</button>
    </form>
  );
}
