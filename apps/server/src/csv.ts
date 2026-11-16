// Reading a member list exported from a spreadsheet, Playtomic or another system: the columns are found by
// their names (in English or Spanish), and each row that can't be used is listed with its line number. Beside the
// name, email and language: a phone, a yes to club news, a Playtomic id and a Playtomic level with its reliability.
import { both, type Text } from "@kumi/i18n";
import { CSV_COLUMNS as COLUMNS, normHeader as norm, parseCsv } from "@kumi/core";
// The parser and the Playtomic export's reader live in core (csv_read.ts), where the move-in reads an upload itself.
export { parseCsv, readDay, readMoveInCsv, type MoveInRow } from "@kumi/core";

export interface PersonRow { display_name: string; email?: string; locale?: "en" | "es"; phone?: string; club_news?: true; playtomic_id?: string; level?: { value: number; reliability?: number; platform?: "playbypoint" } }
/** Which system's export it is, when staff say so: Playbypoint's columns are read by a preset (CSV_COLUMNS). */
export type ImportFrom = "playbypoint";
export interface Problem { line: number; text: Text }

/** One cell of a spreadsheet Kumi hands out: quoted when it needs to be, and text a spreadsheet would run as a
 *  formula (starting =, +, - or @, or a tab or return) kept as text. Plain numbers stay numbers, so a refund's
 *  minus stays a minus. Every CSV export goes through this: names and notes are typed by members and staff. */
export function csvCell(v: unknown): string {
  const s = String(v ?? "");
  const x = /^-?\d+(\.\d+)?$/.test(s) ? s : /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
}

/** A yes in a consent column; anything else (no, blank, a date) isn't one. */
const YES = new Set(["yes", "y", "true", "si", "x", "1", "accepted", "aceptado", "aceptada"]);
const number = (v: string) => { const n = Number(v.replace(",", ".").replace(/%$/, "")); return v.trim() && Number.isFinite(n) ? n : null; };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function language(v: string): "en" | "es" | undefined {
  const x = norm(v);
  return ["en", "english", "ingles"].includes(x) ? "en" : ["es", "spanish", "espanol", "castellano"].includes(x) ? "es" : undefined;
}

/** The people in the file, and every line that couldn't be used (with why). Nothing is changed here. */
export function readPeopleCsv(text: string, from?: ImportFrom): { rows: PersonRow[]; problems: Problem[]; fatal?: Text } {
  return readPeopleRows(parseCsv(text), from);
}
/** The same from a spreadsheet's rows of cells (an Excel workbook's first sheet, xlsx.ts). */
export function readPeopleRows(cells: string[][], from?: ImportFrom): { rows: PersonRow[]; problems: Problem[]; fatal?: Text } {
  const all = cells.filter((r) => r.some((c) => c.trim()));
  if (all.length < 2) return { rows: [], problems: [], fatal: both(all.length ? "csv.empty" : "csv.no_header") };
  const head = all[0]!.map(norm);
  const col = (k: keyof typeof COLUMNS) => head.findIndex((h) => COLUMNS[k].includes(h));
  const name = col("name"), first = col("first"), last = col("last"), email = col("email"), lang = col("language");
  const phone = col("phone"), news = col("news"), ptId = col("playtomic_id"), reliability = col("reliability");
  // A Playbypoint list: its level (NPRP, 1 to 7) under any of its likely names, and no Playtomic columns at all.
  const pbp = from === "playbypoint";
  const ptLevel = pbp ? col("playbypoint_level") : col("playtomic_level") >= 0 ? col("playtomic_level") : ptId >= 0 ? col("level") : -1;
  if (name < 0 && first < 0) return { rows: [], problems: [], fatal: both(head.some((h) => h) ? "csv.no_name_column" : "csv.no_header") };
  const rows: PersonRow[] = [], problems: Problem[] = [], firstLine = new Map<string, number>();
  all.slice(1).forEach((r, i) => {
    const line = i + 2, get = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
    // "Name" beside "Last name" (or "Nombre" beside "Apellido") is the first name.
    const given = first >= 0 ? first : last >= 0 ? name : -1;
    const display = given >= 0 ? [get(given), get(last)].filter(Boolean).join(" ") : get(name);
    const mail = get(email).toLowerCase();
    if (!display) return problems.push({ line, text: both("csv.no_name", { line }) });
    if (mail && !EMAIL.test(mail)) return problems.push({ line, text: both("csv.bad_email", { line, email: mail }) });
    if (mail && firstLine.has(mail)) return problems.push({ line, text: both("csv.duplicate", { line, email: mail, first: firstLine.get(mail)! }) });
    if (mail) firstLine.set(mail, line);
    const l = lang >= 0 ? language(get(lang)) : undefined;
    const extra: Partial<PersonRow> = {};
    if (get(phone)) extra.phone = get(phone).slice(0, 40);
    if (YES.has(norm(get(news)))) extra.club_news = true;
    if (get(ptId) && !pbp) extra.playtomic_id = get(ptId).slice(0, 64);
    if (get(ptLevel) && pbp) {
      const v = number(get(ptLevel));
      if (v === null || v < 1 || v > 7) problems.push({ line, text: both("csv.bad_level", { line, level: get(ptLevel) }) });
      else extra.level = { value: Math.round(v * 100) / 100, platform: "playbypoint" };
    } else if (get(ptLevel)) {
      // Reliability as a percent ("80", "80%") or a fraction ("0.8").
      const v = number(get(ptLevel)), r = number(get(reliability)), pct = r !== null && r > 0 && r < 1 ? r * 100 : r;
      if (v === null || v < 0 || v > 7) problems.push({ line, text: both("csv.bad_level", { line, level: get(ptLevel) }) });
      else extra.level = { value: Math.round(v * 100) / 100, ...(pct !== null && pct >= 0 && pct <= 100 ? { reliability: Math.round(pct) } : {}) };
    }
    rows.push({ display_name: display.slice(0, 80), ...(mail ? { email: mail } : {}), ...(l ? { locale: l } : {}), ...extra });
  });
  return { rows, problems, ...(rows.length ? {} : { fatal: both("csv.empty") }) };
}

