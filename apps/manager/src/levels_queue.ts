// The Levels page's To review list, worked out from the server's queue (kept apart from the page so it's tested on its
// own): each one's flag (why it's here) and its tone, in the order the queue gives them, a level brought from another
// app first (waiting for staff, then those counting as the player's word that staff could still confirm), then reviews
// players asked for, then levels that moved a lot.

export type QueueClaim = { platform: string; raw: number; conf: { reliability?: number; matches?: number; wpr?: string; percent?: number }; start_level: number | null };
export type QueueRequest = { id: string; person_id: string; name: string; note: string | null; created_at: string; level: string | null; provisional: boolean | null;
  rated_games: number | null; kind: string; claim: QueueClaim | null; sent_by?: string | null };
export type QueueMove = { person_id: string; name: string; level: number; from: number; since: string };
/** A level a player brought from another app (level_claims.ts), as the server's queue gives it. */
export type QueueAppClaim = { id: string; person_id: string; name: string; platform: string; shown: string; start_level: number | null; status: "waiting" | "standing";
  profile_url: string | null; proof: "none" | "kept" | "deleted"; created_at: string; sent_by: string | null; level: string | null; provisional: boolean | null; rated_games: number | null };

/** Why someone is in the queue, as the page's flag words it (ui.level_flag_*). */
export type Flag = "imported" | "word" | "asked" | "drop" | "rise";
export const FLAG_TONE: Record<Flag, "warn" | "brand" | "info"> = { imported: "warn", word: "info", asked: "brand", drop: "warn", rise: "info" };

export type QueueItem =
  | { key: string; flag: Flag; kind: "app"; c: QueueAppClaim }
  | { key: string; flag: Flag; kind: "claim" | "ask"; r: QueueRequest }
  | { key: string; flag: Flag; kind: "move"; m: QueueMove };

export function queueItems(q: { requests: QueueRequest[]; moves: QueueMove[]; claims?: QueueAppClaim[] }): QueueItem[] {
  const claim = (r: QueueRequest) => r.kind === "import" && Boolean(r.claim), apps = q.claims ?? [];
  return [
    ...apps.filter((c) => c.status === "waiting").map((c) => ({ key: c.id, flag: "imported" as const, kind: "app" as const, c })),
    ...q.requests.filter(claim).map((r) => ({ key: r.id, flag: "imported" as const, kind: "claim" as const, r })),
    ...apps.filter((c) => c.status === "standing").map((c) => ({ key: c.id, flag: "word" as const, kind: "app" as const, c })),
    ...q.requests.filter((r) => !claim(r)).map((r) => ({ key: r.id, flag: "asked" as const, kind: "ask" as const, r })),
    ...q.moves.map((m) => ({ key: `move-${m.person_id}`, flag: m.level < m.from ? "drop" as const : "rise" as const, kind: "move" as const, m })),
  ];
}
