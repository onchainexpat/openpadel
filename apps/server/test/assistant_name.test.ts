// The assistant's name, a club setting (club.assistant_name): unset, the install's product name (openPadel on a club's
// own server, Kumi on the hosted service); set, every sentence that names the assistant says the club's name instead,
// in both languages. Set like any club setting: previewed, applied, recorded, undone; refused when it isn't a plain name.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { KumiError, plan, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { en, es, setAssistantName, setHosted, t } from "@kumi/i18n";
import { makeApp } from "../src/app.ts";
import { MemoryMailer } from "../src/mailer.ts";
import { doctor } from "../src/doctor.ts";
import { readClubFile, setupClub } from "../src/setup.ts";

let db: Db, drop: () => Promise<void>, app: ReturnType<typeof makeApp>, owner: Actor, desk: Actor;
const club = async () => (await app.request("/club")).json() as Promise<any>;
const assistantLine = async () => (await doctor(db, { KUMI_BACKUP_DIR: "/nonexistent" })).find((c) => c.id === "assistant")!;

before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  app = makeApp({ db, mailer: new MemoryMailer(), secureCookies: false });
  const dana = ((await run(db, "person.create", { display_name: "Dana", email: "dana@example.test" }, owner)).result as any).person_id;
  await run(db, "role.assign", { person_id: dana, role: "front_desk" }, owner);
  desk = { personId: dana, via: "test", lang: "en" };
});
after(async () => { setAssistantName(null); setHosted(false); await drop(); });

test("unset, the assistant has the install's name: openPadel on a club's own server, Kumi on the hosted service", async () => {
  assert.equal((await club()).assistant_name, null);
  setHosted(false);
  assert.equal(t("en", "ui.assistant_title"), "Ask openPadel");
  assert.equal(t("es", "ui.assistant_title"), "Pregúntale a openPadel");
  assert.equal(t("en", "error.assistant_off"), "Ask openPadel isn't on at this club yet.");
  try {
    setHosted(true);
    assert.equal(t("en", "ui.assistant_title"), "Ask Kumi");
    assert.equal(t("es", "ui.assistant_title"), "Pregúntale a Kumi");
    assert.equal(t("es", "error.assistant_busy"), "Kumi todavía está respondiendo tu último mensaje.");
    assert.equal((await assistantLine()).text.en.startsWith("Ask Kumi: off."), true);
  } finally { setHosted(false); }
  assert.match((await assistantLine()).text.en, /^Ask openPadel: off\./);
  assert.match((await assistantLine()).text.es, /^Asistente openPadel: apagado\./);
});

