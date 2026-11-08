// Moving from Playtomic, the bookings side (playtomic_archive.ts): the archive kept from the first read, taking upcoming
// bookings over (stage 3), and the owner's daily comparison. Playtomic is never called: a stand-in serves its feed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { sql } from "kysely";
import { archiveBookings, archiveOf, comparePlaytomic, comparison, diffMirror, normalize, exportData, issueReceipts, plan, processOutbox, messageHandlers, run, runAsSystem, syncMirror, syncMirrorFar, uuidv7, KumiError,
  PlaytomicClient, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, court1: string, court2: string, locationId: string;
const people: Record<string, string> = {};
const as = (personId: string): Actor => ({ personId, via: "test", lang: "en" });
const H = 3600_000, base = Math.ceil(Date.now() / H) * H + 24 * H;
const at = (h: number) => new Date(base + h * H);
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}

type P = { participant_id: string; name?: string; email?: string; participant_type?: string; family_member_id?: string };
/** A booking as Playtomic's Third Party API documents it (third-party.playtomic.io/endpoints/bookings/). */
function booking(id: string, h: number, o: { court?: string; type?: string; minutes?: number; cancelled?: boolean; price?: string; paid?: string; owner?: string; players?: P[] } = {}) {
  const court = o.court ?? "pt-1", start = at(h), end = new Date(start.getTime() + (o.minutes ?? 90) * 60_000);
  return { booking_id: id, object_id: `obj-${id}`, tenant_id: "tenant-1", resource_id: court, resource_name: `Padel ${court.slice(-1)}`, sport_id: "PADEL",
    booking_start_date: start.toISOString().slice(0, 19), booking_end_date: end.toISOString().slice(0, 19), duration: (o.minutes ?? 90) * 60_000 * 1000,
    origin: "APP_IOS", price: o.price ?? "40 USD", booking_type: o.type ?? "REGULAR_BOOKING", payment_status: o.paid ?? "PAID", is_canceled: o.cancelled ?? false,
    participant_info: { owner_id: o.owner ?? "u-ann", participants: o.players ?? [
      { participant_id: "u-ann", name: "Ann Lee", email: "ANN@example.test", accepts_commercial_communications: true, participant_type: "CUSTOMER" },
      { participant_id: "u-bo", name: "Bo Diaz", email: "bo@example.test", accepts_commercial_communications: false, participant_type: "CUSTOMER" },
      { participant_id: "u-guest", name: "Gus Guest", accepts_commercial_communications: false, participant_type: "GUEST" }] },
    coach_ids: null, is_canceled_by: undefined };
}

class FakePlaytomic {
  bookings: ReturnType<typeof booking>[] = [];
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/oauth/token") return Response.json({ token: "tok", expires_in: 3600 });
    if (u.pathname === "/api/v1/bookings") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer tok");
      const from = Date.parse(`${u.searchParams.get("start_booking_date")}Z`), to = Date.parse(`${u.searchParams.get("end_booking_date")}Z`);
      const size = Number(u.searchParams.get("size")), page = Number(u.searchParams.get("page"));
      return Response.json(this.bookings.filter((b) => { const t = Date.parse(`${b.booking_start_date}Z`); return t >= from && t < to; }).slice(page * size, (page + 1) * size));
    }
    return new Response("not found", { status: 404 });
  };
}
const pt = new FakePlaytomic();
const client = () => new PlaytomicClient({ clientId: "kumi", secret: "s", tenantId: "tenant-1", fetch: pt.fetch, pageDelayMs: 0 });
const sync = (now = new Date(base)) => syncMirror(db, client(), { now });
const mb = (ref: string) => db.selectFrom("mirror_booking").selectAll().where("ref", "=", ref).executeTakeFirst();
const players = (id: string) => db.selectFrom("playtomic_booking_player").selectAll().where("booking_id", "=", id).orderBy("participant_id").execute();

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = as((s.result as { owner_person_id: string }).owner_person_id);
  locationId = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as { location_id: string }).location_id;
  court1 = ((await run(db, "court.create", { location_id: locationId, name: "Court 1" }, owner)).result as { court_id: string }).court_id;
  court2 = ((await run(db, "court.create", { location_id: locationId, name: "Court 2" }, owner)).result as { court_id: string }).court_id;
  for (const [name, email] of [["Ann", "ann@example.test"], ["Bo", "bo@example.test"], ["Cy", "cy@example.test"], ["Di", "di@example.test"]] as const) {
    people[name] = ((await run(db, "person.create", { display_name: `${name} Member`, email }, owner)).result as { person_id: string }).person_id;
  }
  // Di came in through an import that kept her Playtomic id, under another email.
  await db.insertInto("external_ref").values({ entity: "person", entity_id: people.Di!, system: "playtomic", external_id: "u-di" }).execute();
  await run(db, "connector.map_court", { resource_id: "pt-1", resource_name: "Padel 1", court_id: court1 }, owner);
  await run(db, "connector.map_court", { resource_id: "pt-2", resource_name: "Padel 2", court_id: court2 }, owner);
});
after(async () => drop());

