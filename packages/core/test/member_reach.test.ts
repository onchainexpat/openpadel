// A connection held to a member's reach (assistant_reach.ts) is a member everywhere: not only in the permission check
// but in every role an action or its plan reads (the desk's refund choice, a founding place given up, naming anyone on
// a court). This walks the whole action catalogue: for each action, inputs made from its schema on a member's own
// things, planned by a true member and by a staff member through a held-back connection, must get the same answer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { actions, plan, run, runAsSystem, setPaymentProvider, uuidv7, KumiError, TestProvider, type Actor, type Db } from "../src/index.ts";

const TZ = "America/Los_Angeles";
let db: Db, drop: () => Promise<void>, owner: Actor;
type World = { person: string; name: string; court: string; courtName: string; booking: string; code: string; membership: string; enrolment: string; series: string };
const W: Record<"member" | "held", World> = {} as any;
const shared: Record<string, string> = {};
const day = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + n * 864e5));
const NOWHERE = uuidv7();   // an id that's nobody's, the same for both

before(async () => {
  ({ db, drop } = await freshDb());
  setPaymentProvider(new TestProvider());
  const s = await runAsSystem(db, "club.setup", { name: "Kestrel Padel", time_zone: TZ, owner_email: "robin@example.test", owner_name: "Robin Hale" }, "setup");
  owner = { personId: (s.result as any).owner_person_id, via: "test", lang: "en" };
  shared.location = ((await run(db, "location.create", { name: "Main", time_zone: TZ }, owner)).result as any).location_id;
  await run(db, "hours.set", { location_id: shared.location, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "07:00", closes: "23:00" })) }, owner);
  await run(db, "price.rule_set", { location_id: shared.location, name: "Standard", cents_per_hour: 4000 }, owner);
  await run(db, "club.update", { court_bookings: true }, owner);
  shared.stranger = ((await run(db, "person.create", { display_name: "Sam Stranger", email: "sam@example.test" }, owner)).result as any).person_id;
  const clinic = ((await run(db, "program.create", { location_id: shared.location, kind: "clinic", name: "Volley Clinic", capacity: 8, price_cents: 0 }, owner)).result as any).program_id;
  shared.program = clinic;
  const spare = ((await run(db, "court.create", { location_id: shared.location, name: "Court C" }, owner)).result as any).court_id;
  const start = new Date(`${day(4)}T17:00:00Z`);
  shared.session = ((await run(db, "session.add", { program_id: clinic, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), court_ids: [spare] }, owner)).result as any).session_id;
  await run(db, "program.publish", { program_id: clinic }, owner);
  shared.plan = ((await run(db, "membership.plan_set", { name: "Founding", price_cents: 6000, period: "month", starts_on: day(120) }, owner)).result as any).plan_id;
  for (const [k, name, court] of [["member", "Mia Member", "Court A"], ["held", "Leo Staff", "Court B"]] as const) {
    const person = ((await run(db, "person.create", { display_name: name, email: `${k}@example.test` }, owner)).result as any).person_id;
    const courtId = ((await run(db, "court.create", { location_id: shared.location, name: court }, owner)).result as any).court_id;
    const me: Actor = { personId: person, via: "web", lang: "en" };
    const booking = ((await run(db, "booking.request", { court_id: courtId, starts_at: `${day(2)}T18:00:00Z`, minutes: 90, pay: "whole", person_id: person }, me)).result as any).booking_id;
    const enrolment = ((await run(db, "enrolment.join", { program_id: clinic, person_id: person }, me)).result as any).enrolment_id;
    // A founding place joined and given up before the start: the app doesn't let a member take it again.
    const m = ((await run(db, "membership.join", { plan_id: shared.plan, person_id: person }, me)).result as any).membership_id;
    await run(db, "membership.cancel", { membership_id: m }, me);
    await db.updateTable("booking").set({ status: "confirmed" }).where("id", "=", booking).execute();   // as if paid: players can be named
    const code = (await db.selectFrom("booking").select("code").where("id", "=", booking).executeTakeFirstOrThrow()).code;
    // The same court every week, booked at the desk: ending it with another refund than each week's rule is the club's.
    const r = await run(db, "booking.repeat", { court_id: courtId, starts_at: `${day(9)}T19:00:00Z`, minutes: 90, person_id: person, weeks: 3 }, owner);
    W[k] = { person, name, court: courtId, courtName: court, booking, code, membership: m, enrolment, series: (r.result as any).series_id };
  }
  // Leo holds the staff roles: through a connection held to a member's reach, none of them may count.
  for (const role of ["manager", "front_desk", "coach"]) await run(db, "role.assign", { person_id: W.held.person, role }, owner);
});
after(async () => drop());

