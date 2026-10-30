// A coach's own two weeks: their lessons (who's coming, which court) and the dates they run, day by day.
// A lesson can be called off from here; its players get all their money back.
import { useEffect, useState } from "preact/hooks";
import { api, lang, t, usePreview } from "@kumi/ui";

type Item = { kind: "lesson" | "session"; id: string; start: string; end: string; court?: string; players_names?: string | null; code?: string; name?: string; program_id?: string; booked?: number };

export function Schedule() {
  const [d, setD] = useState<{ time_zone: string; items: Item[] } | null>(null);
  const load = () => api<{ time_zone: string; items: Item[] }>("/staff/my-schedule").then(setD);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, []);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: d.time_zone, ...o }).format(new Date(iso));
  const days = [...new Set(d.items.map((x) => fmt(x.start, { weekday: "long", day: "numeric", month: "long" })))];
  return (
    <main>
      <h1>{t("ui.schedule_title")}</h1>
      {sheet}
      {!d.items.length && <p class="card">{t("ui.schedule_empty")}</p>}
      {days.map((day) => <section class="card">
        <h2>{day}</h2>
        <ul class="plain">{d.items.filter((x) => fmt(x.start, { weekday: "long", day: "numeric", month: "long" }) === day).map((x) => (
          <li class="row"><span><strong>{fmt(x.start, { hour: "numeric", minute: "2-digit" })} - {fmt(x.end, { hour: "numeric", minute: "2-digit" })}</strong>{" "}
            {x.kind === "lesson" ? t("ui.lesson_item", { players: x.players_names ?? "", court: x.court ?? "" }) : <a href={`/programs/${x.program_id}`}>{t("ui.session_item", { program: x.name ?? "", count: x.booked ?? 0 })}</a>}</span>
            {x.kind === "lesson" && new Date(x.start) > new Date() && <button class="small" onClick={() => preview("booking.cancel", { booking_id: x.id })}>{t("ui.cancel_lesson")}</button>}</li>))}</ul>
      </section>)}
    </main>
  );
}
