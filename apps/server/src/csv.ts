// Reading a member list exported from a spreadsheet, Playtomic or another system: the columns are found by
// their names (in English or Spanish), and each row that can't be used is listed with its line number.
import { both, type Text } from "@kumi/i18n";

export interface PersonRow { display_name: string; email?: string; locale?: "en" | "es" }
export interface Problem { line: number; text: Text }

/** CSV as spreadsheets write it: quotes around fields that need them, "" for a quote, commas or semicolons. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (h: string) => h.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const COLUMNS = {
  name: ["name", "fullname", "displayname", "nombre", "nombrecompleto", "player", "jugador", "member", "miembro"],
  first: ["firstname", "first", "givenname", "nombrepila"],
  last: ["lastname", "last", "surname", "familyname", "apellido", "apellidos"],
  email: ["email", "emailaddress", "mail", "correo", "correoelectronico"],
  language: ["language", "locale", "lang", "idioma"],
};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function language(v: string): "en" | "es" | undefined {
  const x = norm(v);
  return ["en", "english", "ingles"].includes(x) ? "en" : ["es", "spanish", "espanol", "castellano"].includes(x) ? "es" : undefined;
}

/** The people in the file, and every line that couldn't be used (with why). Nothing is changed here. */
export function readPeopleCsv(text: string): { rows: PersonRow[]; problems: Problem[]; fatal?: Text } {
  const all = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (all.length < 2) return { rows: [], problems: [], fatal: both(all.length ? "csv.empty" : "csv.no_header") };
  const head = all[0]!.map(norm);
  const col = (k: keyof typeof COLUMNS) => head.findIndex((h) => COLUMNS[k].includes(h));
  const name = col("name"), first = col("first"), last = col("last"), email = col("email"), lang = col("language");
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
    rows.push({ display_name: display.slice(0, 80), ...(mail ? { email: mail } : {}), ...(l ? { locale: l } : {}) });
  });
  return { rows, problems, ...(rows.length ? {} : { fatal: both("csv.empty") }) };
}
