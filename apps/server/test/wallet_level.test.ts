// The member's Wallet and My level read what the server already keeps: club credit with what came in and went out
// (the books' kind of each entry, which the Wallet words), and a level's floor with when it was set, and each
// change's level before and after (the "Why it moved" sizes). And a member can't undo through action.undo: the
// member role holds no grant for it, so the member app offers no Undo (member-13, 15 Nov 2026).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { giftCardsOf, run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, ana: string, bo: string;
const mailer = new MemoryMailer();
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, cookie: string, body?: unknown) => {
  const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  const member = await db.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
  [ana, bo] = [uuidv7(), uuidv7()];
  for (const [id, name, email] of [[ana, "Ana", "ana@example.test"], [bo, "Bo", "bo@example.test"]] as const) {
    await db.insertInto("person").values({ id, display_name: name, email, locale: "en", created_via: "desk" }).execute();
    await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: member.id, location_id: null }).execute();
  }
});
after(async () => drop());

test("my credit: the balance and each change in or out, with the books' kind of entry", async () => {
  const cookie = await signIn("ana@example.test");
  assert.deepEqual((await call("/my/credit", cookie)).json, { cents: 0, history: [] });
  await run(db, "club.update", { gift_cards: true }, { ...owner, auth: "passkey" } as Actor);
  const sold = (await run(db, "gift_card.sell", { person_id: ana, cents: 2500, method: "cash" }, owner)).result as { gift_card_id: string };
  const code = (await giftCardsOf(db, ana)).find((c) => c.id === sold.gift_card_id)!.code!;
  await run(db, "gift_card.redeem", { person_id: ana, code }, { personId: ana, via: "test", lang: "en" });
  await run(db, "credit.pay_out", { person_id: ana, cents: 1000, method: "cash" }, owner);
  const r = (await call("/my/credit", cookie)).json;
  assert.equal(r.cents, 1500);
  assert.deepEqual(r.history.map((h: any) => [h.kind, h.cents]), [["credit_payout", -1000], ["gift_card_redeemed", 2500]]);
  assert.ok(r.history.every((h: any) => !Number.isNaN(Date.parse(h.at))), "each change has its date");
  // Only their own: Bo sees none of Ana's.
  assert.deepEqual((await call("/my/credit", await signIn("bo@example.test"))).json, { cents: 0, history: [] });
});

test("my level: the floor and when it was set, and each change's level before and after", async () => {
  const cookie = await signIn("ana@example.test");
  await run(db, "level.set", { person_id: ana, level: 2.8, reason: "Starting level" }, owner);
  await run(db, "level.set_floor", { person_id: ana, floor: 3, reason: "Coach assessment" }, owner);
  const r = (await call("/my/level", cookie)).json;
  assert.equal(r.rating.floor, "3.00");
  assert.equal(r.rating.level, "3.00", "the floor lifted the level to it");
  assert.ok(!Number.isNaN(Date.parse(r.rating.floor_since)), "when the floor was set");
  assert.deepEqual(r.events.map((e: any) => [e.kind, e.level_before, e.level_after]), [["floor", "2.80", "3.00"], ["staff_set", null, "2.80"]]);
  // No floor: no date for one.
  const bo2 = (await call("/my/level", await signIn("bo@example.test"))).json;
  assert.equal(bo2.rating, null);
  await run(db, "level.set", { person_id: bo, level: 3.4, reason: "Starting level" }, owner);
  const bo3 = (await call("/my/level", await signIn("bo@example.test"))).json;
  assert.equal(bo3.rating.floor, null); assert.equal(bo3.rating.floor_since, null);
});

test("a member can't undo a change through action.undo: the member role holds no grant for it", async () => {
  const cookie = await signIn("bo@example.test");
  // A change of Bo's own that could be undone by staff: a review he asked for.
  const p = await call("/actions/level.request_review/plan", cookie, { person_id: bo });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal((await call(`/runs/${p.json.run_id}/apply`, cookie, {})).status, 200);
  const undo = await call("/actions/action.undo/plan", cookie, { run_id: p.json.run_id });
  assert.equal(undo.status, 403, JSON.stringify(undo.json));
  assert.equal(undo.json.error, "error.forbidden_reason", JSON.stringify(undo.json));
});
