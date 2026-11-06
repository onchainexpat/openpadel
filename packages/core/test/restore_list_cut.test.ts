// After a restore (payments_after_restore.ts): when the payment provider's list was cut short (StripeProvider.listSince
// stops at 20,000 of each), the staff are told that older payments since the backup weren't looked at.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { checkMoneyAfterRestore, runAsSystem, setPaymentProvider, TestProvider, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>;
const NOW = new Date("2026-11-06T18:00:00Z");
/** The provider's answer, with or without the cut. */
class Listing extends TestProvider {
  cut = false;
  asked: Array<{ since: Date; account: string | null | undefined }> = [];
  override async listSince(since: Date, account?: string | null) { this.asked.push({ since, account }); return { intents: [], refunds: [], cut: this.cut }; }
}
const provider = new Listing();
const alert = () => db.selectFrom("event_outbox").select("payload").where("topic", "=", "ops.failed").where(sql<string>`payload->>'job'`, "=", "restore_money").execute();

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(provider);
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
});
after(async () => { setPaymentProvider(new TestProvider()); await drop(); });

test("a restore whose provider list was whole, with nothing missing: nothing to tell the staff", async () => {
  await db.insertInto("restore_check").values({ since: new Date("2026-11-05T10:00:00Z") }).execute();
  assert.deepEqual(await checkMoneyAfterRestore(db, NOW), { found: 0, refunds: 0, checked: 1 });
  assert.equal(provider.asked.length, 1);
  assert.equal(provider.asked[0]!.since.toISOString(), "2026-11-05T09:00:00.000Z", "from an hour before the copy's newest payment");
  assert.deepEqual(await alert(), []);
});

test("a restore whose provider list was cut short: the staff are told older payments since the backup weren't checked", async () => {
  provider.cut = true;
  await db.insertInto("restore_check").values({ since: new Date("2026-11-05T10:00:00Z") }).execute();
  assert.deepEqual(await checkMoneyAfterRestore(db, NOW), { found: 0, refunds: 0, checked: 1 });
  const [a] = await alert();
  assert.ok(a, "an alert for the staff, even with nothing found");
  const p = a!.payload as { error: string; words: { en: string; es: string } };
  assert.match(p.words.en, /^Only the newest 20,000 payments were checked: older ones since the backup weren't\./);
  assert.match(p.words.es, /^Solo se revisaron los 20\.000 pagos más recientes: los anteriores desde la copia no\./);
  assert.match(p.error, /Only the newest 20,000 payments were checked/);
  assert.equal((await db.selectFrom("restore_check").select("id").where("done_at", "is", null).execute()).length, 0, "each check once");
});
