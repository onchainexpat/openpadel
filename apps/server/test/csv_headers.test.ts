// Every spreadsheet download names its columns in English, whatever the reader's language (Kelly, 6 Nov 2026), so a
// spreadsheet or an accounting tool reads the same file from any member of staff. The coach earnings download was the
// one that followed the reader. Every .csv route the server has is listed here with its columns: a new one, or one
// whose columns follow the reader, fails.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { localDate, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

const COLUMNS: Record<string, string[]> = {
  "/staff/reports.csv": ["date", "open hours", "courts", "court hours", "booked hours", "program hours", "playtomic hours", "blocked hours", "occupancy %", "court revenue", "lesson revenue", "program revenue", "membership revenue", "tax collected", "card payments recorded after a restore"],
  "/staff/coach-earnings.csv": ["coach", "kind", "when", "minutes", "what", "status", "paid", "refunded", "net"],
  "/staff/club-receipts.csv": ["receipt", "kind", "date", "paid by", "for", "what (en)", "what (es)", "subtotal", "tax", "total", "method", "card"],
  "/staff/desk.csv": ["date", "time", "kind", "method", "amount", "person", "what", "recorded by"],
};
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, loc: string, cookie: string;
const mailer = new MemoryMailer(), TZ = "Europe/Madrid", DAY = localDate(new Date(), TZ);

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Club Pádel Sol", time_zone: TZ, owner_email: "lucia@example.test", owner_name: "Lucía Ortega" }, "setup");
  const owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "es", auth: "passkey" } as Actor;
  loc = ((await run(db, "location.create", { name: "Centro", time_zone: TZ }, owner)).result as any).location_id;
  // A reader who reads Kumi in Spanish.
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", owner.personId!).execute();
  app = makeApp({ db, mailer, secureCookies: false });
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "lucia@example.test" }) });
  const code = mailer.last("lucia@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  cookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "lucia@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
});
after(async () => { await drop(); });

test("every .csv route the server has is one listed here", () => {
  const dir = new URL("../src/", import.meta.url).pathname;
  const routes = readdirSync(dir).filter((f) => f.endsWith(".ts")).flatMap((f) => [...readFileSync(dir + f, "utf8").matchAll(/app\.get\("([^"]+\.csv)"/g)].map((m) => m[1]!));
  assert.deepEqual(routes.sort(), Object.keys(COLUMNS).sort(), "a new download: add it here with its English column names");
});

test("a Spanish reader's downloads name their columns in English", async () => {
  for (const [route, columns] of Object.entries(COLUMNS)) {
    const q = route === "/staff/reports.csv" ? `?location_id=${loc}&from=${DAY}&to=${DAY}` : `?from=${DAY}&to=${DAY}`;
    const r = await app.request(route + q, { headers: { cookie, "accept-language": "es" } });
    assert.equal(r.status, 200, route);
    assert.match(r.headers.get("content-type") ?? "", /^text\/csv/, route);
    const head = (await r.text()).split("\r\n")[0]!;
    assert.equal(head, columns.join(","), `${route} names its columns in English`);
  }
});
