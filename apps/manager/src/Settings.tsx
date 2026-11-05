// The club's settings: its details and branding, whether people can join by themselves, and its locations
// and courts. Every change goes through the preview, like everything else; only what changed is sent.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { AMOUNT_PATTERN, parseDollars } from "@kumi/i18n/format";
import { api, club as clubSignal, dollars, lang, me, OtherLang, savedIn, t, translationsOf, usePreview, type Club, applyBrand } from "@kumi/ui";
import { ClubExport } from "./ClubExport.tsx";

type Hours = { weekday: number; opens: string | null; closes: string | null };
// A court's own hours: only the weekdays it has its own for (no times: closed); the rest follow the location.
type Court = { id: string; location_id: string; name: string; kind: string; bookable: boolean; sort: number; hours: Hours[] };
type Special = { id: string; court_id: string | null; on_date: string; opens: string | null; closes: string | null; note: string | null };
type Price = { id: string; name: string; translations?: unknown; court_ids: string[] | null; weekdays: number[] | null; starts: string | null; ends: string | null; valid_from: string | null; valid_to: string | null; cents_per_hour: number; priority: number; plan_ids: string[] | null };
type Loc = { id: string; name: string; address: string | null; time_zone: string; courts: Court[]; hours: Hours[]; special_days: Special[]; prices: Price[] };
type Policy = { version_no: number; days_ahead: number; max_active: number; free_cancel_hours: number; late_refund_percent: number; split_deadline_hours: number; same_day_cutoff_hours: number; lengths: number[];
  late_sub_refund_percent: number; late_filled_refund_percent: number; late_empty_refund_percent: number };
type ClubRow = { name: string; translations?: unknown; legal_name: string | null; time_zone: string; languages: string[]; default_language: string; brand_colour: string; sign_up_open: boolean; court_bookings: boolean; weekly_bookings: boolean; weekly_max_weeks: number; tax_rate_bp: number; public_page: boolean; about: string | null; terms_url: string | null; privacy_policy_url: string | null; question_alert_hours: number; auto_answers: boolean; broadcast_daily_cap: number; broadcast_copy_managers: boolean; program_decide_hours: number; program_heads_up_hours: number; two_factor: "owner_manager" | "all_staff" | "off" };
type Plan = { id: string; name: string };
type Month = { month: string; texts: number; segments: number; held: number; estimate_cents: number; priced: number; actual_cents: number };
type Usage = { cents_per_segment: number; paused: boolean; resets: string; current: Month; history: Month[] };
type Texting = { on: boolean; status: string | null; number: string | null; said: string[]; usage: Usage | null };
type S = { club: ClubRow; answerer: string; texting: Texting; policy: Policy; plans: Plan[]; locations: Loc[]; waiver: { version_no: number; body: string; translations?: unknown } | null };
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
    clubSignal.value = c; applyBrand(c.brand_colour);
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
      <ClubForm key={JSON.stringify(s.club)} c={s.club} answerer={s.answerer} send={send} />
      <BookingRules key={JSON.stringify(s.policy)} p={s.policy} send={send} />
      <WaiverForm key={JSON.stringify(s.waiver)} w={s.waiver} send={send} />
      <TextingCard x={s.texting} tz={s.club.time_zone} />
      <SignInCard key={s.club.two_factor} rule={s.club.two_factor} send={send} />
      {me.value?.roles.some((r) => r.key === "owner") && <ClubExport />}
      {s.locations.map((l) => <LocationCard key={JSON.stringify(l)} l={l} plans={s.plans} send={send} />)}
      <NewLocation tz={s.club.time_zone} send={send} />
      {note && <p class="note" role="status">{note}</p>}
      {sheet}
    </main>
  );
}

/** Texts: on or off, where the club's registration with US carriers stands (done from the server, `kumi
 *  texting`), and this month's texts. They count toward the club's one monthly cap, on the Usage page. */
