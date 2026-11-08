import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "./helpers.ts";
import { alertUnanswered, answerCounts, exportData, messageHandlers, sendEmails, openMinutes, plan, processOutbox, run, runAsSystem, searchFacts, setAnswerer, staffOnly, KumiError, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, parking: string, doorCode: string;
const TZ = "America/Los_Angeles";
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-08:00`);
const NOW = at("2026-12-01", "10:00");
const people: Record<string, string> = {};
const as = (name: string, lang: "en" | "es" = "en"): Actor => ({ personId: people[name]!, via: "test", lang });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => { assert.ok(e instanceof KumiError, String(e)); assert.equal(e.code, code); return true; });
}
const thread = async (id: string) => db.selectFrom("question").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const said = async (personId: string, kind: string, channel: "email" | "inbox" | "push" = "email") =>
  (await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", personId).where("kind", "=", kind).where("channel", "=", channel).orderBy("created_at", "desc").executeTakeFirstOrThrow());

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  const loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  await run(db, "hours.set", { location_id: loc, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "09:00", closes: "17:00" })) }, owner, { now: NOW });
  for (const name of ["Ann", "Ben", "Cal", "Fay"]) people[name] = ((await run(db, "person.create", { display_name: name, email: `${name.toLowerCase()}@example.test` }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: people.Fay, role: "front_desk" }, owner);
  people.Mia = ((await run(db, "household.add_junior", { person_id: people.Ann, display_name: "Mia", birth_year: 2016 }, as("Ann"))).result as any).person_id;
});
after(async () => drop());

test("staff write the club's facts in its languages; members search them by plain words", async () => {
  await rejects(plan(db, "fact.create", { topic: "parking", question_en: "Where do I park?", answer_en: "Behind the club.", question_es: "¿Dónde estaciono?", answer_es: "Detrás del club." }, as("Ann")), "error.forbidden_reason");
  await rejects(plan(db, "fact.create", { topic: "parking", question_en: "Where do I park?", answer_en: "In the lot behind the club." }, as("Fay")), "error.fact_needs_lang");
  await rejects(plan(db, "fact.create", { topic: "parking", question_en: "Where do I park?", question_es: "¿Dónde estaciono?", answer_es: "Detrás del club." }, as("Fay")), "error.fact_half");
  const p = await run(db, "fact.create", { topic: "parking", question_en: "Where do I park?", answer_en: "Free parking in the lot behind the club, and bike racks by the door.",
    question_es: "¿Dónde estaciono?", answer_es: "Estacionamiento gratis detrás del club, y aparcabicis junto a la puerta.", public: true }, as("Fay"));
  assert.equal(p.plan.summary.en, "Add a club fact under Parking and getting here: \"Where do I park?\" Members see it in Common questions, and on the club's public page while it's on.");
  parking = (p.result as any).fact_id;
  await run(db, "fact.create", { topic: "hours", question_en: "When are you open?", answer_en: "Every day, 9 AM to 5 PM.", question_es: "¿Cuándo abren?", answer_es: "Todos los días, de 9 a. m. a 5 p. m." }, as("Fay"));
  doorCode = ((await run(db, "fact.create", { topic: "facilities", question_en: "What's the door code?", answer_en: "4417, then the green button.", question_es: "¿Cuál es el código de la puerta?", answer_es: "4417 y luego el botón verde." }, as("Fay"))).result as any).fact_id;

  assert.equal((await searchFacts(db, "Where can I park my car?"))[0]!.id, parking);
  assert.equal((await searchFacts(db, "¿Dónde puedo estacionar?"))[0]!.id, parking);
  assert.equal((await searchFacts(db, "bike"))[0]!.id, parking);   // a word in the answer finds it too
  assert.deepEqual(await searchFacts(db, "tennis rackets"), []);
  assert.deepEqual((await searchFacts(db, "")).map((f) => f.topic), ["hours", "parking", "facilities"]);   // everything, by topic
  assert.deepEqual((await searchFacts(db, "", { publicOnly: true })).map((f) => f.id), [parking]);           // the door code isn't public

  const off = await run(db, "fact.update", { fact_id: doorCode, active: false }, as("Fay"));
  assert.equal(off.plan.summary.en, "Stop showing the club fact \"What's the door code?\" to members and on the public page. It's kept and can be shown again.");
  assert.ok(!(await searchFacts(db, "door code")).some((f) => f.id === doorCode));
  const ch = await run(db, "fact.update", { fact_id: parking, answer_en: "Free parking behind the club.", public: false }, as("Fay"));
  assert.equal(ch.plan.summary.en, "Change the club fact \"Where do I park?\": the answer, whether it's on the public page.");
  await rejects(plan(db, "fact.update", { fact_id: parking, answer_en: "Free parking behind the club." }, as("Fay")), "error.nothing_changed");
  await run(db, "fact.update", { fact_id: parking, public: true }, as("Fay"));
});

test("a member asks; front desk answers; a reply opens it again; others can't join in", async () => {
  const a = await run(db, "question.ask", { person_id: people.Ann, body: "Can I bring my dog to watch a match on Saturday?" }, as("Ann"), { now: NOW });
  assert.equal(a.plan.summary.en, "Ask the club: \"Can I bring my dog to watch a match on Saturday?\" The staff answer in the app, and you hear when they do.");
  const id = (a.result as any).question_id;
  assert.equal((a.result as any).answered_by, "staff");
  let q = await thread(id);
  assert.deepEqual([q.status, q.waiting_since?.toISOString(), q.asked_by], ["open", NOW.toISOString(), people.Ann]);
  const d = await db.selectFrom("answer_decision").selectAll().where("question_id", "=", id).executeTakeFirstOrThrow();
  assert.deepEqual([d.answerer, d.questions_version, d.outcome, d.confidence], ["staff_only", "1", "staff", null]);   // kept even when it always hands over

  await rejects(plan(db, "question.answer", { question_id: id, body: "Yes" }, as("Ann")), "error.forbidden_reason");   // only staff answer
  await rejects(plan(db, "question.reply", { question_id: id, body: "Me too" }, as("Ben")), "error.forbidden_reason"); // not Ben's thread
  const ans = await run(db, "question.answer", { question_id: id, body: "Dogs on a lead are welcome on the terrace, Ann. Not on court." }, as("Fay"), { now: at("2026-12-01", "10:20") });
  assert.equal(ans.plan.summary.en, "Answer Ann: \"Dogs on a lead are welcome on the terrace, Ann. Not on court.\" They hear straight away.");
  q = await thread(id);
  assert.deepEqual([q.status, q.waiting_since, q.assigned_to], ["answered", null, people.Fay]);   // whoever answers takes it
  await processOutbox(db, messageHandlers);
  const m = await said(people.Ann!, "question_answered");
  assert.equal(m.subject, "The club answered your question");
  assert.equal(m.body, "Fay answered your question \"Can I bring my dog to watch a match on Saturday?\":\n\nDogs on a lead are welcome on the terrace, Ann. Not on court.\n\nYou can reply in the app.");

  await run(db, "question.reply", { question_id: id, body: "Great, and is there water for dogs?" }, as("Ann"), { now: at("2026-12-01", "11:00") });
  q = await thread(id);
  assert.deepEqual([q.status, q.waiting_since?.toISOString()], ["open", at("2026-12-01", "11:00").toISOString()]);
  await run(db, "question.answer", { question_id: id, body: "There's a bowl by the door.", close: true }, as("Fay"), { now: at("2026-12-01", "11:05") });
  assert.equal((await thread(id)).status, "closed");
  await rejects(plan(db, "question.close", { question_id: id }, as("Ann")), "error.question_closed");
  const re = await plan(db, "question.reply", { question_id: id, body: "One more thing about parking" }, as("Ann"));
  assert.equal(re.plan.summary.en, "Send to the club: \"One more thing about parking\". The question opens again for the staff.");

  // Front desk gives a question to someone; only front desk and up can have one.
  await rejects(plan(db, "question.assign", { question_id: id, to: people.Ben }, as("Fay")), "error.assign_desk_only");
  const g = await run(db, "question.assign", { question_id: id, to: owner.personId }, as("Fay"));
  assert.equal(g.plan.summary.en, "Give Ann's question to Robin Hale.");
  await processOutbox(db, messageHandlers);
  assert.equal((await said(owner.personId!, "question_assigned_staff", "inbox")).body, "Fay gave you Ann's question: \"Can I bring my dog to watch a match on Saturday?\" Answer it on the Questions page.");
});

test("a parent asks about their junior; a member can't ask about someone else", async () => {
  const a = await run(db, "question.ask", { person_id: people.Mia, body: "What should Mia bring to her first junior clinic?" }, as("Ann"), { now: NOW });
  assert.equal(a.plan.summary.en, "Ask the club about Mia: \"What should Mia bring to her first junior clinic?\" The staff answer in the app, and you hear when they do.");
  const q = await thread((a.result as any).question_id);
  assert.deepEqual([q.person_id, q.asked_by], [people.Mia, people.Ann]);
  await rejects(plan(db, "question.ask", { person_id: people.Mia, body: "Is Mia playing today?" }, as("Ben")), "error.forbidden_reason");
});

test("five new questions a day each, then wait", async () => {
  const day = at("2026-12-02", "10:00");
  for (let k = 0; k < 5; k++) await run(db, "question.ask", { person_id: people.Ben, body: `Question number ${k + 1} about the courts` }, as("Ben"), { now: day });
  await rejects(plan(db, "question.ask", { person_id: people.Ben, body: "And a sixth one" }, as("Ben"), { now: day }), "error.too_many_questions");
  await plan(db, "question.ask", { person_id: people.Ben, body: "The next day, a new one" }, as("Ben"), { now: at("2026-12-03", "10:01") });
  // Tidy up: these don't wait on anyone in the tests below.
  for (const q of await db.selectFrom("question").select("id").where("asked_by", "=", people.Ben!).execute()) await run(db, "question.close", { question_id: q.id }, as("Fay"));
});

test("a question that waits past the club's setting: front desk hears once, counting opening hours only", async () => {
  for (const q of await db.selectFrom("question").select("id").where("status", "=", "open").execute()) await run(db, "question.close", { question_id: q.id }, as("Fay"));
  // Open 9 to 5 every day: asked at 4:30 pm, it has waited 30 open minutes by closing and 2 hours at 10:30 the next morning.
  assert.equal(await openMinutes(db, at("2026-12-04", "16:30"), at("2026-12-05", "10:30")), 120);
  const id = ((await run(db, "question.ask", { person_id: people.Cal, body: "Do you rent rackets for beginners?" }, as("Cal"), { now: at("2026-12-04", "16:30") })).result as any).question_id;
  assert.deepEqual(await alertUnanswered(db, at("2026-12-04", "23:00")), { alerted: 0 });   // 6.5 hours on the clock, 30 minutes open
  assert.deepEqual(await alertUnanswered(db, at("2026-12-05", "10:29")), { alerted: 0 });
  assert.deepEqual(await alertUnanswered(db, at("2026-12-05", "10:30")), { alerted: 1 });
  assert.deepEqual(await alertUnanswered(db, at("2026-12-05", "15:00")), { alerted: 0 });   // said once
  assert.ok((await thread(id)).alerted_at);
  await processOutbox(db, messageHandlers);
  const m = await said(people.Fay!, "question_unanswered_staff");
  assert.equal(m.subject, "A question is waiting: Cal");
  assert.equal(m.body, "Cal asked on Fri, Dec 4, 4:30 PM, and nobody has answered in 2 hours of opening time: \"Do you rent rackets for beginners?\" Answer it on the Questions page.");
  assert.ok(await said(owner.personId!, "question_unanswered_staff"));                       // front desk and up
  assert.equal((await db.selectFrom("outbound_message").select("id").where("person_id", "=", people.Cal!).where("kind", "=", "question_unanswered_staff").execute()).length, 0);

  // A club that doesn't want the alert sets 0.
  await run(db, "club.update", { question_alert_hours: 0 }, owner);
  await run(db, "question.ask", { person_id: people.Cal, body: "And do you sell balls at the desk?" }, as("Cal"), { now: at("2026-12-06", "09:00") });
  assert.deepEqual(await alertUnanswered(db, at("2026-12-08", "09:00")), { alerted: 0 });
  await run(db, "club.update", { question_alert_hours: 2 }, owner);
});

test("the answerer: a fact it picks goes word for word, \"that didn't answer it\" goes to staff, and every decision is kept", async () => {
  setAnswerer({ name: "test_model", version: "q-7", async decide(q, facts) {
    const f = facts.find((x) => /park/i.test(q.text) && x.topic === "parking");
    return f ? { outcome: "fact", factId: f.id, confidence: 0.93, detail: { parking: 0.93 } } : { outcome: "staff", confidence: 0.4 };
  } });
  try {
    const a = await run(db, "question.ask", { person_id: people.Ben, body: "Is there parking for a van?" }, as("Ben"), { now: at("2026-12-07", "10:00") });
    const id = (a.result as any).question_id;
    assert.equal((a.result as any).answered_by, "club");
    const msgs = await db.selectFrom("question_message").select(["side", "body", "fact_id"]).where("question_id", "=", id).orderBy("created_at").orderBy("id").execute();
    assert.deepEqual(msgs.map((m) => [m.side, m.body, m.fact_id]), [["member", "Is there parking for a van?", null], ["club", "Free parking behind the club.", parking]]);
    let q = await thread(id);
    assert.deepEqual([q.status, q.waiting_since], ["answered", null]);   // nothing waits on the staff
    const d = await db.selectFrom("answer_decision").selectAll().where("question_id", "=", id).executeTakeFirstOrThrow();
    assert.deepEqual([d.answerer, d.questions_version, d.outcome, d.fact_id, Number(d.confidence), d.detail], ["test_model", "q-7", "fact", parking, 0.93, { parking: 0.93 }]);
    await processOutbox(db, messageHandlers);
    assert.equal((await said(people.Ben!, "question_club_answered")).body,
      "From the club's common questions, \"Where do I park?\":\n\nFree parking behind the club.\n\nIf that doesn't answer \"Is there parking for a van?\", tap \"That didn't answer it\" or \"Ask a person\" in the app and the staff will reply.");
    // Seen on the question's page in the app (as the members' app opens it after asking): the email, held a few
    // minutes, isn't sent as well.
    const mail = await db.selectFrom("outbound_message").select(["id", "send_after", "created_at"]).where("person_id", "=", people.Ben!).where("kind", "=", "question_club_answered").where("channel", "=", "email").executeTakeFirstOrThrow();
    assert.ok(new Date(mail.send_after).getTime() - new Date(mail.created_at).getTime() >= 5 * 60_000 - 1000);
    await db.updateTable("question").set({ member_seen_at: at("2026-12-07", "10:01") }).where("id", "=", id).execute();
    const sent: string[] = [];
    await sendEmails(db, { async send(m: { to: string }) { sent.push(m.to); return { id: "x" }; } } as any, new Date(new Date(mail.send_after).getTime() + 60_000));
    const after = await db.selectFrom("outbound_message").select(["status", "failure"]).where("id", "=", mail.id).executeTakeFirstOrThrow();
    assert.deepEqual([after.status, after.failure], ["dropped", "read in the app"]);

    const n = await run(db, "question.not_answered", { question_id: id }, as("Ben"), { now: at("2026-12-07", "10:05") });
    assert.equal(n.plan.summary.en, "Tell the club that answer didn't help. Your question goes to the staff, who answer in the app.");
    q = await thread(id);
    assert.deepEqual([q.status, q.waiting_since?.toISOString()], ["open", at("2026-12-07", "10:05").toISOString()]);
    assert.equal((await db.selectFrom("answer_decision").select("corrected").where("question_id", "=", id).executeTakeFirstOrThrow()).corrected, "not_answered");
    await rejects(plan(db, "question.not_answered", { question_id: id }, as("Ben")), "error.no_club_answer");   // the last word isn't the club's fact now

    // A failing or slow answerer never holds a member up: the question goes to staff, and why is kept.
    setAnswerer({ name: "test_model", version: "q-7", async decide() { throw new Error("service down"); } });
    const b = await run(db, "question.ask", { person_id: people.Ben, body: "Where do I park a trailer?" }, as("Ben"), { now: at("2026-12-07", "11:00") });
    assert.equal((b.result as any).answered_by, "staff");
    assert.deepEqual((await db.selectFrom("answer_decision").select(["outcome", "detail"]).where("question_id", "=", (b.result as any).question_id).executeTakeFirstOrThrow()), { outcome: "staff", detail: { error: "service down" } });
    setAnswerer({ name: "test_model", version: "q-7", timeoutMs: 20, decide: () => new Promise((ok) => setTimeout(() => ok({ outcome: "fact", factId: parking, confidence: 1 }), 500)) });
    const c = await run(db, "question.ask", { person_id: people.Ben, body: "Parking for a bus?" }, as("Ben"), { now: at("2026-12-07", "12:00") });
    assert.equal((c.result as any).answered_by, "staff");
    assert.deepEqual((await db.selectFrom("answer_decision").select(["outcome", "detail"]).where("question_id", "=", (c.result as any).question_id).executeTakeFirstOrThrow()), { outcome: "staff", detail: { error: "timed out" } });
  } finally { setAnswerer(staffOnly); }
});

test("ask the club: the question is saved before the model is asked, a staff answer wins, and the club can switch it off", async () => {
  // The model sees the question's words and the facts in the asker's language: nothing about the person.
  let seen: unknown = null, during: unknown = null;
  setAnswerer({ name: "test_model", version: "q-8", async decide(q, facts) {
    seen = { q, keys: Object.keys(facts[0]!).sort() };
    during = (await db.selectFrom("question").innerJoin("question_message", "question_message.question_id", "question.id").select("question.status")
      .where("question_message.body", "=", q.text).executeTakeFirst())?.status;
    const f = facts.find((x) => x.topic === "parking");
    return f ? { outcome: "fact", factId: f.id, confidence: 0.97, by: "jev" } : { outcome: "staff", confidence: 0.1 };
  } });
  try {
    const p = await plan(db, "question.ask", { person_id: people.Ben, body: "¿Dónde estaciono la moto?" }, as("Ben", "es"), { now: at("2026-12-08", "10:00") });
    assert.equal(p.plan.summary.en, "Ask the club: \"¿Dónde estaciono la moto?\" If one of the club's answers fits, you get it straight away; if not, the staff answer in the app, and you hear when they do.");
    const a = await run(db, "question.ask", { person_id: people.Ben, body: "¿Dónde estaciono la moto?" }, as("Ben", "es"), { now: at("2026-12-08", "10:00") });
    assert.equal((a.result as any).answered_by, "club");
    assert.equal(during, "open");   // already saved, with the staff, while the model thought
    assert.deepEqual((seen as any).keys, ["answer", "id", "question", "topic"]);
    assert.equal((seen as any).q.text, "¿Dónde estaciono la moto?");
    const d = await db.selectFrom("answer_decision").select(["answerer", "questions_version", "outcome"]).where("question_id", "=", (a.result as any).question_id).executeTakeFirstOrThrow();
    assert.deepEqual(d, { answerer: "jev", questions_version: "q-8", outcome: "fact" });   // the model that decided

    // "Ask a person": the fact may have been right; it goes to the staff, labelled differently.
    const id = (a.result as any).question_id;
    const ap = await run(db, "question.ask_person", { question_id: id }, as("Ben"), { now: at("2026-12-08", "10:02") });
    assert.equal(ap.plan.summary.en, "Ask a person at the club. Your question goes to the staff, who answer in the app.");
    assert.equal((await thread(id)).status, "open");
    assert.equal((await db.selectFrom("answer_decision").select("corrected").where("question_id", "=", id).executeTakeFirstOrThrow()).corrected, "wants_person");

    // The staff answer while the model is still deciding: theirs stands, and the pick is kept but not sent.
    setAnswerer({ name: "test_model", version: "q-8", async decide(q, facts) {
      const open = await db.selectFrom("question").innerJoin("question_message", "question_message.question_id", "question.id").select("question.id").where("question_message.body", "=", q.text).executeTakeFirstOrThrow();
      await run(db, "question.answer", { question_id: open.id, body: "Bike racks by the door, Ben." }, as("Fay"), { now: at("2026-12-08", "11:00") });
      return { outcome: "fact", factId: facts.find((x) => x.topic === "parking")!.id, confidence: 0.99 };
    } });
    const b = await run(db, "question.ask", { person_id: people.Ben, body: "Where do I leave my bike?" }, as("Ben"), { now: at("2026-12-08", "11:00") });
    assert.equal((b.result as any).answered_by, "staff");
    const bd = await db.selectFrom("answer_decision").select(["outcome", "fact_id", "detail"]).where("question_id", "=", (b.result as any).question_id).executeTakeFirstOrThrow();
    assert.deepEqual(bd, { outcome: "staff", fact_id: null, detail: { picked: parking, not_sent: "written_since" } });
    assert.deepEqual((await db.selectFrom("question_message").select("side").where("question_id", "=", (b.result as any).question_id).orderBy("created_at").orderBy("id").execute()).map((m) => m.side), ["member", "staff"]);

    // Switched off in Settings: the model isn't asked at all.
    await run(db, "club.update", { auto_answers: false }, owner);
    const off = await plan(db, "question.ask", { person_id: people.Ben, body: "Is there parking?" }, as("Ben"), { now: at("2026-12-08", "12:00") });
    assert.match(off.plan.summary.en, /The staff answer in the app/);
    const c = await run(db, "question.ask", { person_id: people.Ben, body: "Is there parking?" }, as("Ben"), { now: at("2026-12-08", "12:00") });
    assert.equal((c.result as any).answered_by, "staff");
    assert.deepEqual(await db.selectFrom("answer_decision").select(["answerer", "detail"]).where("question_id", "=", (c.result as any).question_id).executeTakeFirstOrThrow(),
      { answerer: "test_model", detail: { skipped: "club_off" } });
    await run(db, "club.update", { auto_answers: true }, owner);
    // Past the club's monthly meter's ceiling (twice the limit, at least $2): not asked either. Below it, decisions
    // keep going past the cap.
    await db.updateTable("club").set({ usage_cap_cents: 0 }).execute();
    await db.insertInto("usage_month").values({ month: "2026-12-01", kind: "texts", count: 1, segments: 1, cents: "200.5" }).execute();
    const cut = await run(db, "question.ask", { person_id: people.Ben, body: "Is there parking?" }, as("Ben"), { now: at("2026-12-08", "12:30") });
    assert.deepEqual(await db.selectFrom("answer_decision").select(["answerer", "detail"]).where("question_id", "=", (cut.result as any).question_id).executeTakeFirstOrThrow(),
      { answerer: "test_model", detail: { skipped: "usage_ceiling" } });
    await db.deleteFrom("usage_month").execute();
    await db.updateTable("club").set({ usage_cap_cents: 5000 }).execute();
    // The health check's count leaves out questions no model was asked about.
    assert.deepEqual(await answerCounts(db, at("2026-12-08", "13:00")), { total: 2, answered: 1, errors: 0 });
  } finally { setAnswerer(staffOnly); }
});

test("a member's file has their questions; deleting them takes their words out everywhere", async () => {
  const a = await run(db, "question.ask", { person_id: people.Cal, body: "My knee surgery is next week, can I pause my plan?" }, as("Cal"), { now: at("2026-12-09", "10:00") });
  const id = (a.result as any).question_id;
  await run(db, "question.answer", { question_id: id, body: "Sorry to hear it, Cal. Yes, the desk can pause it." }, as("Fay"), { now: at("2026-12-09", "10:10") });
  await run(db, "question.reply", { question_id: id, body: "Thanks, please pause it from Monday for six weeks" }, as("Cal"), { now: at("2026-12-09", "10:20") });
  await processOutbox(db, messageHandlers);
  const file = await exportData(db, people.Cal!, at("2026-12-09", "11:00"), "en");
  const mine = (file.questions as any[]).find((q) => q.messages[0].text.startsWith("My knee"));
  assert.deepEqual(mine.messages.map((m: any) => [m.side, m.from, m.text]), [["member", "Cal", "My knee surgery is next week, can I pause my plan?"],
    ["staff", "Fay", "Sorry to hear it, Cal. Yes, the desk can pause it."], ["member", "Cal", "Thanks, please pause it from Monday for six weeks"]]);

  await run(db, "privacy.erase", { person_id: people.Cal }, owner, { now: at("2026-12-09", "12:00") });
  const msgs = await db.selectFrom("question_message").select(["side", "body"]).where("question_id", "=", id).orderBy("created_at").orderBy("id").execute();
  assert.deepEqual(msgs.map((m) => m.body), ["[removed]", "Sorry to hear it, Former member. Yes, the desk can pause it.", "[removed]"]);
  assert.equal((await thread(id)).status, "closed");
  // Nowhere else either: the change log, the events behind messages, anyone's messages.
  const leaks = await sql<{ n: string }>`SELECT
      (SELECT count(*) FROM action_run WHERE (input::text || plan::text) ILIKE ANY (${["%knee surgery%", "%six weeks%"]}::text[]))
    + (SELECT count(*) FROM entity_change WHERE (coalesce(before::text, '') || after::text) ILIKE ANY (${["%knee surgery%", "%six weeks%"]}::text[]))
    + (SELECT count(*) FROM event_outbox WHERE payload::text ILIKE '%knee surgery%')
    + (SELECT count(*) FROM outbound_message WHERE (subject || body) ILIKE '%knee surgery%') AS n`.execute(db);
  assert.equal(Number(leaks.rows[0]!.n), 0);
});
