// Ask openPadel, the hosted assistant (assistant.ts), driven by a fake model: no network. It reads through the same
// door an outside assistant uses, offers only what the person may use, returns a change as the preview the app
// confirms (never applying it), stops plainly at the club's monthly limit and counts what it costs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { claudeCents, exportData, HOSTED_CLIENT_ID, monthOf, run, runAsSystem, tidyAssistantChats, type Actor, type Db } from "@kumi/core";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { MEMBER_MODEL, STAFF_MODEL, type ModelClient } from "../src/assistant.ts";

const TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor;
let robin = "", ann = "", kim = "", loc = "";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const session = async (personId: string) => {
  const token = randomBytes(16).toString("hex");
  await db.insertInto("web_session").values({ token_hash: sha(token), person_id: personId, expires_at: new Date(Date.now() + 864e5), last_seen_at: new Date(), user_agent: null, revoked_at: null, method: "passkey", second_factor: null }).execute();
  return `kumi_session=${token}`;
};
const post = async (cookie: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json", "accept-language": "en", ...headers }, body: JSON.stringify(body) });
const get = async (cookie: string, path: string) => app.request(path, { headers: { cookie, "accept-language": "en" } });

// ---- The fake model: answers in turn from a script, and keeps what it was asked. ----
type Step = (req: Anthropic.MessageCreateParamsNonStreaming) => { content: unknown[]; stop_reason?: string };
const asked: Anthropic.MessageCreateParamsNonStreaming[] = [];
let script: Step[] = [];
const USAGE = { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 3000, cache_read_input_tokens: 9000 };
const fake: ModelClient = {
  async create(req) {
    asked.push(structuredClone(req));
    const step = script.shift();
    if (!step) throw new Error("the script ran out");
    const r = step(req), uses = r.content.some((b: any) => b.type === "tool_use");
    return { id: `msg_${asked.length}`, type: "message", role: "assistant", model: req.model, content: r.content, stop_reason: r.stop_reason ?? (uses ? "tool_use" : "end_turn"),
      stop_sequence: null, usage: USAGE } as unknown as Anthropic.Message;
  },
};
const say = (text: string): Step => () => ({ content: [{ type: "text", text }] });
const use = (name: string, input: unknown, text?: string): Step => () => ({ content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id: `tu_${randomBytes(4).toString("hex")}`, name, input }] });
/** The last tool result the model was given, as text. */
const lastResult = (req: Anthropic.MessageCreateParamsNonStreaming) => {
  const m = req.messages[req.messages.length - 1]!;
  const r = (m.content as any[]).find((b) => b.type === "tool_result");
  return { text: typeof r.content === "string" ? r.content : JSON.stringify(r.content), error: Boolean(r.is_error) };
};
const toolNames = (req: Anthropic.MessageCreateParamsNonStreaming) => (req.tools as Anthropic.Tool[]).map((t) => t.name);

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  robin = (s.result as any).owner_person_id;
  owner = { personId: robin, via: "test", lang: "en", auth: "passkey" };
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: TZ }, owner)).result as any).location_id;
  await run(db, "court.create", { location_id: loc, name: "Court 1" }, owner);
  ann = ((await run(db, "person.create", { display_name: "Ann Lee", email: "ann@example.test" }, owner)).result as any).person_id;
  kim = ((await run(db, "person.create", { display_name: "Kim", email: "kim@example.test" }, owner)).result as any).person_id;
  app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false, assistant: fake });
});
after(async () => drop());

