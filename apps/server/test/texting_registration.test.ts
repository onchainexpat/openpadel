// `kumi texting`: registering the club's texting with US carriers through its own Twilio account, toll-free.
// Twilio's test credentials can't reach Messaging Services or toll-free verification (20008), so these run against
// a stand-in built from Twilio's documented requests and answers (the Messaging API's Services, PhoneNumbers and
// Tollfree/Verifications; the 2010 API's AvailablePhoneNumbers and IncomingPhoneNumbers). It checks what Twilio's
// reference marks required, and the enums, the way Twilio refuses them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { heartbeat, messageHandlers, processOutbox, registeredSender, runAsSystem, textingRegistration, type Db } from "@kumi/core";
import { applyTexting, checkTextingNumber, explainRejection, refreshTexting, textingNeeds, textingPlan, twilioProblem, verificationForm, volumeStep, type TextingDeps } from "../src/texting.ts";
import { TwilioApi, TwilioApiError } from "../src/twilio_admin.ts";
import { doctor } from "../src/doctor.ts";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { watchHealth } from "../src/health.ts";
import { TextingDetails } from "../src/setup.ts";

const AC = `AC${"1".repeat(32)}`, TOKEN = "0123456789abcdef0123456789abcdef";
const STAFF = "https://staff.kestrel.example", MEMBERS = "https://kestrel.example";
const sidOf = (prefix: string) => `${prefix}${randomBytes(16).toString("hex")}`;
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REQUIRED = ["BusinessName", "BusinessWebsite", "NotificationEmail", "UseCaseCategories", "UseCaseSummary", "ProductionMessageSample", "OptInImageUrls", "OptInType", "MessageVolume", "TollfreePhoneNumberSid"];
const USE_CASES = new Set(["TWO_FACTOR_AUTHENTICATION", "ACCOUNT_NOTIFICATIONS", "CUSTOMER_CARE", "CHARITY_NONPROFIT", "DELIVERY_NOTIFICATIONS", "FRAUD_ALERT_MESSAGING", "EVENTS", "HIGHER_EDUCATION", "K12", "MARKETING", "POLLING_AND_VOTING_NON_POLITICAL", "POLITICAL_ELECTION_CAMPAIGNS", "PUBLIC_SERVICE_ANNOUNCEMENT", "SECURITY_ALERT"]);
const VOLUMES = new Set(["10", "100", "1,000", "10,000", "100,000", "250,000", "500,000", "750,000", "1,000,000", "5,000,000", "10,000,000+"]);

