// Refused details in plain words (the third phone check: a program's "Add a date" without a court showed staff
// "✖ Too small: expected array to have >=1 items → at court_ids"). Every action's form, filled in wrongly in a few
// ways, is answered in plain English and Spanish: never the checker's own text, an arrow, or a field's code name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as z from "zod/mini";
import { actions, dryPlan, plainIssues, KumiError, type Db } from "../src/index.ts";

const RAW = /expected|received|→|✖|invalid input|undefined|\b[a-z]+_[a-z_]+\b/i;
const shapeOf = (s: unknown) => (s as { _zod?: { def?: { shape?: Record<string, unknown> } } })._zod?.def?.shape ?? {};

test("every action's refused details are plain words in both languages", () => {
  let checked = 0;
  for (const def of actions()) {
    const keys = Object.keys(shapeOf(def.input));
    const tries: unknown[] = [{}, Object.fromEntries(keys.map((k) => [k, 12345])), Object.fromEntries(keys.map((k) => [k, ""])), Object.fromEntries(keys.map((k) => [k, []])), "nonsense"];
    for (const raw of tries) {
      const r = z.safeParse(def.input, raw);
      if (r.success) continue;
      const t = plainIssues(r.error.issues, raw);
      for (const lang of ["en", "es"] as const) assert.doesNotMatch(t[lang], RAW, `${def.name} ${JSON.stringify(raw).slice(0, 60)}: ${t[lang]}`);
      checked++;
    }
  }
  assert.ok(checked > 200, `checked ${checked}`);
});

test("Add a date without a court: pick a court; the usual fields get their own words", () => {
  const issues = (raw: unknown) => { const r = z.safeParse(z.object({ court_ids: z.array(z.string()).check(z.minLength(1)), starts_at: z.string(), name: z.string().check(z.minLength(2)), price_cents: z.number() }), raw); assert.ok(!r.success); return plainIssues(r.error.issues, raw); };
  assert.deepEqual(issues({ court_ids: [], starts_at: "2026-11-12T17:00", name: "Volley", price_cents: 100 }), { en: "Pick at least one court.", es: "Elige al menos una pista." });
  const t = issues({ court_ids: ["c"], name: "V" });
  assert.equal(t.en, "Choose a date and time. Write a little more in the name. Enter an amount.");
  assert.equal(t.es, "Elige una fecha y una hora. Escribe un poco más en el nombre. Escribe un monto.");
});

test("an action's refusal says it plainly, through the same path the apps use", async () => {
  await assert.rejects(dryPlan({} as Db, "session.add", { program_id: "01a1b2c3-0000-7000-8000-000000000000", starts_at: "2026-11-12T17:00:00-08:00", ends_at: "2026-11-12T18:30:00-08:00", court_ids: [] }, { personId: null, via: "test", lang: "en" }, new Date()),
    (e: unknown) => e instanceof KumiError && e.code === "error.invalid_input" && e.text.en.endsWith("Pick at least one court.") && e.text.es.endsWith("Elige al menos una pista.") && !RAW.test(e.text.en));
});

test("nothing turns the checker's own text into what a person reads", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((f) => f.isDirectory() ? (f.name === "node_modules" || f.name === "dist" ? [] : files(`${dir}/${f.name}`)) : f.name.endsWith(".ts") ? [`${dir}/${f.name}`] : []);
  const root = new URL("../../../", import.meta.url).pathname;
  const hits = [...files(`${root}apps/server/src`), ...files(`${root}packages/core/src`)].filter((f) => /prettifyError|\.issues\[0\]\.message/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});
