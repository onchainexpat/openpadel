import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, threadId: string;
const TZ = "America/Los_Angeles";
const mailer = new MemoryMailer(), cookies: Record<string, string> = {}, people: Record<string, string> = {};
const req = async (path: string, who: string | null, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: { ...(who ? { cookie: cookies[who]! } : {}), "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
};
/** Preview and confirm, as the apps do. */
async function act(who: string, action: string, input: unknown) {
  const p = await req(`/actions/${action}/plan`, who, input);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const a = await req(`/runs/${p.json.run_id}/apply`, who, {});
  assert.equal(a.status, 200, JSON.stringify(a.json));
  return a.json.result;
}
async function signIn(name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const code = mailer.last(email)!.text.match(/\b(\d{6})\b/)![1]!;
  cookies[name] = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) })).headers.get("set-cookie")!.split(";")[0]!;
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer, secureCookies: false, publicUrl: "https://play.kestrel.test" });
  for (const name of ["Ann", "Ben", "Kim", "Fay"]) {
    people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test`, ...(name === "Ben" ? { locale: "es" } : {}) }, owner)).result as any).person_id;
    await signIn(name);
  }
  await run(db, "role.assign", { person_id: people.Kim, role: "coach" }, owner);
  await run(db, "role.assign", { person_id: people.Fay, role: "front_desk" }, owner);
  await run(db, "level.set", { person_id: people.Ann, level: 3.25, reason: "Starting level" }, owner);
});
after(async () => drop());

test("front desk writes facts; members read the switched-on ones in their language, searched", async () => {
  assert.equal((await req("/actions/fact.create/plan", "Ann", { topic: "parking", question_en: "Where do I park?", answer_en: "Behind the club.", question_es: "¿Dónde estaciono?", answer_es: "Detrás del club." })).status, 403);
  await act("Fay", "fact.create", { topic: "parking", question_en: "Where do I park?", answer_en: "Free parking behind the club.", question_es: "¿Dónde estaciono?", answer_es: "Estacionamiento gratis detrás del club.", public: true });
  await act("Fay", "fact.create", { topic: "facilities", question_en: "What's the door code?", answer_en: "4417.", question_es: "¿Cuál es el código de la puerta?", answer_es: "4417." });
  await act("Fay", "fact.create", { topic: "rules", question_en: "Can I bring <script> tags?", answer_en: "Only \"</script>\" & friends.", question_es: "¿Etiquetas?", answer_es: "No." , public: true });
  const en = await req("/my/facts?q=where%20to%20park", "Ann");
  assert.deepEqual(en.json[0], { id: en.json[0].id, topic: "parking", question: "Where do I park?", answer: "Free parking behind the club." });
  const es = await req("/my/facts?q=estacionar", "Ben");
  assert.equal(es.json[0].answer, "Estacionamiento gratis detrás del club.");
  assert.equal((await req("/my/facts", "Ann")).json.length, 3);
  assert.equal((await req("/my/facts", null)).status, 401);
  const staff = await req("/staff/facts", "Fay");
  assert.deepEqual(staff.json.map((f: any) => [f.topic, f.active, f.public]), [["rules", true, true], ["parking", true, true], ["facilities", true, false]]);
  assert.equal((await req("/staff/facts", "Kim")).status, 403);   // coaches don't run the inbox
});

test("a member's question reaches the staff inbox; the answer comes back; nobody else can read it", async () => {
  const r = await act("Ann", "question.ask", { person_id: people.Ann, body: "Do you have lockers I can rent by the month?" });
  threadId = r.question_id;
  const mine = await req("/my/questions", "Ann");
  assert.deepEqual(mine.json.map((q: any) => [q.first, q.status, q.about]), [["Do you have lockers I can rent by the month?", "open", null]]);
  assert.equal((await req(`/my/questions/${threadId}`, "Ben")).status, 404);
  assert.equal((await req(`/my/questions/not-an-id`, "Ann")).status, 404);

  assert.equal((await req("/staff/questions/count", "Fay")).json.waiting, 1);
  assert.equal((await req("/staff/questions/count", "Kim")).json.waiting, 0);
  const list = await req("/staff/questions", "Fay");
  assert.deepEqual(list.json.questions.map((q: any) => [q.asker, q.first, q.status]), [["Ann", "Do you have lockers I can rent by the month?", "open"]]);
  assert.equal((await req("/staff/questions", "Ann")).status, 403);
  assert.equal((await req("/staff/questions", "Kim")).status, 403);
  const t = await req(`/staff/questions/${threadId}`, "Fay");
  assert.deepEqual([t.json.asker, t.json.membership, t.json.level, t.json.desk.map((d: any) => d.name)], ["Ann", null, "3.25", ["Fay", "Robin Hale"]]);
  assert.ok(!JSON.stringify(t.json).includes("@example.test"));

  await act("Fay", "question.answer", { question_id: threadId, body: "Yes, $15 a month at the desk." });
  const th = await req(`/my/questions/${threadId}`, "Ann");
  assert.deepEqual(th.json.messages.map((m: any) => [m.side, m.author, m.body]), [["member", "Ann", "Do you have lockers I can rent by the month?"], ["staff", "Fay", "Yes, $15 a month at the desk."]]);
  assert.equal(th.json.status, "answered");
  assert.equal((await req("/staff/questions/count", "Fay")).json.waiting, 0);
  assert.deepEqual((await req("/staff/questions?view=answered", "Fay")).json.questions.map((q: any) => q.assignee), ["Fay"]);
});

test("the public page lists the public facts, with FAQ markup that can't break out of its tag", async () => {
  await run(db, "club.update", { public_page: true }, owner);
  const p = await req("/public", null);
  assert.equal(p.status, 200);
  assert.match(p.text, /<h2>Common questions<\/h2>.*<h3>Where do I park\?<\/h3><p>Free parking behind the club\.<\/p>/);
  assert.ok(!p.text.includes("4417"));                                  // the door code isn't public
  assert.ok(p.text.includes("Can I bring &lt;script&gt; tags?"));       // escaped in the page
  const ld = [...p.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
  const faq = ld.find((x) => x["@type"] === "FAQPage");
  assert.deepEqual(faq.mainEntity.map((q: any) => [q.name, q.acceptedAnswer.text]), [["Can I bring <script> tags?", "Only \"</script>\" & friends."], ["Where do I park?", "Free parking behind the club."]]);
  assert.match((await req("/public?lang=es", null)).text, /<h2>Preguntas frecuentes<\/h2>.*<h3>¿Dónde estaciono\?<\/h3>/);
});