test("staff: a question answered from a read, on Claude Sonnet, and the meter counts each call", async () => {
  const cookie = await session(robin);
  script = [use("locations", {}), (req) => { assert.match(lastResult(req).text, /Eastside/); return { content: [{ type: "text", text: "One location: Eastside." }] }; }];
  asked.length = 0;
  const r = await post(cookie, "/assistant/turn", { app: "staff", text: "Which locations do we have?" });
  assert.equal(r.status, 200, await r.clone().text());
  const b = await r.json() as any;
  assert.equal(b.text, "One location: Eastside.");
  assert.deepEqual(b.previews, []);
  assert.equal(asked.length, 2);
  assert.equal(asked[0]!.model, STAFF_MODEL);
  const names = toolNames(asked[0]!);
  assert.ok(names.includes("locations") && names.includes("people") && names.includes("court_block_preview"), "an owner's staff reads and changes are offered");
  assert.ok(!names.some((n) => n.endsWith("_confirm")), "never a confirm: the person confirms in the app");
  assert.match(String(asked[0]!.system), /Robin Hale/);
  // Counted as Ask openPadel's own kind, at Sonnet's price, cache reads and writes included.
  const line = await db.selectFrom("usage_month").select(["count", "input_tokens", "output_tokens", "cents"]).where("kind", "=", "ai_assistant").executeTakeFirstOrThrow();
  assert.equal(line.count, 2);
  assert.equal(Number(line.input_tokens), 2 * (1200 + 3000 + 9000));
  assert.equal(Number(line.output_tokens), 160);
  const one = claudeCents("sonnet", { input: 1200, output: 80, cacheWrite: 3000, cacheRead: 9000 });
  assert.ok(Math.abs(Number(line.cents) - 2 * one) < 1e-4, `${line.cents} vs ${2 * one}`);
  // Kept as the person's conversation: their words and the reply.
  const chat = await (await get(cookie, `/assistant/chats/${b.chat_id}`)).json() as any;
  assert.equal(chat.surface, "staff");
  assert.deepEqual(chat.turns.map((x: any) => [x.role, x.text]), [["user", "Which locations do we have?"], ["assistant", "One location: Eastside."]]);
  // The next turn sends the conversation so far back, thinking and tool results as they were.
  script = [say("Still one.")];
  asked.length = 0;
  await post(cookie, "/assistant/turn", { app: "staff", chat_id: b.chat_id, text: "And now?" });
  assert.equal(asked[0]!.messages.length, 5, "question, tool use, tool result, reply, new question");
});

test("a member: a change comes back as the preview and isn't applied until they confirm it in the app", async () => {
  const cookie = await session(ann);
  script = [use("question_ask_preview", { person_id: ann, body: "Do you rent paddles?" }), (req) => {
    const r = lastResult(req);
    assert.equal(r.error, false, r.text);
    assert.match(r.text, /Confirm button/);
    return { content: [{ type: "text", text: "I can send that to the club. Confirm it below." }] };
  }];
  asked.length = 0;
  const b = await (await post(cookie, "/assistant/turn", { app: "member", text: "Ask the club if they rent paddles" })).json() as any;
  assert.equal(asked[0]!.model, MEMBER_MODEL);
  assert.equal(b.previews.length, 1);
  const p = b.previews[0];
  assert.equal(p.action, "question.ask");
  assert.equal(p.status, "planned");
  assert.match(p.summary, /paddles/);
  // Planned through the hosted connection, marked as the hosted assistant's; nothing asked yet.
  const run0 = await db.selectFrom("action_run").innerJoin("oauth_grant", "oauth_grant.id", "action_run.oauth_grant_id").select(["action_run.status", "action_run.via", "oauth_grant.client_id", "action_run.actor_person_id"])
    .where("action_run.id", "=", p.run_id).executeTakeFirstOrThrow();
  assert.deepEqual(run0, { status: "planned", via: "assistant:hosted:member", client_id: HOSTED_CLIENT_ID, actor_person_id: ann });
  assert.equal((await db.selectFrom("question").select("id").where("person_id", "=", ann).execute()).length, 0, "nothing changed");
  // The person's own Confirm, through the app's usual route.
  const done = await post(cookie, `/runs/${p.run_id}/apply`, {}, { "idempotency-key": p.run_id });
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal((await db.selectFrom("question").select("id").where("person_id", "=", ann).execute()).length, 1);
  // It shows on their Assistants list like one they connected, at $0 a week until they choose more.
  const list = await (await get(cookie, "/my/assistants")).json() as any[];
  assert.deepEqual(list.map((a) => [a.name, a.weekly_cap_cents]), [["Ask openPadel", 0]]);
});

