// Everyone at the club (Customers): search them, see the staff, add someone, or import a member list. A table a page at
// a time: each person's name, the email and phone the server shows whoever reads people, their membership and the day it
// ends, their answer about club news, and their level for those who read levels (reads.ts /staff/customers). Narrowed
// by a tag, a saved group or a membership. Imports: each member list brought in from a CSV or Excel file, and what came of it.
import { useEffect, useRef, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import type { Key, Lang } from "@kumi/i18n";
import { formatLocale } from "@kumi/i18n/format";
import { Icon, Skeleton, api, clubTime, lang, mayDo, me, t, usePreview } from "@kumi/ui";
import { initials, Pager, Tabs } from "./lists.tsx";
import { CUSTOMER_COLUMNS, ordered, type CustomerColumn } from "./presets.ts";
import { label, preset } from "./words.ts";

/** Each column's heading. */
const HEAD: Record<CustomerColumn, "ui.name" | "ui.phone" | "ui.email" | "ui.membership" | "ui.membership_ends" | "ui.club_news_col" | "ui.level"> = {
  name: "ui.name", phone: "ui.phone", email: "ui.email", membership: "ui.membership", membership_ends: "ui.membership_ends", club_news: "ui.club_news_col", level: "ui.level" };

type Row = { id: string; display_name: string; email: string | null; phone: string | null; roles: string[] | null; junior?: boolean; tags?: string[] | null;
  membership: { name: string; ends_on: string | null } | null; club_news: boolean | null; level?: string | null };
type Page = { total: number; page: number; pages: number; per_page: number; levels: boolean; plans?: { id: string; name: string }[]; rows: Row[] };
type Csv = { rows: { display_name: string; email?: string }[]; problems: { line: number; text: string }[]; fatal?: string; name?: string };
type Import = { id: string; status: "applied" | "undone" | "awaiting_approval"; at: string; by: string | null; file: string | null; lines: number; added: number; updated: number; skipped: number };
/** A file's bytes as base64, a piece at a time (a whole workbook at once is too many arguments for one call). */
const base64 = (b: ArrayBuffer) => {
  const u = new Uint8Array(b);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
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
  // ?import=1 (or =playbypoint) opens the import, as the guided move-in links it (MoveSteps.tsx).
  const [csv, setCsv] = useState<Csv | null>(null), [importing, setImporting] = useState(Boolean(query.import)), [reading, setReading] = useState(false);
  // Which system the file is from: Playbypoint's list is read by its own preset (csv.ts), anything else as any spreadsheet.
  const [from, setFrom] = useState<"" | "playbypoint">(query.import === "playbypoint" ? "playbypoint" : "");
  // membership: a plan's id, "any" or "none". tab: the people, or the imports.
  const [membership, setMembership] = useState(""), [tab, setTab] = useState<"people" | "imports">(query.tab === "imports" ? "imports" : "people"), [imports, setImports] = useState<Import[] | null>(null);
  const seq = useRef(0);
  const load = (at = page) => {
    const n = ++seq.current;
    return api<Page>(`/staff/customers?page=${at}&q=${encodeURIComponent(q)}${staffOnly ? "&role=staff" : ""}${tag ? `&tag_id=${tag}` : ""}${segment ? `&segment_id=${segment}` : ""}${membership ? `&membership=${membership}` : ""}`)
      .then((x) => { if (n === seq.current) setList(x); });
  };
  const loadImports = () => api<Import[]>("/staff/people/imports").then(setImports).catch(() => setImports([]));
  const { preview, sheet } = usePreview(() => { load(); if (imports) void loadImports(); setAdding(false); setImporting(false); setCsv(null); setF({ display_name: "", email: "", locale: lang.value as Lang }); });
  // A new search starts at the first page.
  useEffect(() => { const id = setTimeout(() => { setPage(1); void load(1); }, 200); return () => clearTimeout(id); }, [q, staffOnly, tag, segment, membership]);
  useEffect(() => { if (tab === "imports" && !imports) void loadImports(); }, [tab]);
  // Only for those who read the messages area: everyone else would be turned away.
  const areas = me.value?.areas ?? null, desk = (me.value?.roles ?? []).some((r) => ["owner", "manager", "front_desk"].includes(r.key));
  const messages = areas ? areas.includes("messages") : desk;
  useEffect(() => { if (messages) api<{ tags: { id: string; name: string }[]; segments: { id: string; name: string }[] }>("/staff/broadcast-options").then(setLists).catch(() => {}); }, [messages]);

  const add = (e: Event) => { e.preventDefault(); preview("person.create", { display_name: f.display_name, email: f.email || undefined, locale: f.locale }); };
  // A CSV is sent as its text, an Excel workbook as its bytes: the server reads either (and keeps neither).
  const pick = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    setReading(true); setCsv(null);
    try {
      const excel = /\.xlsx$/i.test(file.name) || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const r = await api<Csv>("/staff/people/import-preview", { ...(excel ? { xlsx: base64(await file.arrayBuffer()) } : { csv: await file.text() }), ...(from ? { from } : {}) });
      setCsv({ ...r, name: file.name.slice(0, 200) });
    } catch (x) { setCsv({ rows: [], problems: [], fatal: (x as Error).message }); }
    finally { setReading(false); }
  };
  const go = (p: number) => { setPage(p); void load(p); };
  const ends = (d: string) => new Intl.DateTimeFormat(formatLocale(lang.value), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));

  // The columns in the club's "Coming from" order (presets.ts); a level only for those who read levels, as before.
  const cols = ordered(preset().customerColumns, CUSTOMER_COLUMNS.filter((c) => c !== "level" || list?.levels));
  return (
    <main class="wide">
      <div class="page-head">
        <h1>{label("ui.people_title")}</h1>
        {list && tab === "people" && <span class="count-chip" role="status">{t("count.customers", { count: list.total })}</span>}
        <span class="grow" />
        {mayDo("person.import") && <button type="button" aria-expanded={importing} onClick={() => setImporting(!importing)}>{t("ui.import_people")}</button>}
        {mayDo("person.create") && <button type="button" class="primary" aria-expanded={adding} onClick={() => setAdding(!adding)}><Icon name="user-plus" />{t("ui.add_person")}</button>}
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
          <label>{t("ui.import_from")}<select value={from} onChange={(e) => { setFrom(e.currentTarget.value as "" | "playbypoint"); setCsv(null); }}>
            <option value="">{t("ui.import_from_any")}</option><option value="playbypoint">{t("ui.import_from_playbypoint")}</option></select></label>
          {from === "playbypoint" && <p class="meta">{t("ui.moving_playbypoint_unverified")}</p>}
          <input key={from} type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label={t("ui.import_people")} onChange={pick} />
          {reading && <p class="meta" role="status">{t("ui.reading_file")}</p>}
          {csv?.fatal && <p class="error" role="alert">{csv.fatal}</p>}
          {csv && !csv.fatal && <p>{t("count.ready_to_import", { count: csv.rows.length })}</p>}
          {csv && csv.problems.length > 0 && <><p class="meta">{t("count.lines_skipped", { count: csv.problems.length })}</p><ul class="meta">{csv.problems.slice(0, 20).map((p) => <li>{p.text}</li>)}</ul></>}
          {csv && csv.rows.length > 0 && <button class="primary" onClick={() => preview("person.import", { rows: csv.rows,
            ...(csv.name ? { file: { name: csv.name, lines: csv.rows.length + csv.problems.length, unread: csv.problems.length } } : {}) })}>{t("ui.preview")}</button>}
        </section>
      )}

      {mayDo("person.import") && <Tabs label={label("ui.people_title")} tabs={[["people", t("ui.customers_tab")], ["imports", t("ui.imports_tab")]]} on={tab} pick={(x) => setTab(x as "people" | "imports")} id="customers" />}
      {tab === "imports" && <ImportList list={imports} />}
      {tab === "people" && <div id="customers-panel-people" role={mayDo("person.import") ? "tabpanel" : undefined} aria-labelledby={mayDo("person.import") ? "customers-tab-people" : undefined}>
      <div class="list-bar">
        <label class="search-field"><span class="sr-only">{t("ui.search_people")}</span><input type="search" placeholder={t("ui.search_people")} value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        <label class="check"><input type="checkbox" checked={staffOnly} onChange={(e) => setStaffOnly(e.currentTarget.checked)} /> {t("ui.staff_only")}</label>
        {lists && lists.tags.length > 0 && <label class={`filter-chip${tag ? " on" : ""}`}><span>{t("ui.filter_tag")}</span><select value={tag} onChange={(e) => setTag(e.currentTarget.value)}><option value="">{t("ui.any_tag")}</option>
          {lists.tags.map((x) => <option value={x.id}>{x.name}</option>)}</select></label>}
        {lists && lists.segments.length > 0 && <label class={`filter-chip${segment ? " on" : ""}`}><span>{t("ui.filter_group")}</span><select value={segment} onChange={(e) => setSegment(e.currentTarget.value)}><option value="">{t("ui.any_group")}</option>
          {lists.segments.map((x) => <option value={x.id}>{x.name}</option>)}</select></label>}
        {list?.plans && list.plans.length > 0 && <label class={`filter-chip${membership ? " on" : ""}`}><span>{t("ui.membership")}</span><select value={membership} onChange={(e) => setMembership(e.currentTarget.value)}>
          <option value="">{t("ui.any_membership")}</option><option value="any">{t("ui.has_membership")}</option>
          {list.plans.map((x) => <option value={x.id}>{x.name}</option>)}<option value="none">{t("ui.not_a_member")}</option></select></label>}
      </div>
      {list === null ? <Skeleton shape="rows" rows={6} /> : list.rows.length === 0 ? <p class="card meta">{t("ui.no_people")}</p> : <>
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
      </div>}
      {sheet}
    </main>
  );
}

