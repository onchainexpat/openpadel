// The accounting export plugin against a fake club, a fake Xero and a fake QuickBooks: connecting by OAuth (and a state
// that isn't its own refused), refresh tokens kept through the door as they change, each club day's journal balanced
// to the cent with the settings' accounts, nothing sent twice (again, after a restart, after a crash mid-send), a late
// refund in the next day's journal, a back-dated change as one adjusting journal naming its day, the provider down and
// back, a forged callback refused, the cards in both languages, and nothing secret in its log.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { plugin, type Plugin } from "../src/server.ts";
import { fileStore, memoryStore, type Store } from "../src/store.ts";
import { amount, mapLines, parseSettings, atClub, localNow } from "../src/books.ts";
import { redact } from "../src/log.ts";
import { at, fakeClub, fakeQuickBooks, fakeXero, KEPT, TZ } from "./fakes.ts";

const MANIFEST = JSON.parse(readFileSync(new URL("../../../docs/plugins/examples/accounting-export/openpadel-plugin.json", import.meta.url), "utf8"));
const logs: string[] = [];
const log = (level: string, msg: string, f: Record<string, unknown> = {}) => { logs.push(redact(JSON.stringify({ level, msg, ...f }))); };
const sleeps: number[] = [];
let clock = 0;

interface Run { p: Plugin; server: Server; base: string }
async function start(club: Awaited<ReturnType<typeof fakeClub>>, endpoints: Record<string, string>, store: Store = memoryStore()): Promise<Run> {
  const p = plugin({ store, log, allowHttp: true, timers: false, now: () => clock, endpoints, sleep: async (ms) => { sleeps.push(ms); } });
  const server = await p.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const r = club.registration(clock);
  assert.equal(await post(base, "/register", r.body, { "openpadel-signature-ed25519": r.header }), 200);
  await p.runners.get(club.url)!.idle();
  return { p, server, base };
}
async function stop(r: Run) { r.p.stop(); r.server.closeAllConnections(); await new Promise((x) => r.server.close(x)); }
async function post(base: string, path: string, body: string, headers: Record<string, string>) {
  return (await fetch(`${base}${path}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } })).status;
}
async function postJson(base: string, path: string, body: string, headers: Record<string, string>) {
  const r = await fetch(`${base}${path}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  return { status: r.status, json: await r.json() as any };
}
const runnerOf = (r: Run, club: { url: string }) => r.p.runners.get(club.url)!;
async function tickAt(r: Run, club: { url: string }, t: number) { clock = t; const x = runnerOf(r, club); await x.serial(() => x.tick(clock)); }
async function health(r: Run) { const res = await fetch(`${r.base}/health`); return { status: res.status, json: await res.json() as any }; }
/** The owner presses Connect on the card and says yes at the provider: the provider's code comes back with the card's state. */
async function connect(r: Run, club: Awaited<ReturnType<typeof fakeClub>>, oauth: { approve: (c: string) => string }, extra: Record<string, string> = {}) {
  const link = club.state.shown.get("connectors")?.link?.url as string;
  assert.ok(link?.startsWith("https://"), "the Connectors card links to the provider's sign-in");
  const u = new URL(link);
  const code = oauth.approve(u.searchParams.get("code_challenge")!);
  const cb = club.callback(clock, { code, state: u.searchParams.get("state")!, ...extra });
  return postJson(r.base, "/callback", cb.body, { "openpadel-signature": cb.header });
}
const balanced = (lines: { LineAmount: number }[]) => lines.reduce((n, l) => n + Math.round(l.LineAmount * 100), 0) === 0;

const XERO_SETTINGS = { provider: "xero", send_at: "06:00", start_date: "2026-11-15", account_courts: "200", account_lessons: "201", account_tax: "820", account_card: "610",
  account_card_fees: "404", account_bank: "090", account_other: "999" };

let club: Awaited<ReturnType<typeof fakeClub>>, xero: Awaited<ReturnType<typeof fakeXero>>, qclub: Awaited<ReturnType<typeof fakeClub>>, qbo: Awaited<ReturnType<typeof fakeQuickBooks>>;
before(async () => { club = await fakeClub(); xero = await fakeXero(); qclub = await fakeClub("Heron Padel"); qbo = await fakeQuickBooks(); });
after(() => { club.close(); xero.close(); qclub.close(); qbo.close(); });

test("the books: accounts from the settings, refunds off their takings, the rest to anything else, amounts from integers", () => {
  const s = parseSettings({ ...XERO_SETTINGS, send_at: "6:5" });
  assert.equal(s.sendAt, "06:00", "a time that doesn't read falls back to 06:00");
  assert.deepEqual(s.problems, ["send_at"]);
  const m = mapLines({ "takings.courts": -12000, "refunds.courts": 2000, "takings.after_restore": -500, tax: -990, "card.in": 11490, brought_in: 0 }, s);
  assert.deepEqual(m.lines.map((l) => [l.key, l.account, l.cents]), [["card.in", "610", 11490], ["refunds.courts", "200", 2000], ["takings.after_restore", "999", -500], ["takings.courts", "200", -12000], ["tax", "820", -990]]);
  assert.equal(m.suspense, 1, "other takings had no account");
  assert.equal(m.lines[0]!.description, "Card payments [card.in]");
  assert.equal(amount(1), 0.01); assert.equal(amount(-12345), -123.45); assert.equal(amount(1005), 10.05); assert.equal(amount(29), 0.29);
  assert.equal(atClub("2026-11-17", "06:00", TZ), at("2026-11-17", 6));
  assert.deepEqual(localNow(at("2026-11-17", 23, 59), TZ), { date: "2026-11-17", time: "23:59" });
});

test("Xero: connect by OAuth (a strange state refused), each day one balanced journal, never twice, a late refund, an adjustment, rotation kept", async () => {
  club.state.settings = { ...XERO_SETTINGS };
  club.state.vault.set("XERO_CLIENT_ID", xero.oauth.s.clientId);
  club.state.vault.set("XERO_CLIENT_SECRET", xero.oauth.s.clientSecret);
  // The 15th: courts and tax by card, a fee. The 16th: a lesson, and a refund of a court booked on the 15th (the late refund).
  club.state.days.set("2026-11-15", [{ key: "takings.courts", cents: -12000 }, { key: "tax", cents: -990 }, { key: "card.in", cents: 12990 }, { key: "card.fees", cents: 407 }, { key: "card.fees_out", cents: -407 }]);
  club.state.days.set("2026-11-16", [{ key: "takings.lessons", cents: -5000 }, { key: "refunds.courts", cents: 2000 }, { key: "card.in", cents: 5000 }, { key: "card.out", cents: -2000 }]);
  clock = at("2026-11-17", 5, 0);
  const endpoints = { xeroIdentity: xero.url, xeroApi: xero.url };
  let r = await start(club, endpoints);
  // Not connected: the card says so, with the redirect address to register and the link to connect.
  const card = club.state.shown.get("connectors");
  assert.equal(card.tone, "off");
  assert.ok(card.rows.some((x: any) => x.text.en === `${club.url}/plugins/accounting-export/callback`), JSON.stringify(card));
  assert.equal(card.link.label.en, "Connect Xero");
  const link = new URL(card.link.url);
  assert.equal(link.origin + link.pathname, "https://login.xero.com/identity/connect/authorize");
  assert.equal(link.searchParams.get("code_challenge_method"), "S256");
  assert.equal(link.searchParams.get("redirect_uri"), `${club.url}/plugins/accounting-export/callback`);
  assert.ok(card.link.url.length <= 500);

  // A state it didn't give: refused, and nothing kept.
  const forged = club.callback(clock, { code: xero.oauth.approve("x"), state: "not-the-state-it-gave-out" });
  assert.deepEqual((await postJson(r.base, "/callback", forged.body, { "openpadel-signature": forged.header })).json, { ok: false, error: "state" });
  // A callback the club didn't sign: refused before anything.
  const unsigned = club.callback(clock, { code: "x", state: link.searchParams.get("state")! }, { secret: "opps_someone_else" });
  assert.equal((await postJson(r.base, "/callback", unsigned.body, { "openpadel-signature": unsigned.header })).status, 401);
  assert.equal(club.state.kept.length, 0);

  const c = await connect(r, club, xero.oauth);
  assert.deepEqual(c.json, { ok: true });
  assert.equal(club.state.vault.get("XERO_REFRESH_TOKEN"), xero.oauth.latest(), "the refresh token went straight into the club's vault");
  assert.equal(xero.oauth.s.lastRedirect, `${club.url}/plugins/accounting-export/callback`);
  assert.match(club.state.shown.get("connectors").rows[0].text.en, /^Connected to Kestrel Padel LLC$/);
  // The state is single use.
  const again = club.callback(clock, { code: xero.oauth.approve("y"), state: link.searchParams.get("state")! });
  assert.equal((await postJson(r.base, "/callback", again.body, { "openpadel-signature": again.header })).json.error, "state");

  // Before the send time: nothing. At 6:30: the 15th and the 16th, oldest first.
  await tickAt(r, club, at("2026-11-17", 5, 59));
  assert.equal(xero.state.journals.length, 0);
  await tickAt(r, club, at("2026-11-17", 6, 30));
  assert.deepEqual(xero.state.journals.map((j) => [j.Narration, j.Date, j.Status, j.LineAmountTypes]), [
    ["openPadel 2026-11-15 (Kestrel Padel)", "2026-11-15", "POSTED", "NoTax"], ["openPadel 2026-11-16 (Kestrel Padel)", "2026-11-16", "POSTED", "NoTax"]]);
  const [d15, d16] = xero.state.journals as [typeof xero.state.journals[0], typeof xero.state.journals[0]];
  assert.ok(balanced(d15.JournalLines) && balanced(d16.JournalLines));
  assert.deepEqual(d15.JournalLines.map((l) => [l.AccountCode, l.LineAmount]).sort(), [["200", -120], ["404", 4.07], ["610", -4.07], ["610", 129.9], ["820", -9.9]].sort());
  assert.deepEqual(d16.JournalLines.find((l) => l.Description === "Court refunds [refunds.courts]"), { LineAmount: 20, AccountCode: "200", Description: "Court refunds [refunds.courts]" },
    "the refund of the 15th's court is in the 16th's journal, off court takings");
  assert.equal(club.state.shown.get("money").rows.find((x: any) => x.label.en === "Last day sent").text.en, "Mon, Nov 16");
  const h = await health(r);
  assert.equal(h.status, 200);
  assert.equal(h.json.last_sent_day, "2026-11-16");
  assert.equal(h.json.next_send_at, new Date(at("2026-11-18", 6)).toISOString());
  assert.ok(!JSON.stringify(h.json).includes("Kestrel"), "health names no club or organisation");

  // Again the same day, and again: nothing more.
  await tickAt(r, club, at("2026-11-17", 6, 31));
  await tickAt(r, club, at("2026-11-17", 9, 0));
  assert.equal(xero.state.posts, 2);

  // The next morning (the access token has run out): a refresh, and the new refresh token kept before anything else.
  const before = club.state.vault.get("XERO_REFRESH_TOKEN");
  club.state.today = "2026-11-18";
  club.state.days.set("2026-11-17", [{ key: "takings.courts", cents: -3000 }, { key: "cash.in", cents: 3000 }]);
  // A back-dated change to the 16th: a payment found after a restore, counted on the day it was paid.
  club.state.days.set("2026-11-16", [...club.state.days.get("2026-11-16")!, { key: "takings.after_restore", cents: -700 }, { key: "card.in", cents: 700 }]);
  await tickAt(r, club, at("2026-11-18", 6, 5));
  assert.notEqual(club.state.vault.get("XERO_REFRESH_TOKEN"), before);
  assert.equal(club.state.vault.get("XERO_REFRESH_TOKEN"), xero.oauth.latest(), "the door holds the newest refresh token");
  assert.equal(xero.state.posts, 4);
  const adj = xero.state.journals.at(-1)!;
  assert.equal(adj.Narration, "openPadel adjustment to 2026-11-16 #1 (Kestrel Padel)");
  assert.equal(adj.Date, "2026-11-18");
  assert.deepEqual(adj.JournalLines.map((l) => [l.AccountCode, l.LineAmount, l.Description]).sort(), [["610", 7, "Card payments [card.in]"], ["999", -7, "Card payments found after a restore [takings.after_restore]"]].sort());
  assert.equal(club.state.shown.get("money").rows.find((x: any) => x.label.en === "Without an account")?.text.en, "1 line went to the account for anything else");
  // The 17th was sent too (cash had no account of its own: anything else).
  assert.ok(xero.state.journals.some((j) => j.Narration.startsWith("openPadel 2026-11-17") && balanced(j.JournalLines)));
  await tickAt(r, club, at("2026-11-18", 7, 0));
  club.state.today = "2026-11-19";
  await tickAt(r, club, at("2026-11-19", 6, 1));
  assert.equal(xero.state.journals.filter((j) => j.Narration.startsWith("openPadel adjustment")).length, 1, "the adjustment isn't sent again");
  assert.equal(xero.oauth.s.refusedReuse, 0, "an old refresh token was never used again");

  // A restart with nothing remembered (a memory store): the provider is asked, and nothing is sent twice.
  await stop(r);
  const postsBefore = xero.state.posts;
  r = await start(club, endpoints);
  await tickAt(r, club, at("2026-11-19", 6, 30));
  assert.equal(xero.state.posts, postsBefore + 0, "every day found at Xero by its narration");
  assert.equal((await health(r)).json.last_sent_day, "2026-11-18");
  // The keys it kept were only those its manifest says it keeps.
  const keptByManifest = MANIFEST.secrets.filter((s: any) => s.kept_by_plugin).map((s: any) => s.name);
  assert.deepEqual(keptByManifest.sort(), [...KEPT].sort());
  assert.ok(club.state.kept.every((k) => keptByManifest.includes(k.name)));
  await stop(r);
  const all = logs.join("\n");
  for (const t of [...xero.oauth.s.refresh.map((x) => x.token), ...xero.oauth.s.access, xero.oauth.s.clientSecret, club.state.token]) assert.ok(!all.includes(t), "no token or key in its log");
});

test("Xero down, rate limited, and a crash mid-send: days wait and go in order, health says so, nothing doubles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-state-"));
  const store = fileStore(join(dir, "state"));
  club.state.today = "2026-11-21";
  club.state.days.set("2026-11-19", [{ key: "takings.courts", cents: -1000 }, { key: "card.in", cents: 1000 }]);
  club.state.days.set("2026-11-20", [{ key: "takings.courts", cents: -2000 }, { key: "card.in", cents: 2000 }]);
  clock = at("2026-11-21", 5, 0);
  const endpoints = { xeroIdentity: xero.url, xeroApi: xero.url };
  let r = await start(club, endpoints, store);
  const posts = xero.state.posts;
  xero.state.mode = "down";
  await tickAt(r, club, at("2026-11-21", 6, 1));
  let h = await health(r);
  assert.equal(h.status, 503);
  assert.equal(h.json.failing, "down");
  assert.equal(club.state.shown.get("connectors").tone, "warn");
  assert.match(club.state.shown.get("money").rows.at(-1).text.es, /no responde/);
  // Back up, but within the wait: not tried yet. Then past it: both days, in order.
  xero.state.mode = "ok";
  await tickAt(r, club, at("2026-11-21", 6, 1) + 2_000);
  assert.equal(xero.state.posts, posts);
  // A crash mid-send: Xero took the 19th, but the answer never came back.
  xero.state.dropNextPost = true;
  await tickAt(r, club, at("2026-11-21", 6, 3));
  assert.equal(xero.state.posts, posts + 1);
  const kept = JSON.parse(readFileSync(join(dir, "state", readdirSync(join(dir, "state")).find((f) => f.endsWith(".json"))!), "utf8"));
  assert.equal(kept.sending?.day, "2026-11-19", "it wrote down what it was sending before it sent it");
  assert.equal((statSync(join(dir, "state")).mode & 0o777), 0o700);
  // Restarted from its file: Xero is asked first, so the 19th isn't sent again; the 20th is. A 429 is waited out.
  await stop(r);
  xero.state.rateOnce = true;
  clock = at("2026-11-21", 6, 20);
  r = await start(club, endpoints, fileStore(join(dir, "state")));
  assert.ok(sleeps.includes(2000), "Retry-After honoured");
  assert.equal(xero.state.posts, posts + 2);
  assert.deepEqual(xero.state.journals.slice(-2).map((j) => j.Narration), ["openPadel 2026-11-19 (Kestrel Padel)", "openPadel 2026-11-20 (Kestrel Padel)"]);
  h = await health(r);
  assert.equal(h.status, 200);
  assert.equal(h.json.last_sent_day, "2026-11-20");
  assert.equal(h.json.failing, null);
  await stop(r);
});

