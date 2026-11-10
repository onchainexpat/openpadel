import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { expireOffers, offerDeadline, plan, run, runAsSystem, uuidv7, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, monica: Actor, locationId: string, court1: string, court2: string;
const as = (personId: string, lang: "en" | "es" = "en"): Actor => ({ personId, via: "test", lang });
const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
async function person(name: string, role: string | null = "member") {
  const id = uuidv7();
  await db.insertInto("person").values({ id, display_name: name, email: `${name.toLowerCase().replace(/\W/g, "")}@example.test`, created_via: "desk" }).execute();
  if (role) {
    const r = await db.selectFrom("role").select("id").where("key", "=", role).executeTakeFirstOrThrow();
    await db.insertInto("person_role").values({ id: uuidv7(), person_id: id, role_id: r.id, location_id: null }).execute();
  }
  return id;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
/** A published Americano starting in `startsIn` hours, with capacity 4 at $25 and the 24-hour rule. */
async function americano(name: string, startsIn: number, court = court1) {
  const p = (await run(db, "program.create", { location_id: locationId, kind: "social", format: "americano", name, capacity: 4, price_cents: 2500 }, owner)).result as { program_id: string };
  await run(db, "session.add", { program_id: p.program_id, starts_at: hours(startsIn), ends_at: hours(startsIn + 2), court_ids: [court] }, owner);
  await run(db, "program.publish", { program_id: p.program_id }, owner);
  return p.program_id;
}
async function join(programId: string, personId: string, paid = true) {
  const r = (await run(db, "enrolment.join", { program_id: programId, person_id: personId }, as(personId))).result as { enrolment_id: string; status: string; payment_id?: string };
  if (paid && r.payment_id) await runAsSystem(db, "payment.settle", { payment_id: r.payment_id, outcome: "succeeded" }, "test");   // the provider's webhook
  return r;
}
const enrolment = (id: string) => db.selectFrom("enrolment").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  monica = as(await person("Monica", "manager"));
  locationId = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string }).location_id;
  court1 = ((await run(db, "court.create", { location_id: locationId, name: "Court 1" }, owner)).result as { court_id: string }).court_id;
  court2 = ((await run(db, "court.create", { location_id: locationId, name: "Court 2" }, owner)).result as { court_id: string }).court_id;
});
after(async () => drop());

test("a date can't take a court that's already taken", async () => {
  const p = await americano("Clash test", 100);
  const q = (await run(db, "program.create", { location_id: locationId, kind: "clinic", name: "Overlap", capacity: 4, price_cents: 0 }, owner)).result as { program_id: string };
  await rejects(plan(db, "session.add", { program_id: q.program_id, starts_at: hours(101), ends_at: hours(102), court_ids: [court1] }, owner), "error.court_taken");
  await run(db, "session.add", { program_id: q.program_id, starts_at: hours(101), ends_at: hours(102), court_ids: [court2] }, owner);
  void p;
});

test("the fifth and sixth sign-ups go on the waitlist, in order", async () => {
  const p = await americano("Waitlist test", 50, court2);
  for (const n of ["A1", "A2", "A3", "A4"]) assert.equal((await join(p, await person(n))).status, "booked");
  const w1 = await join(p, await person("W1")), w2 = await join(p, await person("W2"));
  assert.equal(w1.status, "waitlisted"); assert.equal((await enrolment(w2.enrolment_id)).waitlist_position, 2);
});

test("Monica's case: a late drop comes off with no refund, and the next player is offered the place", async () => {
  const p = await americano("Friday Americano", 6, court2);
  const dana = await person("Dana");
  const d = await join(p, dana);
  for (const n of ["B2", "B3", "B4"]) await join(p, await person(n));
  const sam = await person("Sam"); const s = await join(p, sam);
  assert.equal(s.status, "waitlisted");
  const pr = await plan(db, "enrolment.remove", { enrolment_id: d.enrolment_id, reason: "late_cancel" }, monica);
  assert.equal(pr.plan.summary.en, "Take Dana off Friday Americano (late cancellation). No refund: it's 5 hours before the start, inside the club's 24-hour window. Sam on the waitlist is offered the place.");
  assert.match(pr.plan.summary.es, /^Quitar a Dana de Friday Americano \(cancelación tardía\)\. Sin reembolso: faltan 5 horas/);
  const { result } = await run(db, "enrolment.remove", { enrolment_id: d.enrolment_id, reason: "late_cancel" }, monica);
  const gone = await enrolment(d.enrolment_id);
  assert.equal(gone.status, "cancelled"); assert.equal(gone.left_how, "removed"); assert.equal(gone.refund_outcome, "none"); assert.equal(gone.refund_cents, 0);
  assert.ok((result as any).offer_id, "the waitlist got an offer");
  await run(db, "enrolment.accept_offer", { enrolment_id: s.enrolment_id }, as(sam));
  assert.equal((await enrolment(s.enrolment_id)).status, "booked");
});

