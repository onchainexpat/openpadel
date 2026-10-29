// Americano rounds: rotating partners, fair teams on every court, sit-outs shared evenly.
// Pure code with a seeded random source, so the same inputs always give the same rounds.
import { MODEL, winChance } from "./levels.ts";

export interface Player { id: string; level: number; mu?: number; sigma?: number }
export interface Pairing { court: string; a: [string, string]; b: [string, string]; predictedA: number }
export interface Round { games: Pairing[]; sittingOut: string[] }
export interface History { partners: Map<string, number>; opponents: Map<string, number>; sitouts: Map<string, number> }

/** The chance team A wins. The default reads the rating model (levels.ts); levels stand in for unrated players. */
export type Predict = (a: Player[], b: Player[]) => number;
export const levelPredict: Predict = (a, b) => winChance(a.map(skillOf), b.map(skillOf));
const skillOf = (p: Player) => ({ mu: p.mu ?? p.level, sigma: p.sigma ?? MODEL.sigmaNew });

const key = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

export function emptyHistory(): History { return { partners: new Map(), opponents: new Map(), sitouts: new Map() }; }

export function recordRound(h: History, r: Round): void {
  for (const g of r.games) {
    bump(h.partners, key(g.a[0], g.a[1])); bump(h.partners, key(g.b[0], g.b[1]));
    for (const x of g.a) for (const y of g.b) bump(h.opponents, key(x, y));
  }
  for (const s of r.sittingOut) bump(h.sitouts, s);
}

/** A small, fast, seeded random source (mulberry32), seeded from a string. */
export function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => { h |= 0; h = (h + 0x6d2b79f5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const COST = { repeatPartner: 100, repeatOpponent: 3, unfair: 20 };

/** The fairest of the three ways to split four players into two teams, given what's been played. */
export function bestSplit(four: Player[], h: History, predict: Predict): { a: [Player, Player]; b: [Player, Player]; p: number; cost: number } {
  const [w, x, y, z] = four as [Player, Player, Player, Player];
  const options: [[Player, Player], [Player, Player]][] = [[[w, x], [y, z]], [[w, y], [x, z]], [[w, z], [x, y]]];
  let best = null as null | { a: [Player, Player]; b: [Player, Player]; p: number; cost: number };
  for (const [a, b] of options) {
    const p = predict(a, b);
    let cost = COST.unfair * Math.abs(p - 0.5) * 2;
    cost += COST.repeatPartner * ((h.partners.get(key(a[0].id, a[1].id)) ?? 0) + (h.partners.get(key(b[0].id, b[1].id)) ?? 0));
    for (const m of a) for (const n of b) cost += COST.repeatOpponent * (h.opponents.get(key(m.id, n.id)) ?? 0);
    if (!best || cost < best.cost) best = { a, b, p, cost };
  }
  return best!;
}

/** One round: who sits out (fewest sit-outs so far first), then the best of many groupings. */
export function nextRound(players: Player[], courts: string[], h: History, rand: () => number, predict: Predict = levelPredict, tries = 400): Round {
  const nCourts = Math.min(courts.length, Math.floor(players.length / 4));
  const shuffled = [...players].sort(() => rand() - 0.5);
  const bySitouts = shuffled.sort((p, q) => (h.sitouts.get(p.id) ?? 0) - (h.sitouts.get(q.id) ?? 0));
  const benched = players.length - nCourts * 4;   // those who've sat out least sit out next
  const sittingOut = bySitouts.slice(0, benched).map((p) => p.id);
  const active = bySitouts.slice(benched);
  let best: { cost: number; games: Pairing[] } | null = null;
  for (let t = 0; t < tries; t++) {
    const order = [...active].sort(() => rand() - 0.5);
    let cost = 0; const games: Pairing[] = [];
    for (let c = 0; c < nCourts; c++) {
      const s = bestSplit(order.slice(c * 4, c * 4 + 4), h, predict);
      cost += s.cost;
      games.push({ court: courts[c]!, a: [s.a[0].id, s.a[1].id], b: [s.b[0].id, s.b[1].id], predictedA: s.p });
    }
    if (!best || cost < best.cost) best = { cost, games };
  }
  return { games: best?.games ?? [], sittingOut };
}

/** All rounds from a starting history (the rounds already played, when re-pairing). */
export function schedule(players: Player[], courts: string[], rounds: number, seed: string, start: History = emptyHistory(), predict: Predict = levelPredict): Round[] {
  const rand = rng(seed), h: History = { partners: new Map(start.partners), opponents: new Map(start.opponents), sitouts: new Map(start.sitouts) };
  const out: Round[] = [];
  for (let r = 0; r < rounds; r++) { const round = nextRound(players, courts, h, rand, predict); recordRound(h, round); out.push(round); }
  return out;
}
