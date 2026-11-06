// Occupancy and revenue by day for a location, with the same figures as a spreadsheet file.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, club, clubTime, dollars, lang, mayDo, me, ReceiptSheet, t, usePreview, type ReceiptView, serverNow } from "@kumi/ui";

type Row = { date: string; court_hours: number; booked_hours: number; program_hours: number; playtomic_hours: number; blocked_hours: number; occupancy_percent: number; court_revenue_cents: number; lesson_revenue_cents: number; program_revenue_cents: number; membership_revenue_cents: number };
type Receipt = { id: string; number: string; kind: "payment" | "refund"; when: string; paid_by: string; for: string | null; what: string; more: number; total_cents: number };
type ByMethod = { cash: number; terminal: number; other: number };
type DeskDay = { date: string; in: ByMethod; back: ByMethod; drawer: number };
type DeskLine = { time: string; kind: "in" | "back"; method: string; cents: number; person_id: string; person: string; what: string; by: string | null };
type Earnings = { coaches: { coach_id: string; coach: string; lessons: number; lesson_minutes: number; net_cents: number; sessions: number; session_minutes: number }[] };
/** The date on the club's calendar (not UTC's, which is already tomorrow on a US evening, nor the phone's). */
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: club.value?.time_zone }).format(d);

export function Reports() {
  const [locs, setLocs] = useState<{ id: string; name: string }[]>([]), [loc, setLoc] = useState("");
  const today = ymd(new Date(serverNow()));
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`), [to, setTo] = useState(today), [rows, setRows] = useState<Row[] | null>(null);
  // A coach on their own gets no club money (the server says "staff only"): their page is their lessons and sessions.
  const [money, setMoney] = useState<boolean | null>(null);
  useEffect(() => { api<{ id: string; name: string }[]>("/staff/locations").then((l) => { setLocs(l); setLoc(l[0]?.id ?? ""); }); }, []);
  useEffect(() => { if (loc && from && to) api<{ rows: Row[] }>(`/staff/reports?location_id=${loc}&from=${from}&to=${to}`).then((r) => { setRows(r.rows); setMoney(true); }).catch(() => { setRows(null); setMoney(false); }); }, [loc, from, to]);
  // Coaches' lessons and sessions, for payroll (for owners, managers and the accountant; a coach sees their own).
  const [earn, setEarn] = useState<Earnings | null>(null);
  const seesEarnings = (me.value?.roles ?? []).some((r) => ["owner", "manager", "accountant", "coach"].includes(r.key));
  useEffect(() => { if (seesEarnings && from && to) api<Earnings>(`/staff/coach-earnings?from=${from}&to=${to}`).then(setEarn).catch(() => setEarn(null)); }, [from, to]);
  // The club's receipts for the same dates (for whoever takes or sees the club's money: the server says who).
  const [receipts, setReceipts] = useState<Receipt[] | null>(null), [open, setOpen] = useState<ReceiptView | null>(null);
  useEffect(() => { if (from && to) api<Receipt[]>(`/staff/club-receipts?from=${from}&to=${to}`).then(setReceipts).catch(() => setReceipts(null)); setOpen(null); }, [from, to, lang.value]);
  // What was paid and given back at the desk, a line a day, for counting the drawer (the same people as receipts);
  // a day opens to each payment and who recorded it.
  const [desk, setDesk] = useState<DeskDay[] | null>(null), [deskDay, setDeskDay] = useState<{ date: string; lines: DeskLine[] } | null>(null);
  // The club credit members hold (credit.ts): what the club owes them, today.
  const [credit, setCredit] = useState<{ cents: number; people: number } | null>(null);
  useEffect(() => { api<{ cents: number; people: number }>("/staff/credit").then(setCredit).catch(() => setCredit(null)); }, []);
  // The club's gift cards (gift_cards.ts): what's owed on those not used yet, and each one, to void or remind.
  type Gift = { id: string; amount_cents: number; status: string; last4: string; buyer: string; redeemed_by: string | null };
  const [gifts, setGifts] = useState<{ outstanding: { cents: number; count: number }; cards: Gift[] } | null>(null);
  const loadGifts = () => api<{ outstanding: { cents: number; count: number }; cards: Gift[] }>("/staff/gift-cards").then(setGifts).catch(() => setGifts(null));
  useEffect(() => { void loadGifts(); }, []);
  // Card payments the payment provider took that nothing here records (payments_after_restore.ts): refund or record.
  type Found = { id: string; amount_cents: number; paid_at: string; email: string | null; description: string | null; status: string };
  const [found, setFound] = useState<Found[]>([]);
  const loadFound = () => api<Found[]>("/staff/payments-found").then(setFound).catch(() => setFound([]));
  useEffect(() => { void loadFound(); }, []);
  const { preview, sheet: giftSheet } = usePreview(() => { void loadGifts(); void loadFound(); });
  useEffect(() => { if (from && to) api<DeskDay[]>(`/staff/desk-days?from=${from}&to=${to}`).then(setDesk).catch(() => setDesk(null)); setDeskDay(null); }, [from, to, lang.value]);
  const openDay = (date: string) => deskDay?.date === date ? setDeskDay(null) : api<DeskLine[]>(`/staff/desk-days/${date}`).then((lines) => setDeskDay({ date, lines }));
  const all = (m: ByMethod) => m.cash + m.terminal + m.other, usd = (c: number) => dollars(c, lang.value), back = (c: number) => c ? `-${usd(c)}` : usd(0);
  const deskSum = (f: (x: DeskDay) => number) => (desk ?? []).reduce((n, x) => n + f(x), 0);
  // One opens as the printable receipt, the same as on the person's page.
  const show = (id: string) => api<ReceiptView>(`/staff/receipts/${id}`).then(setOpen);
  const sum = (k: keyof Row) => (rows ?? []).reduce((n, r) => n + (r[k] as number), 0);
  const usable = sum("court_hours") - sum("blocked_hours"), used = sum("booked_hours") + sum("program_hours") + sum("playtomic_hours");
  const hrs = (n: number) => (Math.round(n * 10) / 10).toLocaleString(lang.value === "es" ? "es-US" : "en-US");
  const day = (d: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
  return (
    <main>
      <h1>{t(money === false ? "ui.my_work_title" : "ui.reports_title")}</h1>
      <section class="card card-form">
        {locs.length > 1 && <label>{t("ui.location")}<select value={loc} onChange={(e) => setLoc(e.currentTarget.value)}>{locs.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>}
        <div class="court-row"><label>{t("ui.from")}<input type="date" value={from} onInput={(e) => setFrom(e.currentTarget.value)} /></label>
          <label>{t("ui.to")}<input type="date" value={to} onInput={(e) => setTo(e.currentTarget.value)} /></label></div>
        {rows && <p><strong>{t("ui.occupancy_total", { percent: usable > 0 ? Math.round(used / usable * 100) : 0 })}</strong> · {t("ui.revenue_total", { courts: dollars(sum("court_revenue_cents"), lang.value), lessons: dollars(sum("lesson_revenue_cents"), lang.value), programs: dollars(sum("program_revenue_cents"), lang.value), memberships: dollars(sum("membership_revenue_cents"), lang.value) })}</p>}
        {rows && <p><a href={`/staff/reports.csv?location_id=${loc}&from=${from}&to=${to}`} download>{t("ui.download_csv")}</a></p>}
      </section>
      {rows && <section class="card"><div class="table-scroll"><table class="stack">
        <thead><tr><th>{t("ui.day")}</th><th>{t("ui.occupancy")}</th><th>{t("ui.court_hours_used")}</th><th>{t("ui.court_revenue")}</th><th>{t("ui.lesson_revenue")}</th><th>{t("ui.program_revenue")}</th><th>{t("ui.membership_revenue")}</th></tr></thead>
        <tbody>{rows.map((r) => <tr><td data-label={t("ui.day")}>{day(r.date)}</td><td data-label={t("ui.occupancy")}>{r.court_hours ? `${r.occupancy_percent}%` : t("ui.closed")}</td><td data-label={t("ui.court_hours_used")}>{hrs(r.booked_hours + r.program_hours + r.playtomic_hours)} / {hrs(r.court_hours - r.blocked_hours)}</td>
          <td data-label={t("ui.court_revenue")}>{dollars(r.court_revenue_cents, lang.value)}</td><td data-label={t("ui.lesson_revenue")}>{dollars(r.lesson_revenue_cents, lang.value)}</td><td data-label={t("ui.program_revenue")}>{dollars(r.program_revenue_cents, lang.value)}</td><td data-label={t("ui.membership_revenue")}>{dollars(r.membership_revenue_cents, lang.value)}</td></tr>)}</tbody>
      </table></div></section>}
      {earn && <section class="card">
        <h2>{t("ui.coach_earnings")}</h2>
        <p class="meta">{t("ui.coach_earnings_help")}</p>
        {!earn.coaches.length ? <p class="meta">{t("ui.no_coach_earnings")}</p> : <div class="table-scroll"><table class="stack">
          <thead><tr><th>{t("ui.coach")}</th><th>{t("ui.col_lessons")}</th><th>{t("ui.col_lesson_hours")}</th><th>{t("ui.col_net")}</th><th>{t("ui.col_sessions")}</th><th>{t("ui.col_session_hours")}</th></tr></thead>
          <tbody>{earn.coaches.map((c) => <tr><td data-label={t("ui.coach")}>{c.coach}</td><td data-label={t("ui.col_lessons")}>{c.lessons}</td><td data-label={t("ui.col_lesson_hours")}>{hrs(c.lesson_minutes / 60)}</td><td data-label={t("ui.col_net")}>{dollars(c.net_cents, lang.value)}</td><td data-label={t("ui.col_sessions")}>{c.sessions}</td><td data-label={t("ui.col_session_hours")}>{hrs(c.session_minutes / 60)}</td></tr>)}</tbody>
        </table></div>}
        <p><a href={`/staff/coach-earnings.csv?from=${from}&to=${to}`} download>{t("ui.download_csv")}</a></p>
      </section>}
      {desk && <section class="card">
        <h2>{t("ui.desk_title")}</h2>
        <p class="meta">{t("ui.desk_help")}</p>
        {credit && credit.cents > 0 && <p>{t("ui.credit_outstanding", { amount: dollars(credit.cents, lang.value), count: credit.people })}</p>}
        {gifts && gifts.cards.length > 0 && <details><summary>{t("ui.gift_card_outstanding", { amount: dollars(gifts.outstanding.cents, lang.value), count: gifts.outstanding.count })}</summary>
          <ul class="plain">{gifts.cards.map((g) => <li class="row" key={g.id}>
            <span>{dollars(g.amount_cents, lang.value)} · …{g.last4} · {g.buyer}{g.redeemed_by ? ` → ${g.redeemed_by}` : ""} · {t(`ui.gift_card_status_${g.status}` as Key)}</span>
            {g.status === "active" && <span>{mayDo("gift_card.resend") && <button class="small" onClick={() => preview("gift_card.resend", { gift_card_id: g.id })}>{t("ui.gift_card_resend")}</button>}{" "}
              {mayDo("gift_card.void") && <button class="small" onClick={() => preview("gift_card.void", { gift_card_id: g.id })}>{t("ui.gift_card_void")}</button>}</span>}
          </li>)}</ul></details>}
        {/* On a phone each day (and each line) stacks into rows of its own, each value beside its column's name (styles.css .stack). */}
        {!desk.length ? <p class="meta">{t("ui.desk_none")}</p> : <div class="table-scroll"><table class="stack">
          <thead><tr><th>{t("ui.day")}</th><th>{t("ui.col_cash")}</th><th>{t("ui.col_card_reader")}</th><th>{t("ui.col_other_way")}</th><th>{t("ui.col_given_back")}</th><th>{t("ui.col_drawer")}</th></tr></thead>
          <tbody>{desk.map((x) => <tr><td data-label={t("ui.day")}><button class="link" onClick={() => openDay(x.date)}>{day(x.date)}</button></td><td data-label={t("ui.col_cash")}>{usd(x.in.cash)}</td>
            <td data-label={t("ui.col_card_reader")}>{usd(x.in.terminal)}</td><td data-label={t("ui.col_other_way")}>{usd(x.in.other)}</td>
            <td data-label={t("ui.col_given_back")}>{back(all(x.back))}</td><td data-label={t("ui.col_drawer")}><strong>{usd(x.drawer)}</strong></td></tr>)}</tbody>
          {desk.length > 1 && <tfoot><tr><th>{t("ui.col_total")}</th><th data-label={t("ui.col_cash")}>{usd(deskSum((x) => x.in.cash))}</th><th data-label={t("ui.col_card_reader")}>{usd(deskSum((x) => x.in.terminal))}</th>
            <th data-label={t("ui.col_other_way")}>{usd(deskSum((x) => x.in.other))}</th><th data-label={t("ui.col_given_back")}>{back(deskSum((x) => all(x.back)))}</th><th data-label={t("ui.col_drawer")}>{usd(deskSum((x) => x.drawer))}</th></tr></tfoot>}
        </table></div>}
        {deskDay && <><h3>{day(deskDay.date)}</h3><div class="table-scroll"><table class="stack">
          <thead><tr><th>{t("ui.col_time")}</th><th>{t("ui.col_who")}</th><th>{t("ui.col_what")}</th><th>{t("ui.col_how")}</th><th>{t("ui.col_total")}</th><th>{t("ui.col_recorded_by")}</th></tr></thead>
          <tbody>{deskDay.lines.map((l) => <tr><td data-label={t("ui.col_time")}>{l.time}</td><td data-label={t("ui.col_who")}><a href={`/people/${l.person_id}`}>{l.person}</a></td><td data-label={t("ui.col_what")}>{l.what}</td>
            <td data-label={t("ui.col_how")}>{t(l.kind === "in" ? "ui.desk_paid_how" : "ui.desk_given_back_how", { how: t(`paid_by.${l.method}` as Key) })}</td><td data-label={t("ui.col_total")}>{l.kind === "back" ? back(l.cents) : usd(l.cents)}</td>
            <td data-label={t("ui.col_recorded_by")}>{l.by ?? ""}</td></tr>)}</tbody>
        </table></div></>}
        <p><a href={`/staff/desk.csv?from=${from}&to=${to}`} download>{t("ui.download_csv")}</a></p>
      </section>}
      {receipts && <section class="card">
        <h2>{t("ui.receipts_title")}</h2>
        <p class="meta">{t("ui.club_receipts_help")}</p>
        {!receipts.length ? <p class="meta">{t("ui.receipts_none")}</p> : <div class="table-scroll"><table class="stack">
          <thead><tr><th>{t("ui.col_receipt")}</th><th>{t("ui.day")}</th><th>{t("ui.col_paid_by")}</th><th>{t("ui.col_what")}</th><th>{t("ui.col_total")}</th></tr></thead>
          <tbody>{receipts.map((r) => <tr><td data-label={t("ui.col_receipt")}><button class="link" onClick={() => show(r.id)}>{r.number}</button></td><td data-label={t("ui.day")}>{r.when}</td><td data-label={t("ui.col_paid_by")}>{r.paid_by}{r.for ? ` (${r.for})` : ""}</td><td data-label={t("ui.col_what")}>{r.what}{r.more ? ` +${r.more}` : ""}</td>
            <td data-label={t("ui.col_total")}>{r.kind === "refund" ? `-${dollars(r.total_cents, lang.value)}` : dollars(r.total_cents, lang.value)}</td></tr>)}</tbody>
        </table></div>}
        <p><a href={`/staff/club-receipts.csv?from=${from}&to=${to}`} download>{t("ui.download_csv")}</a></p>
        {open && <><ReceiptSheet r={open} /><p class="no-print"><button onClick={() => window.print()}>{t("ui.receipt_print")}</button>{" "}
          <button class="secondary" onClick={() => setOpen(null)}>{t("ui.close")}</button></p></>}
      </section>}
      {found.length > 0 && <section class="card">
        <h2>{t("ui.found_title")}</h2>
        <p>{t("ui.found_lead")}</p>
        <div class="scroll"><table class="stack"><tbody>{found.map((f) => <tr>
          <td data-label={t("ui.col_date")}>{clubTime(f.paid_at, { dateStyle: "medium", timeStyle: "short" })}</td>
          <td data-label={t("ui.col_total")}>{dollars(f.amount_cents, lang.value)}</td>
          <td data-label={t("ui.found_who")}>{[f.email, f.description].filter(Boolean).join(" · ")}</td>
          <td>{f.status === "open" ? <span>{mayDo("payment_found.refund") && <button class="small" onClick={() => preview("payment_found.refund", { id: f.id })}>{t("ui.found_refund")}</button>}{" "}
            {mayDo("payment_found.paid_elsewhere") && <button class="small secondary" onClick={() => preview("payment_found.paid_elsewhere", { id: f.id })}>{t("ui.found_elsewhere")}</button>}</span> : t(({ refund_asked: "ui.found_status_refund_asked", refunded: "ui.found_status_refunded", handled: "ui.found_status_handled", refund_failed: "ui.found_status_refund_failed" } as const)[f.status as "refunded"] ?? "ui.found_status_handled")}</td>
        </tr>)}</tbody></table></div>
      </section>}
      {giftSheet}
    </main>
  );
}
