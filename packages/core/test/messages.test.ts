import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { en, es } from "@kumi/i18n";
import { messageHandlers, processOutbox, quietUntil, run, runAsSystem, sendEmails, uuidv7, type Actor, type Db, type Mail } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, monica: Actor, locationId: string, court1: string;
const as = (personId: string): Actor => ({ personId, via: "test", lang: "en" });
const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const TZ = "America/Los_Angeles";
class Outbox { sent: Mail[] = []; fail = false; async send(m: Mail) { if (this.fail) throw new Error("smtp down"); this.sent.push(m); } }

async function person(name: string, opts: { role?: string; locale?: "en" | "es" } = {}) {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: `${name.toLowerCase()}@example.test`, created_via: "desk", locale: opts.locale ?? "en" }).execute();
  const r = await db.selectFrom("role").select("id").where("key", "=", opts.role ?? "member").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  return id;
}
let slot = 0;   // each program gets its own evening on the one court
async function americano(name: string, capacity = 4) {
  const at = 72 + 3 * slot++;
  const p = (await run(db, "program.create", { location_id: locationId, kind: "social", format: "americano", name, capacity, price_cents: 3000 }, owner)).result as { program_id: string };
  await run(db, "session.add", { program_id: p.program_id, starts_at: hours(at), ends_at: hours(at + 2), court_ids: [court1] }, owner);
  await run(db, "program.publish", { program_id: p.program_id }, owner);
  return p.program_id;
}
async function join(programId: string, personId: string, pay = true) {
  const r = (await run(db, "enrolment.join", { program_id: programId, person_id: personId }, as(personId))).result as { enrolment_id: string; payment_id?: string };
  if (pay && r.payment_id) await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test");
  return r.enrolment_id;
}
const deliver = () => processOutbox(db, messageHandlers);
const messages = (personId: string, channel: "inbox" | "email" = "inbox") => db.selectFrom("outbound_message").selectAll().where("person_id", "=", personId).where("channel", "=", channel).orderBy("created_at").execute();
const kinds = async (personId: string, channel: "inbox" | "email" = "inbox") => (await messages(personId, channel)).map((m) => m.kind);

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  monica = as(await person("Monica", { role: "manager" }));
  locationId = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as { location_id: string }).location_id;
  court1 = ((await run(db, "court.create", { location_id: locationId, name: "Court 1" }, owner)).result as { court_id: string }).court_id;
  await deliver();   // the setup's own events tell nobody
});
after(async () => drop());

test("quiet hours run 9 pm to 8 am in the club's time, across the clock change", () => {
  assert.equal(quietUntil(new Date("2026-07-01T19:00:00Z"), TZ), null);                                       // noon
  assert.equal(quietUntil(new Date("2026-07-01T14:30:00Z"), TZ)?.toISOString(), "2026-07-01T15:00:00.000Z");   // 7:30 am, until 8
  assert.equal(quietUntil(new Date("2026-07-02T05:00:00Z"), TZ)?.toISOString(), "2026-07-02T15:00:00.000Z");   // 10 pm, until 8 the next day
  // 11 pm on 31 October (summer time) waits until 8 am on 1 November, after the clocks go back.
  assert.equal(quietUntil(new Date("2026-11-01T06:00:00Z"), TZ)?.toISOString(), "2026-11-01T16:00:00.000Z");
});

test("signing up with something to pay waits in the inbox; the payment brings the email", async () => {
  const p = await americano("Friday social"), sam = await person("Sam");
  const r = (await run(db, "enrolment.join", { program_id: p, person_id: sam }, as(sam))).result as { payment_id: string };
  await deliver();
  assert.deepEqual(await kinds(sam), ["booked_to_pay"]);
  assert.deepEqual(await kinds(sam, "email"), []);
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test");
  await deliver();
  assert.deepEqual(await kinds(sam), ["booked_to_pay", "paid"]);
  const [email] = await messages(sam, "email");
  assert.equal(email!.status, "waiting"); assert.ok(email!.essential);
  assert.match(email!.body, /We have your \$30\.00 for Friday social/);
  const box = new Outbox();
  assert.deepEqual(await sendEmails(db, box), { sent: 1, dropped: 0, failed: 0 });
  assert.equal(box.sent[0]!.to, "sam@example.test"); assert.equal(box.sent[0]!.subject, "Paid: Friday social");
});

test("paid before the messages went out: one confirmation, not two", async () => {
  const p = await americano("Quick payer"), lee = await person("Lee");
  await join(p, lee);   // joins and pays before the outbox runs
  await deliver();
  assert.deepEqual(await kinds(lee, "email"), ["paid"]);
});

test("an event is told once, however many times the outbox runs it", async () => {
  const p = await americano("Twice"), ana = await person("Ana");
  await join(p, ana);
  await deliver();
  const ev = await db.selectFrom("event_outbox").selectAll().where("topic", "=", "payment.succeeded").orderBy("id", "desc").executeTakeFirstOrThrow();
  await messageHandlers["payment.succeeded"]!(db, ev.payload, ev as any);
  assert.equal((await messages(ana)).filter((m) => m.kind === "paid").length, 1);
});

