// Tournaments and leagues, the pure part: seeding, groups, knockout brackets, round robins, match scores,
// standings and a schedule on the program's own courts. No database here, so every rule is tested on its own.

export type MatchFormat = "one_set" | "pro_set" | "best_of_three";
export const MATCH_FORMATS: MatchFormat[] = ["one_set", "pro_set", "best_of_three"];
/** How long a match takes on court, to suggest a schedule (staff can place any match themselves). */
export const MATCH_MINUTES: Record<MatchFormat, number> = { one_set: 45, pro_set: 60, best_of_three: 90 };

export interface SetScore { a: number; b: number }
/** A set to 6 (6-0 to 6-4, 7-5, or 7-6 after a tiebreak at 6-6). */
const normalSet = (w: number, l: number) => (w === 6 && l <= 4) || (w === 7 && (l === 5 || l === 6));
/** Whether the sets are a finished match in the format, and who won it. */
export function matchWinner(format: MatchFormat, sets: SetScore[]): "a" | "b" | null {
  const won = (s: SetScore) => (s.a > s.b ? "a" : s.b > s.a ? "b" : null);
  const ok = (s: SetScore, check: (w: number, l: number) => boolean) => s.a !== s.b && check(Math.max(s.a, s.b), Math.min(s.a, s.b));
  if (format === "one_set") return sets.length === 1 && ok(sets[0]!, normalSet) ? won(sets[0]!) : null;
  if (format === "pro_set") return sets.length === 1 && ok(sets[0]!, (w, l) => w === 9 && l <= 8) ? won(sets[0]!) : null;
  // Best of three, with a match tiebreak (first to 10, by 2) instead of a third set.
  if (sets.length < 2 || sets.length > 3 || !ok(sets[0]!, normalSet) || !ok(sets[1]!, normalSet)) return null;
  const first = won(sets[0]!), second = won(sets[1]!);
  if (sets.length === 2) return first === second ? first : null;
  if (first === second) return null;
  return ok(sets[2]!, (w, l) => (w === 10 && l <= 8) || (w > 10 && w - l === 2)) ? won(sets[2]!) : null;
}

export interface Seeded { id: string; level: number; group?: number }
/** Positions in a bracket of `size` (a power of two), as seed numbers: 1 v size, then the halves kept apart. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) { const n = order.length * 2; order = order.flatMap((s) => [s, n + 1 - s]); }
  return order;
}
export const nextPow2 = (n: number) => { let p = 1; while (p < n) p *= 2; return p; };

/** A side of a match before it's played: a pair, a bye, or whoever comes from a group place or an earlier match. */
export type Side = { entry: string } | { bye: true } | { from: string };
export interface Spec { key: string; stage: "group" | "knockout" | "league"; group?: number; round: number; slot: number; a: Side; b: Side; next?: { key: string; side: "a" | "b" } }

/** A knockout of these sides, best seed first; byes go to the top seeds. The first round's sides are given;
 *  later rounds take the winners. */
export function knockout(sides: Side[], keyOf = (round: number, slot: number) => `k${round}.${slot}`): Spec[] {
  const size = nextPow2(Math.max(2, sides.length)), order = seedOrder(size), rounds = Math.log2(size);
  const at = (seed: number): Side => sides[seed - 1] ?? { bye: true };
  const specs: Spec[] = [];
  for (let r = 1; r <= rounds; r++) {
    const n = size / 2 ** r;
    for (let k = 0; k < n; k++) {
      const a: Side = r === 1 ? at(order[2 * k]!) : { from: `w:${keyOf(r - 1, 2 * k)}` }, b: Side = r === 1 ? at(order[2 * k + 1]!) : { from: `w:${keyOf(r - 1, 2 * k + 1)}` };
      specs.push({ key: keyOf(r, k), stage: "knockout", round: r, slot: k, a, b, ...(r < rounds ? { next: { key: keyOf(r + 1, Math.floor(k / 2)), side: k % 2 === 0 ? "a" : "b" } as const } : {}) });
    }
  }
  return specs;
}

/** Groups of 3 or 4 (as close to `size` as the numbers allow, never fewer than 3), seeds spread like a snake:
 *  1 to the first group, 2 to the second, ... then back. */
export function groups(entries: Seeded[], size: 3 | 4): Seeded[][] {
  let g = Math.max(1, Math.ceil(entries.length / size));
  while (g > 1 && entries.length / g < 3) g--;
  const out: Seeded[][] = Array.from({ length: g }, () => []);
  entries.forEach((e, i) => { const lap = Math.floor(i / g), pos = i % g; out[lap % 2 === 0 ? pos : g - 1 - pos]!.push(e); });
  return out;
}

/** Everyone plays everyone: rounds by the circle method (a pair sits out a round when there's an odd number),
 *  once or twice (the second time sides swapped). */
export function roundRobin(ids: string[], legs: 1 | 2 = 1): { round: number; a: string; b: string }[] {
  const list: (string | null)[] = [...ids];
  if (list.length % 2) list.push(null);
  const n = list.length, out: { round: number; a: string; b: string }[] = [];
  let arr = [...list];
  for (let r = 0; r < n - 1; r++) {
    for (let k = 0; k < n / 2; k++) {
      const x = arr[k], y = arr[n - 1 - k];
      if (x && y) out.push({ round: r + 1, ...(r % 2 === 0 ? { a: x, b: y } : { a: y, b: x }) });
    }
    arr = [arr[0]!, arr[n - 1]!, ...arr.slice(1, n - 1)];
  }
  if (legs === 2) { const first = out.length, rounds = n - 1; for (const m of out.slice(0, first)) out.push({ round: m.round + rounds, a: m.b, b: m.a }); }
  return out;
}

