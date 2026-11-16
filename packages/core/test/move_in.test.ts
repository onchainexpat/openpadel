// The guided move-in's own state (move_in.ts): where the club comes from, its step, the switch-over time, the items
// staff tick and finishing. Each is a previewed change with an undo; a manager asks to finish; nothing else moves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { apply, moveState, plan, run, runAsSystem, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, manager: Actor;
before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const m = ((await run(db, "person.create", { display_name: "Max", email: "max@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: m, role: "manager" }, owner);
  manager = { personId: m, via: "test", lang: "en" };
});
after(async () => drop());
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: any) => e.code === code);

test("a step needs a source; each change says what it does, in both languages, and undoes", async () => {
  await rejects(plan(db, "move.step", { step: "review" }, owner), "error.move_no_source");
  const src = await plan(db, "move.source", { source: "playbypoint" }, owner);
  assert.match(src.plan.summary.en, /moves in from Playbypoint/);
  assert.match(src.plan.summary.es, /se muda desde Playbypoint/);
  await apply(db, src.runId, owner);
  await rejects(plan(db, "move.source", { source: "playbypoint" }, owner), "error.nothing_changed");
  const step = await run(db, "move.step", { step: "review" }, owner);
  assert.equal((await moveState(db)).step, "review");
  const undo = await run(db, "action.undo", { run_id: step.runId }, owner);
  assert.ok(undo.runId);
  assert.equal((await moveState(db)).step, "connect");
  await run(db, "move.step", { step: "review" }, owner);
});

test("ticking an item names it with the old system, and going on says what's still open", async () => {
  const p = await plan(db, "move.check", { item: "close_bookings", done: true }, owner);
  assert.match(p.plan.summary.en, /Marked done: Close new bookings in Playbypoint\./);
  await apply(db, p.runId, owner);
  const s = await moveState(db);
  const c = s.checks.find((x) => x.key === "close_bookings")!;
  assert.equal(c.done, true);
  assert.equal(c.by, "Robin Hale");
  // Three switch-over items left open: going to the wrap up says so, and goes.
  const go = await plan(db, "move.step", { step: "wrap_up" }, owner);
  assert.match(go.plan.summary.en, /step 5 of 5: Wrap up\. 3 items from earlier steps aren't marked done yet\./, go.plan.summary.en);
  await apply(db, go.runId, owner);
  const off = await run(db, "move.check", { item: "close_bookings", done: false }, owner);
  assert.ok(off.runId);
  assert.equal((await moveState(db)).checks.find((x) => x.key === "close_bookings")!.done, false);
  await run(db, "action.undo", { run_id: off.runId }, owner);
  assert.equal((await moveState(db)).checks.find((x) => x.key === "close_bookings")!.done, true);
});

test("the switch-over time is the club's clock; a manager asks to finish, and going back opens it again", async () => {
  const p = await plan(db, "move.switch_at", { at: "2030-11-17T14:00:00Z" }, owner);
  assert.match(p.plan.summary.en, /Switch-over planned for Sun, Nov 17, 6:00/, p.plan.summary.en);
  await apply(db, p.runId, owner);
  const ask = await plan(db, "move.finish", {}, manager);
  assert.equal(ask.status, "awaiting_approval");
  const fin = await plan(db, "move.finish", {}, owner);
  assert.match(fin.plan.summary.en, /5 wrap-up items aren't marked done\./, fin.plan.summary.en);
  await apply(db, fin.runId, owner);
  assert.ok((await moveState(db)).finished_at);
  await rejects(plan(db, "move.finish", {}, owner), "error.already_done");
  const back = await plan(db, "move.step", { step: "wrap_up" }, owner);
  assert.match(back.plan.summary.en, /opens it again/);
  await apply(db, back.runId, owner);
  assert.equal((await moveState(db)).finished_at, null);
});
