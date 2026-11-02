// Occupancy and revenue by day for a location, with the same figures as a spreadsheet file.
import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, me, ReceiptSheet, t, type ReceiptView } from "@kumi/ui";

type Row = { date: string; court_hours: number; booked_hours: number; program_hours: number; playtomic_hours: number; blocked_hours: number; occupancy_percent: number; court_revenue_cents: number; lesson_revenue_cents: number; program_revenue_cents: number; membership_revenue_cents: number };
type Receipt = { id: string; number: string; kind: "payment" | "refund"; when: string; paid_by: string; for: string | null; what: string; more: number; total_cents: number };
type Earnings = { coaches: { coach_id: string; coach: string; lessons: number; lesson_minutes: number; net_cents: number; sessions: number; session_minutes: number }[] };
/** The date on the device's own calendar (not UTC's, which is already tomorrow on a US evening). */
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA").format(d);

export function Reports() {
  const [locs, setLocs] = useState<{ id: string; name: string }[]>([]), [loc, setLoc] = useState("");
  const today = new Date(), first = new Date(today.getFullYear(), today.getMonth(), 1);
  const [from, setFrom] = useState(ymd(first)), [to, setTo] = useState(ymd(today)), [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => { api<{ id: string; name: string }[]>("/staff/locations").then((l) => { setLocs(l); setLoc(l[0]?.id ?? ""); }); }, []);
  useEffect(() => { if (loc && from && to) api<{ rows: Row[] }>(`/staff/reports?location_id=${loc}&from=${from}&to=${to}`).then((r) => setRows(r.rows)).catch(() => setRows([])); }, [loc, from, to]);
  // Coaches' lessons and sessions, for payroll (for owners, managers and the accountant; a coach sees their own).
  const [earn, setEarn] = useState<Earnings | null>(null);
  const seesEarnings = (me.value?.roles ?? []).some((r) => ["owner", "manager", "accountant", "coach"].includes(r.key));
  useEffect(() => { if (seesEarnings && from && to) api<Earnings>(`/staff/coach-earnings?from=${from}&to=${to}`).then(setEarn).catch(() => setEarn(null)); }, [from, to]);
  // The club's receipts for the same dates (for whoever takes or sees the club's money: the server says who).
  const [receipts, setReceipts] = useState<Receipt[] | null>(null), [open, setOpen] = useState<ReceiptView | null>(null);
  useEffect(() => { if (from && to) api<Receipt[]>(`/staff/club-receipts?from=${from}&to=${to}`).then(setReceipts).catch(() => setReceipts(null)); setOpen(null); }, [from, to, lang.value]);
  // One opens as the printable receipt, the same as on the person's page.
  const show = (id: string) => api<ReceiptView>(`/staff/receipts/${id}`).then(setOpen);
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
        {rows && <p><strong>{t("ui.occupancy_total", { percent: usable > 0 ? Math.round(used / usable * 100) : 0 })}</strong> · {t("ui.revenue_total", { courts: dollars(sum("court_revenue_cents"), lang.value), lessons: dollars(sum("lesson_revenue_cents"), lang.value), programs: dollars(sum("program_revenue_cents"), lang.value), memberships: dollars(sum("membership_revenue_cents"), lang.value) })}</p>}
        <p><a href={`/staff/reports.csv?location_id=${loc}&from=${from}&to=${to}`}>{t("ui.download_csv")}</a></p>
      </section>
      {rows && <section class="card"><div class="table-scroll"><table>
        <thead><tr><th>{t("ui.day")}</th><th>{t("ui.occupancy")}</th><th>{t("ui.court_hours_used")}</th><th>{t("ui.court_revenue")}</th><th>{t("ui.lesson_revenue")}</th><th>{t("ui.program_revenue")}</th><th>{t("ui.membership_revenue")}</th></tr></thead>
        <tbody>{rows.map((r) => <tr><td>{day(r.date)}</td><td>{r.court_hours ? `${r.occupancy_percent}%` : t("ui.closed")}</td><td>{hrs(r.booked_hours + r.program_hours + r.playtomic_hours)} / {hrs(r.court_hours - r.blocked_hours)}</td>
          <td>{dollars(r.court_revenue_cents, lang.value)}</td><td>{dollars(r.lesson_revenue_cents, lang.value)}</td><td>{dollars(r.program_revenue_cents, lang.value)}</td><td>{dollars(r.membership_revenue_cents, lang.value)}</td></tr>)}</tbody>
      </table></div></section>}
      {earn && <section class="card">
        <h2>{t("ui.coach_earnings")}</h2>
        <p class="meta">{t("ui.coach_earnings_help")}</p>
        {!earn.coaches.length ? <p class="meta">{t("ui.no_coach_earnings")}</p> : <div class="table-scroll"><table>
          <thead><tr><th>{t("ui.coach")}</th><th>{t("ui.col_lessons")}</th><th>{t("ui.col_lesson_hours")}</th><th>{t("ui.col_net")}</th><th>{t("ui.col_sessions")}</th><th>{t("ui.col_session_hours")}</th></tr></thead>
          <tbody>{earn.coaches.map((c) => <tr><td>{c.coach}</td><td>{c.lessons}</td><td>{hrs(c.lesson_minutes / 60)}</td><td>{dollars(c.net_cents, lang.value)}</td><td>{c.sessions}</td><td>{hrs(c.session_minutes / 60)}</td></tr>)}</tbody>
        </table></div>}
        <p><a href={`/staff/coach-earnings.csv?from=${from}&to=${to}`}>{t("ui.download_csv")}</a></p>
      </section>}
      {receipts && <section class="card">
        <h2>{t("ui.receipts_title")}</h2>
        <p class="meta">{t("ui.club_receipts_help")}</p>
        {!receipts.length ? <p class="meta">{t("ui.receipts_none")}</p> : <div class="table-scroll"><table>
          <thead><tr><th>{t("ui.col_receipt")}</th><th>{t("ui.day")}</th><th>{t("ui.col_paid_by")}</th><th>{t("ui.col_what")}</th><th>{t("ui.col_total")}</th></tr></thead>
          <tbody>{receipts.map((r) => <tr><td><button class="link" onClick={() => show(r.id)}>{r.number}</button></td><td>{r.when}</td><td>{r.paid_by}{r.for ? ` (${r.for})` : ""}</td><td>{r.what}{r.more ? ` +${r.more}` : ""}</td>
            <td>{r.kind === "refund" ? `-${dollars(r.total_cents, lang.value)}` : dollars(r.total_cents, lang.value)}</td></tr>)}</tbody>
        </table></div>}
        <p><a href={`/staff/club-receipts.csv?from=${from}&to=${to}`}>{t("ui.download_csv")}</a></p>
        {open && <><ReceiptSheet r={open} /><p class="no-print"><button onClick={() => window.print()}>{t("ui.receipt_print")}</button>{" "}
          <button class="secondary" onClick={() => setOpen(null)}>{t("ui.close")}</button></p></>}
      </section>}
    </main>
  );
}