test("staff can change the refund, but only with a reason", async () => {
  const p = await americano("Override test", 6, court1);
  const e = await join(p, await person("Lee"));
  await rejects(plan(db, "enrolment.remove", { enrolment_id: e.enrolment_id, reason: "late_cancel", refund: { outcome: "full" } }, monica), "error.refund_note_needed");
  await run(db, "enrolment.remove", { enrolment_id: e.enrolment_id, reason: "late_cancel", refund: { outcome: "full", note: "Family emergency" } }, monica);
  const r = await enrolment(e.enrolment_id);
  assert.equal(r.refund_outcome, "full"); assert.equal(r.refund_cents, 2500); assert.equal(r.refund_changed_by_staff, true); assert.equal(r.refund_note, "Family emergency");
});

test("leaving days ahead refunds in full; a no-show never does", async () => {
  const p = await americano("Next week", 72, court1);
  const a = await join(p, await person("Ann")), b = await join(p, await person("Ben"));
  const left = await run(db, "enrolment.leave", { enrolment_id: a.enrolment_id }, as((await enrolment(a.enrolment_id)).person_id));
  assert.deepEqual(left.result, { refund_outcome: "full", refund_cents: 2500 });
  await run(db, "enrolment.remove", { enrolment_id: b.enrolment_id, reason: "no_show" }, monica);
  assert.equal((await enrolment(b.enrolment_id)).refund_outcome, "none");
});

test("passing a place to a sub: as a gift, or the sub pays and the original is refunded", async () => {
  const p = await americano("Sub test", 10, court1);
  const ivy = await person("Ivy"), joe = await person("Joe"), kim = await person("Kim"), lu = await person("Lu");
  const a = await join(p, ivy), b = await join(p, kim);
  await run(db, "enrolment.transfer", { enrolment_id: a.enrolment_id, to_person_id: joe, pay: "gift" }, as(ivy));
  const orig = await enrolment(a.enrolment_id);
  assert.equal(orig.left_how, "transferred"); assert.equal(orig.refund_outcome, "none");
  assert.equal((await enrolment(orig.replaced_by!)).paid_by, "transfer");
  await run(db, "enrolment.transfer", { enrolment_id: b.enrolment_id, to_person_id: lu, pay: "sub_pays" }, as(kim));
  assert.equal((await enrolment(b.enrolment_id)).refund_outcome, "full");
});

test("a free place for the 17th player, and only when there's room", async () => {
  const p = await americano("Comp test", 30, court2);
  const firsts = [];
  for (const n of ["C1", "C2", "C3", "C4"]) firsts.push(await join(p, await person(n)));
  const extra = await person("Extra");
  await rejects(plan(db, "enrolment.comp", { program_id: p, person_id: extra, note: "Covered by C1's kept fee" }, monica), "error.program_full");
  await run(db, "enrolment.remove", { enrolment_id: firsts[0]!.enrolment_id, reason: "late_cancel" }, monica);
  const c = await run(db, "enrolment.comp", { program_id: p, person_id: extra, note: "Covered by C1's kept fee" }, monica);
  const row = await enrolment((c.result as any).enrolment_id);
  assert.equal(row.paid_by, "comp"); assert.equal(row.price_cents, 0); assert.equal(row.comp_note, "Covered by C1's kept fee");
});

test("a free place for someone who already has a place: a plain no in the preview, not a 500", async () => {
  const p = await americano("Comp twice test", 32, court2);
  const paid = await person("Twice1"), comped = await person("Twice2");
  await join(p, paid);
  await run(db, "enrolment.comp", { program_id: p, person_id: comped, note: "Helping out" }, monica);
  for (const who of [comped, paid]) {
    await rejects(plan(db, "enrolment.comp", { program_id: p, person_id: who, note: "Again" }, monica), "error.already_signed_up");
    await rejects(run(db, "enrolment.comp", { program_id: p, person_id: who, note: "Again" }, monica), "error.already_signed_up");
  }
  assert.equal((await db.selectFrom("enrolment").select("id").where("program_id", "=", p).where("person_id", "=", comped).execute()).length, 1);
});