/** Twilio, as its API reference describes it, for one account. */
class FakeTwilio {
  calls: { method: string; path: string; form: URLSearchParams }[] = [];
  available = ["+18885550100", "+18885550101"];
  numbers: { sid: string; phone_number: string; capabilities: { sms: boolean } }[] = [];
  services = new Map<string, { sid: string; friendly_name: string; inbound_request_url: string | null; status_callback: string | null; numbers: string[] }>();
  verifications = new Map<string, Record<string, unknown>>();
  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url), method = init.method ?? "GET", form = new URLSearchParams(init.body ? String(init.body) : "");
    this.calls.push({ method, path: u.pathname, form });
    if ((init.headers as Record<string, string>).authorization !== `Basic ${Buffer.from(`${AC}:${TOKEN}`).toString("base64")}`) return json(401, { code: 20003, message: "Authenticate", status: 401 });
    const p = u.pathname;
    if (u.host === "api.twilio.com") {
      if (method === "GET" && p.endsWith("/AvailablePhoneNumbers/US/TollFree.json"))
        return json(200, { available_phone_numbers: this.available.map((n) => ({ phone_number: n, friendly_name: n, capabilities: { SMS: true, MMS: false, voice: true } })) });
      if (method === "GET" && p.endsWith("/IncomingPhoneNumbers.json"))
        return json(200, { incoming_phone_numbers: this.numbers.filter((n) => n.phone_number === u.searchParams.get("PhoneNumber")) });
      if (method === "POST" && p.endsWith("/IncomingPhoneNumbers.json")) {
        const want = form.get("PhoneNumber")!;
        if (!this.available.includes(want)) return json(400, { code: 21422, message: `${want} is not available`, status: 400 });
        this.available = this.available.filter((n) => n !== want);
        const n = { sid: sidOf("PN"), phone_number: want, capabilities: { sms: true }, friendly_name: form.get("FriendlyName") };
        this.numbers.push(n);
        return json(201, n);
      }
    }
    if (u.host === "messaging.twilio.com") {
      if (method === "POST" && p === "/v1/Services") {
        const s = { sid: sidOf("MG"), friendly_name: form.get("FriendlyName")!, inbound_request_url: form.get("InboundRequestUrl"), status_callback: form.get("StatusCallback"), numbers: [] as string[] };
        this.services.set(s.sid, s);
        return json(201, s);
      }
      let m = p.match(/^\/v1\/Services\/(MG\w+)(\/PhoneNumbers)?$/);
      if (m) {
        const s = this.services.get(m[1]!);
        if (!s) return json(404, { code: 20404, message: "not found", status: 404 });
        if (!m[2] && method === "GET") return json(200, s);
        if (!m[2] && method === "POST") { s.inbound_request_url = form.get("InboundRequestUrl") ?? s.inbound_request_url; s.status_callback = form.get("StatusCallback") ?? s.status_callback; return json(200, s); }
        if (m[2] && method === "GET") return json(200, { phone_numbers: s.numbers.map((sid) => ({ sid })) });
        if (m[2] && method === "POST") {
          const pn = form.get("PhoneNumberSid")!;
          if ([...this.services.values()].some((o) => o !== s && o.numbers.includes(pn))) return json(409, { code: 21710, message: "Phone Number is already in a Messaging Service", status: 409 });
          s.numbers.push(pn);
          return json(201, { sid: pn });
        }
      }
      if (p === "/v1/Tollfree/Verifications" && method === "GET")
        return json(200, { verifications: [...this.verifications.values()].filter((v) => v.tollfree_phone_number_sid === u.searchParams.get("TollfreePhoneNumberSid")) });
      if (p === "/v1/Tollfree/Verifications" && method === "POST") {
        const missing = REQUIRED.filter((k) => !form.get(k));
        const type = form.get("BusinessType");
        if (type !== "SOLE_PROPRIETOR") for (const k of ["BusinessType", "BusinessRegistrationNumber", "BusinessRegistrationAuthority", "BusinessRegistrationCountry"]) if (!form.get(k)) missing.push(k);
        if (missing.length) return json(400, { code: 20001, message: `Missing required parameter ${missing[0]}`, status: 400 });
        if (form.getAll("UseCaseCategories").some((c) => !USE_CASES.has(c)) || !VOLUMES.has(form.get("MessageVolume")!) || form.get("OptInType") !== "WEB_FORM")
          return json(400, { code: 20001, message: "Invalid enum", status: 400 });
        const v = { sid: sidOf("HH"), status: "PENDING_REVIEW", tollfree_phone_number_sid: form.get("TollfreePhoneNumberSid"), external_reference_id: form.get("ExternalReferenceId"),
          business_name: form.get("BusinessName"), rejection_reason: null, rejection_reasons: null, error_code: null, edit_allowed: null, edit_expiration: null, date_created: new Date().toISOString() };
        this.verifications.set(v.sid, v);
        return json(201, v);
      }
      m = p.match(/^\/v1\/Tollfree\/Verifications\/(HH\w+)$/);
      if (m) {
        const v = this.verifications.get(m[1]!);
        if (!v) return json(404, { code: 20404, message: "not found", status: 404 });
        if (method === "GET") return json(200, v);
        if (method === "DELETE") { this.verifications.delete(m[1]!); return json(204, null); }
        if (!form.get("EditReason")) return json(400, { code: 20001, message: "Missing required parameter EditReason", status: 400 });
        if (!v.edit_allowed) return json(400, { code: 30475, message: "This verification can't be edited", status: 400 });
        Object.assign(v, { status: "PENDING_REVIEW", rejection_reason: null, rejection_reasons: null, error_code: null, edit_allowed: null, edit_expiration: null });
        return json(200, v);
      }
    }
    return json(404, { code: 20404, message: `no ${method} ${u.host}${p}`, status: 404 });
  };
  /** Twilio's review deciding. */
  decide(status: "IN_REVIEW" | "TWILIO_APPROVED" | "TWILIO_REJECTED", o: { reasons?: { reason: string; code: number }[]; editable?: boolean } = {}) {
    for (const v of this.verifications.values()) Object.assign(v, { status, rejection_reasons: o.reasons ?? null, rejection_reason: o.reasons?.[0]?.reason ?? null, error_code: o.reasons?.[0]?.code ?? null,
      edit_allowed: status === "TWILIO_REJECTED" ? Boolean(o.editable) : null, edit_expiration: o.editable ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null });
  }
  posted(path: RegExp) { return this.calls.filter((c) => c.method === "POST" && path.test(c.path)); }
}

