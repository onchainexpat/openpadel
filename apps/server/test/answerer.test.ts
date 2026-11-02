import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { run, runAsSystem, setAnswerer, staffOnly, type Actor, type AnswerCandidate, type Db } from "@kumi/core";
import { answererFromEnv, checkAnswerKeys, haikuProvider, jevProvider, makeAnswerer, FIT_AT_LEAST, PERSON_BELOW } from "../src/answerer.ts";
import { doctor } from "../src/doctor.ts";
import { deepHealth } from "../src/health.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";

let db: Db, drop: () => Promise<void>, owner: Actor;
const FACTS: AnswerCandidate[] = [
  { id: "11111111-1111-7111-8111-111111111111", topic: "hours", question: "When are you open?", answer: "Every day, 7 AM to 11 PM." },
  { id: "22222222-2222-7222-8222-222222222222", topic: "parking", question: "Where do I park?", answer: "Free parking behind the club." },
];
type Sent = { url: string; body: any; headers: Record<string, string> };
/** Jev as a fake: answers each noul from the table, and keeps what it was sent. */
function fakeJev(nouls: Record<string, number>, sent: Sent[], status = 200) {
  return async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ url, body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    if (status !== 200) return new Response("{}", { status });
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: nouls[k] ?? 0.01 }]));
    return new Response(JSON.stringify({ model: "jev-1.14.0", answers, usage: { input_tokens: 420, output_tokens: 40 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}
/** The Anthropic API as a fake: one message whose text is the decision. */
function fakeClaude(decision: unknown, sent: Sent[], status = 200) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (status !== 200) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status, headers: { "content-type": "application/json" } });
    if (String(url).includes("/v1/models/")) return new Response(JSON.stringify({ id: "claude-haiku-5-5", type: "model", display_name: "Claude Haiku 5.5", created_at: "2026-09-01T00:00:00Z" }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify(decision) }], usage: { input_tokens: 380, output_tokens: 14 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
});
after(async () => { setAnswerer(staffOnly); await drop(); });