test("a refresh token the vault can't take yet is held and kept on the next tick; one Xero refuses means connect again", async () => {
  club.state.today = "2026-11-22";
  clock = at("2026-11-22", 5, 0);
  const r = await start(club, { xeroIdentity: xero.url, xeroApi: xero.url });
  club.state.keepDown = true;
  await tickAt(r, club, at("2026-11-22", 6, 1));
  const issued = xero.oauth.latest();
  assert.notEqual(club.state.vault.get("XERO_REFRESH_TOKEN"), issued, "the door was down");
  assert.ok(runnerOf(r, club).rec.held.some((h) => h.value === issued), "held until the door takes it");
  club.state.keepDown = false;
  await tickAt(r, club, at("2026-11-22", 6, 2));
  assert.equal(club.state.vault.get("XERO_REFRESH_TOKEN"), issued);
  assert.equal(runnerOf(r, club).rec.held.length, 0);
  // The owner disconnected the app at Xero: the refresh token is refused, and the card asks to connect again.
  for (const t of xero.oauth.s.refresh) t.used = true;
  club.state.today = "2026-11-23";
  await tickAt(r, club, at("2026-11-23", 6, 1));
  const card = club.state.shown.get("connectors");
  assert.equal(card.tone, "warn");
  assert.equal(card.link.label.en, "Connect Xero again");
  assert.equal(card.link.label.es, "Conectar Xero otra vez");
  assert.equal((await health(r)).status, 503);
  await stop(r);
});

