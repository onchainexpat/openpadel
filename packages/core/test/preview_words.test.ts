// Phone run 14's two previews: a level set for someone with no level yet doesn't move "from 3.50 to 3.50" (the default
// start isn't theirs), and an answer quoted in its preview ends inside its quotes, with no second full stop.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { plan, run, runAsSystem, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, ann: string;
before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  ann = ((await run(db, "person.create", { display_name: "Ann Lee", email: "ann@example.test" }, owner)).result as { person_id: string }).person_id;
});
after(async () => drop());

test("a level for someone with none yet starts them there; one they have changes from it", async () => {
  const first = (await plan(db, "level.set", { person_id: ann, level: 3.5, reason: "Played with her tonight" }, owner)).plan.summary;
  assert.deepEqual(first, { en: "Start Ann Lee at 3.50 (no level yet): Played with her tonight.", es: "Empezar a Ann Lee en 3.50 (sin nivel todavía): Played with her tonight." });
  await run(db, "level.set", { person_id: ann, level: 3.5, reason: "Played with her tonight." }, owner);
  const next = (await plan(db, "level.set", { person_id: ann, level: 3.75, reason: "A second look." }, owner)).plan.summary.en;
  assert.equal(next, "Change Ann Lee's level from 3.50 to 3.75: A second look.");
});

test("an answer's preview ends its quote once", async () => {
  const q = ((await run(db, "question.ask", { person_id: ann, body: "Is there parking at the club?" }, { personId: ann, via: "test", lang: "en" })).result as { question_id: string }).question_id;
  const p = (await plan(db, "question.answer", { question_id: q, body: "Yes, there is free parking behind the club." }, owner)).plan.summary;
  assert.equal(p.en, "Answer Ann Lee: \"Yes, there is free parking behind the club.\" They hear straight away.");
  assert.equal(p.es, "Responder a Ann Lee: \"Yes, there is free parking behind the club.\" Se le avisa al momento.");
});