test("Jev: only the question's words and the facts go out, under short keys; a fact is sent only when it's sure and no person is needed", async () => {
  const sent: Sent[] = [];
  const a = makeAnswerer([jevProvider("ts_key", fakeJev({ fits_a2: 0.93, needs_person: 0.04 }, sent))])!;
  const c = await a.decide({ text: "Can I leave my car overnight?", lang: "en" }, FACTS);
  assert.deepEqual([c.outcome, c.factId, c.confidence, c.by], ["fact", FACTS[1]!.id, 0.93, "jev"]);
  const req = sent[0]!;
  assert.equal(req.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(req.headers.authorization, "Bearer ts_key");
  assert.deepEqual(req.body.state, { question: "Can I leave my car overnight?", club_answers: { a1: { question: "When are you open?", answer: "Every day, 7 AM to 11 PM." }, a2: { question: "Where do I park?", answer: "Free parking behind the club." } } });
  assert.deepEqual(Object.keys(req.body.questions).sort(), ["fits_a1", "fits_a2", "needs_person"]);
  assert.ok(!JSON.stringify(req.body).includes(FACTS[0]!.id), "no fact ids leave the server");
  const d = c.detail as any;
  assert.deepEqual([d.provider, d.model, d.needs_person, d.fits[FACTS[1]!.id], d.thresholds], ["jev", "jev-1.14.0", 0.04, 0.93, { fit: FIT_AT_LEAST, person: PERSON_BELOW }]);
  assert.deepEqual(d.tokens, { input: 420, output: 40 });

  // A person's needed (their own booking): the staff, however well a fact fits.
  const own = await makeAnswerer([jevProvider("k", fakeJev({ fits_a1: 0.9, needs_person: 0.81 }, []))])!.decide({ text: "Why was I charged twice?", lang: "en" }, FACTS);
  assert.deepEqual([own.outcome, own.factId], ["staff", undefined]);
  // Not sure enough: the staff.
  const unsure = await makeAnswerer([jevProvider("k", fakeJev({ fits_a1: 0.7, needs_person: 0.05 }, []))])!.decide({ text: "Open late on the 4th?", lang: "en" }, FACTS);
  assert.deepEqual([unsure.outcome, unsure.confidence], ["staff", 0.7]);
});

test("Claude Haiku when Jev fails, slow or down: the same decision, from a fixed list of answers, and why Jev was passed over is kept", async () => {
  const jevSent: Sent[] = [], claudeSent: Sent[] = [];
  const used: unknown[] = [];
  const a = makeAnswerer([jevProvider("k", fakeJev({}, jevSent, 503)), haikuProvider("sk-ant-test", fakeClaude({ answer: "a1", needs_person: false }, claudeSent))], Date.now,
    async (u) => { used.push(u); })!;
  assert.equal(a.name, "jev+haiku");
  const c = await a.decide({ text: "¿A qué hora abren?", lang: "es" }, FACTS);
  assert.deepEqual([c.outcome, c.factId, c.confidence, c.by], ["fact", FACTS[0]!.id, null, "haiku"]);   // no calibrated probability from Haiku
  // The club's meter hears what the model that answered used (usage.ts).
  assert.deepEqual(used, [{ model: "haiku", tokens: { input: 380, output: 14 } }]);
  assert.deepEqual((c.detail as any).failed.map((f: any) => [f.provider, f.error]), [["jev", "HTTP 503"]]);
  const req = claudeSent[0]!;
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["x-api-key"], "sk-ant-test");
  assert.equal(req.body.model, "claude-haiku-5-5");
  assert.deepEqual(req.body.thinking, { type: "disabled" });
  assert.deepEqual(req.body.output_config.format.schema.properties.answer.enum, ["a1", "a2", "none"]);
  assert.deepEqual(JSON.parse(req.body.messages[0].content), { question: "¿A qué hora abren?", club_answers: { a1: { question: "When are you open?", answer: "Every day, 7 AM to 11 PM." }, a2: { question: "Where do I park?", answer: "Free parking behind the club." } } });
  // Haiku says a person is needed, or none fits: the staff.
  for (const decision of [{ answer: "a2", needs_person: true }, { answer: "none", needs_person: false }])
    assert.equal((await makeAnswerer([haikuProvider("k", fakeClaude(decision, []))])!.decide({ text: "x?", lang: "en" }, FACTS)).outcome, "staff");
  // An answer outside the list is a failure, never a pick.
  await assert.rejects(makeAnswerer([haikuProvider("k", fakeClaude({ answer: "a9", needs_person: false }, []))])!.decide({ text: "x?", lang: "en" }, FACTS), /outside the schema/);
  // Both down: an error, which the question turns into the staff (questions.ts), with both reasons.
  const timeout = async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); };
  await assert.rejects(makeAnswerer([jevProvider("k", timeout), haikuProvider("k", fakeClaude({}, [], 529))])!.decide({ text: "x?", lang: "en" }, FACTS), /^Error: jev: timed out; haiku: HTTP 529$/);
});

test("settings: each key turns its model on; neither, every question goes to the staff", async () => {
  assert.equal(answererFromEnv({}), null);
  assert.equal(answererFromEnv({ KUMI_TYPESAFE_API_KEY: " " }), null);
  assert.equal(answererFromEnv({ KUMI_ANTHROPIC_API_KEY: "sk-ant-x" })!.name, "haiku");
  assert.equal(answererFromEnv({ KUMI_TYPESAFE_API_KEY: "ts", KUMI_ANTHROPIC_API_KEY: "sk-ant-x" })!.name, "jev+haiku");
  // Checking the keys lists models, which costs nothing.
  const sent: Sent[] = [];
  const keys = await checkAnswerKeys({ KUMI_TYPESAFE_API_KEY: "bad" }, async (url: string, init: RequestInit) => { sent.push({ url, body: null, headers: Object.fromEntries(new Headers(init.headers).entries()) }); return new Response("{}", { status: 401 }); });
  assert.deepEqual(keys, [{ model: "jev", error: "HTTP 401" }]);
  assert.equal(sent[0]!.url, "https://api.typesafe.ai/v1/models");
});