test("QuickBooks: connect with its company, one balanced journal entry with debits and credits on the company's accounts, never twice", async () => {
  qclub.state.settings = { provider: "quickbooks", start_date: "2026-11-16", account_courts: "4000", account_card: "Stripe clearing", account_tax: "2200", account_card_fees: "15", account_other: "9999" };
  qclub.state.vault.set("QUICKBOOKS_CLIENT_ID", qbo.oauth.s.clientId);
  qclub.state.vault.set("QUICKBOOKS_CLIENT_SECRET", qbo.oauth.s.clientSecret);
  qclub.state.days.set("2026-11-16", [{ key: "takings.courts", cents: -8000 }, { key: "tax", cents: -660 }, { key: "card.in", cents: 8660 }, { key: "card.fees", cents: 281 }, { key: "card.fees_out", cents: -281 }]);
  clock = at("2026-11-17", 5, 0);
  const endpoints = { qboOauth: qbo.url, qboApi: qbo.url };
  let r = await start(qclub, endpoints);
  const link = new URL(qclub.state.shown.get("connectors").link.url);
  assert.equal(link.origin + link.pathname, "https://appcenter.intuit.com/connect/oauth2");
  assert.equal(link.searchParams.get("scope"), "com.intuit.quickbooks.accounting");
  assert.deepEqual((await connect(r, qclub, qbo.oauth, { realmId: qbo.state.realm })).json, { ok: true });
  assert.equal(qclub.state.vault.get("QUICKBOOKS_COMPANY_ID"), qbo.state.realm);
  assert.equal(qclub.state.vault.get("QUICKBOOKS_REFRESH_TOKEN"), qbo.oauth.latest());
  assert.equal(qclub.state.shown.get("connectors").rows[0].text.es, "Conectado a Kestrel Padel Inc");
  await tickAt(r, qclub, at("2026-11-17", 6, 0));
  assert.equal(qbo.state.entries.length, 1);
  const e = qbo.state.entries[0]!;
  assert.equal(e.DocNumber, "OP-20261116");
  assert.equal(e.TxnDate, "2026-11-16");
  const by = (side: string) => e.Line.filter((l) => l.JournalEntryLineDetail.PostingType === side).map((l) => [l.JournalEntryLineDetail.AccountRef.value, l.Amount]).sort();
  assert.deepEqual(by("Debit"), [["12", 86.6], ["15", 2.81]]);
  assert.deepEqual(by("Credit"), [["11", 80], ["12", 2.81], ["13", 6.6]]);
  // Restarted with nothing remembered: found by its document number, not sent again.
  await stop(r);
  r = await start(qclub, endpoints);
  await tickAt(r, qclub, at("2026-11-17", 6, 30));
  assert.equal(qbo.state.posts, 1);
  await stop(r);
});

