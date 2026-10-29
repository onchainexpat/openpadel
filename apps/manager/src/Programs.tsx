import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, lang, t } from "@kumi/ui";
import { usePreview, dollars } from "@kumi/ui";

type Row = { id: string; name: string; kind: string; status: string; capacity: number; price_cents: number; booked: number; waitlisted: number; first_start: string | null };
type Location = { id: string; name: string };

export function Programs() {
  const [rows, setRows] = useState<Row[] | null>(null), [locations, setLocations] = useState<Location[]>([]), [open, setOpen] = useState(false);
  const [f, setF] = useState({ location_id: "", kind: "social", format: "americano", name: "", capacity: 16, price: 25, rated: true, refund_window_hours: 24 });
  const load = () => api<Row[]>("/staff/programs").then(setRows);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); api<Location[]>("/staff/locations").then((l) => { setLocations(l); setF((x) => ({ ...x, location_id: x.location_id || l[0]?.id || "" })); }); }, []);
  const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "");
  const create = (e: Event) => { e.preventDefault(); preview("program.create", { location_id: f.location_id, kind: f.kind, format: f.format || undefined, name: f.name, capacity: Number(f.capacity), price_cents: Math.round(Number(f.price) * 100), rated: f.rated, refund_window_hours: Number(f.refund_window_hours) }); };

  return (
    <main>
      <h1>{t("ui.nav_programs")}</h1>
      <button onClick={() => setOpen(!open)}>{t("ui.new_program")}</button>
      {open && (
        <form class="card" onSubmit={create}>
          <label>{t("ui.location")}<select value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.currentTarget.value })}>{locations.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>
          <label>{t("ui.name")}<input required value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
          <label>{t("ui.kind")}<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.currentTarget.value })}>{["social", "clinic", "course", "tournament", "league"].map((k) => <option value={k}>{t(`kind.${k}` as Key)}</option>)}</select></label>
          <label>{t("ui.format")}<select value={f.format} onChange={(e) => setF({ ...f, format: e.currentTarget.value })}><option value="">{t("ui.format_none")}</option><option value="americano">{t("ui.format_americano")}</option></select></label>
          <label>{t("ui.capacity")}<input type="number" min="1" value={f.capacity} onInput={(e) => setF({ ...f, capacity: Number(e.currentTarget.value) })} /></label>
          <label>{t("ui.price")}<input type="number" min="0" step="0.01" value={f.price} onInput={(e) => setF({ ...f, price: Number(e.currentTarget.value) })} /></label>
          <label>{t("ui.refund_window")}<input type="number" min="0" value={f.refund_window_hours} onInput={(e) => setF({ ...f, refund_window_hours: Number(e.currentTarget.value) })} /></label>
          <label class="check"><input type="checkbox" checked={f.rated} onChange={(e) => setF({ ...f, rated: e.currentTarget.checked })} /> {t("ui.rated")}</label>
          <button class="primary">{t("ui.preview")}</button>
        </form>
      )}
      {sheet}
      {rows?.length === 0 && <p>{t("ui.no_programs")}</p>}
      <ul class="changes">
        {(rows ?? []).map((r) => (
          <li key={r.id} class="card">
            <a class="summary" href={`/programs/${r.id}`}>{r.name}</a>
            <div class="meta">{t(`kind.${r.kind}` as Key)} · {when(r.first_start)} · {t("ui.places_taken", { booked: r.booked, capacity: r.capacity })}{r.waitlisted ? ` · ${t("ui.waitlist_count", { count: r.waitlisted })}` : ""} · {dollars(r.price_cents, lang.value)} · {t(`ui.status_${r.status}` as Key)}</div>
          </li>
        ))}
      </ul>
    </main>
  );
}
