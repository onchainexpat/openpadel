// Reading a member list exported from a spreadsheet, Playtomic or another system: the columns are found by
// their names (in English or Spanish), and each row that can't be used is listed with its line number. Beside the
// name, email and language: a phone, a yes to club news, a Playtomic id and a Playtomic level with its reliability.
import { both, type Text } from "@kumi/i18n";

export interface PersonRow { display_name: string; email?: string; locale?: "en" | "es"; phone?: string; club_news?: true; playtomic_id?: string; level?: { value: number; reliability?: number } }
export interface Problem { line: number; text: Text }

/** One cell of a spreadsheet Kumi hands out: quoted when it needs to be, and text a spreadsheet would run as a
 *  formula (starting =, +, - or @, or a tab or return) kept as text. Plain numbers stay numbers, so a refund's
 *  minus stays a minus. Every CSV export goes through this: names and notes are typed by members and staff. */
export function csvCell(v: unknown): string {
  const s = String(v ?? "");
  const x = /^-?\d+(\.\d+)?$/.test(s) ? s : /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
}

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
  // From a Playtomic customer export, or any file with these columns (docs/setup/README.md, step 5b).
  phone: ["phone", "phonenumber", "mobile", "mobilephone", "cell", "telephone", "tel", "telefono", "movil", "celular"],
  news: ["clubnews", "news", "newsletter", "marketing", "marketingconsent", "acceptscommercialcommunications", "commercialcommunications", "consent", "noticias", "noticiasdelclub", "comunicacionescomerciales", "consentimiento"],
  playtomic_id: ["playtomicid", "playtomicuserid", "playtomicplayerid", "idplaytomic", "idenplaytomic"],
  playtomic_level: ["playtomiclevel", "nivelplaytomic", "nivelenplaytomic"],
  // A plain "level" is read as Playtomic's only beside a Playtomic id: a file from another system has its own scale.
  level: ["level", "nivel", "levelvalue"],
  reliability: ["reliability", "playtomicreliability", "levelreliability", "fiabilidad", "confiabilidad"],
};
/** A yes in a consent column; anything else (no, blank, a date) isn't one. */
const YES = new Set(["yes", "y", "true", "si", "x", "1", "accepted", "aceptado", "aceptada"]);
const number = (v: string) => { const n = Number(v.replace(",", ".").replace(/%$/, "")); return v.trim() && Number.isFinite(n) ? n : null; };
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
  const phone = col("phone"), news = col("news"), ptId = col("playtomic_id"), reliability = col("reliability");
  const ptLevel = col("playtomic_level") >= 0 ? col("playtomic_level") : ptId >= 0 ? col("level") : -1;
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
    if (get(ptId)) extra.playtomic_id = get(ptId).slice(0, 64);
    if (get(ptLevel)) {
      // Reliability as a percent ("80", "80%") or a fraction ("0.8").
      const v = number(get(ptLevel)), r = number(get(reliability)), pct = r !== null && r > 0 && r < 1 ? r * 100 : r;
      if (v === null || v < 0 || v > 7) problems.push({ line, text: both("csv.bad_level", { line, level: get(ptLevel) }) });
      else extra.level = { value: Math.round(v * 100) / 100, ...(pct !== null && pct >= 0 && pct <= 100 ? { reliability: Math.round(pct) } : {}) };
    }
    rows.push({ display_name: display.slice(0, 80), ...(mail ? { email: mail } : {}), ...(l ? { locale: l } : {}), ...extra });
  });
  return { rows, problems, ...(rows.length ? {} : { fatal: both("csv.empty") }) };
}

// ---- Moving in from Playtomic: wallets and memberships (brought_in.ts) ----
// The customer export's columns aren't published, so these are found by name, in English or Spanish, and listed in
// docs/setup/moving-from-playtomic.md. A wallet column is any whose name says wallet or balance ("Wallet", "Saldo
// monedero Club"): each is one wallet, named by its column. One membership a row: its name and the day it runs until.
const MOVE_IN = {
  wallet: /(wallet|monedero|saldo|balance|cartera|credit|credito)/,
  benefit: ["category", "categories", "benefit", "benefits", "membership", "memberships", "plan", "categoria", "categorias", "beneficio", "beneficios", "membresia", "abono", "tarifa"],
  until: ["expiry", "expires", "expiresat", "expirydate", "expirationdate", "validuntil", "until", "enddate", "paidthrough", "caducidad", "fechadecaducidad", "vence", "vencimiento", "validohasta", "hasta", "fechafin", "fin"],
  commitment: ["commitment", "commitmentuntil", "permanencia", "compromiso", "permanenciahasta"],
};
export interface MoveInRow { playtomic_id?: string; email?: string; name: string; wallets: { ref: string; name: string; balance: string }[]; benefits: { name: string; until: string | null; commitment?: string }[] }

