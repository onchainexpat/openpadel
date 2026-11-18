// What the plugin keeps between restarts, one file per club, readable by this user alone (0600, in a 0700 directory),
// written whole and renamed into place so a crash never leaves half a file. Without a directory it can write, it keeps
// them in memory. Never the club's keys from its vault (Meta's token and secrets): those are read through the door
// and held in memory only.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A message the club handed over, waiting to go (or to be tried again). */
export interface Outgoing {
  message_id: string; to: string; language: "en" | "es"; template: { name: string; parameters: string[] }; text: string;
  essential: boolean; send_before: string | null; attempts: number; next_at: number; received_at: number;
}
/** A report for the club that the door didn't take yet: tried again on each tick. */
export interface Report { tool: "plugin_message_status" | "plugin_channel_stop" | "plugin_channel_reply"; args: Record<string, unknown>; attempts: number; next_at: number;
  /** For a reply: the member's number, to answer once the club says what to answer. */ answer_to?: string }

export interface ClubRecord {
  club: { name: string; url: string; time_zone: string; language: string };
  door: { mcp: string; token: string };
  webhookSecret: string;
  hookSecret: string;
  settings: Record<string, unknown>;
  /** The latest event ids handled (the club's and Meta's), oldest first. */
  seen: string[];
  /** Messages waiting to go, in the order they came. */
  queue: Outgoing[];
  /** Reports and replies for the club, in order. */
  reports: Report[];
  /** Meta's id for each message sent (wamid), to the club's message id: so delivery and read reports find it. */
  sent: Record<string, { message_id: string; at: number }>;
  /** When each member's number last wrote to the club: WhatsApp's 24-hour window, when a plain message may go. */
  lastIn: Record<string, number>;
  /** When each number was last answered automatically (once a day for one the club doesn't know). */
  answered: Record<string, number>;
  /** Numbers that said STOP: nothing goes to them from here, whatever is on its way, until the club hands a message
   *  again after the member turned WhatsApp back on in the app (a message handed over later than the STOP). */
  stopped: Record<string, number>;
  /** The last day's counts, for the card and health. */
  counts: { day: string; sent: number; delivered: number; failed: number; replies: number };
  lastEventAt: number | null;
  lastSentAt: number | null;
}

export function blankRecord(base: Pick<ClubRecord, "club" | "door" | "webhookSecret" | "hookSecret" | "settings">): ClubRecord {
  return { ...base, seen: [], queue: [], reports: [], sent: {}, lastIn: {}, answered: {}, stopped: {}, counts: { day: "", sent: 0, delivered: 0, failed: 0, replies: 0 }, lastEventAt: null, lastSentAt: null };
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