/** A knockout fed by groups: the top two of each, winners seeded first. A runner-up never meets their own group's
 *  winner in the first round when it can be helped. */
export function knockoutFromGroups(nGroups: number): Spec[] {
  const winners: Side[] = Array.from({ length: nGroups }, (_, g) => ({ from: `g${g + 1}:1` }));
  const runners: Side[] = Array.from({ length: nGroups }, (_, g) => ({ from: `g${g + 1}:2` }));
  const specs = knockout([...winners, ...runners]);
  const groupOf = (s: Side) => ("from" in s && s.from.startsWith("g") ? Number(s.from.slice(1).split(":")[0]) : 0);
  const first = specs.filter((s) => s.round === 1);
  for (const m of first) {
    if (!groupOf(m.a) || groupOf(m.a) !== groupOf(m.b)) continue;
    // Swap this runner-up with another first-round runner-up where neither match then pairs a group with itself.
    for (const o of first) {
      if (o === m || !("from" in o.b) || !o.b.from.endsWith(":2")) continue;
      if (groupOf(o.b) !== groupOf(m.a) && groupOf(m.b) !== groupOf(o.a)) { const t = m.b; m.b = o.b; o.b = t; break; }
    }
  }
  return specs;
}

export interface Result { a: string; b: string; winner: string | null; walkover?: string | null; sets: SetScore[] }
export interface Row { entry: string; played: number; won: number; lost: number; points: number; setsFor: number; setsAgainst: number; gamesFor: number; gamesAgainst: number }
/** A table: groups rank by wins, a league by points (2 a win, 1 a loss played, 0 a walkover given); ties by sets
 *  difference, then games difference, then the matches between those still tied, then the seed (the order given). */
export function table(entries: string[], results: Result[], kind: "group" | "league"): Row[] {
  const rows = new Map(entries.map((e) => [e, { entry: e, played: 0, won: 0, lost: 0, points: 0, setsFor: 0, setsAgainst: 0, gamesFor: 0, gamesAgainst: 0 }]));
  for (const r of results) {
    if (!r.winner) continue;
    const loser = r.winner === r.a ? r.b : r.a, w = rows.get(r.winner), l = rows.get(loser);
    if (!w || !l) continue;
    w.played++; l.played++; w.won++; l.lost++;
    w.points += 2; if (!r.walkover) l.points += 1;
    for (const s of r.sets) {
      const [x, y] = r.a === r.winner ? [s.a, s.b] : [s.b, s.a];
      w.gamesFor += x; w.gamesAgainst += y; l.gamesFor += y; l.gamesAgainst += x;
      if (x > y) { w.setsFor++; l.setsAgainst++; } else if (y > x) { l.setsFor++; w.setsAgainst++; }
    }
  }
  const seed = new Map(entries.map((e, i) => [e, i]));
  const primary = (x: Row) => (kind === "league" ? x.points : x.won);
  const base = (x: Row, y: Row) => primary(y) - primary(x) || (y.setsFor - y.setsAgainst) - (x.setsFor - x.setsAgainst) || (y.gamesFor - y.gamesAgainst) - (x.gamesFor - x.gamesAgainst);
  const sorted = [...rows.values()].sort((x, y) => base(x, y) || seed.get(x.entry)! - seed.get(y.entry)!);
  // Head to head among those level on everything above: wins in the matches between them.
  const out: Row[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && base(sorted[i]!, sorted[j]!) === 0) j++;
    const tied = sorted.slice(i, j);
    if (tied.length > 1) {
      const ids = new Set(tied.map((t) => t.entry)), h2h = new Map(tied.map((t) => [t.entry, 0]));
      for (const r of results) if (r.winner && ids.has(r.a) && ids.has(r.b)) h2h.set(r.winner, h2h.get(r.winner)! + 1);
      tied.sort((x, y) => h2h.get(y.entry)! - h2h.get(x.entry)! || seed.get(x.entry)! - seed.get(y.entry)!);
    }
    out.push(...tied); i = j;
  }
  return out;
}

export interface Slot { court: string; start: number; end: number; session: number }
export interface Need { id: string; entries: string[]; deps: string[]; minSession?: number }
export interface Placed { id: string; court: string; start: number; end: number; entries: string[] }
/** Times for matches on the program's own courts and dates: each in the earliest free slot after the matches it
 *  depends on, a pair never on two courts at once, and never two matches in one slot. Those that don't fit are
 *  left out (more dates or courts needed). */
export function suggestTimes(needs: Need[], slots: Slot[], placed: Placed[]): { placed: Placed[]; unplaced: string[] } {
  const used = new Set(placed.map((p) => `${p.court}@${p.start}`));
  const all: Placed[] = [...placed], out: Placed[] = [], unplaced: string[] = [];
  const endOf = new Map(placed.map((p) => [p.id, p.end]));
  const free = [...slots].sort((x, y) => x.start - y.start || x.court.localeCompare(y.court));
  for (const n of needs) {
    if (n.deps.some((d) => !endOf.has(d))) { unplaced.push(n.id); continue; }
    const after = Math.max(0, ...n.deps.map((d) => endOf.get(d)!));
    const slot = free.find((s) => s.start >= after && (n.minSession === undefined || s.session >= n.minSession) && !used.has(`${s.court}@${s.start}`)
      && !all.some((p) => p.start < s.end && s.start < p.end && p.entries.some((e) => n.entries.includes(e))));
    if (!slot) { unplaced.push(n.id); continue; }
    const p = { id: n.id, court: slot.court, start: slot.start, end: slot.end, entries: n.entries };
    used.add(`${slot.court}@${slot.start}`); all.push(p); out.push(p); endOf.set(n.id, slot.end);
  }
  return { placed: out, unplaced };
}
