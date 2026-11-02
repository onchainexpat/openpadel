// The people a coach worked with lately (whoever was marked as not coming isn't counted), and those booked in
// to come: their level now, how many times, the last time and the next. A coach sees their own; front desk and up pick any coach.
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api, lang, t } from "@kumi/ui";

type S = { person_id: string; name: string; junior: boolean; times: number; last_at: string | null; last_kind: "lesson" | "session" | null; last_name: string | null;
  next_at: string | null; next_kind: "lesson" | "session" | null; next_name: string | null; level: string | null; provisional: boolean | null };
type D = { coach: { id: string; name: string } | null; coaches: { id: string; name: string }[]; days: number; time_zone: string; students: S[] };

export function Students() {
  const loc = useLocation(), coach = loc.query.coach ?? "";
  const [d, setD] = useState<D | null>(null);
  useEffect(() => { api<D>(`/staff/students${coach ? `?coach=${encodeURIComponent(coach)}` : ""}`).then(setD); }, [coach, lang.value]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const day = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: d.time_zone, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
  return (
    <main>
      <h1>{d.coach && d.coaches.length ? t("ui.students_of", { coach: d.coach.name }) : t("ui.my_students")}</h1>
      {d.coaches.length > 0 && <label>{t("ui.coach")}<select value={d.coach?.id ?? ""} onChange={(e) => loc.route(`/students?coach=${e.currentTarget.value}`)}>
        {!d.coach && <option value="">{t("ui.students_pick")}</option>}
        {d.coaches.map((c) => <option value={c.id}>{c.name}</option>)}</select></label>}
      {!d.coach ? <p class="card">{t("ui.students_pick")}</p> : <section class="card">
        <p class="meta">{t("ui.students_help", { count: d.days })}</p>
        {!d.students.length ? <p>{t("ui.students_empty")}</p> : <ul class="plain">{d.students.map((s) => (
          <li class="row"><span><a href={`/people/${s.person_id}`}><strong>{s.name}</strong></a>{s.junior && <span class="badge">{t("ui.junior_tag")}</span>}{" "}
            <span class="meta">{s.level ?? t("ui.no_level_yet")}{s.provisional ? ` · ${t("ui.provisional")}` : ""}</span><br />
            <span class="meta">{[s.last_at ? `${t("ui.students_times", { count: s.times })} · ${t("ui.students_last", { what: s.last_kind === "lesson" ? t("ui.lesson_word") : s.last_name ?? "", when: day(s.last_at) })}` : null,
              s.next_at ? t("ui.students_next", { what: s.next_kind === "lesson" ? t("ui.lesson_word") : s.next_name ?? "", when: day(s.next_at) }) : null].filter(Boolean).join(" · ")}</span></span></li>))}</ul>}
      </section>}
    </main>
  );
}