test("the cards say everything in both languages, one line each, without dashes, and name the keys to add", async () => {
  const c3 = await fakeClub("Osprey Padel");
  c3.state.settings = { provider: "xero", start_date: "2026-11-01", account_courts: "200", account_card: "610", account_other: "999" };
  clock = at("2026-11-17", 5, 0);
  const r = await start(c3, { xeroIdentity: xero.url, xeroApi: xero.url });
  const card = c3.state.shown.get("connectors");
  assert.equal(card.tone, "warn");
  assert.ok(!card.link, "no link until the app's keys are in the vault");
  assert.ok(card.rows.some((x: any) => x.text.en === "Add XERO_CLIENT_ID and XERO_CLIENT_SECRET in the vault" && x.text.es === "Agrega XERO_CLIENT_ID y XERO_CLIENT_SECRET en la bóveda"));
  assert.equal((await health(r)).status, 200, "waiting for keys isn't failing");
  for (const c of [card, c3.state.shown.get("money"), ...club.state.shown.values()]) for (const row of c.rows) for (const l of ["en", "es"] as const) {
    assert.ok(row.label[l].length <= 40 && row.text[l].length <= 200 && row.text[l].length > 0);
    assert.ok(!/[\u2013\u2014\n]/.test(row.label[l] + row.text[l]), `${row.label[l]}: ${row.text[l]}`);
  }
  await stop(r);
  c3.close();
});
