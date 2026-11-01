// Everyone at the club: search them, see the staff, add someone, or import a member list.
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import type { Key, Lang } from "@kumi/i18n";
import { api, lang, t, usePreview } from "@kumi/ui";

type Row = { id: string; display_name: string; email: string | null; roles: string[] | null; junior?: boolean; tags?: string[] | null };
type Csv = { rows: { display_name: string; email?: string }[]; problems: { line: number; text: string }[]; fatal?: string };
/** The roles worth showing: "member" only when it's all they are. */
export const roleNames = (roles: string[] | null) => {
  const staff = (roles ?? []).filter((r) => r !== "member");
  return (staff.length ? staff : roles ?? []).map((r) => t(`role.${r}` as Key)).join(", ");
};

export function People() {
  const { query } = useLocation();
  const [q, setQ] = useState(""), [staffOnly, setStaffOnly] = useState(false), [rows, setRows] = useState<Row[] | null>(null);
  // The club's tags and saved groups (front desk and up): narrow the list to one of them.
  const [tag, setTag] = useState(""), [segment, setSegment] = useState(String(query.segment ?? "")), [lists, setLists] = useState<{ tags: { id: string; name: string }[]; segments: { id: string; name: string }[] } | null>(null);
  const [adding, setAdding] = useState(false), [f, setF] = useState({ display_name: "", email: "", locale: lang.value as Lang });
  const [csv, setCsv] = useState<Csv | null>(null), [importing, setImporting] = useState(false);
  const load = () => api<Row[]>(`/staff/people?limit=100&q=${encodeURIComponent(q)}${staffOnly ? "&role=staff" : ""}${tag ? `&tag_id=${tag}` : ""}${segment ? `&segment_id=${segment}` : ""}`).then(setRows);
  const { preview, sheet } = usePreview(() => { load(); setAdding(false); setImporting(false); setCsv(null); setF({ display_name: "", email: "", locale: lang.value as Lang }); });
  useEffect(() => { const id = setTimeout(load, 200); return () => clearTimeout(id); }, [q, staffOnly, tag, segment]);
  useEffect(() => { api<{ tags: { id: string; name: string }[]; segments: { id: string; name: string }[] }>("/staff/broadcast-options").then(setLists).catch(() => {}); }, []);

  const add = (e: Event) => { e.preventDefault(); preview("person.create", { display_name: f.display_name, email: f.email || undefined, locale: f.locale }); };
  const pick = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file) setCsv(await api<Csv>("/staff/people/import-preview", { csv: await file.text() }));
  };

  return (
    <main>
      <h1>{t("ui.people_title")}</h1>
      <section class="card">
        <label>{t("ui.search_people")}<input type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        <label class="check"><input type="checkbox" checked={staffOnly} onChange={(e) => setStaffOnly(e.currentTarget.checked)} /> {t("ui.staff_only")}</label>
        {lists && lists.tags.length > 0 && <label>{t("ui.filter_tag")}<select value={tag} onChange={(e) => setTag(e.currentTarget.value)}><option value="">{t("ui.any_tag")}</option>
          {lists.tags.map((x) => <option value={x.id}>{x.name}</option>)}</select></label>}
        {lists && lists.segments.length > 0 && <label>{t("ui.filter_group")}<select value={segment} onChange={(e) => setSegment(e.currentTarget.value)}><option value="">{t("ui.any_group")}</option>
          {lists.segments.map((x) => <option value={x.id}>{x.name}</option>)}</select></label>}
        {rows === null ? <p>{t("ui.loading")}</p> : rows.length === 0 ? <p class="meta">{t("ui.no_people")}</p> : (
          <ul class="plain">{rows.map((r) => (
            <li class="row"><a href={`/people/${r.id}`}>{r.display_name}</a><span class="meta">{[r.email, r.junior ? t("ui.junior_tag") : roleNames(r.roles), ...(r.tags ?? [])].filter(Boolean).join(" · ")}</span></li>
          ))}</ul>
        )}
      </section>

      <button onClick={() => setAdding(!adding)}>{t("ui.add_person")}</button>
      {adding && (
        <form class="card card-form" onSubmit={add}>
          <label>{t("ui.name")}<input required maxLength={80} value={f.display_name} onInput={(e) => setF({ ...f, display_name: e.currentTarget.value })} /></label>
          <label>{t("ui.email")}<input type="email" value={f.email} onInput={(e) => setF({ ...f, email: e.currentTarget.value })} /></label>
          <label>{t("ui.language")}<select value={f.locale} onChange={(e) => setF({ ...f, locale: e.currentTarget.value as Lang })}><option value="en">English</option><option value="es">Español</option></select></label>
          <button class="primary">{t("ui.preview")}</button>
        </form>
      )}

      <button onClick={() => setImporting(!importing)}>{t("ui.import_people")}</button>
      {importing && (
        <section class="card card-form">
          <p class="meta">{t("ui.import_help")}</p>
          <input type="file" accept=".csv,text/csv" onChange={pick} />
          {csv?.fatal && <p class="error" role="alert">{csv.fatal}</p>}
          {csv && !csv.fatal && <p>{t("count.ready_to_import", { count: csv.rows.length })}</p>}
          {csv && csv.problems.length > 0 && <><p class="meta">{t("count.lines_skipped", { count: csv.problems.length })}</p><ul class="meta">{csv.problems.slice(0, 20).map((p) => <li>{p.text}</li>)}</ul></>}
          {csv && csv.rows.length > 0 && <button class="primary" onClick={() => preview("person.import", { rows: csv.rows })}>{t("ui.preview")}</button>}
        </section>
      )}
      {sheet}
    </main>
  );
}
