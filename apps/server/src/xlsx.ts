// Reading an Excel workbook (.xlsx) as rows of text, for the member import beside CSV. An .xlsx is a zip of XML
// files: fflate unzips it (MIT, no dependencies of its own), and the first sheet's cells are read here, with the
// workbook's shared strings. Only what a member list needs: text, numbers as Excel wrote them, and true/false.
// Formulas give the value Excel saved with them; nothing in the file is ever run. The file is read in memory and
// never kept.
import { unzipSync, strFromU8 } from "fflate";

/** The most a workbook may unpack to: a list of a few thousand members is well under a megabyte of XML. */
export const XLSX_MAX_UNPACKED = 30_000_000;
/** A member list's columns and cells, at most: a cell far to the right (XFD1) would otherwise make every row 16,384
 *  cells wide, and a small file could ask for gigabytes. Cells past the last column are left out; past the last cell (kept
 *  or not), the sheet is refused. */
export const XLSX_MAX_COLUMNS = 64, XLSX_MAX_CELLS = 200_000;

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** XML text with its entities read (&amp;, &#233;, &#x00E9;). */
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
  if (e[0] !== "#") return ENTITY[e.toLowerCase()]!;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;   // no such character: left as written
});
/** The text of a string item (<si> or an inline <is>): its <t> runs joined, leaving out phonetic hints (<rPh>). */
const textOf = (xml: string) => [...xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "").matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?t(?:\s[^>]*)?\/>/g)].map((m) => unescape(m[1] ?? "")).join("");
/** A number as Excel would show it: 15 significant digits, so 0.1 + 0.2 reads 0.3 and 612345678 stays whole. */
const number = (v: string | undefined) => { const n = Number(v); return v === undefined || v === "" ? "" : Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v; };
/** "C12" to its column, from 0. */
const column = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

/** The workbook's first sheet as rows of cell text, or null when the bytes aren't a workbook it can read. */
export function readXlsx(bytes: Uint8Array): string[][] | null {
  let files: Record<string, Uint8Array>;
  let unpacked = 0;
  try {
    // Only the parts read here are unpacked, and only while they stay small (a zip can claim to unpack to anything).
    files = unzipSync(bytes, { filter: (f) => {
      if (!/^xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml)$/.test(f.name)) return false;
      unpacked += f.originalSize;
      if (unpacked > XLSX_MAX_UNPACKED) throw new Error("too big");
      return true;
    } });
  } catch { return null; }
  const text = (name: string) => (files[name] ? strFromU8(files[name]!) : null);
  const book = text("xl/workbook.xml");
  if (!book) return null;
  // The first sheet in the workbook's order, found through its relationship (it needn't be sheet1.xml).
  const firstId = /<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/.exec(book)?.[1] ?? /<(?:\w+:)?sheet\b[^>]*\bid="([^"]+)"/.exec(book)?.[1];
  const rels = text("xl/_rels/workbook.xml.rels") ?? "";
  let target = firstId ? [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${firstId}"`))?.match(/Target="([^"]+)"/)?.[1] : undefined;
  if (target) target = target.replace(/^\/?(xl\/)?/, "xl/");
  const sheet = text(target && files[target] ? target : "xl/worksheets/sheet1.xml");
  if (sheet === null) return null;
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si(?:\s[^>]*)?\/>/g)].map((m) => textOf(m[1] ?? ""));
  const rows: string[][] = [];
  let cells = 0;
  for (const r of sheet.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    // Rows keep their place: a blank row in the sheet stays blank here, so a line number matches Excel's.
    const at = Number(/\br="(\d+)"/.exec(r[1]!)?.[1] ?? rows.length + 1) - 1;
    if (at < rows.length || at > XLSX_MAX_CELLS) continue;
    while (rows.length < at) rows.push([]);
    const row: string[] = [];
    for (const c of (r[2] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = c[1]!, body = c[2] ?? "", ref = /\br="([A-Z]+\d+)"/i.exec(attrs)?.[1], type = /\bt="(\w+)"/.exec(attrs)?.[1] ?? "n";
      const col = ref ? column(ref) : row.length;
      if (++cells > XLSX_MAX_CELLS) return null;   // every cell counts, kept or not: dropping them is still work
      if (col < 0 || col >= XLSX_MAX_COLUMNS) continue;
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      const value = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? textOf(/<(?:\w+:)?is>([\s\S]*?)<\/(?:\w+:)?is>/.exec(body)?.[1] ?? "")
        : type === "b" ? (v === "1" ? "TRUE" : "FALSE") : type === "e" ? "" : type === "n" ? number(v) : unescape(v ?? "");
      while (row.length < col) row.push("");
      row[col] = value;
    }
    rows.push(row);
  }
  return rows;
}

/** Whether the bytes start as a zip does (an .xlsx is one). */
export const looksLikeXlsx = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