/** Past imports, newest first: the file, when, its lines, what was added, updated and skipped, who did it, and how it stands. */
function ImportList({ list }: { list: Import[] | null }) {
  const day = (iso: string) => clubTime(iso, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  const n = (x: number) => new Intl.NumberFormat(formatLocale(lang.value)).format(x);
  return <div id="customers-panel-imports" role="tabpanel" aria-labelledby="customers-tab-imports">
    <p class="meta">{t("ui.imports_help")}</p>
    {list === null ? <Skeleton shape="rows" rows={3} /> : list.length === 0 ? <p class="card meta">{t("ui.no_imports")}</p> :
      <div class="table-scroll table-box">
        <table class="data">
          <caption class="sr-only">{t("ui.imports_tab")}</caption>
          <thead><tr><th scope="col">{t("ui.import_file")}</th><th scope="col">{t("ui.import_when")}</th><th scope="col" class="num">{t("ui.import_lines")}</th><th scope="col" class="num">{t("ui.import_added")}</th>
            <th scope="col" class="num">{t("ui.import_updated")}</th><th scope="col" class="num">{t("ui.import_skipped")}</th><th scope="col">{t("ui.import_by")}</th><th scope="col">{t("ui.import_status")}</th></tr></thead>
          <tbody>{list.map((r) => <tr>
            <td class="wrap"><strong>{r.file ?? t("ui.import_no_name")}</strong></td><td>{day(r.at)}</td><td class="num">{n(r.lines)}</td><td class="num">{n(r.added)}</td>
            <td class="num">{n(r.updated)}</td><td class="num">{n(r.skipped)}</td><td>{r.by ?? <span class="meta">{t("ui.none_dash")}</span>}</td>
            <td><span class={`pill ${r.status === "applied" ? "pill-yes" : "pill-no"}`}>{t(`ui.import_status_${r.status}` as Key)}</span></td>
          </tr>)}</tbody>
        </table>
      </div>}
  </div>;
}
