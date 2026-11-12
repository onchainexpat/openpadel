import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { messageHandlers, processOutbox, run, runAsSystem, setStaffAddress, type Actor, type Db } from "../src/index.ts";

let db: Db, drop: () => Promise<void>, owner: Actor, lee: string, sol: string, loc: string;
before(async () => {
  ({ db, drop } = await freshDb());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: "America/Los_Angeles", owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en", auth: "passkey" };   // roles are a sensitive change: signed in with a second step
  loc = ((await run(db, "location.create", { name: "Eastside", time_zone: "America/Los_Angeles" }, owner)).result as any).location_id;
  lee = ((await run(db, "person.create", { display_name: "Lee Chen", email: "lee@example.test" }, owner)).result as any).person_id;
  sol = ((await run(db, "person.create", { display_name: "Sol Ruiz", email: "sol@example.test", locale: "es" }, owner)).result as any).person_id;
  setStaffAddress("https://staff.kestrelpadel.com/");
});
after(async () => { setStaffAddress(null); await drop(); });

const emails = (to: string) => db.selectFrom("outbound_message").select(["kind", "subject", "body"]).where("person_id", "=", to).where("channel", "=", "email").orderBy("created_at").execute();

test("someone given a staff role is told by email where to sign in, in their language, and once when it's taken away", async () => {
  await run(db, "role.assign", { person_id: lee, role: "front_desk", location_id: loc }, owner);
  await run(db, "role.assign", { person_id: sol, role: "manager" }, owner);
  await db.updateTable("club").set({ two_factor: "owner_manager", second_step_sign_in: true }).execute();   // the usual rule, asked at sign-in (tests run with it off)
  await processOutbox(db, messageHandlers);
  assert.deepEqual(await emails(lee), [{ kind: "staff_role_given", subject: "Staff access at Kestrel Padel: Front desk",
    body: "Robin Hale gave you the Front desk role at Eastside. Sign in to Kestrel Padel's staff app at https://staff.kestrelpadel.com with this email address, and you'll get a code." }]);
  const [es] = await emails(sol);
  assert.equal(es!.subject, "Acceso del personal en Kestrel Padel: Gerente");
  assert.match(es!.body, /^Robin Hale te dio el rol de Gerente\. .* Tu rol también pide un segundo paso al entrar/);   // managers sign in in two steps
  await run(db, "role.remove", { person_id: lee, role: "front_desk", location_id: loc }, owner);
  await processOutbox(db, messageHandlers);
  assert.deepEqual((await emails(lee)).map((m) => [m.kind, m.body]).at(-1), ["staff_role_removed", "Robin Hale took away your Front desk role at Eastside. Your member account stays as it was."]);
  // The owner giving themselves a role hears nothing.
  await run(db, "role.assign", { person_id: owner.personId!, role: "coach" }, owner);
  await processOutbox(db, messageHandlers);
  assert.equal((await emails(owner.personId!)).filter((m) => m.kind.startsWith("staff_role")).length, 0);
});
