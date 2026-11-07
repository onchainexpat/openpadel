// After a restore, what the staff are told (payments_after_restore.ts, messages.ts): nothing failed, so the alert says
// "After a restore", what to do and where (Reports), counted plainly, in whole sentences; it opens on Reports, and when
// nothing is left it just closes (no "working again"). Found on a browser check of the staff app (Nov 2026): the alert
// read "checking the card payments made after a backup failed ... Run kumi doctor", sent staff to Payments, said
// "2 card payment(s)", and was cut mid-word ("Confirmations sent after a backu.").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { checkMoneyAfterRestore, fitWords, messageHandlers, processOutbox, reviewFound, run, runAsSystem, setPaymentProvider, staffAlerts, TestProvider, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
const NOW = new Date("2026-11-06T18:00:00Z");
/** Two card payments the provider has that the copy doesn't. */
class Listing extends TestProvider {
  override async listSince() {
    return { intents: [1, 2].map((n) => ({ ref: `pi_found_${n}`, status: "succeeded" as const, amountCents: 2500 * n, created: new Date("2026-11-06T12:00:00Z"), kumiPaymentId: null, kumiChargeId: null, email: null, description: null })), refunds: [] };
  }
}

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(new Listing());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as { owner_person_id: string }).owner_person_id, via: "test", lang: "en", auth: "passkey" } as Actor;
});
after(async () => { setPaymentProvider(new TestProvider()); await drop(); });

test("whole sentences fit an alert: the last one left off, never a word cut in half", () => {
  const a = { en: "First sentence here.", es: "Primera frase aquí." }, long = { en: "x".repeat(290) + " tail.", es: "y".repeat(10) };
  assert.deepEqual(fitWords([a, long], 300), { en: "First sentence here.", es: "Primera frase aquí. yyyyyyyyyy" });
  const one = fitWords([{ en: `${"word ".repeat(80)}end.`, es: "corta." }], 300);
  assert.ok(one.en.length <= 300 && one.en.endsWith("word…"), one.en);
});

test("payments found after a restore: \"After a restore\", what to do in Reports, counted plainly; not a failure", async () => {
  await db.insertInto("restore_check").values({ since: new Date("2026-11-05T10:00:00Z") }).execute();
  assert.deepEqual(await checkMoneyAfterRestore(db, NOW), { found: 2, refunds: 0, checked: 1 });
  await processOutbox(db, messageHandlers);
  const [m] = await db.selectFrom("outbound_message").select(["kind", "subject", "body", "link", "lang"]).where("person_id", "=", owner.personId!).where("channel", "=", "inbox").execute();
  assert.equal(m?.kind, "ops_restore_staff");
  assert.equal(m!.subject, "After a restore: card payments to look at");
  assert.equal(m!.body, "2 card payments the payment provider took have no record here: refund each, or record it as paid elsewhere, in Reports under \"Paid with nothing here\". Confirmations sent after the backup may refer to things this copy doesn't have.");
  assert.doesNotMatch(`${m!.subject} ${m!.body}`, /failed|kumi doctor|\(s\)/);
  assert.equal(m!.link, "/reports", "it opens where they're handled");
  const open = await staffAlerts(db, owner.personId!, NOW);
  assert.equal(open.open.filter((o) => o.kind === "ops_restore_staff").length, 1, "on Today");
  // Both handled on Reports: the alert closes by itself, with no "working again" message.
  for (const f of await db.selectFrom("payment_found").select("id").execute()) await run(db, "payment_found.paid_elsewhere", { id: f.id }, owner, { now: NOW });
  await reviewFound(db, new Date(NOW.getTime() + 60_000));
  await processOutbox(db, messageHandlers);
  assert.equal((await staffAlerts(db, owner.personId!, new Date(NOW.getTime() + 60_000))).open.filter((o) => o.kind === "ops_restore_staff").length, 0, "closed");
  assert.deepEqual(await db.selectFrom("outbound_message").select("subject").where("kind", "=", "ops_cleared_staff").execute(), []);
});

test("the Spanish words: the same, plainly counted, pointing at Informes", async () => {
  const [e] = await db.selectFrom("event_outbox").select("payload").where("topic", "=", "ops.failed").execute();
  const words = (e!.payload as { words: { es: string } }).words;
  assert.equal(words.es, "2 pagos con tarjeta que cobró el proveedor de pagos no constan aquí: devuelve cada uno, o regístralo como pagado por otra vía, en Informes, en \"Pagado sin registro\". Las confirmaciones enviadas después de la copia pueden referirse a cosas que esta copia no tiene.");
});
