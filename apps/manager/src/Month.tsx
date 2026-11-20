// The Schedule's Month view: one location's month as a calendar, from the club's first weekday. Each day says how
// full its courts are (as the day view counts occupancy), how many bookings it has, and its clinics, courses and
// events by name; tapping a day opens it in the Day view. One read for the month (/staff/month): no names of people
// and no money, so it reads the same for everyone who reads the Schedule.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { formatLocale, weekOrder } from "@kumi/i18n/format";
import { Skeleton, api, lang, t } from "@kumi/ui";

type Program = { name: string; kind: string; start: string };
type Day = { date: string; open: boolean; percent: number; bookings: number; programs: Program[] };
type MonthData = { month: string; time_zone: string; today: string; days: Day[] };

/** How full a day is, in four steps, so the calendar can be read at a glance (and in words, never colour alone). */
const band = (d: Day) => (!d.open ? "closed" : d.percent >= 75 ? "high" : d.percent >= 45 ? "mid" : d.percent > 0 ? "low" : "none");
const SHOWN = 2;   // program dates named in a day's box; the rest are counted

export function MonthView({ loc, date, stamp, onDay }: { loc: string; date: string; stamp: number; onDay: (day: string) => void }) {
  const month = date.slice(0, 7), [m, setM] = useState<MonthData | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setM(null); setFailed(false);
    api<MonthData>(`/staff/month?location_id=${loc}&month=${month}`).then((x) => { if (live) setM(x); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [loc, month, stamp]);
  if (failed) return <p class="error" role="alert">{t("ui.month_failed")}</p>;
  if (!m) return <Skeleton shape="rows" rows={5} />;

  const order = weekOrder(), locale = formatLocale(lang.value);
  const lead = (new Date(`${m.month}-01T12:00:00Z`).getUTCDay() - order[0]! + 7) % 7;
  const weekday = (w: number, style: "short" | "long") => new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));
  const long = (d: string) => new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
  const programs = (d: Day) => d.programs.map((p) => `${p.name} (${t(`kind.${p.kind}` as Key)})`).join(", ");
  const total = m.days.reduce((n, d) => n + d.bookings, 0), openDays = m.days.filter((d) => d.open);
  const average = openDays.length ? Math.round(openDays.reduce((n, d) => n + d.percent, 0) / openDays.length) : 0;
  return (
    <section class="month" aria-labelledby="month-title">
      <h2 id="month-title" class="month-title">{new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m.month}-15T12:00:00Z`))}
        <span class="occ-chip" role="status">{t("ui.occupancy_month", { percent: average })} · {t("count.bookings", { count: total })}</span></h2>
      <ol class="month-grid" role="list">
        {order.map((w) => <li class="month-head" aria-hidden="true"><abbr title={weekday(w, "long")}>{weekday(w, "short")}</abbr></li>)}
        {Array.from({ length: lead }, () => <li class="month-pad" aria-hidden="true" />)}
        {m.days.map((d) => {
          const words = [long(d.date), d.open ? t("ui.occupancy_day", { percent: d.percent }) : t("ui.closed"), t("count.bookings", { count: d.bookings }), programs(d)].filter(Boolean).join(". ");
          return <li><button type="button" class={`month-day m-${band(d)}${d.date < m.today ? " m-past" : ""}`} aria-label={words} aria-current={d.date === m.today ? "date" : undefined} onClick={() => onDay(d.date)}>
            <span class="month-num">{Number(d.date.slice(8))}</span>
            {d.open ? <span class="month-load"><span class="month-bar" aria-hidden="true"><span style={{ width: `${d.percent}%` }} /></span><span>{d.percent}%</span></span>
              : <span class="meta">{t("ui.closed")}</span>}
            {d.bookings > 0 && <span class="month-count">{t("count.bookings", { count: d.bookings })}</span>}
            {d.programs.length > 0 && <ul class="month-progs" aria-hidden="true">
              {d.programs.slice(0, SHOWN).map((p) => <li class={`k-${p.kind === "clinic" || p.kind === "course" ? "learning" : "event"}`}>{p.name}</li>)}
              {d.programs.length > SHOWN && <li class="meta">{t("ui.month_more", { count: d.programs.length - SHOWN })}</li>}
            </ul>}
          </button></li>;
        })}
      </ol>
      <p class="meta">{t("ui.month_hint")}</p>
    </section>
  );
}
