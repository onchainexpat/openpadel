// shape.json is the shape Kumi's own migrations make (shape.ts): what a restore must come back to. A migration that
// adds a function, trigger, rule, view or policy changes it: record it again with
//   KUMI_SHAPE_WRITE=1 node --test apps/server/test/shape.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { freshDb } from "../../../packages/core/test/helpers.ts";
import { expectedShape, schemaShape, shapeDifferences, writeExpectedShape } from "../src/shape.ts";

test("shape.json is what the migrations make", async () => {
  const { db, drop } = await freshDb();
  try {
    const got = await schemaShape(db);
    if (process.env.KUMI_SHAPE_WRITE === "1") writeExpectedShape(got);
    assert.deepEqual(shapeDifferences(got), [], "a migration changed what the database runs: record shape.json again (see the top of this file)");
    assert.equal(got.postgres, expectedShape().postgres, "recorded on another Postgres: record it again on the one Kumi runs on");
  } finally { await drop(); }
});

test("a function, trigger, view or setting of someone else's shows; so does a changed one of Kumi's", async () => {
  const { db, drop } = await freshDb();
  try {
    await sql`CREATE FUNCTION copy_out() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`.execute(db);
    await sql`CREATE TRIGGER copy_out AFTER INSERT ON outbound_message FOR EACH ROW EXECUTE FUNCTION copy_out()`.execute(db);
    await sql`CREATE SCHEMA elsewhere`.execute(db);
    await sql`CREATE OR REPLACE FUNCTION rating_event_words_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`.execute(db);
    await sql`ALTER ROLE CURRENT_USER IN DATABASE ${sql.id((await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d)} SET search_path = elsewhere, public`.execute(db);
    const d = shapeDifferences(await schemaShape(db));
    for (const want of ["not Kumi's: function copy_out()", "not Kumi's: trigger outbound_message.copy_out", "not Kumi's: schema elsewhere", "not Kumi's: function rating_event_words_only()", "not Kumi's: setting for the role here"])
      assert.ok(d.includes(want), `${want} in ${JSON.stringify(d)}`);
  } finally { await drop(); }
});
