import { test } from "node:test";
import assert from "node:assert/strict";
import { namesThatDiffer, oldNamesInUse, setting, settingFrom, settingName, shortName } from "../src/settings.ts";

test("a setting: OPENPADEL_ first, else the old KUMI_ name, under any of its names", () => {
  assert.equal(setting("RESEND_API_KEY", { KUMI_RESEND_API_KEY: "re_old" }), "re_old");
  assert.equal(setting("RESEND_API_KEY", { OPENPADEL_RESEND_API_KEY: "re_new" }), "re_new");
  assert.equal(setting("OPENPADEL_RESEND_API_KEY", { OPENPADEL_RESEND_API_KEY: "re_new", KUMI_RESEND_API_KEY: "re_old" }), "re_new", "both set: the new one wins");
  assert.equal(setting("KUMI_RESEND_API_KEY", { OPENPADEL_RESEND_API_KEY: "re_new" }), "re_new", "asked by its old name: the same reader");
  assert.equal(setting("RESEND_API_KEY", { OPENPADEL_RESEND_API_KEY: "  ", KUMI_RESEND_API_KEY: "re_old" }), "re_old", "a blank new line doesn't hide the old value");
  assert.equal(setting("RESEND_API_KEY", { OPENPADEL_RESEND_API_KEY: "" }), "");
  assert.equal(setting("RESEND_API_KEY", {}), undefined);
  assert.equal(shortName("KUMI_MAIL_FROM"), "MAIL_FROM");
  assert.equal(settingName("KUMI_MAIL_FROM"), "OPENPADEL_MAIL_FROM");
});

test("where a setting comes from, the old names in use, and the ones set twice with different values", () => {
  const env = { KUMI_PRACTICE: "1", OPENPADEL_MAIL_FROM: "a@x.test", KUMI_MAIL_FROM: "b@x.test", OPENPADEL_LANG: "es", KUMI_LANG: "es", PATH: "/bin" };
  assert.deepEqual(settingFrom("PRACTICE", env), { value: "1", from: "KUMI_PRACTICE", differs: false });
  assert.deepEqual(settingFrom("MAIL_FROM", env), { value: "a@x.test", from: "OPENPADEL_MAIL_FROM", differs: true });
  assert.deepEqual(settingFrom("LANG", env), { value: "es", from: "OPENPADEL_LANG", differs: false });
  assert.deepEqual(settingFrom("NOPE", env), { value: undefined, from: null, differs: false });
  assert.deepEqual(oldNamesInUse(env), ["KUMI_LANG", "KUMI_MAIL_FROM", "KUMI_PRACTICE"]);
  assert.deepEqual(namesThatDiffer(env), ["MAIL_FROM"]);
});
