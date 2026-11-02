import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { issueReceipts, run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

// Receipts to read: a member's own in the members' app, and someone's for the club's money people.
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), people: Record<string, string> = {}, cookies: Record<string, string> = {};
const get = async (path: string, who: string) => {
  const r = await app.request(path, { headers: { cookie: cookies[who]! } });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  return (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };
  people.Robin = owner.personId!;
  for (const name of ["Ann", "Ben", "Sam"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Sam, role: "coach" }, owner);
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", people.Ben!).execute();   // reads in Spanish
  app = makeApp({ db, mailer, secureCookies: false });
  for (const name of ["Robin", "Ann", "Ben", "Sam"]) cookies[name] = await signIn(`${name.toLowerCase()}@example.test`);
  for (const [who, cents] of [["Ann", 4800], ["Ben", 1500]] as const)
    await db.insertInto("payment").values({ id: uuidv7(), person_id: people[who]!, amount_cents: cents, method: "cash", provider: "none", provider_ref: null, status: "succeeded" } as any).execute();
  await issueReceipts(db);
});
after(async () => drop());

test("a member reads their own receipts, in their language, and no one else's", async () => {
  const list = (await get("/my/receipts", "Ann")).json;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].what, list[0].total, list[0].kind], ["Payment", "$48.00", "payment"]);
  const one = (await get(`/my/receipts/${list[0].id}`, "Ann")).json;
  assert.deepEqual([one.club, one.total, one.method, one.lines[0].what], ["Kestrel Padel", "$48.00", "cash", "Payment"]);
  assert.equal((await get(`/my/receipts/${list[0].id}`, "Ben")).status, 404);
  const ben = (await get("/my/receipts", "Ben")).json;
  assert.deepEqual([ben[0].what, ben[0].total], ["Pago", "$15.00"]);
});

test("staff with the club's money see someone's receipts; a coach doesn't", async () => {
  const r = await get(`/staff/receipts?person_id=${people.Ann}`, "Robin");
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 1);
  assert.equal((await get(`/staff/receipts/${r.json[0].id}`, "Robin")).json.total, "$48.00");
  assert.equal((await get(`/staff/receipts?person_id=${people.Ann}`, "Sam")).status, 403);
  assert.equal((await get(`/staff/receipts?person_id=${people.Ann}`, "Ann")).status, 403);
});

test("the club's receipts by dates, with a file: refunds negative, and a name a spreadsheet would run kept as text", async () => {
  // An accountant sees them; a coach and a member don't.
  const acct = ((await run(db, "person.create", { display_name: "Ada", email: "ada@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: acct, role: "accountant" }, owner);
  cookies.Ada = await signIn("ada@example.test");
  const evil = ((await run(db, "person.create", { display_name: "=HYPERLINK(\"x\")", email: "eve@example.test" }, owner)).result as any).person_id;
  const pay = uuidv7();
  await db.insertInto("payment").values({ id: pay, person_id: evil, amount_cents: 2000, method: "cash", provider: "none", provider_ref: null, status: "succeeded" } as any).execute();
  await db.insertInto("refund").values({ id: uuidv7(), payment_id: pay, amount_cents: 500, status: "sent", destination: "card" } as any).execute();
  await issueReceipts(db);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const r = await get(`/staff/club-receipts?from=${today}&to=${today}`, "Ada");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((x: any) => [x.kind, x.total_cents, x.paid_by]).sort(), [["payment", 1500, "Ben"], ["payment", 2000, "=HYPERLINK(\"x\")"], ["payment", 4800, "Ann"], ["refund", 500, "=HYPERLINK(\"x\")"]]);
  assert.equal((await get(`/staff/club-receipts?from=${today}&to=${today}`, "Sam")).status, 403);
  assert.equal((await get(`/staff/club-receipts?from=${today}&to=${today}`, "Ann")).status, 403);
  assert.equal((await get(`/staff/club-receipts?from=2025-01-01&to=${today}`, "Ada")).status, 400, "at most a year");
  const file = await app.request(`/staff/club-receipts.csv?from=${today}&to=${today}`, { headers: { cookie: cookies.Ada! } });
  assert.match(file.headers.get("content-disposition")!, new RegExp(`kumi-receipts-${today}-to-${today}\\.csv`));
  const lines = (await file.text()).trim().split("\r\n");
  assert.equal(lines[0], "receipt,kind,date,paid by,for,what,what (es),subtotal,tax,total,method,card");
  assert.equal(lines.length, 5);
  const refund = lines.find((l) => l.includes(",refund,"))!;
  assert.match(refund, /^R-\d{6},refund,\d{4}-\d{2}-\d{2} \d{2}:\d{2},"'=HYPERLINK\(""x""\)",,.*,-5\.00,0\.00,-5\.00,cash,$/);
});

test("a member's data download includes their receipts", async () => {
  const { exportData } = await import("@kumi/core");
  const x = await exportData(db, people.Ann!, new Date(), "en") as any;
  assert.deepEqual(x.receipts.map((r: any) => [r.kind, r.total_cents, r.method, r.paid_by]), [["payment", 4800, "cash", null]]);
  assert.match(x.receipts[0].number, /^R-\d{6}$/);
});