test("a late cancel with a waitlist: the staff give the offered place to the next one straight away", async () => {
  const p = await americano("Late cancel test", 90, court2);
  const firsts = [];
  for (const n of ["Late1", "Late2", "Late3", "Late4"]) firsts.push(await join(p, await person(n)));
  const w1 = await person("Wait1"), w2 = await person("Wait2");
  const a = await join(p, w1), b = await join(p, w2);
  assert.equal((await enrolment(a.enrolment_id)).status, "waitlisted");
  await run(db, "enrolment.remove", { enrolment_id: firsts[0]!.enrolment_id, reason: "late_cancel" }, monica);
  // W1 now holds an offer for the place; the staff needn't wait for them to take it.
  await rejects(plan(db, "enrolment.comp", { program_id: p, person_id: w2, note: "Next in line" }, monica), "error.program_full");
  const c = await run(db, "enrolment.comp", { program_id: p, person_id: w1, note: "In Late1's place" }, monica);
  assert.equal((c.result as any).enrolment_id, a.enrolment_id);
  const row = await enrolment(a.enrolment_id);
  assert.equal(row.status, "booked"); assert.equal(row.paid_by, "comp"); assert.equal(row.price_cents, 0);
  const offer = await db.selectFrom("waitlist_offer").select("outcome").where("enrolment_id", "=", a.enrolment_id).executeTakeFirstOrThrow();
  assert.equal(offer.outcome, "taken");
  assert.equal((await enrolment(b.enrolment_id)).status, "waitlisted");
});

test("two people previewing the last place: the second gets 'look again'", async () => {
  const p = await americano("Race test", 40, court1);
  for (const n of ["R1", "R2", "R3"]) await join(p, await person(n));
  const x = await person("X"), y = await person("Y");
  const px = await plan(db, "enrolment.join", { program_id: p, person_id: x }, as(x));
  const py = await plan(db, "enrolment.join", { program_id: p, person_id: y }, as(y));
  assert.equal((px.plan.details as any).status, "booked"); assert.equal((py.plan.details as any).status, "booked");
  const { apply } = await import("../src/index.ts");
  await apply(db, px.runId, as(x));
  await rejects(apply(db, py.runId, as(y)), "error.changed");
});

test("a member can leave their own place but can't take anyone off", async () => {
  const p = await americano("Permissions test", 60, court2);
  const m1 = await person("M1", "member"), m2 = await person("M2", "member");
  const e1 = await join(p, m1), e2 = await join(p, m2);
  await rejects(plan(db, "enrolment.remove", { enrolment_id: e2.enrolment_id, reason: "other" }, as(m1)), "error.forbidden_reason");
  await rejects(plan(db, "enrolment.leave", { enrolment_id: e2.enrolment_id }, as(m1)), "error.forbidden_reason");
  await run(db, "enrolment.leave", { enrolment_id: e1.enrolment_id }, as(m1));
});

test("someone else's place tells a member nothing in a preview: signed up already, watching, an offer; their own still does", async () => {
  const p = await americano("Whose places", 300, court2);
  const m3 = await person("M3"), m4 = await person("M4");
  const e3 = await join(p, m3);
  // Each said what stood in the way, and whose: "M3 is already signed up", "there's no offer". Now a plain no.
  for (const [action, input] of [
    ["enrolment.join", { program_id: p, person_id: m3 }], ["program.watch", { program_id: p, person_id: m3 }],
    ["enrolment.transfer", { enrolment_id: e3.enrolment_id, to_person_id: m4, pay: "gift" }], ["enrolment.accept_offer", { enrolment_id: e3.enrolment_id }],
  ] as const) await rejects(plan(db, action, input, as(m4)), "error.forbidden_reason");
  await rejects(plan(db, "enrolment.join", { program_id: p, person_id: m3 }, as(m3)), "error.already_signed_up");
  await rejects(plan(db, "enrolment.accept_offer", { enrolment_id: e3.enrolment_id }, as(m3)), "error.no_offer");
});

