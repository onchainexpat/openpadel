import { test } from "node:test";
import assert from "node:assert/strict";
import { comingUp, moneyFigures } from "../src/person_head.ts";
import { queueItems } from "../src/levels_queue.ts";
import { changedRows, isChange, stepLevel } from "../src/level_check.ts";

const NOW = Date.parse("2026-11-15T18:00:00Z");

test("a person's Coming up: bookings still to come and program dates, soonest first, never a cancelled or past one", () => {
  const b = (id: string, at: string, status = "confirmed") => ({ id, code: id.toUpperCase(), status, court: "Court 2", starts_at: at, organiser: id === "b1" });
  const rows = comingUp([b("b1", "2026-11-17T18:00:00Z"), b("b2", "2026-11-14T18:00:00Z"), b("b3", "2026-11-16T18:00:00Z", "cancelled")],
    [{ id: "s1", starts_at: "2026-11-16T02:00:00Z", program_id: "p1", name: "Volley drills", kind: "clinic" }], NOW);
  assert.deepEqual(rows.map((r) => [r.kind, r.id]), [["session", "s1"], ["booking", "b1"]]);
  assert.equal(comingUp(Array.from({ length: 9 }, (_, n) => b(`x${n}`, `2026-11-2${n}T10:00:00Z`)), [], NOW).length, 5);
});

test("the Money card: what's owed is the membership's now, not the next period's; what goes back adds up both kinds", () => {
  assert.deepEqual(moneyFigures({ credit_cents: 1200, membership: { due: { cents: 4500, next: false } }, to_give_back: [{ amount_cents: 1000 }], failed_refunds: [{ amount_cents: 2400 }] }),
    { credit: 1200, owed: 4500, back: 3400 });
  assert.deepEqual(moneyFigures({ credit_cents: null, membership: { due: { cents: 4500, next: true } }, to_give_back: [], failed_refunds: [] }), { credit: 0, owed: 0, back: 0 });
  assert.deepEqual(moneyFigures({ credit_cents: 0, membership: null, to_give_back: [], failed_refunds: [] }), { credit: 0, owed: 0, back: 0 });
});

test("the Levels queue's flags: a level from another app, a review asked for, and a big move up or down", () => {
  const r = (id: string, kind: string, claim = false) => ({ id, person_id: id, name: id, note: null, created_at: "2026-11-01T10:00:00Z", level: "3.00", provisional: false, rated_games: 3, kind,
    claim: claim ? { platform: "playtomic", raw: 4.1, conf: {}, start_level: 3.6 } : null });
  const items = queueItems({ requests: [r("ask", "request"), r("imp", "import", true)],
    moves: [{ person_id: "down", name: "Wen", level: 2.7, from: 3.3, since: "2026-11-01T10:00:00Z" }, { person_id: "up", name: "Tom", level: 3.4, from: 2.8, since: "2026-11-01T10:00:00Z" }] });
  assert.deepEqual(items.map((x) => [x.key, x.flag]), [["imp", "imported"], ["ask", "asked"], ["move-down", "drop"], ["move-up", "rise"]]);
});

test("levels brought from other apps lead the queue: those waiting for staff first, then a player's word staff could confirm", () => {
  const c = (id: string, status: "waiting" | "standing") => ({ id, person_id: id, name: id, platform: "wpr", shown: "9", start_level: 4.4, status, profile_url: null, proof: "none" as const,
    created_at: "2026-11-01T10:00:00Z", sent_by: null, level: null, provisional: null, rated_games: 0 });
  const items = queueItems({ requests: [{ id: "ask", person_id: "ask", name: "ask", note: null, created_at: "2026-11-01T10:00:00Z", level: "3.00", provisional: false, rated_games: 3, kind: "request", claim: null }],
    moves: [], claims: [c("word", "standing"), c("wait", "waiting")] });
  assert.deepEqual(items.map((x) => [x.key, x.flag, x.kind]), [["wait", "imported", "app"], ["word", "word", "app"], ["ask", "asked", "ask"]]);
});

test("a coach's level check: −/+ steps of 0.1 that keep to the floor and to 7, and only real changes are saved", () => {
  assert.equal(stepLevel("3.40", "3.40", 0.1, null), "3.50");
  assert.equal(stepLevel("", "3.40", -0.1, null), "3.30");          // nothing typed: from where they were
  assert.equal(stepLevel("3.05", "3.40", -0.1, "3.00"), "3.00");    // never below the floor
  assert.equal(stepLevel("6.95", "6.95", 0.1, null), "7.00");
  assert.equal(stepLevel("0.05", null, -0.1, null), "0.00");
  assert.equal(stepLevel("", null, 0.1, null), "");                 // no level and nothing typed: nothing to step from
  assert.equal(isChange("3.40", "3.4"), false);
  assert.equal(isChange("3.5", "3.40"), true);
  assert.equal(isChange("", "3.40"), false);
  assert.equal(isChange("8", null), false);
  assert.equal(isChange("2.5", null), true);
  assert.deepEqual(changedRows([{ person_id: "a", level: "3.40" }, { person_id: "b", level: "2.80" }, { person_id: "c", level: null }], { a: "3.40", b: "3.30", c: "" }),
    [{ person_id: "b", level: 3.3 }]);
});
