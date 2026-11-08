// Reading spreadsheets: CSV as spreadsheets write it, the column names a member list uses (apps/server/src/csv.ts reads
// one), and a Playtomic customer export for the move-in (brought_in.ts reads an upload itself, so it lives here).
import { both, type Text } from "@kumi/i18n";

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

export const normHeader = (h: string) => h.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
export const CSV_COLUMNS = {
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

// ---- Moving in from Playtomic: wallets and memberships (brought_in.ts) ----
// The customer export's columns aren't published, so these are found by name, in English or Spanish, and listed in
// docs/setup/playtomic-wallets-and-memberships.md. A wallet column is one whose name says wallet or balance ("Wallet",
// "Saldo monedero Club"), but not one that adds them up or counts what's used, owed or pending; staff see the columns
// read in the preview and can leave any out. One membership a row: its name and the day it runs until.
const MOVE_IN = {
  wallet: /(wallet|monedero|saldo|balance|cartera|credit|credito)/,
  notWallet: /(total|pending|pendiente|used|usado|usados|spent|gastado|consumido|debt|deuda|owed|due|adeudado|count|numero|number|history|historial|movement|movimiento|limit|limite|expir|caduc|vence|date|fecha)/,
  // Playtomic's English export says "Benefit name" and "Expiry date"; its Spanish one "Beneficio" and "Caducidad".
  benefit: ["category", "categories", "categoryname", "benefit", "benefits", "benefitname", "membership", "memberships", "membershipname", "plan", "planname",
    "categoria", "categorias", "beneficio", "beneficios", "nombredelbeneficio", "nombrebeneficio", "membresia", "nombredelamembresia", "abono", "tarifa"],
  until: ["expiry", "expires", "expiresat", "expirydate", "expirationdate", "benefitexpirydate", "benefitexpiry", "benefitexpires", "benefitenddate", "validuntil", "validto", "until",
    "enddate", "paidthrough", "caducidad", "fechadecaducidad", "fechacaducidad", "vence", "vencimiento", "fechadevencimiento", "validohasta", "hasta", "fechafin", "fin"],
  commitment: ["commitment", "commitmentuntil", "permanencia", "compromiso", "permanenciahasta"],
};
/** A row of the export: who, each wallet column's cell (a blank one is 0: the wallet is there, empty), their
 *  membership. `line` is its line in the file, for staff. */
export interface MoveInRow { line?: number; playtomic_id?: string; email?: string; name: string; wallets: { ref: string; name: string; balance: string }[]; benefits: { name: string; until: string | null; commitment?: string }[] }

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

/** The players in a Playtomic customer export, each wallet column's cell and their membership, and every line that
 *  couldn't be used. Nothing is changed here; playtomic.upload keeps what it read for the move-in's previews. */
export function readMoveInCsv(text: string, o: { dayFirst: boolean }): { rows: MoveInRow[]; problems: Problem[]; walletColumns: { ref: string; name: string }[]; fatal?: Text } {
  const all = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (all.length < 2) return { rows: [], problems: [], walletColumns: [], fatal: both(all.length ? "csv.empty" : "csv.no_header") };
  const raw = all[0]!, head = raw.map(normHeader);
  const col = (k: keyof typeof CSV_COLUMNS) => head.findIndex((h) => CSV_COLUMNS[k].includes(h));
  const find = (names: string[]) => head.findIndex((h) => names.includes(h));
  const name = col("name"), first = col("first"), last = col("last"), email = col("email"), ptId = col("playtomic_id");
  const benefit = find(MOVE_IN.benefit), until = find(MOVE_IN.until), commitment = find(MOVE_IN.commitment);
  const wallets = head.map((h, i) => ({ h, i })).filter(({ h, i }) => MOVE_IN.wallet.test(h) && !MOVE_IN.notWallet.test(h) && ![name, first, last, email, ptId, benefit, until, commitment].includes(i));
  if (name < 0 && first < 0) return { rows: [], problems: [], walletColumns: [], fatal: both(head.some((h) => h) ? "csv.no_name_column" : "csv.no_header") };
  if (!wallets.length && benefit < 0) return { rows: [], problems: [], walletColumns: [], fatal: both("csv.no_move_in_columns") };
  const walletColumns = wallets.map((w) => ({ ref: w.h.slice(0, 120), name: (raw[w.i] ?? "").trim().slice(0, 120) || w.h }));
  const rows: MoveInRow[] = [], problems: Problem[] = [];
  all.slice(1).forEach((r, k) => {
    const line = k + 2, get = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
    const given = first >= 0 ? first : last >= 0 ? name : -1;
    const display = given >= 0 ? [get(given), get(last)].filter(Boolean).join(" ") : get(name);
    const mail = get(email).toLowerCase(), id = get(ptId);
    if (!display && !mail && !id) return;
    if (!mail && !id) return problems.push({ line, text: both("csv.move_in_no_one", { line }) });
    // Every wallet column counts for this person: a blank or 0 cell is an empty wallet, not a missing one.
    const row: MoveInRow = { line, name: (display || mail || id).slice(0, 120), ...(mail ? { email: mail.slice(0, 200) } : {}), ...(id ? { playtomic_id: id.slice(0, 64) } : {}),
      wallets: wallets.map((w, j) => ({ ref: walletColumns[j]!.ref, name: walletColumns[j]!.name, balance: get(w.i).slice(0, 40) || "0" })), benefits: [] };
    const b = get(benefit);
    if (b) {
      const day = get(until) ? readDay(get(until), o.dayFirst) : null;
      if (get(until) && !day) problems.push({ line, text: both("csv.bad_day", { line, day: get(until) }) });
      else row.benefits.push({ name: b.slice(0, 120), until: day, ...(get(commitment) ? { commitment: get(commitment).slice(0, 120) } : {}) });
    }
    rows.push(row);
  });
  return { rows, problems, walletColumns };
}
