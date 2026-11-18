// The club's books for a day (the door's `money_books` read: signed cents per line, debits positive, each day summing
// to zero) turned into one journal for the accounting system: each line to the account the settings name, in integer
// cents, checked to balance before it goes. Pure: no clock, no network.
import type { ProviderKind } from "./store.ts";

export interface BookLine { key: string; cents: number }
export interface BookDay { date: string; complete: boolean; lines: BookLine[]; fees?: string; payouts?: string }
export interface Books { currency: string; time_zone: string; today: string; days: BookDay[] }

export interface Settings {
  provider: ProviderKind; sendAt: string; startDate: string | null;
  accounts: Record<string, string>;
  problems: string[];
}
export const ACCOUNT_KEYS = ["courts", "lessons", "programs", "memberships", "other_income", "refunds", "tax", "card", "card_fees", "bank", "cash", "receivable", "credit", "gift_cards", "passes", "other"] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];

export function parseSettings(raw: Record<string, unknown>): Settings {
  const problems: string[] = [];
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string).trim() : "");
  const provider: ProviderKind = raw.provider === "quickbooks" ? "quickbooks" : "xero";
  let sendAt = str("send_at") || "06:00";
  const m = /^(\d{1,2}):(\d{2})$/.exec(sendAt);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) { problems.push("send_at"); sendAt = "06:00"; }
  else sendAt = `${m[1]!.padStart(2, "0")}:${m[2]}`;
  let startDate: string | null = str("start_date") || null;
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) { problems.push("start_date"); startDate = null; }
  const accounts: Record<string, string> = {};
  for (const k of ACCOUNT_KEYS) { const v = str(`account_${k}`); if (v) accounts[k] = v.slice(0, 40); }
  return { provider, sendAt, startDate, accounts, problems };
}

/** The account a book line goes to, before the fallback to "anything else". */
export function accountFor(key: string): AccountKey | null {
  const [head, tail] = key.split(".", 2) as [string, string | undefined];
  const income = (t: string | undefined): AccountKey => (t === "courts" || t === "lessons" || t === "programs" || t === "memberships" ? t : "other_income");
  switch (head) {
    case "takings": return income(tail);
    case "refunds": return "refunds";
    case "tax": return "tax";
    case "credit": return "credit";
    case "gift_cards": return "gift_cards";
    case "passes": return "passes";
    case "card": return tail === "fees" ? "card_fees" : "card";
    case "bank": return "bank";
    case "cash": return "cash";
    case "receivable": return "receivable";
    default: return null;
  }
}

/** What each line is, in words (the line's description at the provider, with its key in brackets). */
const LABELS: Record<string, string> = {
  "takings.courts": "Court takings", "takings.lessons": "Lesson takings", "takings.programs": "Program takings", "takings.memberships": "Membership takings",
  "takings.after_restore": "Card payments found after a restore", "takings.other": "Other takings",
  "refunds.courts": "Court refunds", "refunds.lessons": "Lesson refunds", "refunds.programs": "Program refunds", "refunds.memberships": "Membership refunds",
  "refunds.after_restore": "Refunds of payments found after a restore", "refunds.other": "Other refunds",
  tax: "Sales tax", "credit.added": "Club credit added", "credit.used": "Club credit used", "gift_cards.sold": "Gift cards sold", "gift_cards.used": "Gift cards used",
  "passes.sold": "Passes sold", "passes.used": "Passes used", "card.in": "Card payments", "card.out": "Card refunds", "card.fees": "Card fees", "card.fees_out": "Card fees taken",
  "card.payouts_out": "Payouts sent", "bank.payouts": "Payouts received", "cash.in": "Cash in", "cash.out": "Cash out", "receivable.up": "Owed by players", "receivable.down": "Paid by players",
  refunds_payable: "Refunds owed", adjustment: "Adjustments", brought_in: "Brought in from Playtomic",
};
export const labelOf = (key: string) => LABELS[key] ?? key.replace(/[._]/g, " ");
export const describe = (key: string) => `${labelOf(key)} [${key}]`;
/** The key a line's description carries, read back from the provider. */
export const keyOfDescription = (d: unknown) => (typeof d === "string" ? /\[([a-z_]+(?:\.[a-z_]+)?)\]\s*$/.exec(d)?.[1] ?? null : null);

