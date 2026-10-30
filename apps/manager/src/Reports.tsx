// Occupancy and revenue by day for a location, with the same figures as a spreadsheet file.
import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, t } from "@kumi/ui";

type Row = { date: string; court_hours: number; booked_hours: number; program_hours: number; playtomic_hours: number; blocked_hours: number; occupancy_percent: number; court_revenue_cents: number; program_revenue_cents: number };
/** The date on the device's own calendar (not UTC's, which is already tomorrow on a US evening). */
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA").format(d);

export function Reports() {
  const [locs, setLocs] = useState<{ id: string; name: string }[]>([]), [loc, setLoc] = useState("");
  const today = new Date(), first = new Date(today.getFullYear(), today.getMonth(), 1);
  const [from, setFrom] = useState(ymd(first)), [to, setTo] = useState(ymd(today)), [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => { api<{ id: string; name: string }[]>("/staff/locations").then((l) => { setLocs(l); setLoc(l[0]?.id ?? ""); }); }, []);
  useEffect(() => { if (loc && from && to) api<{ rows: Row[] }>(`/staff/reports?location_id=${loc}&from=${from}&to=${to}`).then((r) => setRows(r.rows)).catch(() => setRows([])); }, [loc, from, to]);
  const sum = (k: keyof Row) => (rows ?? []).reduce((n, r) => n + (r[k] as number), 0);
  const usable = sum("court_hours") - sum("blocked_hours"), used = sum("booked_hours") + sum("program_hours") + sum("playtomic_hours");
  const hrs = (n: number) => (Math.round(n * 10) / 10).toLocaleString(lang.value === "es" ? "es-US" : "en-US");
  const day = (d: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
  return (
    <main>
      <h1>{t("ui.reports_title")}</h1>
      <section class="card card-form">
        {locs.length > 1 && <label>{t("ui.location")}<select value={loc} onChange={(e) => setLoc(e.currentTarget.value)}>{locs.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>}
        <div class="court-row"><label>{t("ui.from")}<input type="date" value={from} onInput={(e) => setFrom(e.currentTarget.value)} /></label>
          <label>{t("ui.to")}<input type="date" value={to} onInput={(e) => setTo(e.currentTarget.value)} /></label></div>
        {rows && <p><strong>{t("ui.occupancy_total", { percent: usable > 0 ? Math.round(used / usable * 100) : 0 })}</strong> · {t("ui.revenue_total", { courts: dollars(sum("court_revenue_cents"), lang.value), programs: dollars(sum("program_revenue_cents"), lang.value) })}</p>}
        <p><a href={`/staff/reports.csv?location_id=${loc}&from=${from}&to=${to}`}>{t("ui.download_csv")}</a></p>
      </section>
      {rows && <section class="card"><div class="table-scroll"><table>
        <thead><tr><th>{t("ui.day")}</th><th>{t("ui.occupancy")}</th><th>{t("ui.court_hours_used")}</th><th>{t("ui.court_revenue")}</th><th>{t("ui.program_revenue")}</th></tr></thead>
        <tbody>{rows.map((r) => <tr><td>{day(r.date)}</td><td>{r.court_hours ? `${r.occupancy_percent}%` : t("ui.closed")}</td><td>{hrs(r.booked_hours + r.program_hours + r.playtomic_hours)} / {hrs(r.court_hours - r.blocked_hours)}</td>
          <td>{dollars(r.court_revenue_cents, lang.value)}</td><td>{dollars(r.program_revenue_cents, lang.value)}</td></tr>)}</tbody>
      </table></div></section>}
    </main>
  );
}