test("doctor and the health check: which model answers, whether its key works, and the last day's decisions (no model is called)", async () => {
  const state = async (env: Record<string, string>, fetch?: any) => (await doctor(db, { KUMI_BACKUP_DIR: "/nonexistent", ...env }, { fetch })).find((c) => c.id === "answers")!;
  assert.equal((await state({})).state, "off");
  const ok = async () => new Response(JSON.stringify({ data: [], id: "claude-haiku-5-5" }), { status: 200, headers: { "content-type": "application/json" } });
  const on = await state({ KUMI_TYPESAFE_API_KEY: "ts", KUMI_ANTHROPIC_API_KEY: "sk-ant-x" }, fakeClaude({}, []));
  assert.equal(on.state, "ok"); assert.equal(on.text.en, "Ask the club: answering through Jev + Claude Haiku. In the last day 0 questions, 0 answered from the club's facts.");
  const refused = await state({ KUMI_TYPESAFE_API_KEY: "ts" }, async () => new Response("{}", { status: 401 }));
  assert.deepEqual([refused.state, refused.text.en], ["fail", "Ask the club: Jev refused its key (HTTP 401)."]);
  await run(db, "club.update", { auto_answers: false }, owner);
  assert.deepEqual([(await state({ KUMI_TYPESAFE_API_KEY: "ts" }, ok)).state, (await state({ KUMI_TYPESAFE_API_KEY: "ts" }, ok)).text.en], ["off", "Ask the club: Jev set up, but the club has switched answering off in Settings."]);
  await run(db, "club.update", { auto_answers: true }, owner);

  // Six questions, four with no decision: the doctor warns, and the health check names it.
  const person = ((await run(db, "person.create", { display_name: "Ann", email: "ann@example.test" }, owner)).result as any).person_id;
  const ann: Actor = { personId: person, via: "test", lang: "en" };
  await run(db, "fact.create", { topic: "parking", question_en: "Where do I park?", answer_en: "Behind the club.", question_es: "¿Dónde estaciono?", answer_es: "Detrás del club." }, owner);
  let n = 0;
  setAnswerer({ name: "jev", version: "atc-1", async decide(_q, facts) { if (n++ < 4) throw new Error("HTTP 503"); return { outcome: "fact", factId: facts[0]!.id, confidence: 0.9 }; } });
  try {
    for (let k = 0; k < 6; k++) {
      const now = new Date(Date.now() - (6 - k) * 60_000);
      const asker = k < 5 ? ann : owner;   // five a day each
      await run(db, "question.ask", { person_id: asker.personId, body: `Parking question ${k}?` }, asker, { now });
    }
  } finally { setAnswerer(staffOnly); }
  const failing = await state({ KUMI_TYPESAFE_API_KEY: "ts" }, ok);
  assert.deepEqual([failing.state, failing.text.en], ["warn", "Ask the club: 4 of the last day's 6 questions got no decision (the model failed or was slow) and went to the staff."]);
  const h = await deepHealth(db, { env: { KUMI_TYPESAFE_API_KEY: "ts", KUMI_BACKUP_DIR: "/nonexistent" } }) as any;
  assert.deepEqual(h.answers, { models: ["jev"], club_on: true, total: 6, answered: 2, errors: 4 });
  assert.ok(h.problems.includes("answers"));
  assert.ok(!(await deepHealth(db, { env: { KUMI_BACKUP_DIR: "/nonexistent" } }) as any).problems.includes("answers"));   // no model: nothing to fail
});

test("staff see which fact Kumi sent and how sure it was; Settings says whether a model is set up", async () => {
  const mailer = new MemoryMailer();
  const app = makeApp({ db, mailer, secureCookies: false, publicUrl: "http://127.0.0.1:8790" });
  await app.request("/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test" }) });
  const code = mailer.last("robin@example.test")!.text.match(/\b(\d{6})\b/)![1]!;
  const cookie = (await app.request("/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "robin@example.test", code }) })).headers.get("set-cookie")!.split(";")[0]!;
  const get = async (path: string) => (await app.request(path, { headers: { cookie } })).json() as Promise<any>;
  assert.equal((await get("/staff/settings")).answerer, "staff_only");
  const q = (await db.selectFrom("answer_decision").select("question_id").where("outcome", "=", "fact").executeTakeFirstOrThrow()).question_id;
  const t = await get(`/staff/questions/${q}`);
  const club = t.messages.find((m: any) => m.side === "club");
  assert.deepEqual(club.kumi, { fact: "Where do I park?", by: "jev", confidence: 0.9, corrected: null });
  assert.equal(t.messages.find((m: any) => m.side === "member").kumi, null);
  setAnswerer(makeAnswerer([jevProvider("k", fakeJev({}, []))])!);
  try { assert.equal((await get("/staff/settings")).answerer, "jev"); } finally { setAnswerer(staffOnly); }
});
