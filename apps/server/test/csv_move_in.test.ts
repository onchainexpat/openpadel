// Reading a Playtomic customer export for the move-in (csv.ts, readMoveInCsv): each wallet column, never a total,
// one membership a row with the day it runs until, read day-first unless the club writes the US way.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { readDay, readMoveInCsv } from "../src/csv.ts";

test("each wallet column is a wallet, a blank cell an empty one; a total, a pending or used column isn't one", () => {
  const csv = [
    "Name;Email;Playtomic ID;Wallet Club;Saldo monedero Bonos;Total balance;Saldo pendiente;Credits used;Category;Expiry date;Permanencia",
    "Ann Lee;ANN@example.test;pt-1;25,50 €;4,50 €;30,00 €;3;2;Oro;30/11/2026;31/03/2027",
    "Ben;;pt-2;0;;0;;;;;",
    "Cal;cal@example.test;;;;;;;Plata;2026-12-15;",
    "Dee;;;10 €;;10 €;;;;;",
    "Eve;eve@example.test;;;;;;;Bronce;31/02/2026;",
  ].join("\n");
  const r = readMoveInCsv(csv, { dayFirst: true });
  assert.equal(r.fatal, undefined);
  assert.deepEqual(r.walletColumns, [{ ref: "walletclub", name: "Wallet Club" }, { ref: "saldomonederobonos", name: "Saldo monedero Bonos" }]);
  assert.deepEqual(r.rows[0], { line: 2, name: "Ann Lee", email: "ann@example.test", playtomic_id: "pt-1",
    wallets: [{ ref: "walletclub", name: "Wallet Club", balance: "25,50 €" }, { ref: "saldomonederobonos", name: "Saldo monedero Bonos", balance: "4,50 €" }],
    benefits: [{ name: "Oro", until: "2026-11-30", commitment: "31/03/2027" }] });
  // Ben's wallets are there and empty: 0 each (so a wallet emptied in Playtomic reads as 0, not as missing).
  assert.deepEqual(r.rows[1]!.wallets.map((w) => w.balance), ["0", "0"]);
  assert.deepEqual(r.rows.map((x) => x.name), ["Ann Lee", "Ben", "Cal", "Eve"]);
  assert.deepEqual(r.rows[2]!.benefits, [{ name: "Plata", until: "2026-12-15" }]);
  // Dee has no email or Playtomic id: nobody to match. Eve's day isn't one.
  assert.deepEqual(r.problems.map((p) => p.text.en), ["Line 5 has no email or Playtomic id, so it can't be matched to anyone here.", "Line 6: \"31/02/2026\" isn't a date, so that membership is left out."]);
});

test("Playtomic's English export: Benefit name and Expiry date are its membership and its last day", () => {
  const r = readMoveInCsv("Name,Email,Benefit name,Expiry date\nAnn,ann@example.test,Gold,12/01/2026\n", { dayFirst: false });
  assert.equal(r.fatal, undefined);
  assert.deepEqual(r.rows[0]!.benefits, [{ name: "Gold", until: "2026-12-01" }]);
});

test("days: ISO, day first, or the US way for a club that writes month first", () => {
  assert.equal(readDay("2026-12-01T00:00:00", true), "2026-12-01");
  assert.equal(readDay("01/12/2026", true), "2026-12-01");
  assert.equal(readDay("12/01/2026", false), "2026-12-01");
  assert.equal(readDay("1.12.26", true), "2026-12-01");
  assert.equal(readDay("13/13/2026", true), null);
});

test("a file with no wallet or membership column says so", () => {
  assert.equal(readMoveInCsv("Name,Email\nAnn,ann@example.test", { dayFirst: true }).fatal?.en, "The file has no wallet or membership columns (the setup guide lists the names it reads).");
});

// The staff routes: the owner and managers only (club credit and members' details), and the file read only.

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer();
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (path: string, cookie: string, body?: unknown) => {
  const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const d = ((await run(db, "person.create", { display_name: "Dana", email: "dana@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: d, role: "front_desk" }, owner);
  await run(db, "membership.plan_set", { name: "Gold", price_cents: 6000, period: "month", join_in_app: true }, owner);
  app = makeApp({ db, mailer, secureCookies: false });
});
after(async () => drop());

test("the move-in page reads for the owner, and not for front desk; the latest upload is what staff choose from", async () => {
  const robin = await signIn("robin@example.test"), dana = await signIn("dana@example.test");
  assert.equal((await call("/staff/move-in", dana)).status, 403);
  const s = await call("/staff/move-in", robin);
  assert.equal(s.status, 200);
  assert.deepEqual([s.json.players_read_at, s.json.credit_cents, s.json.memberships, s.json.upload, s.json.plans.map((p: any) => p.name)], [null, 0, 0, null, ["Gold"]]);
  await run(db, "playtomic.upload", { csv: "Name,Email,Wallet,Category,Expiry\nAnn,ann@example.test,10,Gold,2026-12-01\n", file_name: "export.csv" }, owner);
  const u = (await call("/staff/move-in", robin)).json.upload;
  assert.deepEqual([u.file_name, u.rows, u.wallet_columns, u.benefits], ["export.csv", 1, [{ ref: "wallet", name: "Wallet" }], [{ name: "Gold", people: 1 }]]);
  // The rows themselves never go back and forth: a preview names the upload.
  assert.equal(u.players, undefined);
  assert.equal(await db.selectFrom("brought_credit").select("id").executeTakeFirst(), undefined);
});