test("each read is kept as Playtomic gave it, players by name and email, matched to members; an unchanged one isn't written again", async () => {
  pt.bookings = [booking("b1", 2), booking("b2", 5, { court: "pt-2", owner: "u-di", players: [{ participant_id: "u-di", name: "Di P", email: "di.other@example.test" }] })];
  const r = await sync();
  assert.ok(r.ok, JSON.stringify(r));
  const b1 = await db.selectFrom("playtomic_booking").selectAll().where("booking_id", "=", "b1").executeTakeFirstOrThrow();
  assert.equal(b1.court_id, court1);
  assert.equal(b1.price, "40 USD");
  assert.equal(b1.price_cents, 4000);
  assert.equal(b1.payment_status, "PAID");
  assert.equal(b1.origin, "APP_IOS");
  assert.equal(new Date(b1.ends_at).getTime() - new Date(b1.starts_at).getTime(), 90 * 60_000);
  assert.equal((b1.raw as any).participant_info, undefined, "players are kept in their own rows");
  const p1 = await players("b1");
  assert.deepEqual(p1.map((p) => [p.participant_id, p.name, p.email, p.is_owner, p.person_id]), [
    ["u-ann", "Ann Lee", "ann@example.test", true, people.Ann], ["u-bo", "Bo Diaz", "bo@example.test", false, people.Bo], ["u-guest", "Gus Guest", null, false, null]]);
  assert.equal((await players("b2"))[0]!.person_id, people.Di, "matched by the Playtomic id an import kept");
  const v = b1.version;
  await sync();
  assert.equal((await db.selectFrom("playtomic_booking").select("version").where("booking_id", "=", "b1").executeTakeFirstOrThrow()).version, v, "unchanged: not written again");
  pt.bookings[0] = booking("b1", 2, { paid: "PENDING" });
  await sync();
  assert.equal((await db.selectFrom("playtomic_booking").select("payment_status").where("booking_id", "=", "b1").executeTakeFirstOrThrow()).payment_status, "PENDING");
  pt.bookings[0] = booking("b1", 2);
  await sync();
});

test("the past three months are read into the archive only: a past booking holds nothing and clashes with nothing", async () => {
  pt.bookings.push(booking("old1", -24 * 40), booking("old2", -24 * 75));
  const lastRead = new Map<number, number>();
  // Ahead first (nothing further ahead to read here), then the past, a slice a sync.
  for (let n = 0; n < 6; n++) await syncMirrorFar(db, client(), { now: new Date(base), everyMs: 6 * H, lastRead });
  assert.ok([-1, -2, -3].every((k) => lastRead.has(k)), JSON.stringify([...lastRead.keys()]));
  for (const id of ["old1", "old2"]) {
    assert.ok(await db.selectFrom("playtomic_booking").select("booking_id").where("booking_id", "=", id).executeTakeFirst(), `${id} archived`);
    assert.equal(await mb(`${id}:pt-1`), undefined, `${id} holds nothing`);
  }
});

test("staff see a person's Playtomic history, and it comes with their data download", async () => {
  const ann = await archiveOf(db, people.Ann!);
  assert.ok(ann.some((b) => b.booking_id === "b1" && b.owner && b.others.includes("Bo Diaz") && b.others.includes("Gus Guest")));
  const data: any = await exportData(db, people.Bo!, new Date(base), "en");
  const mine = data.person?.playtomic_bookings ?? data.playtomic_bookings;
  assert.ok(Array.isArray(mine) && mine.some((b: any) => b.court === "Padel 1" && b.other_players.includes("Ann Lee") && b.booked_by_you === false), JSON.stringify(mine));
});

test("a deleted account's name and email go from the archive, and a later read doesn't bring them back", async () => {
  pt.bookings.push(booking("c1", 30, { owner: "u-cy", players: [{ participant_id: "u-cy", name: "Cy Hart", email: "cy@example.test" }, { participant_id: "u-ann", name: "Ann Lee", email: "ann@example.test" }] }));
  await sync();
  assert.equal((await players("c1")).find((p) => p.participant_id === "u-cy")!.person_id, people.Cy);
  await run(db, "privacy.erase", { person_id: people.Cy }, as(people.Cy!), { now: new Date(base) });
  const gone = (await players("c1")).find((p) => p.participant_id === "u-cy")!;
  assert.equal(gone.name, null);
  assert.equal(gone.email, null);
  assert.ok(gone.erased_at);
  // Read again, and a new booking of theirs: still without a name.
  pt.bookings.push(booking("c2", 54, { owner: "u-cy", players: [{ participant_id: "u-cy", name: "Cy Hart", email: "cy@example.test" }] }));
  pt.bookings = pt.bookings.map((b) => b.booking_id === "c1" ? { ...b, payment_status: "PENDING" } : b);
  await sync();
  for (const id of ["c1", "c2"]) {
    const p = (await players(id)).find((x) => x.participant_id === "u-cy")!;
    assert.equal(p.name, null, id);
    assert.equal(p.email, null, id);
  }
  assert.equal((await players("c1")).find((p) => p.participant_id === "u-ann")!.name, "Ann Lee", "the others stay");
  assert.deepEqual(await archiveOf(db, people.Cy!), []);
});

