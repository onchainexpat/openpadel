// A member file with Playtomic's columns (csv.ts): a phone, a yes to club news (only a yes counts), the Playtomic id,
// and the Playtomic level with its reliability. A plain "Level" is Playtomic's only beside a Playtomic id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readPeopleCsv } from "../src/csv.ts";

test("a Playtomic export: id, phone, consent only from a yes, level and reliability", () => {
  const r = readPeopleCsv([
    "Name,Email,Phone,Playtomic ID,Playtomic level,Reliability,Accepts commercial communications",
    "Gil Moss,gil@example.test,(503) 226-1234,pt-111,\"4,1\",0.7,Yes",
    "Hal Ng,hal@example.test,,pt-222,9,80%,No",
    "Ivy Ko,ivy@example.test,+34 612 345 678,,,,",
  ].join("\n"));
  assert.deepEqual(r.rows, [
    { display_name: "Gil Moss", email: "gil@example.test", phone: "(503) 226-1234", club_news: true, playtomic_id: "pt-111", level: { value: 4.1, reliability: 70 } },
    { display_name: "Hal Ng", email: "hal@example.test", playtomic_id: "pt-222" },
    { display_name: "Ivy Ko", email: "ivy@example.test", phone: "+34 612 345 678" },
  ]);
  assert.deepEqual(r.problems.map((p) => p.text.en), ["Line 3: \"9\" isn't a Playtomic level (0 to 7), so it's left out."]);
});

test("Spanish column names, and a plain Level column read as Playtomic's only beside a Playtomic id", () => {
  const es = readPeopleCsv("Nombre;Correo;Teléfono;ID Playtomic;Nivel;Fiabilidad;Noticias del club\nAna Ruiz;ana@example.test;612345678;7781;3,5;55;sí\n");
  assert.deepEqual(es.rows, [{ display_name: "Ana Ruiz", email: "ana@example.test", phone: "612345678", club_news: true, playtomic_id: "7781", level: { value: 3.5, reliability: 55 } }]);
  // Another system's file with its own "Level" column: not a Playtomic level.
  const other = readPeopleCsv("Name,Email,Level\nLee Chen,lee@example.test,B+\n");
  assert.deepEqual(other.rows, [{ display_name: "Lee Chen", email: "lee@example.test" }]);
  assert.deepEqual(other.problems, []);
});
