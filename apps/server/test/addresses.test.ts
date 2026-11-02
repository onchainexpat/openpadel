import { test } from "node:test";
import assert from "node:assert/strict";
import { memberUrl } from "../src/addresses.ts";

test("the members' address: the setting, else the staff address without its \"staff.\", else the staff address", () => {
  assert.equal(memberUrl("https://staff.app.yourclub.com", { KUMI_MEMBER_URL: "https://play.yourclub.com/" }), "https://play.yourclub.com");
  assert.equal(memberUrl("https://staff.trial.kumi.club", {}), "https://trial.kumi.club");
  assert.equal(memberUrl("https://staff.trial.kumi.club/", {}), "https://trial.kumi.club");
  assert.equal(memberUrl("https://club.example", {}), "https://club.example");
  assert.equal(memberUrl("http://127.0.0.1:8790", {}), "http://127.0.0.1:8790");
  assert.equal(memberUrl("https://staffordpadel.com", {}), "https://staffordpadel.com");   // "staff." only as a label of its own
});