test("a removal says why and what happens to the money, in the member's language", async () => {
  const p = await americano("Sábado social"), lucia = await person("Lucia", { locale: "es" });
  const e = await join(p, lucia);
  await run(db, "enrolment.remove", { enrolment_id: e, reason: "club", refund: { outcome: "full" } }, monica);
  await deliver();
  const removed = (await messages(lucia, "email")).find((m) => m.kind === "removed")!;
  assert.equal(removed.lang, "es"); assert.ok(removed.essential);
  assert.equal(removed.subject, "Ya no estás en Sábado social");
  assert.ok(!removed.body.includes(".."), removed.body);   // "10:00 a.m." ends the sentence once
  assert.match(removed.body, /Motivo: decisión del club\. Te devolvemos US\$\s?30\.00 a tu tarjeta\.$|Motivo: decisión del club\. Te devolvemos \$30\.00 a tu tarjeta\.$/);
});

test("a place offer waits out quiet hours, and is dropped rather than sent after it ran out", async () => {
  const p = await americano("Small one", 1), first = await person("First"), next = await person("Next");
  const e = await join(p, first);
  await join(p, next);
  await run(db, "enrolment.leave", { enrolment_id: e }, as(first));
  await deliver();
  const [offer] = (await messages(next, "email")).filter((m) => m.kind === "offered");
  assert.ok(offer && !offer.essential && offer.stale_at);
  // Sent straight away in the day; at night it waits until 8 am.
  const expected = quietUntil(offer.created_at, TZ) ?? offer.created_at;
  assert.ok(Math.abs(offer.send_after.getTime() - expected.getTime()) < 1000);
  // Past its deadline, it's dropped, not sent late.
  const box = new Outbox();
  await sendEmails(db, box, new Date(offer.stale_at.getTime() + 1000));
  assert.equal((await messages(next, "email")).find((m) => m.kind === "offered")!.status, "dropped");
  assert.ok(!box.sent.some((m) => m.to === "next@example.test" && /place opened/.test(m.subject)));
});

test("a member who said no to email still gets what they can't do without", async () => {
  const p = await americano("Consent", 1), keen = await person("Keen"), quiet = await person("Quiet");
  await db.insertInto("channel_consent").values({ id: uuidv7(), person_id: quiet, channel: "email", purpose: "account", granted: false, source: "test" }).execute();
  const e = await join(p, keen);
  await join(p, quiet);   // waitlisted
  await run(db, "enrolment.leave", { enrolment_id: e }, as(keen));
  await deliver();
  const offer = (await messages(quiet, "email")).find((m) => m.kind === "offered")!;
  await sendEmails(db, new Outbox(), new Date(offer.send_after.getTime() + 1000));
  const after = (await messages(quiet, "email")).find((m) => m.kind === "offered")!;
  assert.equal(after.status, "dropped"); assert.equal(after.failure, "no consent");
  assert.deepEqual(await kinds(quiet), ["waitlisted", "offered"]);   // the inbox still has it
  // Taking the place and paying for it is still confirmed by email.
  const mine = await db.selectFrom("enrolment").select("id").where("person_id", "=", quiet).executeTakeFirstOrThrow();
  const r = (await run(db, "enrolment.accept_offer", { enrolment_id: mine.id }, as(quiet))).result as { payment_id: string };
  await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test");
  await deliver();
  const box = new Outbox();
  await sendEmails(db, box, new Date(Date.now() + 1000));
  assert.ok(box.sent.some((m) => m.to === "quiet@example.test" && m.subject === "Paid: Consent"));
});

test("passing a place on tells both people", async () => {
  const p = await americano("Sub night"), from = await person("Robin2"), sub = await person("Sasha");
  const e = await join(p, from);
  await run(db, "enrolment.transfer", { enrolment_id: e, to_person_id: sub, pay: "sub_pays" }, monica);
  await deliver();
  const gave = (await messages(from, "email")).find((m) => m.kind === "passed_on")!, got = (await messages(sub, "email")).find((m) => m.kind === "passed_to_you")!;
  assert.match(gave.body, /now belongs to Sasha\. Your \$30\.00 goes back to your card once Sasha pays\.$/);
  assert.match(got.body, /^Robin2 passed you their place in Sub night, .+\. Pay \$30\.00 in the app\.$/);
});

test("staff hear about a Playtomic clash; members don't", async () => {
  await db.insertInto("event_outbox").values({ topic: "mirror.conflict", payload: JSON.stringify({ ref: "b1:r1", court_name: "Court 1", start: hours(30), end: hours(31), type: "REGULAR_BOOKING" }) }).execute();
  await deliver();
  for (const staff of [owner.personId!, monica.personId!]) {
    const m = (await messages(staff, "email")).find((x) => x.kind === "mirror_conflict")!;
    assert.equal(m.purpose, "staff"); assert.match(m.body, /A Playtomic regular booking on Court 1/);
  }
});

test("a failed send is tried again later, then given up", async () => {
  const p = await americano("Retry"), kim = await person("Kim");
  await join(p, kim);
  await deliver();
  const box = new Outbox(); box.fail = true;
  let now = new Date();
  assert.equal((await sendEmails(db, box, now)).failed >= 1, true);
  for (let i = 0; i < 6; i++) { now = new Date(now.getTime() + 24 * 3600_000); await sendEmails(db, box, now); }
  const m = (await messages(kim, "email")).find((x) => x.kind === "paid")!;
  assert.equal(m.status, "failed"); assert.equal(m.attempts, 5); assert.equal(m.failure, "smtp down");
});

test("every message has both languages and no em dashes", () => {
  for (const k of Object.keys(en).filter((k) => k.startsWith("msg."))) {
    assert.ok(k in es, k);
    for (const v of [en[k as keyof typeof en], es[k as keyof typeof es]]) assert.ok(typeof v === "string" && !v.includes("—"), k);
  }
});
