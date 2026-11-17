// What the plugin keeps between restarts: each club's registration (its token and secrets), settings, what it last told
// Home Assistant, and the event ids it has handled. One file per club, readable by this user alone (0600, in a 0700
// directory), written whole and renamed into place so a crash never leaves half a file. Without a directory it can
// write (a local plugin's sandbox), it keeps them in memory: the club's door and Home Assistant are read again on start.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Commanded { state: "on" | "off"; at: string; entities: string[] }
export interface ClubRecord {
  club: { name: string; url: string; time_zone: string; language: string };
  door: { mcp: string; token: string };
  webhookSecret: string;
  hookSecret: string;
  settings: Record<string, unknown>;
  /** What it last told Home Assistant for each court, by court id. */
  commanded: Record<string, Commanded>;
  /** The latest event ids handled, oldest first. */
  seen: string[];
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
        try { out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as ClubRecord); } catch { /* a file it can't read is left alone */ }
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