test("a place offered from the waitlist is held for that person, and a second opening goes to the next one", async () => {
  const p = await americano("Held places", 120);
  const [a, b, c, d, w1, w2, x] = await Promise.all(["Hp A", "Hp B", "Hp C", "Hp D", "Hp W1", "Hp W2", "Hp X"].map((n) => person(n)));
  const ins: { enrolment_id: string }[] = [];
  for (const id of [a!, b!, c!, d!]) ins.push(await join(p, id));
  const wait1 = await join(p, w1!), wait2 = await join(p, w2!);
  assert.equal(wait1.status, "waitlisted");
  await run(db, "enrolment.remove", { enrolment_id: ins[0]!.enrolment_id, reason: "other" }, owner);
  // W1 holds the opened place: someone new joins the waitlist instead of taking it.
  assert.equal((await join(p, x!)).status, "waitlisted");
  await run(db, "enrolment.remove", { enrolment_id: ins[1]!.enrolment_id, reason: "other" }, owner);
  const offers = await db.selectFrom("waitlist_offer").select("enrolment_id").where("outcome", "is", null).where("enrolment_id", "in", [wait1.enrolment_id, wait2.enrolment_id]).execute();
  assert.deepEqual(offers.map((o) => o.enrolment_id).sort(), [wait1.enrolment_id, wait2.enrolment_id].sort());
  await run(db, "enrolment.accept_offer", { enrolment_id: wait1.enrolment_id }, as(w1!));
  await run(db, "enrolment.accept_offer", { enrolment_id: wait2.enrolment_id }, as(w2!));
  const booked = await db.selectFrom("enrolment").select("person_id").where("program_id", "=", p).where("status", "=", "booked").execute();
  assert.deepEqual(booked.map((r) => r.person_id).sort(), [c!, d!, w1!, w2!].sort());
});

// Offers last two hours; the job runs as if it were later.
const later = (h: number) => new Date(Date.now() + h * 3600_000);
const pastDeadline = async (enrolmentId: string) => new Date((await openOfferFor(enrolmentId))!.expires_at.getTime() + 60_000);
const openOfferFor = (enrolmentId: string) => db.selectFrom("waitlist_offer").selectAll().where("enrolment_id", "=", enrolmentId).where("outcome", "is", null).executeTakeFirst();
const jobRuns = async () => Number((await db.selectFrom("action_run").select((eb) => eb.fn.countAll<string>().as("n")).where("action", "=", "waitlist.expire_offers").executeTakeFirstOrThrow()).n);
/** A full event (four booked) with the given people waiting. */
async function fullWith(name: string, startsIn: number, waiting: string[]) {
  const p = await americano(name, startsIn);
  const ins = [];
  for (const n of ["A", "B", "C", "D"]) ins.push(await join(p, await person(`${name} ${n}`)));
  const w = [];
  for (const n of waiting) w.push({ id: await person(`${name} ${n}`), ...(await join(p, (await db.selectFrom("person").select("id").where("display_name", "=", `${name} ${n}`).executeTakeFirstOrThrow()).id)) });
  return { p, ins, w };
}

test("an offer is held 4 hours from when the person can be told, never past the start", () => {
  const tz = "America/Los_Angeles", far = new Date("2026-08-01T00:00:00Z");
  assert.equal(offerDeadline(new Date("2026-07-01T19:00:00Z"), tz, far).toISOString(), "2026-07-01T23:00:00.000Z");   // noon: until 4 pm
  assert.equal(offerDeadline(new Date("2026-07-02T05:00:00Z"), tz, far).toISOString(), "2026-07-02T19:00:00.000Z");   // 10 pm: from 8 am, until noon
  const nineAm = new Date("2026-07-02T16:00:00Z");
  assert.equal(offerDeadline(new Date("2026-07-02T05:00:00Z"), tz, nineAm).toISOString(), nineAm.toISOString());     // a 9 am start comes first
});

