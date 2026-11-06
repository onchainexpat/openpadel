// Passes and promo codes over a restore (after_restore.ts GONE passes, pass_returns, promos_off, promo_uses): a copy
// from before a pass's refund, a use or a promo code's last use must not give any of them back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { connect, migrate, plan, run, runAsSystem, setPaymentProvider, TestProvider, type Actor, type Db } from "@kumi/core";
import { afterRestore, readSentBefore } from "../src/after_restore.ts";

const ADMIN = process.env.KUMI_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const urlFor = (name: string) => ADMIN.replace(/\/[^/]*$/, `/${name}`);
const tag = Math.random().toString(16).slice(2, 10);
const LIVE = `kumi_test_value_live_${tag}`, COPY = `kumi_test_value_copy_${tag}`;
const TZ = "America/Los_Angeles";
let admin: Kysely<any>, live: Db, owner: Actor, desk: Actor, clinic: string;
const P: Record<string, string> = {}, ids: Record<string, string> = {};
const as = (n: string): Actor => ({ personId: P[n]!, via: "test", lang: "en" });
const join = async (db: Db, who: string) => (await run(db, "enrolment.join", { program_id: clinic, person_id: P[who] }, as(who))).result as { enrolment_id: string; payment_id: string };

before(async () => {
  const pool = new pg.Pool({ connectionString: ADMIN, max: 1 }); pool.on("error", () => {});
  admin = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  await sql.raw(`CREATE DATABASE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  await migrate(live);
  await sql`ALTER TABLE club ALTER COLUMN two_factor SET DEFAULT 'off'`.execute(live);
  setPaymentProvider(new TestProvider());
  const s = await runAsSystem(live, "club.setup", { name: "Value Padel", time_zone: TZ, owner_email: "owner@example.test", owner_name: "Olu Owner" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" } as Actor;
  for (const n of ["Lee", "Ann", "Ben"]) P[n] = ((await run(live, "person.create", { display_name: `${n} Test`, email: `${n.toLowerCase()}@example.test` }, owner)).result as { person_id: string }).person_id;
  await run(live, "role.assign", { person_id: P.Lee, role: "front_desk" }, owner);
  desk = as("Lee");
  const loc = ((await run(live, "location.create", { name: "East", time_zone: TZ }, owner)).result as any).location_id;
  const court = ((await run(live, "court.create", { location_id: loc, name: "Court 1" }, owner)).result as any).court_id;
  clinic = ((await run(live, "program.create", { location_id: loc, kind: "clinic", name: "Beginners", capacity: 10, price_cents: 6000 }, owner)).result as any).program_id;
  await run(live, "session.add", { program_id: clinic, starts_at: "2026-12-10T18:00:00-08:00", ends_at: "2026-12-10T19:30:00-08:00", court_ids: [court] }, owner);
  await run(live, "program.publish", { program_id: clinic }, owner);
  const product = ((await run(live, "pass_product.set", { name: "3 clinic places", covers: "programs", program_kinds: ["clinic"], price_cents: 15000, uses: 3 }, owner)).result as any).product_id;
  ids.refunded = ((await run(live, "pass.sell", { person_id: P.Ann, product_id: product, cents: 15000, method: "cash" }, desk)).result as any).pass_id;
  ids.used = ((await run(live, "pass.sell", { person_id: P.Ben, product_id: product, cents: 15000, method: "cash" }, desk)).result as any).pass_id;
  ids.promo = ((await run(live, "promo_code.set", { code: "AUTUMN10", kind: "percent", percent: 10, applies_to: ["programs"], max_uses: 1 }, owner)).result as any).promo_code_id;
  ids.off = ((await run(live, "promo_code.set", { code: "SPRING5", kind: "percent", percent: 5, applies_to: ["programs"] }, owner)).result as any).promo_code_id;
  await live.destroy();
  await sql.raw(`CREATE DATABASE ${COPY} TEMPLATE ${LIVE}`).execute(admin);
  live = connect(urlFor(LIVE));
  // After the copy: Ann's pass refunded at the desk; Ben uses one of his; Ann takes the promo's only use; SPRING5 off.
  await run(live, "pass.refund", { pass_id: ids.refunded }, { ...owner } as Actor).catch(async (e) => { throw e; });
  const ben = await join(live, "Ben");
  await run(live, "payment.use_pass", { payment_id: ben.payment_id, pass_id: ids.used }, as("Ben"));
  const ann = await join(live, "Ann");
  await run(live, "payment.use_promo", { payment_id: ann.payment_id, code: "AUTUMN10" }, as("Ann"));
  await run(live, "promo_code.set", { promo_code_id: ids.off, code: "SPRING5", kind: "percent", percent: 5, applies_to: ["programs"], active: false }, owner);
});
after(async () => {
  await live.destroy();
  for (const d of [LIVE, COPY]) await sql.raw(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).execute(admin);
  await admin.destroy();
});

test("a restore to before a pass's refund, a use and a promo code's last use gives none of them back", async () => {
  const r = await afterRestore(urlFor(COPY), await readSentBefore(urlFor(LIVE)));
  const db = connect(urlFor(COPY));
  try {
    const refunded = await db.selectFrom("pass").select(["status", "uses_left"]).where("id", "=", ids.refunded!).executeTakeFirstOrThrow();
    assert.deepEqual([refunded.status, refunded.uses_left], ["refunded", 0], "refunded since: no uses come back");
    assert.equal((await db.selectFrom("pass").select("uses_left").where("id", "=", ids.used!).executeTakeFirstOrThrow()).uses_left, 2, "used since: not usable twice");
    assert.ok(r.gone.check?.some((c) => c.what === "pass"), "listed for the staff");
    assert.equal((await db.selectFrom("promo_code").select("active").where("id", "=", ids.off!).executeTakeFirstOrThrow()).active, false, "turned off since: off");
    const e = await join(db, "Ben");
    await assert.rejects(plan(db, "payment.use_promo", { payment_id: e.payment_id, code: "AUTUMN10" }, as("Ben")), /used as many times/, "its only use was taken since: not usable again");
  } finally { await db.destroy(); }
});