function TextingCard({ x, tz }: { x: Texting; tz: string }) {
  const u = x.usage, usd = (cents: number) => dollars(cents, lang.value), loc = lang.value === "es" ? "es-US" : "en-US";
  const monthName = (m: string) => new Intl.DateTimeFormat(loc, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}T12:00:00Z`));
  const day = (iso: string) => new Intl.DateTimeFormat(loc, { day: "numeric", month: "long", timeZone: tz }).format(new Date(iso));
  const boss = me.value?.roles.some((r) => r.key === "owner" || r.key === "manager");
  return (
    <section class="card card-form">
      <h2>{t("ui.texting_title")}</h2>
      <p class="meta">{t(x.on ? "ui.texting_on" : "ui.texting_off")}</p>
      {x.said.map((line) => <p class="meta">{line}</p>)}
      {!x.on && <p class="meta">{t("ui.texting_how")}</p>}
      {u && <>
        <p class="meta">{t("ui.texts_month", { texts: u.current.texts, segments: u.current.segments, money: usd(u.current.estimate_cents) })}</p>
        {u.current.priced > 0 && <p class="meta">{t("ui.texts_actual", { count: u.current.priced, money: usd(u.current.actual_cents) })}</p>}
        {u.paused && <p class="note" role="status">{t("ui.texts_paused", { resets: day(u.resets) })}</p>}
        {u.current.held > 0 && <p class="meta">{t("ui.texts_held", { count: u.current.held })}</p>}
        <p class="meta">{t("ui.texts_codes")}{boss && <> <a href="/usage">{t("ui.texts_usage_link")}</a></>}</p>
        {u.history.length > 0 && <details><summary>{t("ui.texts_history")}</summary><ul class="plain">
          {u.history.map((m) => <li class="meta">{t("ui.texts_history_row", { month: monthName(m.month), texts: m.texts, segments: m.segments, money: usd(m.estimate_cents) })}</li>)}
        </ul></details>}
      </>}
    </section>
  );
}

/** Who signs in with two steps, and the roles the club makes. */
function SignInCard({ rule, send }: { rule: ClubRow["two_factor"]; send: Preview }) {
  const [v, setV] = useState(rule);
  return (
    <section class="card card-form">
      <h2>{t("ui.sign_in_settings")}</h2>
      <label>{t("ui.two_factor_rule")}<select value={v} onChange={(e) => setV(e.currentTarget.value as ClubRow["two_factor"])}>
        <option value="owner_manager">{t("ui.two_factor_owner_manager")}</option>
        <option value="all_staff">{t("ui.two_factor_all_staff")}</option>
        {rule === "off" && <option value="off" disabled>{t("ui.two_factor_off")}</option>}
      </select></label>
      <p class="meta">{t("ui.two_factor_hint")}</p>
      <button class="primary" disabled={v === rule || v === "off"} onClick={() => send("club.update", { two_factor: v })}>{t("ui.preview")}</button>
      <p><a href="/roles">{t("ui.roles_link")}</a></p>
      {me.value?.roles.some((r) => r.key === "owner") && <p><a href="/vault">{t("ui.vault_link")}</a></p>}
      {!me.value?.support && me.value?.roles.some((r) => r.key === "owner" || r.key === "manager") && <p><a href="/support">{t("ui.support_link")}</a></p>}
    </section>
  );
}

/** The club's waiver: one text, saved as a new version each time; members accept it before playing. */
function WaiverForm({ w, send }: { w: S["waiver"]; send: Preview }) {
  const [body, setBody] = useState(w?.body ?? ""), bodyTr0 = savedIn(w?.translations, "body"), [bodyTr, setBodyTr] = useState(bodyTr0);
  return (
    <section class="card card-form">
      <h2>{t("ui.waiver_settings")}</h2>
      <p class="meta">{w ? t("ui.waiver_version", { version: w.version_no }) : t("ui.waiver_off")}</p>
      <p class="meta">{t("ui.waiver_settings_hint")}</p>
      <textarea rows={8} maxLength={20000} value={body} aria-label={t("ui.waiver_settings")} onInput={(e) => setBody(e.currentTarget.value)} />
      <OtherLang value={bodyTr} onInput={setBodyTr} source={body} multiline rows={8} maxLength={20000} />
      <button class="primary" disabled={!body.trim() || (body.trim() === (w?.body ?? "") && bodyTr.trim() === bodyTr0)} onClick={() => send("waiver.set", { body, translations: translationsOf({ body: bodyTr }) })}>{t("ui.waiver_save")}</button>{" "}
      {w && <button onClick={() => send("waiver.clear", {})}>{t("ui.waiver_stop")}</button>}
    </section>
  );
}

function ClubForm({ c, answerer, send }: { c: ClubRow; answerer: string; send: Preview }) {
  const { translations, ...rest } = c, aboutTr0 = savedIn(translations, "about");
  const start = { ...rest, legal_name: c.legal_name ?? "", about: c.about ?? "", terms_url: c.terms_url ?? "", privacy_policy_url: c.privacy_policy_url ?? "" };
  const [f, setF] = useState(start), [aboutTr, setAboutTr] = useState(aboutTr0);
  const set = (k: keyof ClubRow, v: unknown) => setF({ ...f, [k]: v });
  // A link left empty takes it off: members then see none.
  const links = (d: Partial<typeof f>) => ({ ...d, ...(d.terms_url !== undefined ? { terms_url: d.terms_url.trim() || null } : {}), ...(d.privacy_policy_url !== undefined ? { privacy_policy_url: d.privacy_policy_url.trim() || null } : {}) });
  const toggleLang = (l: string, on: boolean) => set("languages", on ? [...new Set([...f.languages, l])].sort() : f.languages.filter((x) => x !== l));
  return (
    <form class="card card-form" onSubmit={(e) => { e.preventDefault(); send("club.update", { ...links(diff(start, f)), ...(aboutTr.trim() !== aboutTr0 ? { translations: translationsOf({ about: aboutTr }) } : {}) }); }}>
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
      {/* Members booking the same court every week themselves (off until the club says): the desk can always make one for a member. */}
      <label class="check"><input type="checkbox" checked={f.weekly_bookings} onChange={(e) => set("weekly_bookings", e.currentTarget.checked)} /> {t("ui.weekly_bookings_on")}</label>
      {f.weekly_bookings && <label>{t("ui.weekly_max_weeks")}<input type="number" min="2" max="26" step="1" value={String(f.weekly_max_weeks)} onChange={(e) => set("weekly_max_weeks", Math.max(2, Math.min(26, Math.round(Number(e.currentTarget.value) || 12))))} /></label>}
      <label class="check"><input type="checkbox" checked={f.public_page} onChange={(e) => set("public_page", e.currentTarget.checked)} /> {t("ui.public_page_on")}</label>
      {c.public_page && <p class="meta"><a href={`${clubSignal.value?.member_url ?? ""}/public`} target="_blank" rel="noopener">{t("ui.see_public_page")}</a></p>}
      <label>{t("ui.about_club")}<textarea maxLength={600} rows={3} value={f.about ?? ""} onInput={(e) => set("about", e.currentTarget.value)} /></label>
      <OtherLang value={aboutTr} onInput={setAboutTr} source={f.about ?? ""} multiline rows={3} maxLength={600} />
      <label>{t("ui.terms_url")}<input type="url" inputMode="url" placeholder="https://" maxLength={2000} value={f.terms_url} onInput={(e) => set("terms_url", e.currentTarget.value)} /></label>
      <label>{t("ui.privacy_policy_url")}<input type="url" inputMode="url" placeholder="https://" maxLength={2000} value={f.privacy_policy_url} onInput={(e) => set("privacy_policy_url", e.currentTarget.value)} /></label>
      <p class="meta">{t("ui.policies_hint")}</p>
      <label>{t("ui.question_alert_hours")}<input type="number" min="0" max="72" step="1" value={String(f.question_alert_hours)} onChange={(e) => set("question_alert_hours", Math.max(0, Math.min(72, Math.round(Number(e.currentTarget.value) || 0))))} /></label>
      {/* Ask the club: on by default, and only does anything once the server has a decision model. */}
      <label class="check"><input type="checkbox" checked={f.auto_answers} onChange={(e) => set("auto_answers", e.currentTarget.checked)} /> {t("ui.auto_answers")}</label>
      <p class="meta">{t(answerer === "staff_only" ? "ui.auto_answers_no_model" : "ui.auto_answers_help")}</p>
      <label>{t("ui.broadcast_daily_cap")}<input type="number" min="1" max="100000" step="1" value={String(f.broadcast_daily_cap)} onChange={(e) => set("broadcast_daily_cap", Math.max(1, Math.min(100000, Math.round(Number(e.currentTarget.value) || 1))))} /></label>
      <label class="check"><input type="checkbox" checked={f.broadcast_copy_managers} onChange={(e) => set("broadcast_copy_managers", e.currentTarget.checked)} /> {t("ui.broadcast_copy_managers")}</label>
      <label>{t("ui.program_decide_hours")}<input type="number" min="1" max="336" step="1" value={String(f.program_decide_hours)} onChange={(e) => set("program_decide_hours", Math.max(1, Math.min(336, Math.round(Number(e.currentTarget.value) || 24))))} /></label>
      <label>{t("ui.program_heads_up_hours")}<input type="number" min="0" max="336" step="1" value={String(f.program_heads_up_hours)} onChange={(e) => set("program_heads_up_hours", Math.max(0, Math.min(336, Math.round(Number(e.currentTarget.value) || 0))))} /></label>
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
      <ul class="plain">{l.courts.map((c) => <CourtRow key={JSON.stringify(c)} c={c} l={l} send={send} />)}</ul>
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
  const [sp, setSp] = useState({ date: "", closed: true, opens: "09:00", closes: "14:00", note: "", court: "" });
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
        <li class="row"><span>{x.on_date}{x.court_id ? ` · ${l.courts.find((c) => c.id === x.court_id)?.name ?? ""}` : ""} · {x.opens ? `${x.opens} - ${x.closes}` : t("ui.closed")}{x.note ? ` · ${x.note}` : ""}</span>
          <button type="button" class="small" onClick={() => send("hours.exception_remove", { exception_id: x.id })}>{t("ui.remove")}</button></li>))}</ul>
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("hours.exception_set", { location_id: l.id, date: sp.date, ...(sp.closed ? {} : { opens: sp.opens, closes: closing(sp.closes) }), note: sp.note || undefined,
        ...(sp.court ? { court_id: sp.court } : {}) }); }}>
        <label>{t("ui.add_special_day")}<input type="date" required value={sp.date} onInput={(e) => setSp({ ...sp, date: e.currentTarget.value })} /></label>
        {l.courts.length > 1 && <label>{t("ui.special_day_for")}<select value={sp.court} onChange={(e) => setSp({ ...sp, court: e.currentTarget.value })}>
          <option value="">{t("ui.every_court")}</option>{l.courts.map((c) => <option value={c.id}>{c.name}</option>)}</select></label>}
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
  const blank = { rule_id: "", name: "", dollars: "", days: [] as number[], allDay: true, starts: "17:00", ends: "22:00", valid_from: "", valid_to: "", courts: [] as string[], priority: 0, plans: [] as string[], name_tr: "" };
  const [f, setF] = useState(blank);
  const edit = (r: Price) => setF({ rule_id: r.id, name: r.name, dollars: String(r.cents_per_hour / 100), days: r.weekdays ?? [], allDay: !r.starts, starts: r.starts ?? "17:00", ends: r.ends ?? "22:00",
    valid_from: r.valid_from ?? "", valid_to: r.valid_to ?? "", courts: r.court_ids ?? [], priority: r.priority, plans: r.plan_ids ?? [], name_tr: savedIn(r.translations, "name") });
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
        cents_per_hour: parseDollars(f.dollars) ?? NaN, weekdays: f.days.length ? f.days : null, starts: f.allDay ? null : f.starts, ends: f.allDay ? null : closing(f.ends),
        valid_from: f.valid_from || null, valid_to: f.valid_to || null, court_ids: f.courts.length ? f.courts : null, priority: Number(f.priority), plan_ids: f.plans.length ? f.plans : null,
        translations: translationsOf({ name: f.name_tr }) }); }}>
        <label>{f.rule_id ? t("ui.change_price") : t("ui.add_price")}<input required placeholder={t("ui.price_name_hint")} value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
        <OtherLang value={f.name_tr} onInput={(v) => setF({ ...f, name_tr: v })} source={f.name} maxLength={60} />
        <label>{t("ui.dollars_per_hour")}<input required inputMode="decimal" pattern={AMOUNT_PATTERN} title={t("ui.amount_format")} value={f.dollars} onInput={(e) => setF({ ...f, dollars: e.currentTarget.value })} /></label>
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
  const changed = Object.fromEntries((["days_ahead", "max_active", "free_cancel_hours", "late_refund_percent", "split_deadline_hours", "same_day_cutoff_hours", "lengths",
    "late_sub_refund_percent", "late_filled_refund_percent", "late_empty_refund_percent"] as const)
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
      <label>{t("ui.same_day_cutoff_hours")}<input type="number" min={1} max={24} value={f.same_day_cutoff_hours} onInput={num("same_day_cutoff_hours")} /></label>
      <fieldset><legend>{t("ui.late_refunds")}</legend>
        {([["late_sub_refund_percent", "ui.late_sub_refund_percent"], ["late_filled_refund_percent", "ui.late_filled_refund_percent"], ["late_empty_refund_percent", "ui.late_empty_refund_percent"]] as const).map(([k, label]) =>
          <label class="inline-number"><input type="number" min={0} max={100} value={f[k]} onInput={num(k)} /> {t(label)}</label>)}
      </fieldset>
      <fieldset><legend>{t("ui.lengths")}</legend>{[60, 90, 120, 150, 180].map((m) => <label class="check inline"><input type="checkbox" checked={f.lengths.includes(m)}
        onChange={() => setF({ ...f, lengths: f.lengths.includes(m) ? f.lengths.filter((x) => x !== m) : [...f.lengths, m].sort((a, b) => a - b) })} /> {m}</label>)}</fieldset>
      <button class="primary">{t("ui.preview")}</button>
    </form>
  );
}

function CourtRow({ c, l, send }: { c: Court; l: Loc; send: Preview }) {
  const start = { name: c.name, kind: c.kind };
  const [f, setF] = useState(start), [hours, setHours] = useState(false);
  return (
    <li>
      <form class="court-row" onSubmit={(e) => { e.preventDefault(); send("court.update", { court_id: c.id, ...diff(start, f) }); }}>
        <input required aria-label={t("ui.name")} value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} />
        <select aria-label={t("ui.court_kind")} value={f.kind} onChange={(e) => setF({ ...f, kind: e.currentTarget.value })}>{KINDS.map((k) => <option value={k}>{t(`ui.kind_${k}` as Key)}</option>)}</select>
        <button class="small">{t("ui.save")}</button>
        <button type="button" class="small" onClick={() => setHours(!hours)}>{c.hours.length ? t("ui.court_own_hours") : t("ui.court_hours")}</button>
        <button type="button" class="small" onClick={() => send("court.archive", { court_id: c.id })}>{t("ui.archive")}</button>
      </form>
      {hours && <CourtHours c={c} l={l} send={send} />}
    </li>
  );
}

/** A court's own week: each day the location's hours, closed, or its own times. */
function CourtHours({ c, l, send }: { c: Court; l: Loc; send: Preview }) {
  type Day = { weekday: number; mode: "location" | "closed" | "open"; opens: string; closes: string };
  const [days, setDays] = useState<Day[]>(ORDER.map((w) => {
    const own = c.hours.find((h) => h.weekday === w), loc = l.hours.find((h) => h.weekday === w);
    return { weekday: w, mode: !own ? "location" : own.opens ? "open" : "closed", opens: own?.opens ?? loc?.opens ?? "08:00", closes: (own?.closes ?? loc?.closes ?? "22:00").replace("24:00", "00:00") };
  }));
  const set = (w: number, patch: Partial<Day>) => setDays(days.map((d) => (d.weekday === w ? { ...d, ...patch } : d)));
  const locHours = (w: number) => { const h = l.hours.find((x) => x.weekday === w); return h?.opens ? `${h.opens} - ${h.closes}` : t("ui.closed"); };
  return (
    <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("court.hours_set", { court_id: c.id, days: days.filter((d) => d.mode !== "location")
      .map((d) => d.mode === "closed" ? { weekday: d.weekday, opens: null, closes: null } : { weekday: d.weekday, opens: d.opens, closes: closing(d.closes) }) }); }}>
      {days.map((d) => (
        <div class="hours-row">
          <label>{dayName(d.weekday)}<select value={d.mode} onChange={(e) => set(d.weekday, { mode: e.currentTarget.value as Day["mode"] })}>
            <option value="location">{t("ui.court_follows", { hours: locHours(d.weekday) })}</option><option value="closed">{t("ui.closed")}</option><option value="open">{t("ui.court_open_own")}</option></select></label>
          {d.mode === "open" && <>
            <input type="time" step={1800} aria-label={t("ui.from")} value={d.opens} onInput={(e) => set(d.weekday, { opens: e.currentTarget.value })} />
            <input type="time" step={1800} aria-label={t("ui.to")} value={d.closes} onInput={(e) => set(d.weekday, { closes: e.currentTarget.value })} />
          </>}
        </div>))}
      <button>{t("ui.preview")}</button>
    </form>
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
