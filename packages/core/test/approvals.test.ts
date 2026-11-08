// What someone asked for (actions.ts approve, decline): everyone who can say yes hears once, in their language; yes
// needs the change's own permission and strong sign-in; no changes nothing and tells the person who asked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { fakeStripe } from "./fake-stripe.ts";
import { approve, clubStripeAccount, connectStripe, decline, mayAnswer, messageHandlers, plan, processOutbox, registerMessageTopics, run, runAsSystem,
  setPaymentProvider, StripeProvider, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, second: Actor, mia: Actor, dee: Actor;
const as = (personId: string, auth: Actor["auth"] = "two_factor"): Actor => ({ personId, via: "test", lang: "en", auth });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
async function staff(name: string, role: string, locale: "en" | "es" = "en") {
  const id = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test`, locale }, owner)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: id, role }, owner);
  return as(id);
}
/** What each person was told about this run, in the inbox. */
const told = (runId: string, kind: string) => db.selectFrom("outbound_message").innerJoin("event_outbox", "event_outbox.id", "outbound_message.event_id")
  .select(["outbound_message.person_id", "outbound_message.body"]).where("event_outbox.action_run_id", "=", runId)
  .where("outbound_message.kind", "=", kind).where("outbound_message.channel", "=", "inbox").execute();
const capAsk = (cents: number) => plan(db, "club.usage_cap_set", { cap_cents: cents, over_cents: 0 }, mia);

before(async () => {
  ({ db, drop } = await freshDb());
  await registerMessageTopics(db, new Date(Date.now() - 60_000));
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id, "passkey");
  second = await staff("Sam", "owner");
  mia = await staff("Mia", "manager", "es");
  dee = await staff("Dee", "front_desk");
  await processOutbox(db, messageHandlers);
});
after(async () => drop());

test("a manager's ask: each owner hears once, in the inbox, with who asked and what; the asker and the desk don't", async () => {
  const asked = await capAsk(9000);
  assert.equal(asked.status, "awaiting_approval");
  await processOutbox(db, messageHandlers);
  await processOutbox(db, messageHandlers);
  const notes = await told(asked.runId, "approval_waiting");
  assert.deepEqual(notes.map((n) => n.person_id).sort(), [owner.personId, second.personId].sort());
  assert.match(notes[0]!.body, /Mia asked for this/);
  assert.match(notes[0]!.body, /\$90\.00/);
  assert.equal(await mayAnswer(db, { ...(await runRow(asked.runId)) }, dee.personId, new Date()), false);
  assert.equal(await mayAnswer(db, { ...(await runRow(asked.runId)) }, mia.personId, new Date()), false, "not their own");
});

test("saying yes: not the asker, not the desk, with the change's strong sign-in; then it's done and the asker hears in Spanish", async () => {
  const asked = await capAsk(8000);
  await rejects(approve(db, asked.runId, mia), "error.own_approval");
  await rejects(approve(db, asked.runId, dee), "error.forbidden_reason");
  // The cap needs a strong sign-in: an owner with a passkey on an emailed code alone can't say yes.
  await db.insertInto("passkey").values({ credential_id: "owner-key", person_id: owner.personId!, public_key: Buffer.from("k"), counter: "0", transports: null, name: "Phone" }).execute();
  await rejects(approve(db, asked.runId, { ...owner, auth: "email_code" }), "error.need_passkey");
  await approve(db, asked.runId, owner);
  assert.equal((await db.selectFrom("club").select("usage_cap_cents").executeTakeFirstOrThrow()).usage_cap_cents, 8000);
  const row = await runRow(asked.runId);
  assert.deepEqual([row.status, row.approved_by], ["applied", owner.personId]);
  await rejects(decline(db, asked.runId, second), "error.not_planned");
  await processOutbox(db, messageHandlers);
  const yes = await told(asked.runId, "approval_approved");
  assert.deepEqual(yes.map((n) => n.person_id), [mia.personId]);
  assert.match(yes[0]!.body, /Robin Hale lo aprobó/);
});

test("saying no: nothing changes, it's kept as declined with who and why, and only once", async () => {
  const before = (await db.selectFrom("club").select("usage_cap_cents").executeTakeFirstOrThrow()).usage_cap_cents;
  const asked = await capAsk(20000);
  await rejects(decline(db, asked.runId, mia), "error.own_approval");
  await rejects(decline(db, asked.runId, dee), "error.forbidden_reason");
  await rejects(decline(db, asked.runId, { ...second, auth: "oauth", grantId: "g" }), "error.assistant_in_app");
  await decline(db, asked.runId, second, { reason: "  Too much for November  " });
  await rejects(decline(db, asked.runId, owner), "error.not_planned");
  await rejects(approve(db, asked.runId, owner), "error.declined");
  assert.equal((await db.selectFrom("club").select("usage_cap_cents").executeTakeFirstOrThrow()).usage_cap_cents, before);
  const row = await runRow(asked.runId);
  assert.equal(row.status, "failed");
  assert.deepEqual(row.error, { code: "error.declined", params: { by: second.personId, reason: "Too much for November" } });
  await processOutbox(db, messageHandlers);
  const no = await told(asked.runId, "approval_declined");
  assert.deepEqual(no.map((n) => n.person_id), [mia.personId]);
  assert.match(no[0]!.body, /Sam rechazó lo que pediste/);
  assert.match(no[0]!.body, /Motivo: Too much for November/);
});

test("the same ask again while the first still waits is refused, saying when; once it's answered it can be asked again", async () => {
  const first = await capAsk(7000);
  await rejects(capAsk(7000), "error.ask_waiting");
  // Anyone asking for the same change: another manager's ask would tell the owners again, and two yeses would do it twice.
  const ana = await staff("Ana", "manager");
  await assert.rejects(plan(db, "club.usage_cap_set", { over_cents: 0, cap_cents: 7000 }, ana), (e: unknown) => {
    assert.ok(e instanceof KumiError && e.code === "error.ask_waiting");
    assert.match(e.text.en, /^This was asked for already on \w{3}, \w{3} \d+, \d+:\d\d [AP]M, and it's still waiting for a yes\.$/);
    assert.match(e.text.es, /^Esto ya se pidió el .+ y sigue esperando un sí\.$/);
    return true;
  });
  // A different change is its own ask, and nothing more waits for the refused ones.
  const other = await capAsk(7100);
  assert.equal(other.status, "awaiting_approval");
  assert.equal((await db.selectFrom("action_run").select("id").where("action", "=", "club.usage_cap_set").where("status", "=", "awaiting_approval")
    .where(sql<boolean>`input->>'cap_cents' = '7000'`).execute()).length, 1);
  await decline(db, first.runId, second);
  assert.equal((await capAsk(7000)).status, "awaiting_approval");
});

test("the other asks work the same way: a manager connecting Stripe waits for an owner's yes", async () => {
  const fake = fakeStripe();
  const stripe = new StripeProvider({ secretKey: "sk_test_platform", fetch: fake.fetch, connect: clubStripeAccount(db) });
  setPaymentProvider(stripe);
  const urls = { refresh: "https://kestrel.example/payments?stripe=refresh", return: "https://kestrel.example/payments?stripe=return" };
  const asked = await connectStripe(db, stripe, mia, urls);
  assert.ok("awaiting_approval" in asked);
  await processOutbox(db, messageHandlers);
  assert.equal((await told(asked.awaiting_approval, "approval_waiting")).length, 2);
  await approve(db, asked.awaiting_approval, second);
  assert.ok((await db.selectFrom("club").select("stripe_account_id").executeTakeFirstOrThrow()).stripe_account_id);
});

async function runRow(id: string) {
  return db.selectFrom("action_run").select(["id", "action", "input", "plan", "location_id", "actor_person_id", "status", "approved_by", "error"]).where("id", "=", id).executeTakeFirstOrThrow();
}
