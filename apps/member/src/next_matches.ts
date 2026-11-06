// A pair's matches still to finish, as the Competitions page lists them: ones whose time has come and that have no
// score yet ("Played, score to come", where the score is entered or confirmed) apart from ones still ahead ("Next
// matches"). Phone check 5 saw a match played an hour before listed as next.
export function splitNext<F extends { starts_at: string | null }>(next: F[], now: number): { toScore: F[]; ahead: F[] } {
  const started = (f: F) => Boolean(f.starts_at) && new Date(f.starts_at!).getTime() <= now;
  return { toScore: next.filter(started), ahead: next.filter((f) => !started(f)) };
}
