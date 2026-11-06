// Mexicano and King of the Court: the nights that make each round from the one before. Pure code with a
// seeded random source, like americano.ts, so the same inputs always give the same round.
import { levelPredict, rng, type Pairing, type Player, type Predict, type Round } from "./americano.ts";

/** Mexicano's points per game: the four the club picks from. */
export const MEXICANO_POINTS = [16, 21, 24, 32] as const;
/** King of the Court's rounds, in minutes, unless staff choose another length. */
export const KOTC_MINUTES = 12;

/** Who sits out a round: those who've sat out least, then (to keep it fair over the night) the lowest in the
 *  standings, then by the seeded draw. Everyone else plays. */
function bench(players: Player[], nCourts: number, sitouts: Map<string, number>, rank: Map<string, number>, rand: () => number): { active: Player[]; out: string[] } {
  const benched = players.length - nCourts * 4;
  if (benched <= 0) return { active: players, out: [] };
  const order = [...players].map((p) => ({ p, r: rand() })).sort((x, y) =>
    (sitouts.get(x.p.id) ?? 0) - (sitouts.get(y.p.id) ?? 0) || (rank.get(x.p.id) ?? 0) - (rank.get(y.p.id) ?? 0) || x.r - y.r).map((x) => x.p);
  const out = new Set(order.slice(0, benched).map((p) => p.id));
  return { active: players.filter((p) => !out.has(p.id)), out: [...out] };
}

/** Four players in order (1st to 4th) on a court: 1st and 4th against 2nd and 3rd. */
const oneFour = (court: string, four: Player[], predict: Predict): Pairing => {
  const [w, x, y, z] = four as [Player, Player, Player, Player];
  return { court, a: [w.id, z.id], b: [x.id, y.id], predictedA: predict([w, z], [x, y]) };
};

/** A Mexicano round. Round 1 goes by level (a random order when nobody has one); later rounds by the night's
 *  standings so far (points, ties by level). Top court first: the four best on it, 1st and 4th against 2nd and 3rd. */
export function mexicanoRound(players: Player[], courts: string[], points: Map<string, number> | null, sitouts: Map<string, number>, seed: string, predict: Predict = levelPredict, partners?: Set<string>): Round {
  const rand = rng(seed), nCourts = Math.min(courts.length, Math.floor(players.length / 4));
  const levels = new Set(players.map((p) => p.level));
  const score = (p: Player) => (points ? points.get(p.id) ?? 0 : levels.size > 1 ? p.level : 0);
  const rank = new Map(players.map((p) => [p.id, score(p)]));
  const { active, out } = bench(players, nCourts, sitouts, rank, rand);
  const order = active.map((p) => ({ p, r: rand() })).sort((x, y) => score(y.p) - score(x.p) || y.p.level - x.p.level || x.r - y.r).map((x) => x.p);
  const games: Pairing[] = [];
  for (let c = 0; c < nCourts; c++) {
    const four = order.slice(c * 4, c * 4 + 4) as [Player, Player, Player, Player];
    // King of the Court seeded again (a changed roster, a round re-paired): the same four courts by standings, but
    // split so nobody keeps last round's partner.
    games.push(partners ? splitPairs(courts[c]!, [four[0], four[1]], [four[2], four[3]], predict, partners) : oneFour(courts[c]!, four, predict));
  }
  return { games, sittingOut: out };
}

/** The fairest way to split four players into two teams where nobody keeps last round's partner (of the three
 *  splits of four, at least one always does that when the last round had them in two pairs at most). */
function splitPairs(court: string, x: [Player, Player], y: [Player, Player], predict: Predict, partners: Set<string> = new Set()): Pairing {
  const [p, q] = x, [r, s] = y;
  const options: [[Player, Player], [Player, Player]][] = [[[p, r], [q, s]], [[p, s], [q, r]], [[p, q], [r, s]]];
  const kept = (t: [Player, Player]) => partners.has([t[0].id, t[1].id].sort().join("|"));
  const ok = options.filter(([a, b]) => !kept(a) && !kept(b));
  const best = (ok.length ? ok : options).map(([a, b]) => ({ a, b, p: predict(a, b) })).sort((m, n) => Math.abs(m.p - 0.5) - Math.abs(n.p - 0.5))[0]!;
  return { court, a: [best.a[0].id, best.a[1].id], b: [best.b[0].id, best.b[1].id], predictedA: best.p };
}

/** King of the Court's first round: by level, the best four on the top court, split fairly. */
export function kotcFirstRound(players: Player[], courts: string[], seed: string, predict: Predict = levelPredict): Round {
  return mexicanoRound(players, courts, null, new Map(), seed, predict);
}

export interface PlayedGame { court: string; a: [string, string]; b: [string, string]; scoreA: number; scoreB: number }
/** King of the Court's next round, from the one just played. On each court the winners move up a court and the
 *  losers down; the top court's winners stay on it, the bottom court's losers stay on theirs (or sit out, when
 *  there are more players than places, and those who sat out come in there). On every court the two pairs that
 *  meet are split, so nobody keeps their partner. `courts` is top court first. */
export function kotcNextRound(byId: Map<string, Player>, courts: string[], last: PlayedGame[], waiting: string[], sitouts: Map<string, number>, seed: string, predict: Predict = levelPredict): Round {
  const rand = rng(seed), pos = new Map(courts.map((c, i) => [c, i]));
  const played = [...last].sort((g, h) => pos.get(g.court)! - pos.get(h.court)!);
  const n = played.length;
  const arrive: string[][][] = Array.from({ length: n }, () => []);
  played.forEach((g, i) => {
    const won = g.scoreA > g.scoreB ? g.a : g.b, lost = g.scoreA > g.scoreB ? g.b : g.a;
    arrive[Math.max(0, i - 1)]!.push(won);
    arrive[Math.min(n - 1, i + 1)]!.push(lost);
  });
  // The bottom court takes those who sat out; whoever sits out next comes from there (fewest sit-outs first).
  const bottom = arrive[n - 1]!.flat().concat(waiting);
  const g = played[n - 1]!, bottomLost = new Set(g.scoreA > g.scoreB ? g.b : g.a);
  let out: string[] = [];
  if (bottom.length > 4) {
    // Fewest sit-outs first; among equals, the pair that just lost on the bottom court waits before those coming down.
    const order = bottom.map((id) => ({ id, r: rand() })).sort((x, y) => (sitouts.get(x.id) ?? 0) - (sitouts.get(y.id) ?? 0) || Number(bottomLost.has(y.id)) - Number(bottomLost.has(x.id)) || x.r - y.r);
    // Those who sat out play now; the rest of the order decides who waits.
    const mustPlay = new Set(waiting.slice(0, 4));
    const candidates = order.filter((o) => !mustPlay.has(o.id));
    out = candidates.slice(0, bottom.length - 4).map((o) => o.id);
    const stay = bottom.filter((id) => !out.includes(id));
    arrive[n - 1] = [[stay[0]!, stay[1]!], [stay[2]!, stay[3]!]];
  } else if (waiting.length) {
    arrive[n - 1] = [[bottom[0]!, bottom[1]!], [bottom[2]!, bottom[3]!]];
  }
  const p = (id: string) => byId.get(id)!;
  const partners = new Set(last.flatMap((g) => [[...g.a].sort().join("|"), [...g.b].sort().join("|")]));
  const games = arrive.map((pairs, i) => splitPairs(courts[i]!, [p(pairs[0]![0]!), p(pairs[0]![1]!)], [p(pairs[1]![0]!), p(pairs[1]![1]!)], predict, partners));
  return { games, sittingOut: out };
}