test("an offer that runs out goes to the next person, and the one who missed it moves to the back", async () => {
  const { p, ins, w } = await fullWith("Expiry", 130, ["W1", "W2", "W3"]);
  await run(db, "enrolment.remove", { enrolment_id: ins[0]!.enrolment_id, reason: "other" }, owner);
  assert.ok(await openOfferFor(w[0]!.enrolment_id));
  // Nothing due yet: no run at all.
  const before = await jobRuns();
  assert.deepEqual(await expireOffers(db), { expired: 0, offered: 0 });
  assert.equal(await jobRuns(), before);

  assert.deepEqual(await expireOffers(db, await pastDeadline(w[0]!.enrolment_id)), { expired: 1, offered: 1 });
  assert.equal((await db.selectFrom("waitlist_offer").select("outcome").where("enrolment_id", "=", w[0]!.enrolment_id).executeTakeFirstOrThrow()).outcome, "expired");
  assert.ok(await openOfferFor(w[1]!.enrolment_id));
  const order = await db.selectFrom("enrolment").select("id").where("program_id", "=", p).where("status", "=", "waitlisted").orderBy("waitlist_position").execute();
  assert.deepEqual(order.map((r) => r.id), [w[1]!.enrolment_id, w[2]!.enrolment_id, w[0]!.enrolment_id]);
  await rejects(plan(db, "enrolment.accept_offer", { enrolment_id: w[0]!.enrolment_id }, as(w[0]!.id)), "error.no_offer");
  await run(db, "enrolment.accept_offer", { enrolment_id: w[1]!.enrolment_id }, as(w[1]!.id));
  assert.equal((await enrolment(w[1]!.enrolment_id)).status, "booked");
  assert.equal((await db.selectFrom("waitlist_offer").select("id").where("waitlist_offer.outcome", "is", null).where("enrolment_id", "in", w.map((x) => x.enrolment_id)).execute()).length, 0);
});

test("when nobody else is waiting, a place nobody took opens to anyone", async () => {
  const { p, ins, w } = await fullWith("Lapsed", 140, ["W1"]);
  await run(db, "enrolment.remove", { enrolment_id: ins[0]!.enrolment_id, reason: "other" }, owner);
  assert.deepEqual(await expireOffers(db, await pastDeadline(w[0]!.enrolment_id)), { expired: 1, offered: 0 });
  assert.equal((await enrolment(w[0]!.enrolment_id)).status, "waitlisted");
  assert.equal((await join(p, await person("Lapsed X"))).status, "booked");
});

test("no new offers once the event has started", async () => {
  const { ins, w } = await fullWith("Started", 1, ["W1", "W2"]);
  await run(db, "enrolment.remove", { enrolment_id: ins[0]!.enrolment_id, reason: "other" }, owner);
  assert.deepEqual(await expireOffers(db, later(2.5)), { expired: 1, offered: 0 });
  assert.equal(await openOfferFor(w[1]!.enrolment_id), undefined);
});

test("someone holding an offer who leaves the waitlist passes it on", async () => {
  const { ins, w } = await fullWith("Pass on", 150, ["W1", "W2"]);
  await run(db, "enrolment.remove", { enrolment_id: ins[0]!.enrolment_id, reason: "other" }, owner);
  const p = await plan(db, "enrolment.leave", { enrolment_id: w[0]!.enrolment_id }, as(w[0]!.id));
  assert.match(p.plan.summary.en, /Pass on W2 on the waitlist is offered the place/);
  await run(db, "enrolment.leave", { enrolment_id: w[0]!.enrolment_id }, as(w[0]!.id));
  assert.equal((await db.selectFrom("waitlist_offer").select("outcome").where("enrolment_id", "=", w[0]!.enrolment_id).executeTakeFirstOrThrow()).outcome, "declined");
  assert.ok(await openOfferFor(w[1]!.enrolment_id));
});

test("results change levels by default for socials, leagues and tournaments, not for clinics and courses; staff can choose", async () => {
  const rated = async (kind: string, extra: Record<string, unknown> = {}) => {
    const id = ((await run(db, "program.create", { location_id: locationId, kind, name: `Rated ${kind} ${Object.keys(extra).length}`, capacity: 4, price_cents: 0, ...extra }, owner)).result as { program_id: string }).program_id;
    return (await db.selectFrom("program").select("rated").where("id", "=", id).executeTakeFirstOrThrow()).rated;
  };
  assert.deepEqual([await rated("clinic"), await rated("course"), await rated("social"), await rated("league"), await rated("tournament")], [false, false, true, true, true]);
  assert.deepEqual([await rated("clinic", { rated: true }), await rated("social", { rated: false })], [true, false]);
  // The preview says which, so staff see it before creating.
  const said = async (input: Record<string, unknown>) => (await plan(db, "program.create", { location_id: locationId, name: "Preview", capacity: 4, price_cents: 0, ...input }, owner)).plan.summary.en;
  assert.match(await said({ kind: "clinic" }), /Its results don't change levels\.$/);
  assert.match(await said({ kind: "clinic", rated: true }), /Its results change the players' levels\.$/);
});
