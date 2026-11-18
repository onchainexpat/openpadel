// What the plugin keeps between restarts, one file per club, readable by this user alone (0600, in a 0700 directory),
// written whole and renamed into place so a crash never leaves half a file. Without a directory it can write, it keeps
// them in memory. Nothing here is the truth about what was sent: the accounting system is (club.ts looks each day up
// there before it sends), so a lost file never sends a day twice; it only costs a few more lookups.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ProviderKind = "xero" | "quickbooks";
/** What was sent for one club day: each book line's cents (original and adjustments added up), and how many
 *  adjustments. An empty `lines` with `empty` is a day with nothing to send. */
export interface SentDay { lines: Record<string, number>; adjustments: number; empty?: boolean }
export interface Books { sent: Record<string, SentDay>; lastSentDay: string | null; lastRunDate: string | null }

export interface ClubRecord {
  club: { name: string; url: string; time_zone: string; language: string };
  door: { mcp: string; token: string };
  webhookSecret: string;
  hookSecret: string;
  settings: Record<string, unknown>;
  /** The latest event ids handled, oldest first. */
  seen: string[];
  /** A connect waiting for the browser to come back: its state and PKCE verifier (single use, 24 hours). */
  connect: { provider: ProviderKind; state: string; verifier: string; createdAt: number } | null;
  /** What it's connected to (not secret): the organisation's name, Xero's tenant, QuickBooks' company. */
  link: { provider: ProviderKind; org: string | null; tenant: string | null; realm: string | null } | null;
  /** The provider wants the owner to connect again (a refresh token refused). */
  reconnect: boolean;
  /** Keys from the provider not yet kept in the club's vault (the door didn't answer): kept again on each tick. */
  held: { name: string; value: string }[];
  /** Per accounting system, what was sent. */
  books: Partial<Record<ProviderKind, Books>>;
  /** A journal on its way (written before the POST): on a restart, the provider is asked before anything is sent. */
  sending: { provider: ProviderKind; day: string; ref: string; at: number } | null;
}

export function blankRecord(base: Pick<ClubRecord, "club" | "door" | "webhookSecret" | "hookSecret" | "settings">): ClubRecord {
  return { ...base, seen: [], connect: null, link: null, reconnect: false, held: [], books: {}, sending: null };
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
