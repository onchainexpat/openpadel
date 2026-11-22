// `openpadel settings rename`: a settings file's old KUMI_ names become OPENPADEL_ ones (settings.ts in core reads
// both, the new one first, so nothing needs this; it's for an owner who wants the file to say what the docs say).
// Every other line, comment and value stays as it was, byte for byte. A name set both ways keeps its OPENPADEL_ line,
// the one in use: the old line goes when its value is the same, and is kept as a comment, with a note, when it isn't,
// so nothing the owner wrote is lost. A dated copy of the file is kept beside it first, with the same mode and owner.
// Running it again changes nothing. Only names are ever reported, never a value.
import { chownSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

/** What renaming did, by name: renamed (old name to new), dropped (the new one already had the same value), and
 *  kept_old (the new one has a different value; the old line is kept as a comment). Names are the old ones. */
export interface Renamed { text: string; renamed: string[]; dropped: string[]; kept_old: string[] }

const OLD = /^(\s*(?:export\s+)?)KUMI_([A-Za-z0-9_]+)=(.*)$/;
const NEW = /^\s*(?:export\s+)?OPENPADEL_([A-Za-z0-9_]+)=(.*)$/;
const valueOf = (v: string) => v.trim();

/** The file's text with the old names renamed. Line endings (\n or \r\n) are kept as they were. */
export function renameSettings(text: string): Renamed {
  const lines = text.split("\n");
  const cr = (l: string) => l.endsWith("\r");
  const bare = (l: string) => (cr(l) ? l.slice(0, -1) : l);
  const now = new Map<string, string>();
  for (const l of lines) { const m = NEW.exec(bare(l)); if (m) now.set(m[1]!, valueOf(m[2]!)); }
  const out: string[] = [], r: Renamed = { text: "", renamed: [], dropped: [], kept_old: [] };
  for (const l of lines) {
    const m = OLD.exec(bare(l));
    if (!m) { out.push(l); continue; }
    const [, lead, name, value] = m as unknown as [string, string, string, string];
    const end = cr(l) ? "\r" : "";
    if (!now.has(name)) { out.push(`${lead}OPENPADEL_${name}=${value}${end}`); r.renamed.push(`KUMI_${name}`); continue; }
    if (now.get(name) === valueOf(value)) { r.dropped.push(`KUMI_${name}`); continue; }
    out.push(`# OPENPADEL_${name} is set too, and is the one used; the old line, as it was:${end}`, `# ${bare(l)}${end}`);
    r.kept_old.push(`KUMI_${name}`);
  }
  r.text = out.join("\n");
  return r;
}

/** A dated name beside the file for its copy: kumi.env.before-rename-20261122-153000. */
export const backupName = (file: string, now: Date) => `${file}.before-rename-${now.toISOString().slice(0, 19).replace(/-/g, "").replace("T", "-").replace(/:/g, "")}`;

/** Renames the file in place (its mode and owner stay), after a dated copy. Null when there's no such file. */
export function renameSettingsFile(file: string, now = new Date()): (Omit<Renamed, "text"> & { changed: boolean; backup: string | null }) | null {
  if (!existsSync(file)) return null;
  const before = readFileSync(file, "utf8"), r = renameSettings(before);
  const names = { renamed: r.renamed, dropped: r.dropped, kept_old: r.kept_old };
  if (r.text === before) return { changed: false, backup: null, ...names };
  const st = statSync(file);
  let backup = backupName(file, now);
  for (let i = 2; existsSync(backup); i++) backup = `${backupName(file, now)}-${i}`;
  copyFileSync(file, backup);
  try { chownSync(backup, st.uid, st.gid); } catch { /* not root: it's this user's already */ }
  // Written into the same file, so its mode (0640, root:kumi on a one-server install) and owner stay.
  writeFileSync(file, r.text);
  return { changed: true, backup, ...names };
}
