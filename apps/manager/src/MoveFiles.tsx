import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useRoute } from "preact-iso";
import { api, clubTime, dollars, FileInput, lang, mayDo, me, t, usePreview } from "@kumi/ui";
import type { Key } from "@kumi/i18n";

type Kind = "people" | "bookings" | "programs";
type Upload = { id: string; sha256: string; file_name: string | null; at: string; rows: number; uploaded_by: string | null; columns: { what: string; name: string }[]; problems: { line: number; text: string }[]; lines_left: number };
type Named = { name: string; count: number };
type Files = {
  system: "courtreserve" | "playbypoint"; name: string; uploads: Record<Kind, Upload | null>;
  memberships: Named[]; has_credit: boolean; courts: (Named & { court_id: string | null })[]; events: Named[];
  brought: { people_linked: number; credit_cents: number; credit_people: number; memberships: number; bookings: number; places: number };
  plans: { id: string; name: string; join_in_app: boolean }[]; programs: { id: string; name: string; kind: string; sign_up: string }[]; courts_here: { id: string; name: string }[];
};

/** Reads a file the way move.upload takes it: a CSV as its text, an Excel workbook as its first sheet's cells (read on
 *  the server, which keeps nothing of it). */
async function fileInput(f: File): Promise<{ csv: string } | { cells: string[][] }> {
  if (!/\.xlsx$/i.test(f.name)) return { csv: await f.text() };
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const r = await api<{ cells?: string[][]; fatal?: string }>("/staff/move-in/cells", { xlsx: btoa(bin) });
  if (!r.cells) throw new Error(r.fatal ?? t("csv.not_xlsx"));
  return { cells: r.cells };
}

/** Moving in from CourtReserve or Playbypoint (move_files.ts): each file the club exports there, read by the server,
 *  then members, memberships, club credit, upcoming bookings and program sign-ups, each previewed before anything
 *  changes. The owner, and managers (who ask the owner for credit and memberships). */
