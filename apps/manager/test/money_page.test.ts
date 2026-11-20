// The Money page (/payments, Payments.tsx): behind the money check in the menu and the route, its "Record payment" the
// existing record-payment actions with their preview, and its menu word: Payments for Playtomic clubs (their word),
// Money in openPadel's own words, in English and Spanish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en } from "../../../packages/i18n/src/en.ts";
import { es } from "../../../packages/i18n/src/es.ts";
import { payAction } from "../src/money_pay.ts";
import { PRESETS, labelKey } from "../src/presets.ts";

const src = (f: string) => readFileSync(join(import.meta.dirname, "../src", f), "utf8");

test("a payment taken for something owed is the Schedule's or the roster's own action, offered only where it's allowed", () => {
  const yes = () => true, court = { kind: "booking" as const, id: "b1", location_id: "L1" }, place = { kind: "place" as const, id: "e1", location_id: "L1" };
  assert.deepEqual(payAction(court, 3000, "cash", yes, yes), { action: "booking.record_payment", input: { booking_id: "b1", cents: 3000, method: "cash" } });
  assert.deepEqual(payAction(place, 2000, "terminal", yes, yes), { action: "enrolment.record_payment", input: { enrolment_id: "e1", cents: 2000, method: "terminal" } });
  assert.equal(payAction(court, 3000, "cash", (a) => a !== "booking.record_payment", yes), null, "a role without it");
  assert.equal(payAction(place, 2000, "cash", yes, (l) => l !== "L1"), null, "a role kept to another location");
  // Through the preview (usePreview), never straight to the server.
  const page = src("Payments.tsx");
  assert.match(page, /void preview\(p\.action, p\.input\)/);
  assert.ok(page.includes('api<MoneyView>("/staff/money")'));
});

test("only the club's money people get the page, as before", () => {
  const app = src("App.tsx");
  assert.ok(app.includes('payments: link(show("money"), "payments", "/payments", label("ui.nav_payments"))'));
  assert.ok(app.includes('<Route path="/payments" component={only("money", Payments)} />'));
});

test("the menu says Payments for Playtomic clubs and Money in openPadel's own words", () => {
  const say = (lang: Record<string, unknown>, name: keyof typeof PRESETS) => lang[labelKey(PRESETS[name], "ui.nav_payments")];
  assert.deepEqual([say(en, "playtomic"), say(es, "playtomic")], ["Payments", "Pagos"]);
  assert.deepEqual([say(en, "none"), say(es, "none")], ["Money", "Dinero"]);
});
