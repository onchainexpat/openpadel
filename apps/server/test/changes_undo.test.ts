// Changes offers Undo only where it can work, and a refusal says why once, in plain words (staff sweep, 6 Nov 2026:
// every row had Undo, receipts and money sent included, and the refusal read "This can't be undone: Can't be
// undone: the refund has gone out." or borrowed "an undo is final" for changes that were never undos).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { runAsSystem, uuidv7, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>;
const mailer = new MemoryMailer();
const OWNER = "robin@example.test";

async function call(path: string, opts: { method?: string; body?: unknown; cookie?: string; lang?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.lang) headers["accept-language"] = opts.lang;
  const res = await app.request(path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, json: await res.json() as any, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}
async function signIn(email: string): Promise<string> {
  assert.equal((await call("/auth/email/start", { body: { email } })).status, 200);
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  const r = await call("/auth/email/verify", { body: { email, code } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.cookie!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: OWNER, owner_name: "Robin Hale" }, "setup");
  app = makeApp({ db, mailer, secureCookies: false });
});
after(async () => drop());

test("Changes offers Undo only on a change that can be undone", async () => {
  const cookie = await signIn(OWNER);
  const p = await call("/actions/club.update/plan", { body: { name: "Kestrel Padel Club" }, cookie });
  assert.equal((await call(`/runs/${p.json.run_id}/apply`, { method: "POST", cookie, headers: { "idempotency-key": uuidv7() } })).status, 200);
  let rows = (await call("/staff/changes", { cookie })).json as any[];
  const rename = rows.find((r) => r.action === "club.update"), setup = rows.find((r) => r.action === "club.setup");
  assert.equal(rename.can_undo, true, "a rename can go back");
  assert.equal(setup.can_undo, false, "setting the club up can't");

  // Undo the rename: the undo itself is final, so it isn't offered again, and asked anyway it says why.
  const u = await call("/actions/action.undo/plan", { body: { run_id: rename.id }, cookie });
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.equal((await call(`/runs/${u.json.run_id}/apply`, { method: "POST", cookie, headers: { "idempotency-key": uuidv7() } })).status, 200);
  rows = (await call("/staff/changes", { cookie })).json as any[];
  const undo = rows.find((r) => r.action === "action.undo");
  assert.equal(undo.can_undo, false);
  assert.equal((await call("/actions/action.undo/plan", { body: { run_id: undo.id }, cookie })).json.message,
    "This can't be undone: an undo is final; make the change again instead.");

  // A change that was never an undo doesn't borrow that reason.
  assert.equal((await call("/actions/action.undo/plan", { body: { run_id: setup.id }, cookie })).json.message,
    "This can't be undone: Kumi has no way to put this one back by itself; make the opposite change instead.");
});

test("a refusal says its reason once, for changes kept before the fix too", async () => {
  const cookie = await signIn(OWNER);
  // A pay-out recorded before this fix kept the whole sentence as its note.
  const id = uuidv7();
  await db.insertInto("action_run").values({ id, action: "credit.pay_out", action_version: 1, via: "web", input: JSON.stringify({}),
    plan: JSON.stringify({ title: { en: "Pay out club credit", es: "Pagar crédito del club" }, summary: { en: "Pay out $20.00.", es: "Pagar 20,00 $." }, reads: [],
      undo: { kind: "none", note: { en: "Can't be undone: the refund has gone out.", es: "No se puede deshacer: ya se envió el reembolso." } } }),
    status: "applied", undo_kind: "none", read_versions: JSON.stringify({}), plan_expires_at: new Date(), applied_at: new Date() } as any).execute();
  const rows = (await call("/staff/changes", { cookie })).json as any[];
  assert.equal(rows.find((r) => r.id === id).can_undo, false, "money sent isn't offered an Undo");
  assert.equal((await call("/actions/action.undo/plan", { body: { run_id: id }, cookie })).json.message, "This can't be undone: the refund has gone out.");
  // In Spanish too (the owner reads Kumi in their own language).
  await db.updateTable("person").set({ locale: "es" }).where("email", "=", OWNER).execute();
  try {
    assert.equal((await call("/actions/action.undo/plan", { body: { run_id: id }, cookie })).json.message, "No se puede deshacer: ya se envió el reembolso.");
  } finally { await db.updateTable("person").set({ locale: "en" }).where("email", "=", OWNER).execute(); }
});

test("a change made now keeps a bare reason, so its refusal reads once", () => {
  // The refusal adds "This can't be undone:" itself, so a note is the reason alone: never the whole sentence again.
  const dir = new URL("../../../packages/core/src/", import.meta.url).pathname;
  const bad = readdirSync(dir).filter((f) => f.endsWith(".ts")).filter((f) => readFileSync(join(dir, f), "utf8").includes('both("undo.none"'));
  assert.deepEqual(bad, [], "notes that would read twice");
  // And a change that was never an undo doesn't borrow the undo's own reason.
  const borrowed = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "actions.ts").filter((f) => readFileSync(join(dir, f), "utf8").includes('both("reason.undo_final")'));
  assert.deepEqual(borrowed, []);
});
