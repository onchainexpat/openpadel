// Levels players bring from other apps, through the server (core/level_claims.ts): a screenshot sent first and named
// by the claim, seen only by the player (or their parent) and staff who read levels, as a picture that can't run
// anything; staff find the claim in the Levels queue and answer it; and the screenshot is gone once they have.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, uuidv7, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("my Playtomic profile")]);
const raw = (path: string, who: string) => app.request(path, { headers: { cookie: cookies[who]! } });
const get = async (path: string, who: string) => { const r = await raw(path, who); return { status: r.status, json: await r.json() as any }; };
const post = async (path: string, who: string, body: unknown = {}) => {
  const r = await app.request(path, { method: "POST", headers: { cookie: cookies[who]!, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
async function signIn(email: string) {
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[email] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false });
  for (const name of ["Pat", "Zed", "Dana"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
    await signIn(`${name.toLowerCase()}@example.test`);
  }
  const desk = await db.selectFrom("role").select("id").where("key", "=", "front_desk").executeTakeFirstOrThrow();
  await db.insertInto("person_role").values({ id: uuidv7(), person_id: people.Dana!, role_id: desk.id, location_id: null }).execute();
});
after(async () => drop());

test("a screenshot with a level from another app: the player's and staff's alone, a picture only, gone once staff answer", async () => {
  assert.equal((await post("/my/level/proof", "pat@example.test", { data: Buffer.from("<script>").toString("base64") })).json.error, "error.proof_type");
  const up = await post("/my/level/proof", "pat@example.test", { data: PNG.toString("base64") });
  assert.equal(up.status, 200);
  assert.equal(up.json.content_type, "image/png");
  const p = await post("/actions/level.claim/plan", "pat@example.test", { person_id: people.Pat, platform: "playtomic", value: 5.4, reliability: 75, proof_id: up.json.proof_id, profile_url: "https://playtomic.com/p/pat" });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.match(p.json.summary, /^Send your level on Playtomic \(5\.4, reliability 75%\) to the club\..*deleted once they answer, or after 60 days\.$/);
  assert.equal((await post(`/runs/${p.json.run_id}/apply`, "pat@example.test")).status, 200);
  const mine = (await get("/my/level", "pat@example.test")).json.claims;
  assert.deepEqual(mine.map((c: any) => [c.platform, c.status, c.proof, c.shown]), [["playtomic", "waiting", "kept", "5.4, reliability 75%"]]);
  // The player sees their own screenshot; someone else gets nothing; staff who read levels see it, as a plain picture.
  assert.equal((await raw(`/my/level/claims/${mine[0].id}/proof`, "pat@example.test")).status, 200);
  assert.equal((await raw(`/my/level/claims/${mine[0].id}/proof`, "zed@example.test")).status, 404);
  assert.equal((await raw(`/staff/levels/claims/${mine[0].id}/proof`, "zed@example.test")).status, 403);
  const pic = await raw(`/staff/levels/claims/${mine[0].id}/proof`, "dana@example.test");
  assert.equal(pic.status, 200);
  assert.deepEqual([pic.headers.get("content-type"), pic.headers.get("x-content-type-options"), pic.headers.get("cache-control")], ["image/png", "nosniff", "private, no-store"]);
  assert.ok(Buffer.from(await pic.arrayBuffer()).equals(PNG));
  // In the Levels queue, waiting, with the link and the screenshot.
  const q = (await get("/staff/levels", "dana@example.test")).json.claims;
  assert.deepEqual(q.map((c: any) => [c.name, c.status, c.proof, c.profile_url, c.shown]), [["Pat", "waiting", "kept", "https://playtomic.com/p/pat", "5.4, reliability 75%"]]);
  const a = await post("/actions/level.answer_claim/plan", "dana@example.test", { claim_id: q[0].id, outcome: "confirm" });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal((await post(`/runs/${a.json.run_id}/apply`, "dana@example.test")).status, 200);
  assert.equal((await raw(`/staff/levels/claims/${mine[0].id}/proof`, "dana@example.test")).status, 404);
  const after = (await get("/my/level", "pat@example.test")).json;
  assert.deepEqual([after.rating.level, after.claims[0].status, after.claims[0].proof, after.claims[0].is_start], ["5.40", "confirmed", "deleted", true]);
  // Spanish on the player's page.
  await db.updateTable("person").set({ locale: "es" }).where("id", "=", people.Pat!).execute();
  const es = await app.request("/my/level", { headers: { cookie: cookies["pat@example.test"]!, "accept-language": "es" } });
  assert.equal(((await es.json()) as any).claims[0].shown, "5.4, confiabilidad 75%");
});