/** A day in a spreadsheet: 2026-12-01, 2026-12-01T00:00, or 01/12/2026 (day first unless the club writes the US way). */
export function readDay(v: string, dayFirst: boolean): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) { const at = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`); return Number.isNaN(at.getTime()) || at.getUTCDate() !== Number(m[3]) ? null : `${m[1]}-${m[2]}-${m[3]}`; }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])], y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const [d, mo] = dayFirst ? [a, b] : [b, a];
  // A real day of that month (no 31 February).
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The players in a Playtomic customer export, with their wallets and their membership, and every line that couldn't
 *  be used. Nothing is changed here; credit.bring_in and membership.bring_in preview what they'd do. */
export function readMoveInCsv(text: string, o: { dayFirst: boolean }): { rows: MoveInRow[]; problems: Problem[]; fatal?: Text } {
  const all = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (all.length < 2) return { rows: [], problems: [], fatal: both(all.length ? "csv.empty" : "csv.no_header") };
  const raw = all[0]!, head = raw.map(norm);
  const col = (k: keyof typeof COLUMNS) => head.findIndex((h) => COLUMNS[k].includes(h));
  const find = (names: string[]) => head.findIndex((h) => names.includes(h));
  const name = col("name"), first = col("first"), last = col("last"), email = col("email"), ptId = col("playtomic_id");
  const benefit = find(MOVE_IN.benefit), until = find(MOVE_IN.until), commitment = find(MOVE_IN.commitment);
  // A "Total" column adds the wallets up: counting it too would bring the money in twice.
  const wallets = head.map((h, i) => ({ h, i })).filter(({ h, i }) => MOVE_IN.wallet.test(h) && !/total/.test(h) && ![name, first, last, email, ptId, benefit, until, commitment].includes(i));
  if (name < 0 && first < 0) return { rows: [], problems: [], fatal: both(head.some((h) => h) ? "csv.no_name_column" : "csv.no_header") };
  if (!wallets.length && benefit < 0) return { rows: [], problems: [], fatal: both("csv.no_move_in_columns") };
  const rows: MoveInRow[] = [], problems: Problem[] = [];
  all.slice(1).forEach((r, k) => {
    const line = k + 2, get = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
    const given = first >= 0 ? first : last >= 0 ? name : -1;
    const display = given >= 0 ? [get(given), get(last)].filter(Boolean).join(" ") : get(name);
    const mail = get(email).toLowerCase(), id = get(ptId);
    if (!display && !mail && !id) return;
    if (!mail && !id) return problems.push({ line, text: both("csv.move_in_no_one", { line }) });
    const row: MoveInRow = { name: (display || mail || id).slice(0, 120), ...(mail ? { email: mail.slice(0, 200) } : {}), ...(id ? { playtomic_id: id.slice(0, 64) } : {}), wallets: [], benefits: [] };
    for (const w of wallets) {
      const v = get(w.i);
      if (!v || /^0([.,]0+)?(\s*[A-Za-z€$£]{1,3})?$/.test(v)) continue;
      row.wallets.push({ ref: w.h.slice(0, 120), name: (raw[w.i] ?? "").trim().slice(0, 120) || w.h, balance: v.slice(0, 40) });
    }
    const b = get(benefit);
    if (b) {
      const day = get(until) ? readDay(get(until), o.dayFirst) : null;
      if (get(until) && !day) problems.push({ line, text: both("csv.bad_day", { line, day: get(until) }) });
      else row.benefits.push({ name: b.slice(0, 120), until: day, ...(get(commitment) ? { commitment: get(commitment).slice(0, 120) } : {}) });
    }
    if (row.wallets.length || row.benefits.length) rows.push(row);
  });
  return { rows, problems };
}
