// Everyone at the club (Customers): search them, see the staff, add someone, or import a member list. A table a page at
// a time: each person's name, the email and phone the server shows whoever reads people, their membership and the day it
// ends, their answer about club news, and their level for those who read levels (reads.ts /staff/customers).
import { useEffect, useRef, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import type { Key, Lang } from "@kumi/i18n";
import { formatLocale } from "@kumi/i18n/format";
import { api, lang, mayDo, me, t, usePreview } from "@kumi/ui";
import { initials, Pager } from "./lists.tsx";
import { CUSTOMER_COLUMNS, ordered, type CustomerColumn } from "./presets.ts";
import { label, preset } from "./words.ts";

/** Each column's heading. */
const HEAD: Record<CustomerColumn, "ui.name" | "ui.phone" | "ui.email" | "ui.membership" | "ui.membership_ends" | "ui.club_news_col" | "ui.level"> = {
  name: "ui.name", phone: "ui.phone", email: "ui.email", membership: "ui.membership", membership_ends: "ui.membership_ends", club_news: "ui.club_news_col", level: "ui.level" };

type Row = { id: string; display_name: string; email: string | null; phone: string | null; roles: string[] | null; junior?: boolean; tags?: string[] | null;
  membership: { name: string; ends_on: string | null } | null; club_news: boolean | null; level?: string | null };
type Page = { total: number; page: number; pages: number; per_page: number; levels: boolean; rows: Row[] };
type Csv = { rows: { display_name: string; email?: string }[]; problems: { line: number; text: string }[]; fatal?: string };
const BUILT_IN = ["owner", "manager", "front_desk", "coach", "accountant", "member"];
/** The roles worth showing: "member" only when it's all they are. */
export const roleNames = (roles: string[] | null) => {
  const staff = (roles ?? []).filter((r) => r !== "member");
  // A role the club made comes as its own name; the built-in ones as keys.
  return (staff.length ? staff : roles ?? []).map((r) => (BUILT_IN.includes(r) ? t(`role.${r}` as Key) : r)).join(", ");
};

export function People() {
  const { query } = useLocation();
  const [q, setQ] = useState(""), [staffOnly, setStaffOnly] = useState(false), [list, setList] = useState<Page | null>(null), [page, setPage] = useState(1);
  // The club's tags and saved groups (front desk and up): narrow the list to one of them.
  const [tag, setTag] = useState(""), [segment, setSegment] = useState(String(query.segment ?? "")), [lists, setLists] = useState<{ tags: { id: string; name: string }[]; segments: { id: string; name: string }[] } | null>(null);
  const [adding, setAdding] = useState(false), [f, setF] = useState({ display_name: "", email: "", locale: lang.value as Lang });
  const [csv, setCsv] = useState<Csv | null>(null), [importing, setImporting] = useState(false);
  const seq = useRef(0);
  const load = (at = page) => {
    const n = ++seq.current;
    return api<Page>(`/staff/customers?page=${at}&q=${encodeURIComponent(q)}${staffOnly ? "&role=staff" : ""}${tag ? `&tag_id=${tag}` : ""}${segment ? `&segment_id=${segment}` : ""}`)
      .then((x) => { if (n === seq.current) setList(x); });
  };
  const { preview, sheet } = usePreview(() => { load(); setAdding(false); setImporting(false); setCsv(null); setF({ display_name: "", email: "", locale: lang.value as Lang }); });
  // A new search starts at the first page.
  useEffect(() => { const id = setTimeout(() => { setPage(1); void load(1); }, 200); return () => clearTimeout(id); }, [q, staffOnly, tag, segment]);
  // Only for those who read the messages area: everyone else would be turned away.
  const areas = me.value?.areas ?? null, desk = (me.value?.roles ?? []).some((r) => ["owner", "manager", "front_desk"].includes(r.key));
  const messages = areas ? areas.includes("messages") : desk;
  useEffect(() => { if (messages) api<{ tags: { id: string; name: string }[]; segments: { id: string; name: string }[] }>("/staff/broadcast-options").then(setLists).catch(() => {}); }, [messages]);

  const add = (e: Event) => { e.preventDefault(); preview("person.create", { display_name: f.display_name, email: f.email || undefined, locale: f.locale }); };
  const pick = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file) setCsv(await api<Csv>("/staff/people/import-preview", { csv: await file.text() }));
  };
  const go = (p: number) => { setPage(p); void load(p); };
  const ends = (d: string) => new Intl.DateTimeFormat(formatLocale(lang.value), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));

  // The columns in the club's "Coming from" order (presets.ts); a level only for those who read levels, as before.
  const cols = ordered(preset().customerColumns, CUSTOMER_COLUMNS.filter((c) => c !== "level" || list?.levels));
  return (
    <main class="wide">
      <div class="page-head">
        <h1>{label("ui.people_title")}</h1>
        {list && <span class="count-chip" role="status">{t("count.customers", { count: list.total })}</span>}
        <span class="grow" />
        {mayDo("person.import") && <button type="button" aria-expanded={importing} onClick={() => setImporting(!importing)}>{t("ui.import_people")}</button>}
        {mayDo("person.create") && <button type="button" class="primary" aria-expanded={adding} onClick={() => setAdding(!adding)}><span aria-hidden="true">+</span> {t("ui.add_person")}</button>}
      </div>
      {adding && (
        <form class="card card-form" onSubmit={add}>
          <label>{t("ui.name")}<input required maxLength={80} value={f.display_name} onInput={(e) => setF({ ...f, display_name: e.currentTarget.value })} /></label>
          <label>{t("ui.email")}<input type="email" value={f.email} onInput={(e) => setF({ ...f, email: e.currentTarget.value })} /></label>
          <label>{t("ui.language")}<select value={f.locale} onChange={(e) => setF({ ...f, locale: e.currentTarget.value as Lang })}><option value="en">English</option><option value="es">Español</option></select></label>
          <button class="primary">{t("ui.preview")}</button>
        </form>
      )}
      {importing && (
        <section class="card card-form">
          <p class="meta">{t("ui.import_help")}</p>
          <input type="file" accept=".csv,text/csv" aria-label={t("ui.import_people")} onChange={pick} />
          {csv?.fatal && <p class="error" role="alert">{csv.fatal}</p>}
          {csv && !csv.fatal && <p>{t("count.ready_to_import", { count: csv.rows.length })}</p>}
          {csv && csv.problems.length > 0 && <><p class="meta">{t("count.lines_skipped", { count: csv.problems.length })}</p><ul class="meta">{csv.problems.slice(0, 20).map((p) => <li>{p.text}</li>)}</ul></>}
          {csv && csv.rows.length > 0 && <button class="primary" onClick={() => preview("person.import", { rows: csv.rows })}>{t("ui.preview")}</button>}
        </section>
      )}

      <div class="list-bar">
        <label class="search-field"><span class="sr-only">{t("ui.search_people")}</span><input type="search" placeholder={t("ui.search_people")} value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        <label class="check"><input type="checkbox" checked={staffOnly} onChange={(e) => setStaffOnly(e.currentTarget.checked)} /> {t("ui.staff_only")}</label>
        {lists && lists.tags.length > 0 && <label class={`filter-chip${tag ? " on" : ""}`}><span>{t("ui.filter_tag")}</span><select value={tag} onChange={(e) => setTag(e.currentTarget.value)}><option value="">{t("ui.any_tag")}</option>
          {lists.tags.map((x) => <option value={x.id}>{x.name}</option>)}</select></label>}
        {lists && lists.segments.length > 0 && <label class={`filter-chip${segment ? " on" : ""}`}><span>{t("ui.filter_group")}</span><select value={segment} onChange={(e) => setSegment(e.currentTarget.value)}><option value="">{t("ui.any_group")}</option>
          {lists.segments.map((x) => <option value={x.id}>{x.name}</option>)}</select></label>}
      </div>
      {list === null ? <p>{t("ui.loading")}</p> : list.rows.length === 0 ? <p class="card meta">{t("ui.no_people")}</p> : <>
        <div class="table-scroll table-box">
          <table class="data">
            <caption class="sr-only">{label("ui.people_title")}</caption>
            <thead><tr>{cols.map((c) => <th scope="col">{t(HEAD[c])}</th>)}</tr></thead>
            <tbody>{list.rows.map((r) => {
              const also = [r.junior ? t("ui.junior_tag") : roleNames(r.roles), ...(r.tags ?? [])].filter((x) => x && x !== t("role.member")).join(" · ");
              const cell: Record<CustomerColumn, any> = {
                name: <td class="wrap"><a class="person-cell" href={`/people/${r.id}`}><span class="avatar" aria-hidden="true">{initials(r.display_name)}</span>
                  <span><strong>{r.display_name}</strong>{also && <span class="meta block">{also}</span>}</span></a></td>,
                phone: <td>{r.phone ?? <span class="meta">{t("ui.none_dash")}</span>}</td>,
                email: <td>{r.email ?? <span class="meta">{t("ui.none_dash")}</span>}</td>,
                membership: <td>{r.membership?.name ?? <span class="meta">{t("ui.not_a_member")}</span>}</td>,
                membership_ends: <td>{r.membership?.ends_on ? ends(r.membership.ends_on) : <span class="meta">{t("ui.none_dash")}</span>}</td>,
                club_news: <td>{r.club_news === null ? <span class="meta">{t("ui.consent_unknown")}</span> : <span class={`pill ${r.club_news ? "pill-yes" : "pill-no"}`}>{t(r.club_news ? "ui.yes" : "ui.no")}</span>}</td>,
                level: <td>{r.level ?? <span class="meta">{t("ui.none_dash")}</span>}</td>,
              };
              return <tr>{cols.map((c) => cell[c])}</tr>;
            })}</tbody>
          </table>
        </div>
        <Pager page={list.page} pages={list.pages} go={go} shown={list.rows.length} total={list.total} per={list.per_page} />
      </>}
      {sheet}
    </main>
  );
}
