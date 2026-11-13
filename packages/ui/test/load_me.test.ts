// Starting the app (loadMe, state.ts): no connection, or the server failing, while it starts is "can't reach the
// club" on the start screen (boot.ts), never the sign-in page for someone who is signed in; signed out is sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMe, me, unreachable } from "../src/state.ts";

const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const offline = async () => { throw new TypeError("fetch failed"); };

test("starting: no connection or a failing server is 'can't reach', and trying again once it answers signs them in", async () => {
  me.value = undefined; unreachable.value = false;
  globalThis.fetch = offline as typeof fetch;
  await loadMe();
  assert.equal(me.value, undefined, "still starting: not the sign-in page");
  assert.equal(unreachable.value, true);
  globalThis.fetch = answer(502, {}) as typeof fetch;
  await loadMe();
  assert.equal(me.value, undefined); assert.equal(unreachable.value, true);
  globalThis.fetch = answer(200, { person: { id: "p1", display_name: "Ana Example", locale: "en" }, signed_in_with: "email_code", lang: "en", roles: [] }) as typeof fetch;
  await loadMe();
  assert.equal(me.value?.person.id, "p1"); assert.equal(unreachable.value, false);
});

test("signed out while starting is the sign-in page; once signed in, a failure is signed out as before", async () => {
  me.value = undefined; unreachable.value = false;
  globalThis.fetch = answer(401, { error: "error.signed_out" }) as typeof fetch;
  await loadMe();
  assert.equal(me.value, null); assert.equal(unreachable.value, false);
  me.value = { person: { id: "p1", display_name: "Ana", locale: "en" }, signed_in_with: "email_code", lang: "en", roles: [] };
  globalThis.fetch = offline as typeof fetch;
  await loadMe();
  assert.equal(me.value, null);
});
