// A lesson's or a program date's players: level, a junior's parents, the club's waiver, and who came. The
// coach who runs it (or front desk and up) marks "came" or "didn't come" from the start until 48 hours after.
import { useEffect, useState } from "preact/hooks";
import { ApiError, api, lang, t, usePreview, serverNow } from "@kumi/ui";
import { formatLocale } from "@kumi/i18n/format";

type Player = { person_id: string; name: string; level: string | null; provisional: boolean | null; junior: boolean; parents: string[]; waiver: "accepted" | "missing" | null; came: boolean | null };
type R = { item: { kind: "lesson" | "session"; id: string; program_id: string | null; name: string | null; code: string | null; start: string; end: string; cancelled: boolean; coach: string | null; courts: string[]; location: string };
  marking: { open: boolean; until: string }; players: Player[]; time_zone: string; hours: number };

export function Roster({ kind, id }: { kind: string; id: string }) {
  const [d, setD] = useState<R | null>(null), [error, setError] = useState<string | null>(null), [marks, setMarks] = useState<Record<string, boolean | null>>({});
  const load = () => api<R>(`/staff/roster/${kind}/${id}`).then((x) => { setD(x); setMarks(Object.fromEntries(x.players.map((p) => [p.person_id, p.came]))); setError(null); }).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [kind, id, lang.value]);
  if (error) return <main class="card"><p class="error">{error}</p></main>;
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const fmt = (iso: string) => new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: d.time_zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const changed = d.players.filter((p) => marks[p.person_id] !== p.came);
  const count = (v: boolean | null) => d.players.filter((p) => p.came === v).length;
  const toggle = (pid: string, v: boolean) => setMarks({ ...marks, [pid]: marks[pid] === v ? null : v });
  const save = () => preview("attendance.mark", { [d.item.kind === "lesson" ? "booking_id" : "session_id"]: d.item.id, marks: changed.map((p) => ({ person_id: p.person_id, came: marks[p.person_id] ?? null })) });
  return (
    <main>
      {d.item.program_id && <p><a class="tap" href={`/programs/${d.item.program_id}`}>{d.item.name}</a></p>}
      <h1>{d.item.kind === "lesson" ? t("ui.roster_lesson", { court: d.item.courts.join(", ") }) : d.item.name}</h1>
      <p class="meta">{fmt(d.item.start)} · {[d.item.courts.join(", "), d.item.location].filter(Boolean).join(", ")}{d.item.coach ? ` · ${t("ui.roster_with", { coach: d.item.coach })}` : ""}</p>
      {sheet}
      {d.item.cancelled && <p class="card">{t("ui.roster_cancelled")}</p>}
      <section class="card">
        <h2>{t("ui.roster_who")}</h2>
        <p class="meta">{d.marking.open ? t("ui.attendance_until", { when: fmt(d.marking.until) }) : !d.item.cancelled && new Date(d.item.start) > new Date(serverNow()) ? t("ui.attendance_later", { hours: d.hours }) : t("error.attendance_window", { hours: d.hours })}</p>
        {d.players.some((p) => p.came !== null) && <p class="meta">{t("ui.attendance_counts", { came: count(true), missed: count(false), open: count(null) })}</p>}
        {!d.players.length ? <p>{t("ui.no_players_session")}</p> : <ul class="plain">{d.players.map((p) => (
          <li class="row"><span><strong>{p.name}</strong>{p.junior && <span class="badge">{t("ui.junior_tag")}</span>}{" "}
            <span class="meta">{p.level ?? t("ui.no_level_yet")}{p.provisional ? ` · ${t("ui.provisional")}` : ""}{p.waiver === "accepted" ? ` · ${t("ui.waiver_ok")}` : p.waiver === "missing" ? ` · ${t("ui.waiver_missing")}` : ""}</span>
            {p.junior && p.parents.length > 0 && <><br /><span class="meta">{t("ui.roster_parents", { parents: p.parents.join(", ") })}</span></>}</span>
            {d.marking.open && <span class="chips"><button class={`small${marks[p.person_id] === true ? " primary" : ""}`} aria-pressed={marks[p.person_id] === true} onClick={() => toggle(p.person_id, true)}>{t("ui.came")}</button>{" "}
              <button class={`small${marks[p.person_id] === false ? " primary" : ""}`} aria-pressed={marks[p.person_id] === false} onClick={() => toggle(p.person_id, false)}>{t("ui.not_came")}</button></span>}
            {!d.marking.open && p.came !== null && <span class="meta">{p.came ? t("ui.came") : t("ui.not_came")}</span>}</li>))}</ul>}
        {d.marking.open && d.players.length > 0 && <p><button class="primary" disabled={!changed.length} onClick={save}>{t("ui.attendance_save")}</button></p>}
      </section>
    </main>
  );
}
