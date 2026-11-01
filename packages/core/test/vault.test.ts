import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { generateVapidKeys, grantableActions, isSealedText, openBytes, openText, plan, pushKeys, resealAll, run, runAsSystem, sealBytes, sealText, secretKeyStatus, setSecretKeys,
  stageVaultUpload, vaultDocument, vaultList, vaultSecret, KumiError, SealedError, type Actor, type Db } from "../src/index.ts";

const KEY_A = Buffer.alloc(32, 7).toString("base64"), KEY_B = Buffer.alloc(32, 9).toString("hex");
let db: Db, drop: () => Promise<void>, owner: Actor, manager: Actor;
const NOW = new Date("2026-11-30T16:00:00Z");
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(3000, 65)]);
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}

before(async () => {
  ({ db, drop } = await freshDb());
  setSecretKeys({ current: KEY_A });
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "two_factor" };
  const mia = ((await run(db, "person.create", { display_name: "Mia", email: "mia@example.test" }, owner, { now: NOW })).result as any).person_id;
  await run(db, "role.assign", { person_id: mia, role: "manager" }, owner, { now: NOW });
  manager = { personId: mia, via: "test", lang: "en", auth: "two_factor" };
});
after(async () => { setSecretKeys({}); await drop(); });

test("sealing: text and bytes round-trip, a fresh nonce each time, and the key's id up front", () => {
  setSecretKeys({ current: KEY_A });
  const a = sealText("JBSWY3DPEHPK3PXP"), b = sealText("JBSWY3DPEHPK3PXP");
  assert.ok(isSealedText(a) && a !== b && !a.includes("JBSWY3"));
  assert.equal(openText(a), "JBSWY3DPEHPK3PXP");
  assert.equal(a.split(":")[2], secretKeyStatus().current);
  assert.deepEqual(openBytes(sealBytes(PDF)), PDF);
  assert.equal(openText("plain from before the key"), "plain from before the key");
  // Under another key it won't open; tampered, it won't either.
  setSecretKeys({ current: KEY_B });
  assert.throws(() => openText(a), SealedError);
  setSecretKeys({ current: KEY_A });
  const box = Buffer.from(a.split(":")[3]!, "base64url"); box[box.length - 1]! ^= 1;
  assert.throws(() => openText(`enc:v1:${a.split(":")[2]}:${box.toString("base64url")}`));
  assert.throws(() => setSecretKeys({ current: "too-short" }), /32 random bytes/);
});

test("without a key (development) secrets are kept as they are", () => {
  setSecretKeys({});
  assert.equal(sealText("x"), "x");
  assert.deepEqual(openBytes(sealBytes(Buffer.from("doc"))), Buffer.from("doc"));
  setSecretKeys({ current: KEY_A });
});

test("rotating: what's under the old key moves to the new one, and plain rows from before get sealed", async () => {
  setSecretKeys({});
  const plainKeys = await pushKeys(db);                       // made with no key: stored as it is
  assert.equal((await db.selectFrom("push_key").select("private_key").executeTakeFirstOrThrow()).private_key, plainKeys.privateKey);
  setSecretKeys({ current: KEY_A });
  const r1 = await resealAll(db);
  assert.ok(r1.sealed >= 1, JSON.stringify(r1));
  const stored = (await db.selectFrom("push_key").select("private_key").executeTakeFirstOrThrow()).private_key;
  assert.ok(isSealedText(stored));
  assert.deepEqual(await pushKeys(db), plainKeys);           // opens to the same keys
  // A new key, the old one as previous: everything moves across, and still opens.
  setSecretKeys({ current: KEY_B, previous: KEY_A });
  const r2 = await resealAll(db);
  assert.equal(r2.unreadable, 0);
  assert.ok(r2.resealed >= 1);
  setSecretKeys({ current: KEY_B });
  assert.deepEqual(await pushKeys(db), plainKeys);
  assert.equal((await resealAll(db)).resealed, 0);
  // Missing the key it was sealed under: counted, never guessed at.
  setSecretKeys({ current: KEY_A });
  assert.ok((await resealAll(db)).unreadable >= 1);
  setSecretKeys({ current: KEY_B });
  void generateVapidKeys;
});