test("what the person may not use is never offered, and a tool named anyway is refused without being run", async () => {
  // A member: no staff reads or staff changes.
  const ac = await session(ann);
  script = [use("court_block_preview", { court_id: "00000000-0000-7000-8000-000000000000" }), (req) => {
    assert.equal(lastResult(req).error, true); return { content: [{ type: "text", text: "I can't do that." }] }; }];
  asked.length = 0;
  const before = await db.selectFrom("action_run").select((e) => e.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
  await post(ac, "/assistant/turn", { app: "member", text: "Block court 1" });
  const names = toolNames(asked[0]!);
  assert.ok(names.includes("open_matches") && names.includes("question_ask_preview"));
  for (const n of ["people", "person_page", "day", "court_block_preview", "booking_cancel_confirm"]) assert.ok(!names.includes(n), `${n} isn't offered to a member`);
  const after = await db.selectFrom("action_run").select((e) => e.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
  assert.equal(after.n, before.n, "nothing planned, not even a refusal");
  // The owner in the members' app: a member's reach there, whatever their roles.
  const rc = await session(robin);
  script = [say("Hello")];
  asked.length = 0;
  await post(rc, "/assistant/turn", { app: "member", text: "Hi" });
  const owners = toolNames(asked[0]!);
  for (const n of ["people", "court_block_preview", "club_usage_cap_set_preview"]) assert.ok(!owners.includes(n), `${n} isn't offered in the members' app`);
  // A member can't open the staff one at all; and the owner's cap is the app's alone, never offered anywhere.
  assert.equal((await post(ac, "/assistant/turn", { app: "staff", text: "Hi" })).status, 403);
  script = [say("Hello")];
  asked.length = 0;
  await post(rc, "/assistant/turn", { app: "staff", text: "Hi" });
  assert.ok(!toolNames(asked[0]!).includes("club_usage_cap_set_preview"), "a strong-sign-in change stays the app's");
});

test("past the club's monthly limit it says so and stops, without calling the model; the rest goes on", async () => {
  const cookie = await session(kim);
  const tz = (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone, month = monthOf(new Date(), tz);
  const was = await db.selectFrom("club").select(["usage_cap_cents", "usage_over_cents"]).executeTakeFirstOrThrow();
  await db.updateTable("club").set({ usage_cap_cents: 100, usage_over_cents: 0 }).execute();
  await db.insertInto("usage_month").values({ month, kind: "texts", count: 1, cents: "150" }).onConflict((oc) => oc.columns(["month", "kind"]).doUpdateSet({ cents: "150" })).execute();
  script = [];
  asked.length = 0;
  const r = await post(cookie, "/assistant/turn", { app: "member", text: "Any open matches tonight?" });
  assert.equal(r.status, 200);
  const b = await r.json() as any;
  assert.equal(b.stopped, "usage");
  assert.match(b.text, /paused until the 1st/);
  assert.equal(asked.length, 0, "the model isn't called");
  assert.equal((await (await get(cookie, "/assistant?app=member")).json() as any).paused, true);
  // The conversation keeps what was said; the app's own changes go on.
  const chat = await (await get(cookie, `/assistant/chats/${b.chat_id}`)).json() as any;
  assert.equal(chat.turns.length, 2);
  const plan = await post(cookie, "/actions/question.ask/plan", { person_id: kim, body: "Are you open on Sunday?" });
  assert.equal(plan.status, 200);
  await db.updateTable("club").set(was).execute();
  await db.deleteFrom("usage_month").where("kind", "=", "texts").execute();
});

test("off without a key: the app says so and nothing runs", async () => {
  const off = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false });
  const cookie = await session(robin);
  const s = await (await off.request("/assistant?app=staff", { headers: { cookie } })).json() as any;
  assert.equal(s.on, false);
  const r = await off.request("/assistant/turn", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ app: "staff", text: "Hi" }) });
  assert.equal(r.status, 503);
  assert.equal((await r.json() as any).error, "error.assistant_off");
});

