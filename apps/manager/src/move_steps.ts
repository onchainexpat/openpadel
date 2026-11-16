// The guided move-in's stepper (MoveSteps.tsx), apart from the page so it can be tested without a browser.
export type Step = "connect" | "review" | "practice" | "switch" | "wrap_up";
export const MOVE_STEPS: Step[] = ["connect", "review", "practice", "switch", "wrap_up"];

/** Each step as the stepper shows it: done (a tick) before the club's step, or every one once the move is finished;
 *  the club's own step now; the rest later, numbered. */
export function stepMarks(step: Step, finished: boolean): { step: Step; state: "done" | "now" | "later"; mark: string }[] {
  const at = MOVE_STEPS.indexOf(step);
  return MOVE_STEPS.map((s, i) => {
    const state = finished || i < at ? "done" : i === at ? "now" : "later";
    return { step: s, state, mark: state === "done" ? "✓" : String(i + 1) };
  });
}

/** From the step being looked at: the one before, the one after, and whether going on is a change to the club's step
 *  (previewed) or only a look at a step it has already reached. */
export function around(shown: Step, step: Step): { back: Step | null; next: Step | null; nextMoves: boolean } {
  const i = MOVE_STEPS.indexOf(shown), next = MOVE_STEPS[i + 1] ?? null;
  return { back: MOVE_STEPS[i - 1] ?? null, next, nextMoves: next !== null && MOVE_STEPS.indexOf(next) > MOVE_STEPS.indexOf(step) };
}