test("the vault: a secret goes in by its upload, and neither the input nor the change log ever has the value", async () => {
  setSecretKeys({ current: KEY_B });
  const value = "sk_live_supplier_1234567890abcd";
  const up = await stageVaultUpload(db, owner.personId!, { kind: "secret", value }, NOW);
  assert.equal(up.last4, "abcd");
  const r = await run(db, "vault.add", { name: "Lighting supplier API key", upload_id: up.upload_id, note: "for the court lights" }, owner, { now: NOW });
  assert.equal(r.plan.summary.en, "Keep a secret ending in abcd in the vault as \"Lighting supplier API key\". Only the owner sees the vault, and what's in it is sealed with the server's own key.");
  // Nowhere in the run log, the change log or the stored bytes.
  const runs = await sql<{ t: string }>`SELECT input::text || plan::text || coalesce(result::text, '') AS t FROM action_run`.execute(db);
  const changes = await sql<{ t: string }>`SELECT coalesce(before::text, '') || after::text AS t FROM entity_change`.execute(db);
  const blob = (await db.selectFrom("vault_blob").select("bytes").where("id", "=", up.upload_id).executeTakeFirstOrThrow()).bytes;
  for (const row of [...runs.rows, ...changes.rows]) assert.ok(!row.t.includes(value) && !row.t.includes("supplier_1234"), row.t.slice(0, 200));
  assert.ok(!blob.includes(Buffer.from(value)));
  // The list has the end only; Kumi itself can read it by name, on the server.
  const list = await vaultList(db);
  assert.deepEqual(list.map((x) => [x.name, x.last4]), [["Lighting supplier API key", "abcd"]]);
  assert.ok(!JSON.stringify(list).includes(value));
  assert.equal(await vaultSecret(db, "lighting supplier api key"), value);
  // The same upload can't be used twice, and the name is taken.
  await rejects(plan(db, "vault.add", { name: "Again", upload_id: up.upload_id }, owner, { now: NOW }), "error.vault_upload_gone");
  const up2 = await stageVaultUpload(db, owner.personId!, { kind: "secret", value: "1234" }, NOW);
  await rejects(plan(db, "vault.add", { name: "lighting SUPPLIER api key", upload_id: up2.upload_id }, owner, { now: NOW }), "error.vault_name_taken");
  // A short secret shows no end at all.
  assert.equal(up2.last4, null);
});

test("the vault is the owner's: a manager is told no, and no role the club makes can hold it", async () => {
  const up = await stageVaultUpload(db, manager.personId!, { kind: "secret", value: "alarm code 4421-9981" }, NOW);
  await rejects(plan(db, "vault.add", { name: "Alarm", upload_id: up.upload_id }, manager, { now: NOW }), "error.forbidden_reason");
  // Someone else's upload isn't the owner's to use either.
  await rejects(plan(db, "vault.add", { name: "Alarm", upload_id: up.upload_id }, owner, { now: NOW }), "error.vault_upload_gone");
  await rejects(plan(db, "vault.add", { name: "Alarm", upload_id: up.upload_id }, { ...owner, agentId: "00000000-0000-7000-8000-00000000aaaa" }, { now: NOW }), "error.vault_not_for_agents");
  assert.ok(!(await grantableActions(db)).some((a) => a.startsWith("vault.")));
});

test("documents: only PDFs and pictures by their first bytes, under the size cap; each download is kept", async () => {
  await assert.rejects(stageVaultUpload(db, owner.personId!, { kind: "document", bytes: Buffer.from("<svg onload=alert(1)>"), filename: "x.pdf" }, NOW), (e: any) => e.code === "error.vault_doc_type");
  await assert.rejects(stageVaultUpload(db, owner.personId!, { kind: "document", bytes: Buffer.alloc(2_000_001, 1), filename: "big.pdf" }, NOW), (e: any) => e.code === "error.vault_doc_big");
  const up = await stageVaultUpload(db, owner.personId!, { kind: "document", bytes: PDF, filename: "Insurance 2026/27 (signed).pdf" }, NOW);
  assert.equal(up.content_type, "application/pdf");
  const r = await run(db, "vault.add", { name: "Insurance", upload_id: up.upload_id }, owner, { now: NOW });
  assert.match(r.plan.summary.en, /the document Insurance 2026_27 \(signed\)\.pdf \(3 KB\)/);
  const id = (r.result as any).item_id;
  const doc = (await vaultDocument(db, id, owner.personId!))!;
  assert.deepEqual(doc.bytes, PDF);
  assert.equal(doc.content_type, "application/pdf");
  const list = await vaultList(db);
  assert.equal(list.find((x) => x.id === id)!.downloads.length, 1);
  // A newer copy replaces it (and can be undone); taking it out hides it.
  const up2 = await stageVaultUpload(db, owner.personId!, { kind: "document", bytes: Buffer.concat([PDF, Buffer.from("v2")]), filename: "insurance-v2.pdf" }, NOW);
  const rep = await run(db, "vault.replace", { item_id: id, upload_id: up2.upload_id }, owner, { now: NOW });
  assert.equal(rep.plan.summary.en, "Replace \"Insurance\" in the vault with the document insurance-v2.pdf (3 KB). The one before stays sealed in the change history, so this can be undone.");
  assert.equal((await vaultDocument(db, id, owner.personId!))!.filename, "insurance-v2.pdf");
  await run(db, "vault.remove", { item_id: id }, owner, { now: NOW });
  assert.equal(await vaultDocument(db, id, owner.personId!), null);
});
