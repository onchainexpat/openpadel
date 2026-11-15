// What each "Why it moved" row on My level did to the level: up or down by how much (+0.04, −0.02), or "floor" for
// a floor the club set. From the level before and after each change (rating_event). No Preact here: the tests read it.

export type Move = { kind: "floor" } | { kind: "up" | "down"; text: string };

/** The change one history row made, or null when there's nothing to show (a first level, or no change). */
export function moveOf(e: { kind: string; level_before: string | null; level_after: string }): Move | null {
  if (e.kind === "floor") return { kind: "floor" };
  if (e.level_before === null || e.level_before === undefined) return null;
  const d = Math.round((Number(e.level_after) - Number(e.level_before)) * 100) / 100;
  if (!Number.isFinite(d) || d === 0) return null;
  // A real minus sign, as the numbers on the board read.
  return d > 0 ? { kind: "up", text: `+${d.toFixed(2)}` } : { kind: "down", text: `−${Math.abs(d).toFixed(2)}` };
}