export interface JournalLine { key: string; account: string; cents: number; description: string }
export interface Journal { day: string; date: string; ref: string; narration: string; idempotencyKey: string; lines: JournalLine[]; adjusts: string | null }

export class Unbalanced extends Error {}

/** The day's lines with their accounts. Lines whose account isn't set go to "anything else" and are counted. */
export function mapLines(lines: Record<string, number>, s: Settings): { lines: JournalLine[]; suspense: number; missing: string[] } {
  const out: JournalLine[] = [];
  let suspense = 0;
  const missing: string[] = [];
  for (const key of Object.keys(lines).sort()) {
    const cents = lines[key]!;
    if (!Number.isInteger(cents) || cents === 0) continue;
    const want = accountFor(key);
    let account = want === "refunds" ? s.accounts.refunds ?? s.accounts[accountFor(`takings.${key.split(".")[1]}`)!] : want ? s.accounts[want] : undefined;
    if (!account) { account = s.accounts.other; suspense++; }
    if (!account) { missing.push(key); continue; }
    out.push({ key, account, cents, description: describe(key) });
  }
  return { lines: out, suspense, missing };
}

/** The lines as a map of key to cents, adding up repeats. */
export function byKey(lines: BookLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) if (Number.isInteger(l.cents) && l.cents !== 0) out[l.key] = (out[l.key] ?? 0) + l.cents;
  return out;
}
export function addLines(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) { out[k] = (out[k] ?? 0) + v; if (out[k] === 0) delete out[k]; }
  return out;
}
/** What changed: now less what was sent, nonzero lines only. */
export function diffLines(now: Record<string, number>, sent: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(now), ...Object.keys(sent)])) { const d = (now[k] ?? 0) - (sent[k] ?? 0); if (d) out[k] = d; }
  return out;
}
export const sum = (lines: { cents: number }[]) => lines.reduce((n, l) => n + l.cents, 0);
export function checkBalanced(lines: { cents: number }[]): void {
  if (sum(lines) !== 0) throw new Unbalanced(`the journal is off by ${sum(lines)} cents`);
}

/** Cents as a decimal amount, built from the integer so no float creeps in: 12345 is 123.45. */
export function amount(cents: number): number {
  const abs = Math.abs(cents);
  return Number(`${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`);
}
export const toCents = (x: unknown) => Math.round(Number(x) * 100);

// ---- References: what makes a re-send find what was sent instead of sending it again ----
export const compact = (day: string) => day.replace(/-/g, "");
export function refs(provider: ProviderKind, day: string, clubHash: string, clubName: string) {
  const club = clubName.replace(/[\u0000-\u001f\u2013\u2014]/g, " ").trim().slice(0, 60);
  return {
    original: provider === "xero" ? `openPadel ${day}` : `OP-${compact(day)}`,
    adjustment: (n: number) => (provider === "xero" ? `openPadel adjustment to ${day} #${n}` : `OP-${compact(day)}-A${n}`),
    narration: (n: number) => (n === 0 ? `openPadel ${day}${club ? ` (${club})` : ""}` : `openPadel adjustment to ${day} #${n}${club ? ` (${club})` : ""}`),
    note: (n: number) => (n === 0 ? `openPadel: the club's books for ${day}` : `openPadel: adjustment ${n} to the club's books for ${day}`),
    key: (n: number) => `openpadel-${clubHash}-${day}${n ? `-a${n}` : ""}`,
  };
}

// ---- Dates at the club ----
const pad = (n: number) => String(n).padStart(2, "0");
/** The club's own date and time at an instant. */
export function localNow(ms: number, timeZone: string): { date: string; time: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000); }
/** The instant a club date and time is, in its time zone. */
export function atClub(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const l = localNow(guess, timeZone);
    const seen = Date.UTC(...(l.date.split("-").map(Number).map((v, j) => (j === 1 ? v - 1 : v)) as [number, number, number]), ...(l.time.split(":").map(Number) as [number, number]));
    guess += want - seen;
  }
  return guess;
}
export { pad };