export function MoveFiles() {
  const { params } = useRoute();
  const from = params.from === "playbypoint" ? "playbypoint" : "courtreserve";
  const [s, setS] = useState<Files | null>(null), [failed, setFailed] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, string>>({}), [events, setEvents] = useState<Record<string, string>>({}), [courts, setCourts] = useState<Record<string, string>>({});
  const [takeBack, setTakeBack] = useState(false);
  const load = () => api<Files>(`/staff/move-in/files?from=${from}`).then((x) => { setS(x); setFailed(null); }).catch((e: Error) => setFailed(e.message));
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value, from]);
  const allowed = me.value?.can ? mayDo("move.upload") : (me.value?.roles ?? []).some((r) => r.key === "owner" || r.key === "manager");
  if (!allowed) return <main class="card"><p>{t("ui.not_for_your_role")}</p></main>;
  if (failed) return <main class="card"><p class="error" role="alert">{failed}</p></main>;
  if (!s) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const fmt = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
  const pick = (kind: Kind) => async (f: File | null, input: HTMLInputElement) => {
    if (!f) return;
    try { await preview("move.upload", { from, kind, ...(await fileInput(f)), file_name: f.name.slice(0, 200) }); }
    catch (err) { setFailed((err as Error).message); }
    input.value = "";
  };
  const ref = (u: Upload) => ({ upload_id: u.id, sha256: u.sha256 });
  const filled = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v));
  const fileCard = (kind: Kind, body?: ComponentChildren) => {
    const u = s.uploads[kind];
    return <section class="card">
      <h2>{t(`ui.move_files_${kind}` as Key)}</h2>
      <p class="meta">{t(`ui.move_files_${s.system}_${kind}` as Key)}</p>
      <FileInput label={t("ui.move_files_pick")} accept=".csv,.xlsx,text/csv" onFile={pick(kind)} />
      {u && <>
        <p>{t("ui.move_files_read", { name: u.file_name ?? "CSV", when: fmt(u.at), by: u.uploaded_by ?? "-", rows: t("count.move_rows", { count: u.rows }) })}</p>
        <p class="meta">{t("ui.move_files_columns", { columns: u.columns.map((c) => `${c.name} (${t(`move.col_${c.what}` as Key)})`).join(", ") })}</p>
        {u.lines_left > 0 && <><p class="meta">{t("count.lines_skipped", { count: u.lines_left })}</p><ul class="meta">{u.problems.slice(0, 20).map((p) => <li>{p.text}</li>)}</ul></>}
        {body}
      </>}
    </section>;
  };
  const choose = (label: string, value: string, set: (v: string) => void, options: { id: string; name: string }[]) => (
    <select aria-label={label} value={value} onChange={(e) => set(e.currentTarget.value)}>
      <option value="">{t("ui.move_files_choose")}</option>
      {options.map((o) => <option value={o.id}>{o.name}</option>)}
      <option value="skip">{t("ui.movein_leave_out")}</option>
    </select>);
  const people = s.uploads.people, bookings = s.uploads.bookings, programs = s.uploads.programs;

  return (
    <main>
      <p><a href="/settings/moving-in">{t("ui.moving_link")}</a></p>
      <h1>{t("ui.move_files_title", { from: s.name })}</h1>
      <section class="card">
        <p>{t("ui.move_files_intro", { from: s.name })}</p>
        <p class="note">{t("ui.move_files_unverified", { from: s.name })}</p>
        <ul class="plain move-list">
          <li class="row"><span>{t("count.move_files_linked", { count: s.brought.people_linked })}</span><a href="/people">{t("ui.moving_see")}</a></li>
          <li class="row"><span>{t("count.movein_kept", { count: s.brought.memberships })}</span></li>
          <li class="row"><span>{t("ui.movein_credit_so_far", { amount: dollars(s.brought.credit_cents, lang.value), people: t("count.people", { count: s.brought.credit_people }) })}</span></li>
          <li class="row"><span>{t("count.move_files_bookings", { count: s.brought.bookings })}</span><a href="/bookings">{t("ui.moving_see")}</a></li>
          <li class="row"><span>{t("count.move_files_places", { count: s.brought.places })}</span><a href="/programs">{t("ui.moving_see")}</a></li>
        </ul>
      </section>
      {sheet}

      {fileCard("people", people && <>
        <h3>{t("ui.move_files_step_members")}</h3>
        <p class="meta">{t("ui.move_files_members_help")}</p>
        <button class="primary" onClick={() => preview("move.members", ref(people))}>{t("ui.preview")}</button>

        {s.memberships.length > 0 && <>
          <h3>{t("ui.move_files_step_memberships")}</h3>
          <p class="meta">{t("ui.move_files_memberships_help", { from: s.name })}</p>
          <ul class="plain">{s.memberships.map((m) => <li class="row"><span>{m.name} <span class="meta">{t("count.move_lines", { count: m.count })}</span></span>
            {choose(t("ui.movein_plan_for", { name: m.name }), plans[m.name] ?? "", (v) => setPlans((x) => ({ ...x, [m.name]: v })), s.plans)}</li>)}</ul>
          <button class="primary" onClick={() => preview("move.memberships", { ...ref(people), map: filled(plans) })}>{t("ui.preview")}</button>
        </>}

        {s.has_credit && <>
          <h3>{t("ui.move_files_step_credit")}</h3>
          <p class="meta">{t("ui.move_files_credit_help", { from: s.name })}</p>
          <label class="check"><input type="checkbox" checked={takeBack} onChange={(e) => setTakeBack(e.currentTarget.checked)} /> {t("ui.move_files_take_back", { from: s.name })}</label>
          <button class="primary" onClick={() => preview("move.credit", { ...ref(people), ...(takeBack ? { take_back: true } : {}) })}>{t("ui.preview")}</button>
        </>}
      </>)}

      {fileCard("bookings", bookings && <>
        <p class="meta">{t("ui.move_files_bookings_help", { from: s.name })}</p>
        <ul class="plain">{s.courts.map((c) => <li class="row"><span>{c.name} <span class="meta">{t("count.move_lines", { count: c.count })}</span></span>
          {choose(t("ui.move_files_court_for", { name: c.name }), courts[c.name] ?? c.court_id ?? "", (v) => setCourts((x) => ({ ...x, [c.name]: v })), s.courts_here)}</li>)}</ul>
        <button class="primary" onClick={() => preview("move.bookings", { ...ref(bookings), courts: filled(courts) })}>{t("ui.preview")}</button>
      </>)}

      {fileCard("programs", programs && <>
        <p class="meta">{t("ui.move_files_programs_help", { from: s.name })}</p>
        <ul class="plain">{s.events.map((ev) => <li class="row"><span>{ev.name} <span class="meta">{t("count.move_lines", { count: ev.count })}</span></span>
          {choose(t("ui.move_files_program_for", { name: ev.name }), events[ev.name] ?? "", (v) => setEvents((x) => ({ ...x, [ev.name]: v })), s.programs)}</li>)}</ul>
        <button class="primary" onClick={() => preview("move.programs", { ...ref(programs), map: filled(events) })}>{t("ui.preview")}</button>
      </>)}
    </main>
  );
}
