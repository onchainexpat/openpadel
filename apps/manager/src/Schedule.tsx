// A coach's own two weeks: their lessons (who's coming, which court) and the dates they run, day by day, each
// with its list of players (and who came). A lesson can be called off from here; its players get all their
// money back. Their calendar link sits on top: a phone's calendar subscribes to it.
import { useEffect, useState } from "preact/hooks";
import { api, lang, t, usePreview, serverNow } from "@kumi/ui";
import { formatLocale } from "@kumi/i18n/format";

type Item = { kind: "lesson" | "session"; id: string; start: string; end: string; court?: string; players_names?: string | null; code?: string; name?: string; program_id?: string; booked?: number };

function CalendarLink() {
  const [link, setLink] = useState<{ path: string | null } | null>(null), [copied, setCopied] = useState(false), [asked, setAsked] = useState(false);
  useEffect(() => { api<{ path: string | null }>("/staff/calendar-link").then(setLink).catch(() => setLink(null)); }, []);
  if (!link) return null;
  const url = link.path ? `${location.origin}${link.path}` : "";
  const make = async () => { setLink(await api<{ path: string }>("/staff/calendar-link", {})); setCopied(false); setAsked(false); };
  const copy = async () => { await navigator.clipboard?.writeText(url).catch(() => {}); setCopied(true); };
  return (
    <section class="card">
      <h2>{t("ui.calendar_title")}</h2>
      <p class="meta">{t("ui.calendar_help")}</p>
      {link.path ? <>
        <input readOnly value={url} aria-label={t("ui.calendar_title")} onFocus={(e) => e.currentTarget.select()} />
        <p><button onClick={copy}>{copied ? t("ui.link_copied") : t("ui.calendar_copy")}</button>{" "}
          {asked ? <button class="small" onClick={make}>{t("ui.calendar_new")}</button> : <button class="link" onClick={() => setAsked(true)}>{t("ui.calendar_new")}</button>}</p>
        {asked && <p class="meta">{t("ui.calendar_new_note")}</p>}
      </> : <p><button class="primary" onClick={make}>{t("ui.calendar_make")}</button></p>}
    </section>
  );
}

export function Schedule() {
  const [d, setD] = useState<{ time_zone: string; items: Item[] } | null>(null);
  const load = () => api<{ time_zone: string; items: Item[] }>("/staff/my-schedule").then(setD);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, []);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: d.time_zone, ...o }).format(new Date(iso));
  const days = [...new Set(d.items.map((x) => fmt(x.start, { weekday: "long", day: "numeric", month: "long" })))];
  return (
    <main>
      <h1>{t("ui.schedule_title")}</h1>
      <p><a href="/students">{t("ui.my_students")}</a></p>
      {sheet}
      <CalendarLink />
      {!d.items.length && <p class="card">{t("ui.schedule_empty")}</p>}
      {days.map((day) => <section class="card">
        <h2>{day}</h2>
        <ul class="plain">{d.items.filter((x) => fmt(x.start, { weekday: "long", day: "numeric", month: "long" }) === day).map((x) => (
          <li class="row"><span><strong>{fmt(x.start, { hour: "numeric", minute: "2-digit" })} - {fmt(x.end, { hour: "numeric", minute: "2-digit" })}</strong>{" "}
            {x.kind === "lesson" ? t("ui.lesson_item", { players: x.players_names ?? "", court: x.court ?? "" }) : <a href={`/programs/${x.program_id}`}>{t("ui.session_item", { program: x.name ?? "", count: x.booked ?? 0 })}</a>}
            {" "}<a href={`/roster/${x.kind}/${x.id}`}>{t("ui.students")}</a></span>
            {x.kind === "lesson" && new Date(x.start) > new Date(serverNow()) && <button class="small" onClick={() => preview("booking.cancel", { booking_id: x.id })}>{t("ui.cancel_lesson")}</button>}</li>))}</ul>
      </section>)}
    </main>
  );
}
