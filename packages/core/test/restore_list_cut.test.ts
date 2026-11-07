// After a restore (payments_after_restore.ts): when the payment provider's list was cut short (StripeProvider.listSince
// stops at 20,000 of each), the staff are told that older payments since the backup weren't looked at, in an alert of
// its own that stays on Today until someone marks it handled: the server's 30-second job, which closes the "paid with
// nothing here" alert once Payments has nothing left, leaves it alone (no later check covers those payments).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { checkMoneyAfterRestore, messageHandlers, processOutbox, reviewFound, run, runAsSystem, setPaymentProvider, staffAlerts, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
const NOW = new Date("2026-11-06T18:00:00Z");
/** The provider's answer, with or without the cut. */
class Listing extends TestProvider {
  cut = false;
  asked: Array<{ since: Date; account: string | null | undefined }> = [];
  override async listSince(since: Date, account?: string | null) { this.asked.push({ since, account }); return { intents: [], refunds: [], cut: this.cut }; }
}
const provider = new Listing();
const alertsOf = (job: string) => db.selectFrom("event_outbox").select(["id", "payload"]).where("topic", "=", "ops.failed").where(sql<string>`payload->>'job'`, "=", job).execute();
const alert = () => alertsOf("restore_unchecked");

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(provider);
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en", auth: "passkey" } as Actor;
});
after(async () => { setPaymentProvider(new TestProvider()); await drop(); });

test("a restore whose provider list was whole, with nothing missing: nothing to tell the staff", async () => {
  await db.insertInto("restore_check").values({ since: new Date("2026-11-05T10:00:00Z") }).execute();
  assert.deepEqual(await checkMoneyAfterRestore(db, NOW), { found: 0, refunds: 0, checked: 1 });
  assert.equal(provider.asked.length, 1);
  assert.equal(provider.asked[0]!.since.toISOString(), "2026-11-05T09:00:00.000Z", "from an hour before the copy's newest payment");
  assert.deepEqual(await alert(), []);
  assert.deepEqual(await alertsOf("restore_money"), []);
});

test("a restore whose provider list was cut short: the staff are told older payments since the backup weren't checked", async () => {
  provider.cut = true;
  await db.insertInto("restore_check").values({ since: new Date("2026-11-05T10:00:00Z") }).execute();
  assert.deepEqual(await checkMoneyAfterRestore(db, NOW), { found: 0, refunds: 0, checked: 1 });
  const [a] = await alert();
  assert.ok(a, "an alert for the staff, even with nothing found");
  const p = a!.payload as { error: string; words: { en: string; es: string } };
  assert.equal(p.words.en, "Only the newest 20,000 card payments since the backup were checked: older ones weren't. Look for them in the payment provider's own dashboard.");
  assert.equal(p.words.es, "Solo se revisaron los 20.000 pagos con tarjeta más recientes desde la copia: los anteriores no. Búscalos en el panel del propio proveedor de pagos.");
  assert.match(p.error, /Only the newest 20,000 card payments/);
  assert.deepEqual(await alertsOf("restore_money"), [], "nothing found: no \"paid with nothing here\" alert");
  assert.equal((await db.selectFrom("restore_check").select("id").where("done_at", "is", null).execute()).length, 0, "each check once");
});

test("the cut-short alert stays on Today through the 30-second job's runs, until someone marks it handled", async () => {
  await processOutbox(db, messageHandlers);
  // Whichever alert says so (found by its words, not its job).
  const [a] = (await db.selectFrom("event_outbox").select(["id", "payload"]).where("topic", "=", "ops.failed").execute())
    .filter((e) => /newest 20,000/.test((e.payload as { error: string }).error));
  assert.ok(a, "the staff were told");
  const open = () => staffAlerts(db, owner.personId!, NOW).then((x) => x.open.filter((o) => o.event_id === a!.id && o.kind === "ops_restore_staff"));
  assert.equal((await open()).length, 1, "on the owner's Today");
  // The server's 30-second job, run a while (it closes the restore's other alert once Payments has nothing left).
  for (let i = 1; i <= 40; i++) await reviewFound(db, new Date(NOW.getTime() + i * 30_000));
  assert.equal((await open()).length, 1, "still there after 20 minutes of the job");
  assert.equal((await db.selectFrom("staff_alert").select("id").where("event_id", "=", a!.id).execute()).length, 0, "closed by nobody");
  // The owner marks it handled: gone from the list, with their name.
  await run(db, "alert.handle", { event_id: a!.id, kind: "ops_restore_staff" }, owner, { now: NOW });
  assert.equal((await open()).length, 0);
  const done = (await staffAlerts(db, owner.personId!, NOW)).handled.find((h) => h.event_id === a!.id);
  assert.equal(done?.handled_by, "Robin Hale");
});