test("turned off under Assistants, it stays off until turned on again", async () => {
  const cookie = await session(ann);
  const grant = (await db.selectFrom("oauth_grant").select("id").where("person_id", "=", ann).where("client_id", "=", HOSTED_CLIENT_ID).where("revoked_at", "is", null).executeTakeFirstOrThrow()).id;
  await run(db, "assistant.disconnect", { grant_id: grant }, { personId: ann, via: "test", lang: "en" });
  const r = await post(cookie, "/assistant/turn", { app: "member", text: "Hi" });
  assert.equal(r.status, 409);
  assert.equal((await (await get(cookie, "/assistant?app=member")).json() as any).turned_off, true);
  assert.equal((await post(cookie, "/assistant/turn-on", {})).status, 200);
  script = [say("Hi Ann")];
  assert.equal((await post(cookie, "/assistant/turn", { app: "member", text: "Hi" })).status, 200);
});

test("conversations: only the person's own, in their data export, deleted by them or after 30 days", async () => {
  const cookie = await session(ann), other = await session(kim);
  const mine = (await (await get(cookie, "/assistant?app=member")).json() as any).chats;
  assert.ok(mine.length >= 2);
  assert.equal((await get(other, `/assistant/chats/${mine[0].id}`)).status, 404, "nobody else's");
  const robinPlan = await post(await session(robin), "/actions/assistant.chat_delete/plan", { chat_id: mine[0].id });
  assert.notEqual(robinPlan.status, 200, "not even the owner's");
  const exported = await exportData(db, ann, new Date(), "en") as any;
  assert.ok(exported.assistant_chats.some((c: any) => c.turns.some((t: any) => t.text === "Ask the club if they rent paddles")));
  // One, then all of them.
  const p = await (await post(cookie, "/actions/assistant.chat_delete/plan", { chat_id: mine[0].id })).json() as any;
  assert.match(p.summary, /Delete your conversation/);
  assert.equal((await post(cookie, `/runs/${p.run_id}/apply`, {}, { "idempotency-key": p.run_id })).status, 200);
  assert.equal((await get(cookie, `/assistant/chats/${mine[0].id}`)).status, 404);
  const all = await (await post(cookie, "/actions/assistant.chat_delete/plan", {})).json() as any;
  assert.match(all.summary, /Delete (your conversation|all \d+ of your conversations)/);
  await post(cookie, `/runs/${all.run_id}/apply`, {}, { "idempotency-key": all.run_id });
  assert.equal((await db.selectFrom("assistant_chat").select("id").where("person_id", "=", ann).execute()).length, 0);
  // Others' go 30 days after their last turn.
  const left = await db.selectFrom("assistant_chat").select("id").execute();
  assert.ok(left.length > 0);
  assert.equal((await tidyAssistantChats(db, new Date(Date.now() + 29 * 864e5))).deleted, 0);
  assert.equal((await tidyAssistantChats(db, new Date(Date.now() + 31 * 864e5))).deleted, left.length);
  assert.equal((await db.selectFrom("assistant_message").select("id").execute()).length, 0, "their messages with them");
});

test("the hosted assistant's client can't be used to sign an outside assistant in", async () => {
  const r = await app.request("/oauth/device_authorization", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: HOSTED_CLIENT_ID }).toString() });
  assert.equal(r.status, 400);
  const tok = await app.request("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: HOSTED_CLIENT_ID, grant_type: "refresh_token", refresh_token: "x" }).toString() });
  assert.equal((await tok.json() as any).error, "invalid_client");
});
