// What the plugin keeps between restarts, one file per club, readable by this user alone (0600, in a 0700 directory),
// written whole and renamed into place so a crash never leaves half a file. Without a directory it can write (a local
// plugin's sandbox), it keeps them in memory and checks the whole list against Klaviyo on start.
//
// No member's email, name or language is kept: only each member's id at the club, the id Klaviyo gave their profile,
// and a fingerprint (a SHA-256) of what was sent, to tell when it changed. The club is the truth about who said yes,
// and Klaviyo about who's on the list; this is a note of what was done in between.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One member on the list: their Klaviyo profile's id, and the fingerprint of what was sent for them. */
export interface Synced { p: string; h: string }
/** Someone to take off the list (they said no, or their account was deleted), until Klaviyo has taken them off. */
export interface Removal { person: string; deleted: boolean; at: number }

export interface ClubRecord {
  club: { name: string; url: string; time_zone: string; language: string };
  door: { mcp: string; token: string };
  webhookSecret: string;
  hookSecret: string;
  settings: Record<string, unknown>;
  /** The latest event ids handled, oldest first. */
  seen: string[];
  /** Who it put on the list, by their id at the club. */
  synced: Record<string, Synced>;
  /** The list they're on (a new list in the settings starts again). */
  listId: string | null;
  removals: Removal[];
  /** When it last checked the whole Klaviyo list against the club's (ms). */
  lastFullAt: number | null;
}

export function blankRecord(base: Pick<ClubRecord, "club" | "door" | "webhookSecret" | "hookSecret" | "settings">): ClubRecord {
  return { ...base, seen: [], synced: {}, listId: null, removals: [], lastFullAt: null };
}

export interface Store { load(): ClubRecord[]; save(r: ClubRecord): void; readonly durable: boolean }

const fileOf = (dir: string, url: string) => join(dir, `club-${createHash("sha256").update(url).digest("hex").slice(0, 24)}.json`);

export function fileStore(dir: string): Store {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return {
    durable: true,
    load() {
      const out: ClubRecord[] = [];
      for (const f of readdirSync(dir)) {
        if (!/^club-[0-9a-f]{24}\.json$/.test(f)) continue;
        try { out.push({ ...blankRecord({} as any), ...JSON.parse(readFileSync(join(dir, f), "utf8")) } as ClubRecord); } catch { /* a file it can't read is left alone */ }
      }
      return out;
    },
    save(r) {
      const file = fileOf(dir, r.club.url), tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    },
  };
}

export function memoryStore(): Store {
  const kept = new Map<string, string>();
  return { durable: false, load: () => [...kept.values()].map((v) => JSON.parse(v) as ClubRecord), save: (r) => { kept.set(r.club.url, JSON.stringify(r)); } };
}

/** A directory it can write, or memory. */
export function openStore(dir: string | null): Store {
  if (!dir) return memoryStore();
  try { const s = fileStore(dir); writeFileSync(join(dir, ".probe"), "", { mode: 0o600 }); return s; } catch { return memoryStore(); }
}