test("set like the club's other settings (not by the front desk): previewed in both languages, applied, undone; then every sentence names it", async () => {
  const p = await plan(db, "club.update", { assistant_name: "  Kumi " }, owner);
  assert.equal(p.plan.summary.en, "Change the assistant's name to Kumi.");
  assert.equal(p.plan.summary.es, "Cambiar el nombre del asistente a Kumi.");
  assert.equal((await club()).assistant_name, null, "a preview changes nothing");
  await assert.rejects(run(db, "club.update", { assistant_name: "Kumi" }, desk), (e: unknown) => e instanceof KumiError && e.status === 403, "the front desk can't");
  await run(db, "club.update", { assistant_name: "  Kumi " }, owner);
  // Both apps read it from /club, trimmed, and the server's own words name it at once.
  assert.equal((await club()).assistant_name, "Kumi");
  assert.equal(t("en", "ui.assistant_title"), "Ask Kumi");
  assert.equal(t("es", "ui.assistant_title"), "Pregúntale a Kumi");
  assert.equal(t("en", "error.assistant_failed"), "Kumi couldn't answer just now. Try again in a minute.");
  assert.equal(t("es", "error.assistant_off"), "El asistente Kumi todavía no está activado en este club.");
  // A preview that names it: deleting a conversation with it.
  const chat = "0190a000-0000-7000-8000-00000000c4a7";
  await db.insertInto("assistant_chat").values({ id: chat, person_id: owner.personId!, surface: "staff", title: "Thursday" }).execute();
  const del = (await plan(db, "assistant.chat_delete", { chat_id: chat }, owner)).plan;
  assert.deepEqual([del.title, del.summary], [
    { en: "Delete a conversation with the Kumi assistant", es: "Borrar una conversación con el asistente Kumi" },
    { en: "Delete your conversation \"Thursday\" with the Kumi assistant. It can't be brought back.", es: "Borrar tu conversación \"Thursday\" con el asistente Kumi. No se puede recuperar." },
  ]);
  assert.match((await assistantLine()).text.en, /^Ask Kumi: off\./);
  assert.match((await assistantLine()).text.es, /^Asistente Kumi: apagado\./);
  // Its name stays the club's on the hosted service too: Kumi there is only the default.
  let rally: string;
  try { setHosted(true); rally = (await run(db, "club.update", { assistant_name: "Rally" }, owner)).runId; assert.equal(t("en", "ui.assistant_title"), "Ask Rally"); }
  finally { setHosted(false); }
  // Taken off, it goes back to the install's name, which the preview reads out.
  const off = await plan(db, "club.update", { assistant_name: null }, owner);
  assert.equal(off.plan.summary.en, "Change the assistant's name to openPadel, the default.");
  assert.equal(off.plan.summary.es, "Cambiar el nombre del asistente a openPadel, el predeterminado.");
  // Undone, the name is Kumi again (as a change from another process is, when the apps next read /club).
  await run(db, "action.undo", { run_id: rally }, owner);
  assert.equal((await club()).assistant_name, "Kumi");
  assert.equal(t("en", "ui.assistant_title"), "Ask Kumi");
  await run(db, "club.update", { assistant_name: null }, owner);
  assert.equal((await club()).assistant_name, null);
  assert.equal(t("en", "ui.assistant_title"), "Ask openPadel");
});

test("only a plain name: 1 to 24 characters, no long dash, without \"Ask\"", async () => {
  for (const bad of ["", "   ", "x".repeat(25), "Kumi—bot", "Ask Kumi", "Pregúntale a Kumi"])
    await assert.rejects(plan(db, "club.update", { assistant_name: bad }, owner), KumiError, JSON.stringify(bad));
  await plan(db, "club.update", { assistant_name: "x".repeat(24) }, owner);
  await plan(db, "club.update", { assistant_name: "Askari" }, owner);
});

test("club.yaml sets it through the plan, then only when it differs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-assistant-name-"));
  const path = join(dir, "club.yaml");
  writeFileSync(path, "club: { name: Kestrel Padel, time_zone: America/Los_Angeles, assistant_name: Kestrel }\nowner: { name: Robin Hale, email: robin@example.test }\n");
  const f = readClubFile(path);
  const p = await setupClub(db, f, { apply: false, lang: "en" });
  assert.deepEqual(p.steps.map((s) => s.text.en), ["Name the club's assistant Kestrel."]);
  assert.equal(p.steps[0]!.text.es, "Llamar Kestrel al asistente del club.");
  await setupClub(db, f, { apply: true, lang: "en" });
  assert.equal((await club()).assistant_name, "Kestrel");
  assert.deepEqual((await setupClub(db, f, { apply: false, lang: "en" })).steps, [], "nothing again");
  writeFileSync(path, "club: { name: Kestrel Padel, time_zone: America/Los_Angeles, assistant_name: \"Ask Kestrel\" }\nowner: { name: Robin Hale, email: robin@example.test }\n");
  assert.throws(() => readClubFile(path), /club\.assistant_name/);
  await run(db, "club.update", { assistant_name: null }, owner);
  await club();
});

test("no sentence in either language still writes the assistant's name in: each says {assistant}", () => {
  for (const [lang, catalog] of [["en", en], ["es", es]] as const) {
    const fixed = Object.entries(catalog).filter(([, m]) => /Ask openPadel|Ask Kumi|Pregúntale a (openPadel|Kumi)/.test(JSON.stringify(m))).map(([k]) => k);
    assert.deepEqual(fixed, [], lang);
  }
  assert.match(en["ui.assistant_title"] as string, /\{assistant\}/);
  assert.match(es["ui.assistant_title"] as string, /\{assistant\}/);
});
