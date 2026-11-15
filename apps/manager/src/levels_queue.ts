// The Levels page's To review list, worked out from the server's queue (kept apart from the page so it's tested on its
// own): each one's flag (why it's here) and its tone, in the order the queue gives them, a level brought from another
// app first, then reviews players asked for, then levels that moved a lot.

export type QueueClaim = { platform: string; raw: number; conf: { reliability?: number; matches?: number; wpr?: string; percent?: number }; start_level: number | null };
export type QueueRequest = { id: string; person_id: string; name: string; note: string | null; created_at: string; level: string | null; provisional: boolean | null;
  rated_games: number | null; kind: string; claim: QueueClaim | null; sent_by?: string | null };
export type QueueMove = { person_id: string; name: string; level: number; from: number; since: string };

/** Why someone is in the queue, as the page's flag words it (ui.level_flag_*). */
export type Flag = "imported" | "asked" | "drop" | "rise";
export const FLAG_TONE: Record<Flag, "warn" | "brand" | "info"> = { imported: "warn", asked: "brand", drop: "warn", rise: "info" };

export type QueueItem =
  | { key: string; flag: Flag; kind: "claim" | "ask"; r: QueueRequest }
  | { key: string; flag: Flag; kind: "move"; m: QueueMove };

export function queueItems(q: { requests: QueueRequest[]; moves: QueueMove[] }): QueueItem[] {
  const claim = (r: QueueRequest) => r.kind === "import" && Boolean(r.claim);
  return [
    ...q.requests.filter(claim).map((r) => ({ key: r.id, flag: "imported" as const, kind: "claim" as const, r })),
    ...q.requests.filter((r) => !claim(r)).map((r) => ({ key: r.id, flag: "asked" as const, kind: "ask" as const, r })),
    ...q.moves.map((m) => ({ key: `move-${m.person_id}`, flag: m.level < m.from ? "drop" as const : "rise" as const, kind: "move" as const, m })),
  ];
}
