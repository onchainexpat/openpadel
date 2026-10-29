// The level model, as the backtest left it (levels_backtest.md): OpenSkill's Bradley-Terry update
// for two teams, in level units; the score margin as a stretched share; Playtomic levels as a
// confident start; a fast estimate behind a shown level that moves 30% of the way each game.
// Every constant is here, so a club (or the next backtest) can tune them in one place.

export const MODEL_VERSION = "openskill-bt-margin-1";
export const MODEL = {
  defaultLevel: 3.5,
  sigmaNew: 1.167,          // a stranger: OpenSkill's default uncertainty, in level units
  sigmaSeeded: 0.6,         // started from a Playtomic level: more confident
  beta: 0.204,              // performance spread: 0.35 x OpenSkill's default (backtest)
  tau: 0.0117,              // drift per game
  kappa: 0.0001,
  marginStretch: 3,         // 13-11 counts a little, 24-0 counts fully
  smoothing: 0.3,           // the shown level moves 30% of the way to the estimate each game
  provisionalSigma: 0.55,   // provisional while the model is this unsure
  oddsCap: 0.8,             // odds shown no stronger than 80/20
};

export interface Skill { mu: number; sigma: number }
export interface TeamResult { a: Skill[]; b: Skill[]; scoreA: number; scoreB: number }

/** Team A's share of the game, stretched so close games count less than blowouts. */
export function stretchedShare(scoreA: number, scoreB: number, k = MODEL.marginStretch): number {
  const total = scoreA + scoreB;
  if (total <= 0) return 0.5;
  return Math.min(1, Math.max(0, 0.5 + k * (scoreA / total - 0.5)));
}

/** The chance team A wins. */
export function winChance(a: Skill[], b: Skill[], beta = MODEL.beta): number {
  const muA = a.reduce((s, p) => s + p.mu, 0), muB = b.reduce((s, p) => s + p.mu, 0);
  const c = Math.sqrt(a.reduce((s, p) => s + p.sigma ** 2, 0) + b.reduce((s, p) => s + p.sigma ** 2, 0) + 2 * beta ** 2);
  return 1 / (1 + Math.exp((muB - muA) / c));
}

/** The odds a person is shown: never stronger than 80/20. */
export const shownOdds = (p: number) => Math.round(Math.min(MODEL.oddsCap, Math.max(1 - MODEL.oddsCap, p)) * 1000) / 1000;

/** OpenSkill's Bradley-Terry update for two teams, with the stretched share as the outcome. */
export function update(r: TeamResult, m = MODEL): { a: Skill[]; b: Skill[]; share: number; p: number } {
  const drift = (s: Skill): Skill => ({ mu: s.mu, sigma: Math.sqrt(s.sigma ** 2 + m.tau ** 2) });
  const A = r.a.map(drift), B = r.b.map(drift);
  const share = stretchedShare(r.scoreA, r.scoreB, m.marginStretch);
  const sum = (t: Skill[]) => ({ mu: t.reduce((s, p) => s + p.mu, 0), s2: t.reduce((s, p) => s + p.sigma ** 2, 0) });
  const ta = sum(A), tb = sum(B);
  const c = Math.sqrt(ta.s2 + tb.s2 + 2 * m.beta ** 2);
  const pA = 1 / (1 + Math.exp((tb.mu - ta.mu) / c));
  const side = (team: Skill[], t: { mu: number; s2: number }, outcome: number, p: number) => {
    const omega = (t.s2 / c) * (outcome - p);
    const delta = (Math.sqrt(t.s2) / c) * (t.s2 / c ** 2) * p * (1 - p);
    return team.map((s) => ({
      mu: s.mu + (s.sigma ** 2 / t.s2) * omega,
      sigma: s.sigma * Math.sqrt(Math.max(1 - (s.sigma ** 2 / t.s2) * delta, m.kappa)),
    }));
  };
  return { a: side(A, ta, share, pA), b: side(B, tb, 1 - share, 1 - pA), share, p: pA };
}

/** The shown level: provisional players see the estimate; others move part of the way; never below a floor. */
export function shownLevel(prevShown: number, estimate: number, sigma: number, floor: number | null, m = MODEL): number {
  const next = sigma > m.provisionalSigma ? estimate : prevShown + m.smoothing * (estimate - prevShown);
  return Math.round(Math.max(floor ?? -Infinity, next) * 100) / 100;
}