test("taking over: a paid booking becomes a booking here with its players, paid in Playtomic, and the mirror doesn't hold it twice", async () => {
  pt.bookings.push(booking("t1", 8, { court: "pt-2" }), booking("t2", 10, { court: "pt-2", paid: "UNPAID" }));
  await sync();
  const held = await mb("t1:pt-2");
  assert.equal(held?.status, "held");
  const p = await plan(db, "mirror.take_over", { booking_ids: ["t1", "t2"] }, owner, { now: new Date(base) });
  assert.match(p.plan.summary.en, /Take over 2 Playtomic bookings/);
  assert.match(p.plan.summary.en, /\$40\.00 was paid in Playtomic/);
  assert.match(p.plan.summary.en, /\$40\.00 wasn't paid in Playtomic: it's owed at the desk/);
  assert.match(p.plan.summary.en, /refund of what was paid in Playtomic is made in Playtomic/);
  await run(db, "mirror.take_over", { booking_ids: ["t1", "t2"] }, owner, { now: new Date(base) });
  const taken = await db.selectFrom("playtomic_booking").select(["taken_over_booking_id"]).where("booking_id", "=", "t1").executeTakeFirstOrThrow();
  const b = await db.selectFrom("booking").selectAll().where("id", "=", taken.taken_over_booking_id!).executeTakeFirstOrThrow();
  assert.equal(b.organiser_id, people.Ann);
  assert.equal(b.source, "import");
  assert.equal(b.price_cents, 4000);
  const bps = await db.selectFrom("booking_player").select(["person_id", "guest_name", "share_cents"]).where("booking_id", "=", b.id).orderBy("share_cents", "desc").execute();
  assert.deepEqual(bps.map((x) => [x.person_id ?? x.guest_name, x.share_cents]).sort(), [[people.Ann, 4000], [people.Bo, 0], ["Gus Guest", 0]].sort());
  const pays = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(["payment.method", "payment.amount_cents", "payment.status"])
    .where("booking_player.booking_id", "=", b.id).execute();
  assert.deepEqual(pays, [{ method: "playtomic", amount_cents: 4000, status: "succeeded" }]);
  // No money moved through Kumi: nothing in the books.
  const ledger = await db.selectFrom("ledger_txn").select("id").where("action_run_id", "in", db.selectFrom("action_run").select("id").where("action", "=", "mirror.take_over")).execute();
  assert.equal(ledger.length, 0);
  const unpaid = await db.selectFrom("playtomic_booking").select("taken_over_booking_id").where("booking_id", "=", "t2").executeTakeFirstOrThrow();
  assert.equal((await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id").where("booking_player.booking_id", "=", unpaid.taken_over_booking_id!).execute()).length, 0, "owed at the desk");
  // The mirror's hold gave way to the booking's own court time, and the next read leaves it alone.
  const m = await mb("t1:pt-2");
  assert.equal(m?.status, "taken");
  assert.equal(m?.court_time_id, null);
  assert.equal((await db.selectFrom("court_time").select("active").where("id", "=", held!.court_time_id!).executeTakeFirstOrThrow()).active, false);
  await sync();
  assert.equal((await mb("t1:pt-2"))?.status, "taken");
  const times = await db.selectFrom("court_time").select(["kind", "booking_id"]).where("court_id", "=", court2).where("active", "=", true)
    .where((w) => w.or([w("booking_id", "=", b.id), w("kind", "=", "mirror")])).execute();
  assert.equal(times.filter((t) => t.booking_id === b.id).length, 1);
  assert.equal((await db.selectFrom("mirror_booking").select("ref").where("status", "=", "conflict").execute()).length, 0, "not a clash with itself");
  // Taken over already: refused the second time.
  await rejects(plan(db, "mirror.take_over", { booking_ids: ["t1"] }, owner, { now: new Date(base) }), "error.take_over_none");
  // No receipt: Playtomic gave one.
  await db.updateTable("club").set({ receipts_from: new Date(base - 1000 * H) }).execute();
  await issueReceipts(db, { now: new Date(base) });
  assert.equal((await db.selectFrom("receipt_payment").innerJoin("payment", "payment.id", "receipt_payment.payment_id").select("payment.id").where("payment.method", "=", "playtomic").execute()).length, 0);
});

test("a taken-over booking cancelled here: what was paid in Playtomic goes back there, staff are told, and the mirror holds the court again", async () => {
  const id = (await db.selectFrom("playtomic_booking").select("taken_over_booking_id").where("booking_id", "=", "t1").executeTakeFirstOrThrow()).taken_over_booking_id!;
  const pay = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select("payment.id").where("booking_player.booking_id", "=", id).executeTakeFirstOrThrow();
  await rejects(plan(db, "booking.refund", { booking_id: id, payment_id: pay.id, cents: 1000 }, owner, { now: new Date(base) }), "error.refund_in_playtomic");
  const p = await plan(db, "booking.cancel", { booking_id: id, refund: "full" }, owner, { now: new Date(base) });
  assert.match(p.plan.summary.en, /\$40\.00 paid in Playtomic goes back, as chosen: refund it in Playtomic/);
  assert.match(p.plan.summary.en, /still booked in Playtomic: cancel it there too/);
  await run(db, "booking.cancel", { booking_id: id, refund: "full" }, owner, { now: new Date(base) });
  // No money back through Kumi: only a note that it's given back in Playtomic, sent nowhere.
  assert.deepEqual((await db.selectFrom("refund").select(["destination", "status", "amount_cents"]).where("payment_id", "=", pay.id).execute()), [{ destination: "playtomic", status: "sent", amount_cents: 4000 }]);
  const ev = await db.selectFrom("event_outbox").select("payload").where("topic", "=", "booking.refund_in_playtomic").execute();
  assert.equal(ev.length, 1);
  assert.equal((ev[0]!.payload as any).cents, 4000);
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["kind", "body"]).where("kind", "=", "playtomic_refund_staff").where("channel", "=", "inbox").execute();
  assert.ok(told.length >= 1 && /refund it in Playtomic/.test(told[0]!.body), JSON.stringify(told));
  await sync();
  const m = await mb("t1:pt-2");
  assert.equal(m?.status, "held", "still booked in Playtomic: held again");
  assert.ok(m?.court_time_id);
});

test("recurring bookings every week become a weekly court; with a gap, each week stays a booking of its own", async () => {
  const rec = (id: string, h: number) => booking(id, h, { type: "RECURRING_BOOKING", owner: "u-bo", players: [{ participant_id: "u-bo", name: "Bo Diaz", email: "bo@example.test" }] });
  pt.bookings.push(rec("r1", 24 * 2 + 4), rec("r2", 24 * 9 + 4), rec("r3", 24 * 16 + 4));
  const gap = (id: string, h: number) => booking(id, h, { type: "RECURRING_BOOKING", court: "pt-2", owner: "u-bo", players: [{ participant_id: "u-bo", name: "Bo Diaz", email: "bo@example.test" }] });
  pt.bookings.push(gap("g1", 24 * 3 + 6), gap("g2", 24 * 17 + 6));
  await sync();
  const p = await plan(db, "mirror.take_over", { booking_ids: ["r1", "r2", "r3", "g1", "g2"] }, owner, { now: new Date(base) });
  assert.match(p.plan.summary.en, /weekly court on Court 1, every week from .* to .*: 3 weeks/);
  assert.match(p.plan.summary.en, /2 recurring bookings aren't every week without a gap/);
  await run(db, "mirror.take_over", { booking_ids: ["r1", "r2", "r3", "g1", "g2"] }, owner, { now: new Date(base) });
  const series = await db.selectFrom("booking_series").selectAll().where("organiser_id", "=", people.Bo!).execute();
  assert.equal(series.length, 1);
  assert.equal(series[0]!.court_id, court1);
  assert.equal(series[0]!.pay, "desk");
  const weeks = await db.selectFrom("booking_series_week").select(["on_date", "booking_id"]).where("series_id", "=", series[0]!.id).orderBy("on_date").execute();
  assert.equal(weeks.length, 3);
  assert.ok(weeks.every((w) => w.booking_id));
  const g = await db.selectFrom("playtomic_booking").innerJoin("booking", "booking.id", "playtomic_booking.taken_over_booking_id").select("booking.series_id")
    .where("playtomic_booking.booking_id", "in", ["g1", "g2"]).execute();
  assert.deepEqual(g.map((x) => x.series_id), [null, null]);
});

test("what can't be taken over stays in Playtomic, held here, with the reason by name", async () => {
  const social = ((await run(db, "program.create", { location_id: locationId, kind: "social", format: "americano", name: "Late Social", capacity: 8, price_cents: 2500 }, owner)).result as { program_id: string }).program_id;
  await run(db, "session.add", { program_id: social, starts_at: at(22).toISOString(), ends_at: at(24).toISOString(), court_ids: [court1] }, owner);
  pt.bookings.push(
    booking("x-clash", 22),
    booking("x-unknown", 12, { owner: "u-zed", players: [{ participant_id: "u-zed", name: "Zed Stranger", email: "zed@example.test" }] }),
    booking("x-class", 14, { type: "PUBLIC_CLASS" }),
    booking("x-partial", 16, { paid: "PARTIAL_PAID" }),
    booking("x-euro", 18, { price: "40 EUR" }),
    booking("x-gone", 20, { cancelled: true }));
  await sync();
  const p = await plan(db, "mirror.take_over", { booking_ids: ["x-unknown", "x-class", "x-partial", "x-euro", "x-gone", "x-clash", "b1"] }, owner, { now: new Date(base) });
  assert.match(p.plan.summary.en, /Take over 1 Playtomic booking/);
  assert.match(p.plan.summary.en, /its player \(Zed Stranger\) isn't a member here yet/);
  assert.match(p.plan.summary.en, /Group class, not one player's court/);
  assert.match(p.plan.summary.en, /partly paid in Playtomic/);
  assert.match(p.plan.summary.en, /its price isn't in the club's currency/);
  assert.match(p.plan.summary.en, /cancelled in Playtomic/);
  assert.match(p.plan.summary.en, /it clashes with Late Social here/);
  await rejects(plan(db, "mirror.take_over", { booking_ids: ["x-unknown"] }, owner, { now: new Date(base) }), "error.take_over_none");
  // Front desk doesn't take bookings over: a manager's decision.
  const desk = ((await run(db, "person.create", { display_name: "Dana Desk", email: "dana@example.test" }, owner)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: desk, role: "front_desk" }, owner);
  await assert.rejects(plan(db, "mirror.take_over", { booking_ids: ["b1"] }, as(desk), { now: new Date(base) }));
});

test("the owner's daily comparison: run once a club day, each difference told once", async () => {
  // A Playtomic booking over a Kumi event: a clash.
  const prog = ((await run(db, "program.create", { location_id: locationId, kind: "social", format: "americano", name: "Friday Americano", capacity: 8, price_cents: 2500 }, owner)).result as { program_id: string }).program_id;
  await run(db, "session.add", { program_id: prog, starts_at: at(40).toISOString(), ends_at: at(42).toISOString(), court_ids: [court2] }, owner);
  pt.bookings.push(booking("k-clash", 40, { court: "pt-2", type: "LEAGUE_MATCH" }));
  await sync();
  const first = await comparePlaytomic(db, { now: new Date(base) });
  assert.ok(first.ran);
  assert.ok(first.told >= 1, JSON.stringify(first));
  const again = await comparePlaytomic(db, { now: new Date(base + 2 * H) });
  assert.equal(again.ran, false, "once a club day");
  await processOutbox(db, messageHandlers);
  const msgs = await db.selectFrom("outbound_message").select(["person_id", "body"]).where("kind", "=", "playtomic_compare").where("channel", "=", "inbox").execute();
  assert.ok(msgs.length >= 1 && msgs.every((m) => m.person_id === owner.personId), "the owners");
  assert.match(msgs[0]!.body, /League match in Playtomic clashes with something here/);
  // The next day, the same clash isn't said again.
  await db.updateTable("connector_status").set({ last_ok_at: new Date(base + 26 * H) }).execute();
  const next = await comparePlaytomic(db, { now: new Date(base + 26 * H) });
  assert.ok(next.ran);
  assert.equal(next.told, 0);
});

test("archiveBookings reads a row with no players, an unreadable row, and the same player twice", async () => {
  const r = await archiveBookings(db, [
    { ...booking("z1", 60), participant_info: { participants: [] } },
    { booking_id: "z-bad" },
    { ...booking("z2", 62), participant_info: { owner_id: "u-bo", participants: [{ participant_id: "u-bo", name: "Bo Diaz" }, { participant_id: "u-bo", name: "Bo Diaz" }] } },
  ], new Date(base));
  assert.equal(r.unreadable, 1);
  assert.equal((await players("z1")).length, 0);
  assert.equal((await players("z2")).length, 1);
});

test("an account deleted before any of its Playtomic bookings were read: they come in later without a name or email", async () => {
  // Eve deletes her account before the archive's slices of the past three months have been read. She came in from an
  // import that kept her Playtomic id; her address is known too, so a booking under another Playtomic id but her
  // address is kept out as well.
  const eve = ((await run(db, "person.create", { display_name: "Eve Member", email: "eve@example.test" }, owner)).result as { person_id: string }).person_id;
  await db.insertInto("external_ref").values({ entity: "person", entity_id: eve, system: "playtomic", external_id: "u-eve" }).execute();
  await run(db, "privacy.erase", { person_id: eve }, as(eve), { now: new Date(base) });
  const marks = await db.selectFrom("playtomic_erased").select(["playtomic_id", "email_hash"]).execute();
  assert.ok(marks.some((m) => m.playtomic_id === "u-eve"));
  assert.ok(marks.every((m) => !m.email_hash || !m.email_hash.includes("@")), "no address kept");
  await archiveBookings(db, [
    booking("old-eve", -24 * 50, { owner: "u-eve", players: [{ participant_id: "u-eve", name: "Eve Hart", email: "eve@example.test" }, { participant_id: "u-ann", name: "Ann Lee", email: "ann@example.test" }] }),
    booking("old-eve2", -24 * 52, { owner: "u-eve2", players: [{ participant_id: "u-eve2", name: "Eve H.", email: "EVE@example.test" }] }),
  ], new Date(base));
  for (const [id, pid] of [["old-eve", "u-eve"], ["old-eve2", "u-eve2"]] as const) {
    const p = (await players(id)).find((x) => x.participant_id === pid)!;
    assert.deepEqual([p.name, p.email, p.person_id], [null, null, null], `${id}: ${JSON.stringify(p)}`);
    assert.ok(p.erased_at);
  }
  assert.equal((await players("old-eve")).find((x) => x.participant_id === "u-ann")!.name, "Ann Lee", "the others stay");
});

// ---- Found by the review of f4ce124 and phone run 10 ----
const kumiOf = async (ptId: string) => (await db.selectFrom("playtomic_booking").select("taken_over_booking_id").where("booking_id", "=", ptId).executeTakeFirstOrThrow()).taken_over_booking_id!;
const alerts = async (bookingId: string) => (await db.selectFrom("event_outbox").select("payload").where("topic", "=", "booking.refund_in_playtomic").execute())
  .filter((e) => (e.payload as any).booking_id === bookingId).map((e) => (e.payload as any).cents as number);
const ptRefunds = async (bookingId: string) => (await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
  .select(["refund.amount_cents", "refund.destination", "refund.status"]).where("booking_player.booking_id", "=", bookingId).execute());

test("a member ending a taken-over weekly court: what was paid in Playtomic is said, kept as given back there, and each week told to the managers", async () => {
  const rec = (id: string, h: number) => booking(id, h, { type: "RECURRING_BOOKING", court: "pt-2", owner: "u-ann", players: [{ participant_id: "u-ann", name: "Ann Lee", email: "ann@example.test" }] });
  pt.bookings.push(rec("w1", 24 * 4 + 7), rec("w2", 24 * 11 + 7), rec("w3", 24 * 18 + 7));
  await sync();
  await run(db, "mirror.take_over", { booking_ids: ["w1", "w2", "w3"] }, owner, { now: new Date(base) });
  const series = await db.selectFrom("booking_series").innerJoin("booking", "booking.series_id", "booking_series.id").select("booking_series.id")
    .where("booking.id", "=", await kumiOf("w1")).executeTakeFirstOrThrow();
  const p = await plan(db, "booking.repeat_end", { series_id: series.id }, as(people.Ann!), { now: new Date(base) });
  assert.match(p.plan.summary.en, /\$120\.00 paid in Playtomic goes back by the club's rule: refund it in Playtomic/);
  assert.doesNotMatch(p.plan.summary.en, /Nothing comes back/i);
  await run(db, "booking.repeat_end", { series_id: series.id }, as(people.Ann!), { now: new Date(base) });
  for (const id of ["w1", "w2", "w3"]) {
    const k = await kumiOf(id);
    assert.deepEqual(await alerts(k), [4000], id);
    assert.deepEqual((await ptRefunds(k)).map((r) => [r.amount_cents, r.destination, r.status]), [[4000, "playtomic", "sent"]], id);
  }
});

test("a taken-over booking made shorter: the part paid in Playtomic goes back there, and a later cancel counts only what's left", async () => {
  pt.bookings.push(booking("sh1", 24 * 5 + 9, { court: "pt-2" }));
  await sync();
  await run(db, "mirror.take_over", { booking_ids: ["sh1"] }, owner, { now: new Date(base) });
  const k = await kumiOf("sh1");
  const p = await plan(db, "booking.extend", { booking_id: k, minutes: 60 }, owner, { now: new Date(base) });
  assert.match(p.plan.summary.en, /paid in Playtomic goes back there .*refund it in Playtomic/);
  await run(db, "booking.extend", { booking_id: k, minutes: 60 }, owner, { now: new Date(base) });
  const first = await alerts(k);
  assert.equal(first.length, 1);
  assert.ok(first[0]! > 0 && first[0]! < 4000, String(first));
  const c = await plan(db, "booking.cancel", { booking_id: k, refund: "full" }, owner, { now: new Date(base) });
  assert.match(c.plan.summary.en, /goes back, as chosen: refund it in Playtomic/, "the staff's own choice, not the rule");
  await run(db, "booking.cancel", { booking_id: k, refund: "full" }, owner, { now: new Date(base) });
  const all = await alerts(k);
  assert.equal(all.length, 2);
  assert.equal(all[0]! + all[1]!, 4000, "never more than was paid there");
});

test("Playtomic moving a taken-over booking to another court: one court time, the move is a difference, and nothing goes 'gone'", async () => {
  pt.bookings.push(booking("mv1", 24 * 6 + 3, { court: "pt-1" }));
  await sync();
  await run(db, "mirror.take_over", { booking_ids: ["mv1"] }, owner, { now: new Date(base) });
  const k = await kumiOf("mv1");
  pt.bookings = pt.bookings.map((b) => b.booking_id === "mv1" ? booking("mv1", 24 * 6 + 3, { court: "pt-2" }) : b);
  await sync();
  // One court time for it: the taken-over booking's own, and no mirror hold on either court.
  const times = await db.selectFrom("court_time").select(["kind", "booking_id"]).where("active", "=", true)
    .where(sql<boolean>`during && tstzrange(${at(24 * 6 + 3)}, ${at(24 * 6 + 4.5)})`).execute();
  assert.deepEqual(times.map((t) => [t.kind, t.booking_id === k]), [["booking", true]], JSON.stringify(times));
  assert.equal((await db.selectFrom("mirror_booking").select("ref").where("ref", "=", "mv1:pt-2").executeTakeFirst()), undefined, "no fresh hold for it");
  assert.equal((await mb("mv1:pt-1"))?.status, "taken", "not gone");
  const c = await comparison(db, new Date(base), 14);
  assert.ok(c.diffs.some((d) => d.kind === "moved" && d.key.startsWith("moved:mv1")), JSON.stringify(c.diffs.filter((d) => d.key.includes("mv1"))));
});

test("a mirror change worked out before a take-over and applied after it leaves the take-over alone", async () => {
  pt.bookings.push(booking("race1", 24 * 7 + 5, { court: "pt-2" }));
  await sync();
  pt.bookings = pt.bookings.map((b) => b.booking_id === "race1" ? booking("race1", 24 * 7 + 5.5, { court: "pt-2" }) : b);
  const fetched = pt.bookings.map(normalize).filter((b): b is NonNullable<ReturnType<typeof normalize>> => b !== null);
  const diff = await diffMirror(db, fetched, new Date(base - 864e5), new Date(base + 30 * 864e5));
  assert.ok(diff.changes.some((c) => c.ref === "race1:pt-2"));
  await run(db, "mirror.take_over", { booking_ids: ["race1"] }, owner, { now: new Date(base) });
  await runAsSystem(db, "mirror.apply", { changes: diff.changes }, "mirror:playtomic", { now: new Date(base) });
  const m = await mb("race1:pt-2");
  assert.equal(m?.status, "taken");
  assert.equal(m?.court_time_id, null);
});

test("cancelled and refunded in Playtomic, then cancelled here: the preview says Playtomic refunded it, and nobody is told to refund it", async () => {
  pt.bookings.push(booking("rf1", 24 * 8 + 5, { court: "pt-1" }));
  await sync();
  await run(db, "mirror.take_over", { booking_ids: ["rf1"] }, owner, { now: new Date(base) });
  const k = await kumiOf("rf1");
  pt.bookings = pt.bookings.map((b) => b.booking_id === "rf1" ? booking("rf1", 24 * 8 + 5, { court: "pt-1", cancelled: true, paid: "REFUNDED" }) : b);
  await sync();
  const p = await plan(db, "booking.cancel", { booking_id: k }, owner, { now: new Date(base) });
  assert.match(p.plan.summary.en, /already refunded there/);
  await run(db, "booking.cancel", { booking_id: k }, owner, { now: new Date(base) });
  assert.deepEqual(await alerts(k), []);
  // The history says it was cancelled here, not "now booking".
  const h = (await archiveOf(db, people.Ann!)).find((x) => x.booking_id === "rf1")!;
  assert.equal(h.taken_over_as, null);
  assert.ok(h.cancelled_here_as);
});

test("taken over unpaid, then paid in Playtomic: the comparison says so, and the desk marks it paid there", async () => {
  pt.bookings.push(booking("up1", 24 * 9 + 13, { court: "pt-1", paid: "PENDING" }));
  await sync();
  await run(db, "mirror.take_over", { booking_ids: ["up1"] }, owner, { now: new Date(base) });
  const k = await kumiOf("up1");
  await rejects(plan(db, "booking.paid_in_playtomic", { booking_id: k }, owner, { now: new Date(base) }), "error.not_paid_in_playtomic");
  pt.bookings = pt.bookings.map((b) => b.booking_id === "up1" ? booking("up1", 24 * 9 + 13, { court: "pt-1", paid: "PAID" }) : b);
  await sync();
  const c = await comparison(db, new Date(base), 14);
  const d = c.diffs.find((x) => x.key === "paid:up1");
  assert.ok(d && d.booking_id === k, JSON.stringify(c.diffs.filter((x) => x.key.includes("up1"))));
  const desk = ((await run(db, "person.create", { display_name: "Dee Desk", email: "dee@example.test" }, owner)).result as { person_id: string }).person_id;
  await run(db, "role.assign", { person_id: desk, role: "front_desk" }, owner);
  const p = await plan(db, "booking.paid_in_playtomic", { booking_id: k }, as(desk), { now: new Date(base) });
  assert.match(p.plan.summary.en, /Mark booking .* paid in Playtomic: \$40\.00/);
  await run(db, "booking.paid_in_playtomic", { booking_id: k }, as(desk), { now: new Date(base) });
  const pays = await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(["payment.method", "payment.amount_cents"])
    .where("booking_player.booking_id", "=", k).execute();
  assert.deepEqual(pays, [{ method: "playtomic", amount_cents: 4000 }]);
  assert.equal((await comparison(db, new Date(base), 14)).diffs.some((x) => x.key === "paid:up1"), false);
  await rejects(plan(db, "booking.paid_in_playtomic", { booking_id: k }, as(desk), { now: new Date(base) }), "error.booking_paid_in_full");
});

test("bookings further ahead than members can book are archived too, up to a year: for the archive only", async () => {
  // The club's book-ahead is a couple of weeks; Playtomic has a weekly series out to four months.
  pt.bookings.push(booking("far1", 24 * 120 + 5, { court: "pt-1", type: "RECURRING_BOOKING" }));
  const lastRead = new Map<number, number>();
  for (let n = 0; n < 20; n++) await syncMirrorFar(db, client(), { now: new Date(base), everyMs: 6 * H, lastRead });
  assert.ok(await db.selectFrom("playtomic_booking").select("booking_id").where("booking_id", "=", "far1").executeTakeFirst(), "archived");
  assert.equal(await mb("far1:pt-1"), undefined, "held by nothing: past what Kumi sells");
});

// ---- The second review: the marker learns ids, and a rejoin starts fresh ----
test("an id matched by address only is learned: a later booking listing it without the address keeps them out", async () => {
  const gil = ((await run(db, "person.create", { display_name: "Gil Member", email: "gil@example.test" }, owner)).result as { person_id: string }).person_id;
  await run(db, "privacy.erase", { person_id: gil }, as(gil), { now: new Date(base) });
  await archiveBookings(db, [booking("gil-1", 24 * 30 + 4, { owner: "u-gil", players: [{ participant_id: "u-gil", name: "Gil Hart", email: "gil@example.test" }] })], new Date(base));
  assert.equal((await players("gil-1"))[0]!.name, null);
  assert.ok(await db.selectFrom("playtomic_erased").select("id").where("playtomic_id", "=", "u-gil").executeTakeFirst(), "learned");
  await archiveBookings(db, [booking("gil-2", 24 * 31 + 4, { owner: "u-gil", players: [{ participant_id: "u-gil", name: "Gil Hart" }] })], new Date(base));
  assert.equal((await players("gil-2"))[0]!.name, null, "no address on this row, still out");
});

test("someone who deleted their account and joined again starts fresh from that day: earlier bookings stay out, later ones come in", async () => {
  const hal = ((await run(db, "person.create", { display_name: "Hal Member", email: "hal@example.test" }, owner)).result as { person_id: string }).person_id;
  await db.insertInto("external_ref").values({ entity: "person", entity_id: hal, system: "playtomic", external_id: "u-hal" }).execute();
  await run(db, "privacy.erase", { person_id: hal }, as(hal), { now: new Date(base) });
  // Hal signs up again with the same address: a new person here.
  const again = ((await run(db, "person.create", { display_name: "Hal Again", email: "HAL@example.test" }, owner)).result as { person_id: string }).person_id;
  const marks = await db.selectFrom("playtomic_erased").select(["playtomic_id", "rejoined_at", "erased_person_id"]).where("erased_person_id", "=", hal).execute();
  assert.ok(marks.length >= 2 && marks.every((m) => m.rejoined_at), JSON.stringify(marks));
  const rejoined = new Date(marks[0]!.rejoined_at!);
  await archiveBookings(db, [
    booking("hal-before", -24 * 40, { owner: "u-hal", players: [{ participant_id: "u-hal", name: "Hal Hart", email: "hal@example.test" }] }),
    booking("hal-after", (rejoined.getTime() - base) / H + 24 * 3, { owner: "u-hal", players: [{ participant_id: "u-hal", name: "Hal Hart", email: "hal@example.test" }] }),
  ], new Date(base));
  assert.equal((await players("hal-before"))[0]!.name, null, "from before the rejoin: out");
  const after = (await players("hal-after"))[0]!;
  assert.deepEqual([after.name, after.person_id], ["Hal Hart", again], "after it: theirs");
  // Deleted again: marked afresh, the rejoin no longer counts.
  await run(db, "privacy.erase", { person_id: again }, as(again), { now: new Date(base) });
  const fresh = await db.selectFrom("playtomic_erased").select(["rejoined_at", "erased_person_id"]).where("playtomic_id", "=", "u-hal").executeTakeFirstOrThrow();
  assert.deepEqual([fresh.rejoined_at, fresh.erased_person_id], [null, again]);
});