/** Values to try for one field of an input, from its schema and its name, on this world's own things. */
function candidates(key: string, schema: any, w: World): unknown[] {
  const d = schema?._zod?.def;
  if (!d) return [];
  switch (d.type) {
    case "optional": case "default": return [undefined, ...candidates(key, d.innerType, w)];
    case "nullable": return [...candidates(key, d.innerType, w), null];
    case "enum": return Object.keys(d.entries);
    case "literal": return d.values;
    case "boolean": return [false, true];
    case "number": return [/minutes/.test(key) ? 90 : /cents/.test(key) ? 1000 : 1];
    case "array": { const one = candidates(key.replace(/s$/, ""), d.element, w)[0]; return one === undefined ? [[]] : [[one], []]; }
    case "object": return [Object.fromEntries(Object.entries(d.shape).map(([k, v]) => [k, candidates(k, v, w)[0]]).filter(([, v]) => v !== undefined))];
    case "union": return d.options.flatMap((o: any) => candidates(key, o, w)).slice(0, 2);
    case "string":
      if (d.format === "uuid") {
        const someoneElse = [shared.stranger!];
        const own: Record<string, string[]> = { person_id: [w.person, shared.stranger!], booking_id: [w.booking], court_id: [w.court], court: [w.court], location_id: [shared.location!],
          friend_id: someoneElse, partner_id: someoneElse, to_person_id: someoneElse, person_a: [w.person], person_b: someoneElse, player_id: someoneElse,
          program_id: [shared.program!], session_id: [shared.session!], plan_id: [shared.plan!], membership_id: [w.membership], enrolment_id: [w.enrolment], series_id: [w.series] };
        return own[key] ?? [NOWHERE];
      }
      if (d.format === "datetime") return [`${day(3)}T18:00:00Z`];
      if (d.format === "email" || /email/.test(key)) return ["walk.in@example.test"];
      if (/date|_on$|day|^until$|^from$|^to$/.test(key)) return [day(3)];
      if (/time|opens|closes|^starts$|^ends$/.test(key)) return ["18:00"];
      return ["Test"];
    default: return [];
  }
}
/** The base input (each field's first value) and one more for each other value of each field. */
function inputs(shape: Record<string, any>, w: World): Record<string, unknown>[] {
  const fields = Object.entries(shape).map(([k, s]) => [k, candidates(k, s, w)] as const);
  const base = Object.fromEntries(fields.map(([k, c]) => [k, c[0]]).filter(([, v]) => v !== undefined));
  const out = [base];
  for (const [k, c] of fields) for (const v of c.slice(1)) out.push(Object.fromEntries(Object.entries({ ...base, [k]: v }).filter(([, x]) => x !== undefined)));
  return out;
}
const same = (text: string) => text.replaceAll(W.held.name, W.member.name).replaceAll(W.held.courtName, W.member.courtName).replaceAll(W.held.code, W.member.code).replaceAll("Leo", "Mia");
/** What's compared: a refusal (whatever its reason: the person's own things can differ in what they are, such as
 *  being a coach) or what the plan would do, in its words. */
const outcome = (a: string) => a.startsWith("ok") ? a : "refused";
async function answer(name: string, input: unknown, actor: Actor): Promise<string> {
  try {
    const p = await plan(db, name, input, actor);
    return `ok ${p.status}: ${same(p.plan.summary.en)}`;
  } catch (e) {
    return e instanceof KumiError ? `no ${e.code}` : `no ${(e as Error).name}`;
  }
}

test("every action: a staff member through a connection held to a member's reach gets exactly a member's answer", async () => {
  const mia: Actor = { personId: W.member.person, via: "mcp:test", lang: "en", auth: "oauth" };
  const leo: Actor = { personId: W.held.person, via: "mcp:test", lang: "en", auth: "oauth", memberOnly: true };
  const differ: string[] = [];
  let compared = 0, planned = 0;
  const names = new Set<string>();
  for (const a of actions().filter((x) => !x.system && !x.internal && !x.name.startsWith("test."))) {
    const shape = (a.input as any)?._zod?.def?.shape;
    if (!shape) continue;
    const forMia = inputs(shape, W.member), forLeo = inputs(shape, W.held);
    for (let n = 0; n < forMia.length; n++) {
      const [m, l] = [await answer(a.name, forMia[n], mia), await answer(a.name, forLeo[n], leo)];
      compared++;
      if (m.startsWith("ok")) { planned++; names.add(a.name); }
      if (outcome(m) !== outcome(l)) differ.push(`${a.name} ${JSON.stringify(forMia[n])}\n    member: ${m}\n    held:   ${l}`);
    }
  }
  console.log(`  ${compared} inputs over the catalogue; a member could plan ${planned} of them, in ${names.size} actions`);
  assert.deepEqual(differ, [], `answers differ:\n  ${differ.join("\n  ")}`);
  // The cases the review found are among them, and come out a member's.
  assert.equal(await answer("booking.cancel", { booking_id: W.held.booking, refund: "full" }, leo), "no error.refund_choice_staff");
  assert.equal(await answer("membership.join", { plan_id: shared.plan, person_id: W.held.person }, leo), "no error.presale_given_up");
  assert.equal(await answer("booking.repeat_end", { series_id: W.held.series, refund: "full" }, leo), "no error.refund_choice_staff");
  // The desk names anyone on anyone's court; held back, Leo names no one on Mia's.
  assert.match(await answer("booking.add_player", { booking_id: W.member.booking, person_id: shared.stranger }, leo), /^no /);
  assert.ok(names.size >= 9, `the walk plans what members do (${[...names].join(", ")})`);
});

test("and in the app, the same staff member still has the desk's powers (the hold is the connection's alone)", async () => {
  const web: Actor = { personId: W.held.person, via: "web", lang: "en" };
  assert.match(await answer("booking.cancel", { booking_id: W.held.booking, refund: "full" }, web), /^ok/);
  assert.match(await answer("membership.join", { plan_id: shared.plan, person_id: W.held.person }, web), /^ok/);
  assert.match(await answer("booking.repeat_end", { series_id: W.held.series, refund: "full" }, web), /^ok/);
  assert.match(await answer("booking.add_player", { booking_id: W.member.booking, person_id: shared.stranger }, web), /^ok/);
});
