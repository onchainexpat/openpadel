import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { amountPattern, amountStep, fromMajor, parseDollars } from "@kumi/i18n/format";
import { useLocation } from "preact-iso";
import { api, lang, mayCreate, OtherLang, t, translationsOf, clubTime } from "@kumi/ui";
import { usePreview, dollars } from "@kumi/ui";

type Row = { id: string; name: string; kind: string; status: string; capacity: number; price_cents: number; member_price_cents: number | null; booked: number; waitlisted: number; first_start: string | null };
type Location = { id: string; name: string };

const KINDS = ["social", "clinic", "course", "tournament", "league"];

export function Programs() {
  // Opened from the Schedule's + Create (/programs?new=clinic): the form is open, on that kind.
  const asked = useLocation().query.new ?? "", start = KINDS.includes(asked) && mayCreate("program.create") ? asked : "";
  // Clinics and courses are for learning: their results don't change levels unless staff tick it (socials, leagues and tournaments do).
  const [ratedSet, setRatedSet] = useState(false), ratedFor = (kind: string) => kind !== "clinic" && kind !== "course";
  const [rows, setRows] = useState<Row[] | null>(null), [locations, setLocations] = useState<Location[]>([]), [open, setOpen] = useState(Boolean(start));
  const [f, setF] = useState({ location_id: "", kind: start || "social", format: start && start !== "social" ? "" : "americano", name: "", capacity: 16, price: 25, member_price: "", rated: ratedFor(start || "social"),
    refund_window_hours: 24, min_players: "", per_date: false, name_tr: "" });
  const load = () => api<Row[]>("/staff/programs").then(setRows);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); api<Location[]>("/staff/locations").then((l) => { setLocations(l); setF((x) => ({ ...x, location_id: x.location_id || l[0]?.id || "" })); }); }, []);
  const when = (iso: string | null) => (iso ? clubTime(iso, { dateStyle: "medium", timeStyle: "short" }) : "");
  const create = (e: Event) => { e.preventDefault(); preview("program.create", { location_id: f.location_id, kind: f.kind, format: f.format || undefined, name: f.name, capacity: Number(f.capacity), price_cents: fromMajor(Number(f.price)),
    ...(f.member_price.trim() ? { member_price_cents: parseDollars(f.member_price) ?? NaN } : {}), rated: f.rated, refund_window_hours: Number(f.refund_window_hours), ...(f.min_players.trim() ? { min_players: Number(f.min_players) } : {}),
    ...(f.per_date && (f.kind === "clinic" || f.kind === "social") ? { sign_up: "per_session" } : {}), translations: translationsOf({ name: f.name_tr }) }); };

  return (
    <main>
      <h1>{t("ui.nav_programs")}</h1>
      {mayCreate("program.create") && <button onClick={() => setOpen(!open)} aria-expanded={open}>{t("ui.new_program")}</button>}
      {open && (
        <form class="card" onSubmit={create}>
          <label>{t("ui.location")}<select value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.currentTarget.value })}>{locations.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>
          <label>{t("ui.name")}<input required value={f.name} autoFocus={Boolean(start)} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
          <OtherLang value={f.name_tr} onInput={(v) => setF({ ...f, name_tr: v })} source={f.name} maxLength={120} />
          <label>{t("ui.kind")}<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.currentTarget.value, rated: ratedSet ? f.rated : ratedFor(e.currentTarget.value) })}>{KINDS.map((k) => <option value={k}>{t(`kind.${k}` as Key)}</option>)}</select></label>
          <label>{t("ui.format")}<select value={f.format} onChange={(e) => setF({ ...f, format: e.currentTarget.value })}><option value="">{t("ui.format_none")}</option><option value="americano">{t("ui.format_americano")}</option></select></label>
          <label>{t("ui.capacity")}<input type="number" min="1" value={f.capacity} onInput={(e) => setF({ ...f, capacity: Number(e.currentTarget.value) })} /></label>
          <label>{t("ui.price")}<input type="number" min="0" step={amountStep()} value={f.price} onInput={(e) => setF({ ...f, price: Number(e.currentTarget.value) })} /></label>
          <label>{t("ui.member_price_optional")}<input inputMode="decimal" pattern={amountPattern()} title={t("ui.amount_format")} value={f.member_price} onInput={(e) => setF({ ...f, member_price: e.currentTarget.value })} /></label>
          <label>{t("ui.refund_window")}<input type="number" min="0" value={f.refund_window_hours} onInput={(e) => setF({ ...f, refund_window_hours: Number(e.currentTarget.value) })} /></label>
          <label>{t("ui.min_players")}<input type="number" min="1" value={f.min_players} onInput={(e) => setF({ ...f, min_players: e.currentTarget.value })} /></label>
          <label class="check"><input type="checkbox" checked={f.rated} onChange={(e) => { setRatedSet(true); setF({ ...f, rated: e.currentTarget.checked }); }} /> {t("ui.rated")}</label>
          {/* A weekly drop-in: people sign up for the dates they want, each with its own places (clinics and socials). */}
          {(f.kind === "clinic" || f.kind === "social") && <label class="check"><input type="checkbox" checked={f.per_date} onChange={(e) => setF({ ...f, per_date: e.currentTarget.checked })} /> {t("ui.sign_up_per_date")}</label>}
          <button class="primary">{t("ui.preview")}</button>
        </form>
      )}
      {sheet}
      {rows?.length === 0 && <p>{t("ui.no_programs")}</p>}
      <ul class="changes">
        {(rows ?? []).map((r) => (
          <li key={r.id} class="card">
            <a class="summary" href={`/programs/${r.id}`}>{r.name}</a>
            <div class="meta">{t(`kind.${r.kind}` as Key)} · {when(r.first_start)} · {t("ui.places_taken", { booked: r.booked, capacity: r.capacity })}{r.waitlisted ? ` · ${t("ui.waitlist_count", { count: r.waitlisted })}` : ""} · {dollars(r.price_cents, lang.value)}{r.member_price_cents !== null ? ` (${t("ui.members_pay", { amount: dollars(r.member_price_cents, lang.value) })})` : ""} · {t(`ui.status_${r.status}` as Key)}</div>
          </li>
        ))}
      </ul>
    </main>
  );
}