const DETAILS: TextingDetails = {
  business_name: "Kestrel Padel LLC", doing_business_as: "Kestrel Padel", business_type: "private_profit", registration_number: "12-3456789",
  website: "https://kestrelpadel.example", privacy_policy_url: "https://kestrelpadel.example/privacy",
  address: { street: "100 Example St", city: "Springfield", state: "OR", postal_code: "97477" },
  contact: { first_name: "Robin", last_name: "Hale", email: "robin@example.test", phone: "+15035550123" }, monthly_texts: 800,
};
let db: Db, drop: () => Promise<void>, owner: string;
const deps = (tw: FakeTwilio, details: TextingDetails | undefined = DETAILS): TextingDeps =>
  ({ db, api: new TwilioApi(AC, TOKEN, tw.fetch), club: "Kestrel Padel", details, publicUrl: STAFF, memberUrl: MEMBERS });
const fresh = async () => { await db.deleteFrom("texting_registration").execute(); };

before(async () => {
  ({ db, drop } = await freshDb());
  owner = ((await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup")).result as any).owner_person_id;
});
after(async () => drop());

test("what club.yaml still needs, said field by field; a sole proprietor has no EIN to give", () => {
  const urls = { publicUrl: STAFF, memberUrl: MEMBERS };
  assert.match(textingNeeds(undefined, urls)[0]!.en, /no texting section/);
  const some = textingNeeds({ business_name: "Kestrel Padel LLC", business_type: "private_profit" }, urls).map((x) => x.en);
  assert.deepEqual(some.map((x) => x.split(":")[0]), ["texting.website", "texting.address", "texting.contact", "texting.monthly_texts", "texting.registration_number"]);
  assert.deepEqual(textingNeeds({ ...DETAILS, business_type: "sole_proprietor", registration_number: undefined }, urls), []);
  assert.match(textingNeeds(DETAILS, { publicUrl: "http://127.0.0.1:8790", memberUrl: "http://127.0.0.1:8790" })[0]!.en, /https/);
  assert.equal(volumeStep(800), "1,000"); assert.equal(volumeStep(10), "10"); assert.equal(volumeStep(20_000_000), "10,000,000+");
});

test("a plan changes nothing; apply stops before buying a number without --yes", async () => {
  await fresh();
  const tw = new FakeTwilio();
  const p = await textingPlan(deps(tw));
  assert.deepEqual(p.steps.map((s) => s.id), ["buy_number", "service", "add_number", "submit", "wait"]);
  assert.equal(p.steps[0]!.costs, true);
  assert.equal(tw.calls.filter((c) => c.method !== "GET").length, 0);
  const r = await applyTexting(deps(tw), { yes: false });
  assert.equal(r.stopped, "needs_yes");
  assert.equal(tw.numbers.length, 0);
  assert.equal(await textingRegistration(db), null);
});

test("apply --yes: a toll-free number, a Messaging Service pointed at this server, and the verification in Kumi's words; again, nothing twice", async () => {
  await fresh();
  const tw = new FakeTwilio();
  const r = await applyTexting(deps(tw), { yes: true });
  assert.equal(r.stopped, null);
  assert.equal(r.done.length, 4);
  const reg = (await textingRegistration(db))!;
  assert.equal(reg.phone_number, "+18885550100"); assert.equal(reg.bought, true); assert.equal(reg.status, "submitted"); assert.match(reg.verification_sid!, /^HH/);
  const svc = tw.services.get(reg.messaging_service_sid!)!;
  assert.equal(svc.inbound_request_url, `${STAFF}/webhooks/twilio/sms`); assert.equal(svc.status_callback, `${STAFF}/webhooks/twilio/status`);
  assert.deepEqual(svc.numbers, [reg.phone_number_sid]);
  const f = tw.posted(/^\/v1\/Tollfree\/Verifications$/)[0]!.form;
  assert.equal(f.get("BusinessName"), "Kestrel Padel LLC"); assert.equal(f.get("DoingBusinessAs"), "Kestrel Padel");
  assert.deepEqual(f.getAll("UseCaseCategories"), ["ACCOUNT_NOTIFICATIONS", "TWO_FACTOR_AUTHENTICATION"]);
  assert.equal(f.get("BusinessType"), "PRIVATE_PROFIT"); assert.equal(f.get("BusinessRegistrationAuthority"), "EIN"); assert.equal(f.get("BusinessRegistrationCountry"), "US");
  assert.equal(f.get("MessageVolume"), "1,000"); assert.equal(f.get("OptInType"), "WEB_FORM"); assert.equal(f.get("NotificationEmail"), "robin@example.test");
  assert.deepEqual(f.getAll("OptInImageUrls"), [`${MEMBERS}/public/texts`]);
  assert.equal(f.get("ProductionMessageSample"), `Kestrel Padel: A place opened up in Beginner Clinic, Tue, Nov 10, 6:00 PM. It's yours if you take it in the app by Mon, Nov 9, 8:00 PM: ${MEMBERS} Reply STOP to stop.`);
  assert.match(f.get("HelpMessageSample")!, /^Kestrel Padel: .* Reply STOP to stop\.$/);
  assert.match(f.get("AdditionalInformation")!, /ticks an unticked box that reads: "Yes, Kestrel Padel may text me/);
  assert.equal(f.get("ExternalReferenceId"), reg.id); assert.equal(f.get("AgeGatedContent"), "false");
  assert.equal(f.get("CustomerProfileSid"), null);   // Twilio makes one from the business details given
  assert.ok(!/[—]/.test([...f.values()].join(" ")));
  const before = tw.calls.filter((c) => c.method === "POST").length;
  const again = await applyTexting(deps(tw), { yes: true });
  assert.equal(again.done.length, 0);
  assert.equal(tw.calls.filter((c) => c.method === "POST").length, before);
  assert.equal(await registeredSender(db), null);   // not approved yet: nothing texts from it
});

test("through a host's Twilio account: the club's own Secondary Customer Profile goes with the verification", () => {
  const bu = `BU${"a".repeat(32)}`;
  const f = verificationForm({ ...DETAILS, customer_profile_sid: bu }, { club: "Kestrel Padel", memberUrl: MEMBERS, numberSid: sidOf("PN"), reference: "r" });
  assert.equal(f.CustomerProfileSid, bu);
  assert.equal(f.BusinessName, "Kestrel Padel LLC");   // the club's business, never the host's: Twilio turns those down
  assert.equal(verificationForm(DETAILS, { club: "Kestrel Padel", memberUrl: MEMBERS, numberSid: "PN", reference: "r" }).CustomerProfileSid, undefined);
  assert.equal(TextingDetails.safeParse({ customer_profile_sid: "BU123" }).success, false);
});

test("the club's own number: used, not bought; one that can't text is refused; a verification made in the console is carried on", async () => {
  await fresh();
  const tw = new FakeTwilio();
  tw.numbers.push({ sid: sidOf("PN"), phone_number: "+18885550199", capabilities: { sms: false } });
  await assert.rejects(applyTexting(deps(tw, { ...DETAILS, number: "+18885550199" }), { yes: false }), (e) => /can't send texts/.test(twilioProblem(e).en));
  await assert.rejects(applyTexting(deps(tw, { ...DETAILS, number: "+18885550177" }), { yes: false }), (e) => /isn't in the club's Twilio account/.test(twilioProblem(e).en));
  const own = { sid: sidOf("PN"), phone_number: "+18885550188", capabilities: { sms: true } };
  tw.numbers.push(own);
  const made = { sid: sidOf("HH"), status: "IN_REVIEW", tollfree_phone_number_sid: own.sid, rejection_reasons: null, rejection_reason: null, error_code: null, edit_allowed: null, edit_expiration: null };
  tw.verifications.set(made.sid, made);
  const r = await applyTexting(deps(tw, { ...DETAILS, number: "+18885550188" }), { yes: false });
  assert.equal(r.stopped, null);
  const reg = (await textingRegistration(db))!;
  assert.equal(reg.bought, false); assert.equal(reg.verification_sid, made.sid); assert.equal(reg.status, "in_review");
  assert.equal(tw.posted(/IncomingPhoneNumbers/).length, 0); assert.equal(tw.posted(/^\/v1\/Tollfree\/Verifications$/).length, 0);
});

test("the review: asked about, recorded only when it moves; a rejection is explained once, corrected and sent again; approval starts texts", async () => {
  await fresh();
  await db.deleteFrom("outbound_message").execute();
  const tw = new FakeTwilio(), api = new TwilioApi(AC, TOKEN, tw.fetch);
  await applyTexting(deps(tw), { yes: true });
  const runs = async () => Number((await db.selectFrom("action_run").select((e) => e.fn.countAll<string>().as("n")).where("action", "=", "texting.registration_record").executeTakeFirstOrThrow()).n);
  const n0 = await runs();
  assert.equal(await refreshTexting(db, api), "submitted");
  assert.equal(await runs(), n0);   // nothing moved: nothing written
  tw.decide("TWILIO_REJECTED", { reasons: [{ reason: "Could not validate business information", code: 30445 }], editable: true });
  assert.equal(await refreshTexting(db, api), "rejected");
  await refreshTexting(db, api);
  await processOutbox(db, messageHandlers);
  const told = await db.selectFrom("outbound_message").select(["subject", "body", "channel"]).where("person_id", "=", owner).where("kind", "=", "texting_rejected_staff").execute();
  assert.deepEqual(told.map((m) => m.channel).sort(), ["email", "inbox"]);
  assert.match(told[0]!.body, /\+18885550100: Could not validate business information \(30445\)/);
  const why = explainRejection((await textingRegistration(db))!.rejection);
  assert.match(why[0]!.en, /match the IRS records exactly/);
  assert.match(explainRejection([{ reason: "Something new", code: 39999 }])[0]!.en, /^Something new \(39999\)\. Twilio's console/);
  const p = await textingPlan(deps(tw));
  assert.deepEqual(p.steps.map((s) => s.id), ["resubmit", "wait"]);
  await applyTexting(deps(tw), { yes: false, reason: "EIN corrected" });
  const edit = tw.posted(/^\/v1\/Tollfree\/Verifications\/HH/)[0]!.form;
  assert.equal(edit.get("EditReason"), "EIN corrected"); assert.equal(edit.get("TollfreePhoneNumberSid"), null);
  assert.equal((await textingRegistration(db))!.status, "submitted");
  tw.decide("TWILIO_APPROVED");
  assert.equal(await refreshTexting(db, api), "approved");
  await processOutbox(db, messageHandlers);
  assert.equal((await db.selectFrom("outbound_message").select("id").where("person_id", "=", owner).where("kind", "=", "texting_approved_staff").where("channel", "=", "email").execute()).length, 1);
  const reg = (await textingRegistration(db))!;
  assert.equal(await registeredSender(db), reg.messaging_service_sid);
  const calls = tw.calls.length;
  assert.equal(await refreshTexting(db, api), "approved");   // decided: Twilio isn't asked again
  assert.equal(tw.calls.length, calls);
});

const sms = (status: "sent" | "failed", failure: string | null = null) => db.insertInto("outbound_message").values({ id: crypto.randomUUID(), event_id: null, person_id: owner, kind: "place_offered",
  channel: "sms", purpose: "account", essential: false, lang: "en", subject: "", body: "Kestrel Padel: test", link: null, status, send_after: new Date(), stale_at: null, sent_at: null, read_at: null, failure }).execute();

test("after approval the number is still checked: withdrawn, gone from the account, or refused for the number itself", async () => {
  await fresh();
  await db.deleteFrom("outbound_message").execute();
  const tw = new FakeTwilio(), api = new TwilioApi(AC, TOKEN, tw.fetch);
  assert.equal(await checkTextingNumber(db, api), null);   // nothing approved: nothing to check
  await applyTexting(deps(tw), { yes: true });
  tw.decide("TWILIO_APPROVED");
  assert.equal(await refreshTexting(db, api), "approved");
  assert.deepEqual(await checkTextingNumber(db, api), { ok: true });
  await sms("failed", "30032: Toll-Free Number Has Not Been Verified");
  await sms("failed", "21610: Attempt to send to unsubscribed recipient");   // the member's STOP: not the number's fault
  const refused = await checkTextingNumber(db, api);
  assert.equal(refused?.ok, false); assert.equal((refused as any).words.en, "Twilio refused texts because of the number itself (1 in the last day)");
  await db.deleteFrom("outbound_message").execute();
  const kept = tw.numbers.splice(0);
  assert.match((await checkTextingNumber(db, api) as any).words.en, /^the number \+18885550100 isn't in the club's Twilio account any more$/);
  tw.numbers.push(...kept);
  tw.decide("TWILIO_REJECTED", { reasons: [{ reason: "Opt-in not shown", code: 30446 }], editable: false });
  assert.equal((await checkTextingNumber(db, api) as any).words.en, "Twilio no longer shows its registration as approved (now TWILIO_REJECTED)");
  assert.equal((await textingRegistration(db))!.status, "rejected");
  assert.equal(await registeredSender(db), null);   // texts stop going from it
});

test("texts failing: staff hear once, and once more when they get through again (ask the club's model is watched the same way)", async () => {
  await db.deleteFrom("outbound_message").execute(); await db.deleteFrom("ops_heartbeat").execute();
  const NOW = new Date();
  for (let i = 0; i < 4; i++) await sms("sent");
  await sms("failed", "30003: Unreachable");
  await watchHealth(db, { texting: true, models: [], now: NOW });   // 1 of 5: fine
  assert.equal((await heartbeat(db, "texts"))!.last_error, null);
  await sms("failed", "30003: Unreachable");
  await watchHealth(db, { texting: true, models: [], now: NOW });   // 2 of 6: failing
  await watchHealth(db, { texting: true, models: [], now: NOW });   // still failing: not said again
  await processOutbox(db, messageHandlers);
  const failed = await db.selectFrom("outbound_message").select(["subject", "body"]).where("person_id", "=", owner).where("kind", "=", "ops_failed_staff").where("channel", "=", "email").execute();
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.subject, "Needs a look: texts to members failed");
  assert.match(failed[0]!.body, /texts to members failed: 2 of 6 texts in the last day didn't go through\./);
  for (let i = 0; i < 6; i++) await sms("sent");
  await watchHealth(db, { texting: true, models: [], now: NOW });   // 2 of 12: working again
  await watchHealth(db, { texting: true, models: [], now: NOW });
  await processOutbox(db, messageHandlers);
  const again = await db.selectFrom("outbound_message").select(["subject"]).where("person_id", "=", owner).where("kind", "=", "ops_cleared_staff").where("channel", "=", "email").execute();
  assert.deepEqual(again.map((m) => m.subject), ["Working again: texts to members"]);
  const alert = await db.selectFrom("staff_alert").select(["handled_by"]).where("kind", "=", "ops_failed_staff").execute();
  assert.deepEqual(alert, [{ handled_by: null }]);   // closed by itself, with no one's name
});

test("a rejection Twilio won't let be edited: a new verification, only with --yes", async () => {
  await fresh();
  const tw = new FakeTwilio(), api = new TwilioApi(AC, TOKEN, tw.fetch);
  await applyTexting(deps(tw), { yes: true });
  const first = (await textingRegistration(db))!.verification_sid;
  tw.decide("TWILIO_REJECTED", { reasons: [{ reason: "Phone number not provisioned to Twilio", code: 30447 }], editable: false });
  await refreshTexting(db, api);
  assert.deepEqual((await textingPlan(deps(tw))).steps.map((s) => s.id), ["restart", "wait"]);
  assert.equal((await applyTexting(deps(tw), { yes: false })).stopped, "needs_yes");
  await applyTexting(deps(tw), { yes: true });
  const reg = (await textingRegistration(db))!;
  assert.notEqual(reg.verification_sid, first); assert.equal(reg.status, "submitted");
  assert.equal(tw.verifications.size, 1);
});

test("Twilio's refusals, said for a person", async () => {
  const tw = new FakeTwilio();
  assert.match(twilioProblem(new TwilioApiError(403, 20008, "Resource not accessible with Test Account Credentials")).en, /test credentials can't register/);
  await assert.rejects(new TwilioApi(AC, "f".repeat(32), tw.fetch).searchTollFree(), (e) => /refused the account and token/.test(twilioProblem(e).en));
});

test("the page showing how members say yes: the exact words, an unticked box, in English and Spanish", async () => {
  const app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false, publicUrl: STAFF, memberUrl: MEMBERS });
  const en = await (await app.request("/public/texts")).text();
  assert.match(en, /Yes, Kestrel Padel may text me about my bookings and places\. Message and data rates may apply\. Reply STOP to stop, HELP for help\./);
  assert.match(en, /<input type="checkbox" disabled>/);
  assert.match(en, /Never club news or marketing/);
  const es = await (await app.request("/public/texts?lang=es")).text();
  assert.match(es, /Mensajes de texto de Kestrel Padel/);
});

test("doctor: keys with nothing to text from point to kumi texting; a registration under review says so", async () => {
  await fresh();
  const env = { KUMI_BACKUP_DIR: "/nonexistent", KUMI_TWILIO_ACCOUNT_SID: AC, KUMI_TWILIO_AUTH_TOKEN: TOKEN };
  const texts = async (fetch?: any) => (await doctor(db, env, { fetch })).find((c) => c.id === "texts")!;
  let c = await texts();
  assert.equal(c.state, "warn"); assert.match(c.text.en, /openpadel texting plan/);
  const tw = new FakeTwilio();
  await applyTexting(deps(tw), { yes: true });
  c = await texts();
  assert.equal(c.state, "warn"); assert.match(c.text.en, /waiting for Twilio's review/);
  tw.decide("TWILIO_APPROVED");
  await refreshTexting(db, new TwilioApi(AC, TOKEN, tw.fetch));
  c = await texts(async () => json(200, { sid: AC, status: "active" }));
  assert.notEqual(c.state, "fail"); assert.doesNotMatch(c.text.en, /openpadel texting/);
});
