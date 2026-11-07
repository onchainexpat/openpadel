// The 0.3.0 security review's two LOWs about typed text: a gift card's who-for and message kept control and bidi
// characters (they reach the receipt, its email and the club's download), and names saved before 0.3.0 made names
// plain as they're saved were never cleaned (one reached the operator's terminal on a restore).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { plainStoredText, run, runAsSystem, setPaymentProvider, uuidv7, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
const hidden = /[\p{Cc}\p{Cf}]/u;
before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(new TestProvider());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en" };
});
after(async () => drop());

test("a gift card's who-for and message are made plain as they're typed", async () => {
  await run(db, "club.update", { gift_cards: true }, { ...owner, auth: "passkey" } as Actor);
  const ann = ((await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner)).result as { person_id: string }).person_id;
  const r = (await run(db, "gift_card.buy", { person_id: ann, cents: 5000, for_name: "‮maS​", message: "Happy\u0007 birthday\n\n\n\nfrom Ann⁦" }, { personId: ann, via: "test", lang: "en" })).result as { gift_card_id: string };
  const g = await db.selectFrom("gift_card").select(["for_name", "message"]).where("id", "=", r.gift_card_id).executeTakeFirstOrThrow();
  assert.deepEqual(g, { for_name: "maS", message: "Happy birthday\n\nfrom Ann" });
});

test("names and gift card words saved before are made plain as the server starts, once", async () => {
  const ids = { esc: uuidv7(), blank: uuidv7(), fine: uuidv7() };
  await db.insertInto("person").values([
    { id: ids.esc, display_name: "Hal\u001b]52;c;ZXZpbA==\u0007 Smith‮", email: null, created_via: "desk" },
    { id: ids.blank, display_name: "​‮", email: null, created_via: "desk" },
    { id: ids.fine, display_name: "Zoë 👨‍👩‍👧", email: null, created_via: "desk" }]).execute();
  const card = (await db.selectFrom("gift_card").select("id").executeTakeFirstOrThrow()).id;
  await db.updateTable("gift_card").set({ for_name: "Sam‮", message: "Hi\u001b[2J" }).where("id", "=", card).execute();
  const r = await plainStoredText(db);
  assert.deepEqual(r, { names: 2, giftCards: 1 });
  const name = async (id: string) => (await db.selectFrom("person").select("display_name").where("id", "=", id).executeTakeFirstOrThrow()).display_name;
  assert.equal(await name(ids.esc), "Hal]52;c;ZXZpbA== Smith");
  assert.ok(!hidden.test(await name(ids.esc)));
  assert.equal(await name(ids.blank), "", "nothing left that draws: shown as \"A player\"");
  assert.equal(await name(ids.fine), "Zoë 👨‍👩‍👧", "a name with nothing hidden is left alone, emoji joiners and all");
  assert.deepEqual(await db.selectFrom("gift_card").select(["for_name", "message"]).where("id", "=", card).executeTakeFirstOrThrow(), { for_name: "Sam", message: "Hi[2J" });
  assert.deepEqual(await plainStoredText(db), { names: 0, giftCards: 0 }, "nothing to do the next time");
});
