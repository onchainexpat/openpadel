// The first actions: setting up the club, its details, locations, roles and profiles.
import * as z from "zod/mini";
import { both, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, type PlanCtx } from "./actions.ts";
import { KumiError } from "./errors.ts";
import { withManagers } from "./households.ts";
import { uuidv7 } from "./ids.ts";

const isTimeZone = (v: string) => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } };
const timeZone = z.string().check(z.refine(isTimeZone, { message: "Not a time zone (use an IANA name such as America/Los_Angeles)" }));
const lang = z.enum(["en", "es"]);
export const ROLE_KEYS = ["owner", "manager", "front_desk", "coach", "accountant", "member"] as const;
const roleKey = z.enum(ROLE_KEYS);

/** "the name and the time zone", in each language. */
function fieldList(fields: string[]): Text {
  const keys = fields.map((f) => `field.${f}` as Key);
  return { en: keys.map((k) => both(k).en).join(", "), es: keys.map((k) => both(k).es).join(", ") };
}
const changed = (row: Record<string, unknown>, input: Record<string, unknown>) =>
  Object.keys(input).filter((k) => input[k] !== undefined && JSON.stringify(row[k]) !== JSON.stringify(input[k]));
const roleText = (key: string): Text => both(`role.${key}` as Key);

async function roleId(ctx: PlanCtx, key: string): Promise<string> {
  const r = await ctx.db.selectFrom("role").select("id").where("key", "=", key).executeTakeFirst();
  if (!r) throw new KumiError("error.not_found", { thing: both("thing.role") }, 404);
  return r.id;
}
async function whereText(ctx: PlanCtx, locationId: string | undefined): Promise<Text> {
  if (!locationId) return both("where.everywhere");
  const { row } = await readRow(ctx.db, "location", locationId, "thing.location");
  return both("where.at", { location: row.name });
}

export const clubSetup = defineAction({
  name: "club.setup", version: 1, system: true,
  input: z.object({ name: z.string().check(z.minLength(1)), time_zone: timeZone, owner_email: z.email(), owner_name: z.string().check(z.minLength(1)), default_language: z.optional(lang) }),
  async plan(ctx, i) {
    if (await ctx.db.selectFrom("club").select("name").executeTakeFirst()) throw new KumiError("error.forbidden_reason", { reason: both("reason.owner_only") }, 403);
    return { title: { en: `Set up ${i.name}`, es: `Configurar ${i.name}` }, summary: { en: `Create ${i.name} with ${i.owner_name} as owner.`, es: `Crear ${i.name} con ${i.owner_name} como propietario.` }, reads: [], undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    await ctx.insert("club", { name: i.name, time_zone: i.time_zone, default_language: i.default_language ?? "en" });
    const personId = uuidv7();
    await ctx.insert("person", { id: personId, display_name: i.owner_name, email: i.owner_email, locale: i.default_language ?? "en", created_via: "setup" });
    await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: personId, kind: "email", value: i.owner_email, verified_at: null }).execute();
    const owner = await ctx.trx.selectFrom("role").select("id").where("key", "=", "owner").executeTakeFirstOrThrow();
    await ctx.insert("person_role", { id: uuidv7(), person_id: personId, role_id: owner.id, location_id: null });
    await ctx.insert("staff_member", { id: uuidv7(), person_id: personId, title: "Owner" });
    await ctx.emit("club.set_up", { owner_person_id: personId });
    return { owner_person_id: personId };
  },
});

export const clubUpdate = defineAction({
  name: "club.update", version: 1, strongAuth: true,
  input: z.object({
    name: z.optional(z.string().check(z.minLength(1))), legal_name: z.optional(z.string()), time_zone: z.optional(timeZone),
    languages: z.optional(z.array(lang).check(z.minLength(1))), default_language: z.optional(lang),
    brand_colour: z.optional(z.string().check(z.regex(/^#[0-9A-Fa-f]{6}$/))), sign_up_open: z.optional(z.boolean()),
    court_bookings: z.optional(z.boolean()), tax_rate_bp: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(3000))),
    public_page: z.optional(z.boolean()), about: z.optional(z.nullable(z.string().check(z.maxLength(600)))),
    question_alert_hours: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(72))),
    broadcast_daily_cap: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100000))), broadcast_copy_managers: z.optional(z.boolean()),
    program_decide_hours: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(336), z.describe("A program's minimum is decided this many hours before its first date, unless it sets its own."))),
    program_heads_up_hours: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(336), z.describe("Staff hear this many hours before that decision if a program is short (0: no heads-up)."))),
  }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "club", "singleton");
    const fields = changed(row, i);
    const langs = i.languages ?? row.languages;
    if (!langs.includes(i.default_language ?? row.default_language)) throw new KumiError("error.invalid_input", { details: "The default language must be one of the club's languages." }, 400);
    return { title: both("action.club.update"), summary: both("plan.club.update", { fields: fieldList(fields) }), reads: [read], undo: { kind: "reversible" }, details: { fields } };
  },
  async apply(ctx, i) { await ctx.update("club", "singleton", Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined))); await ctx.emit("club.updated", {}); return null; },
});

export const locationCreate = defineAction({
  name: "location.create", version: 1,
  input: z.object({ name: z.string().check(z.minLength(1)), time_zone: timeZone, address: z.optional(z.string()) }),
  async plan(_ctx, i) {
    return { title: both("action.location.create"), summary: both("plan.location.create", { name: i.name, tz: i.time_zone }), reads: [], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("location", { id, name: i.name, time_zone: i.time_zone, address: i.address ?? null });
    await ctx.emit("location.created", { location_id: id });
    return { location_id: id };
  },
});

export const locationUpdate = defineAction({
  name: "location.update", version: 1,
  input: z.object({ location_id: z.uuid(), name: z.optional(z.string().check(z.minLength(1))), time_zone: z.optional(timeZone), address: z.optional(z.string()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "location", i.location_id, "thing.location");
    const { location_id, ...rest } = i;
    return { title: both("action.location.update"), summary: both("plan.location.update", { fields: fieldList(changed(row, rest)), name: row.name }), reads: [read], locationId: location_id, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const { location_id, ...rest } = i;
    await ctx.update("location", location_id, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
    return null;
  },
});

/** Staff add someone: a member by default. Signing in later is by an emailed code to this address. */
export const personCreate = defineAction({
  name: "person.create", version: 1,
  input: z.object({ display_name: z.string().check(z.minLength(1)), email: z.optional(z.email()), locale: z.optional(lang) }),
  async plan(ctx, i) {
    const email = i.email?.trim().toLowerCase();
    if (email && await ctx.db.selectFrom("person").select("id").where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).executeTakeFirst()) throw new KumiError("error.duplicate_email");
    return { title: both("action.person.create"), summary: both("plan.person.create", { name: i.display_name, email: email ?? "-" }), reads: [], undo: { kind: "compensating" } };
  },
  async apply(ctx, i) {
    const id = uuidv7(), email = i.email?.trim().toLowerCase() ?? null;
    await ctx.insert("person", { id, display_name: i.display_name, email, locale: i.locale ?? "en", created_via: "desk" });
    if (email) await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: id, kind: "email", value: email, verified_at: null }).execute();
    const member = await ctx.trx.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
    await ctx.insert("person_role", { id: uuidv7(), person_id: id, role_id: member.id, location_id: null });
    await ctx.emit("person.created", { person_id: id });
    return { person_id: id };
  },
});

/** Many members at once, from a spreadsheet. Anyone whose email is already here is left as they are, and
 *  nobody is emailed: telling members about the app is the club's own announcement. */
export const personImport = defineAction({
  name: "person.import", version: 1,
  input: z.object({ rows: z.array(z.object({ display_name: z.string().check(z.minLength(1), z.maxLength(80)), email: z.optional(z.email()), locale: z.optional(lang) })).check(z.minLength(1), z.maxLength(5000)) }),
  async plan(ctx, i) {
    const { add, skipped } = await newPeople(ctx, i.rows);
    const people = both("count.people", { count: add.length });
    return { title: both("action.person.import"), summary: skipped ? both("plan.person.import_skipped", { people, already: both("count.already_here", { count: skipped }) }) : both("plan.person.import", { people }),
      reads: [], undo: { kind: "compensating" }, details: { add: add.length, skipped } };
  },
  async apply(ctx, i) {
    const { add } = await newPeople(ctx, i.rows);   // again, in case someone joined meanwhile
    const member = await ctx.trx.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
    for (const r of add) {
      const id = uuidv7();
      await ctx.insert("person", { id, display_name: r.display_name.trim(), email: r.email ?? null, locale: r.locale ?? "en", created_via: "import" });
      if (r.email) await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: id, kind: "email", value: r.email, verified_at: null }).execute();
      await ctx.insert("person_role", { id: uuidv7(), person_id: id, role_id: member.id, location_id: null });
    }
    await ctx.emit("person.imported", { count: add.length });
    return { added: add.length };
  },
});
async function newPeople(ctx: PlanCtx, rows: { display_name: string; email?: string; locale?: "en" | "es" }[]) {
  const emails = rows.map((r) => r.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e));
  const have = new Set(emails.length ? (await ctx.db.selectFrom("person").select((eb) => eb.fn<string>("lower", ["email"]).as("e")).where((eb) => eb(eb.fn("lower", ["email"]), "in", emails)).execute()).map((r) => r.e) : []);
  const seen = new Set<string>(), add: typeof rows = [];
  let skipped = 0;
  for (const r of rows) {
    const email = r.email?.trim().toLowerCase();
    if (email && (have.has(email) || seen.has(email))) { skipped++; continue; }
    if (email) seen.add(email);
    add.push({ ...r, email });
  }
  return { add, skipped };
}

/** Someone joins by themselves, after proving their email address. Their answer about club news is kept
 *  as consent evidence; emails about their own sign-ups and payments need no consent. */
export const SIGN_UP_FORM = "sign-up-1";
export const personSignUp = defineAction({
  name: "person.sign_up", version: 1, system: true, internal: true,
  input: z.object({ email: z.email(), display_name: z.string().check(z.minLength(1), z.maxLength(80)), locale: lang, club_news: z.boolean() }),
  async plan(ctx, i) {
    const email = i.email.trim().toLowerCase();
    if (await ctx.db.selectFrom("person").select("id").where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).executeTakeFirst()) throw new KumiError("error.duplicate_email");
    return { title: both("action.person.sign_up"), summary: both("plan.person.sign_up", { name: i.display_name.trim(), email }), reads: [], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const id = uuidv7(), email = i.email.trim().toLowerCase();
    await ctx.insert("person", { id, display_name: i.display_name.trim(), email, locale: i.locale, created_via: "signup" });
    await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: id, kind: "email", value: email, verified_at: ctx.now }).execute();
    const member = await ctx.trx.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
    await ctx.insert("person_role", { id: uuidv7(), person_id: id, role_id: member.id, location_id: null });
    await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: id, channel: "email", purpose: "club_news", granted: i.club_news, source: "sign_up", form_version: SIGN_UP_FORM, evidence: JSON.stringify({ at: ctx.now.toISOString() }) }).execute();
    await ctx.emit("person.signed_up", { person_id: id });
    return { person_id: id };
  },
});

export const roleAssign = defineAction({
  name: "role.assign", version: 1, strongAuth: true,
  input: z.object({ person_id: z.uuid(), role: roleKey, location_id: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const { row: person, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    if (person.junior) throw new KumiError("error.not_an_adult");   // a junior has no login, so no role
    await roleId(ctx, i.role);
    return { title: both("action.role.assign"), summary: both("plan.role.assign", { person: person.display_name, role: roleText(i.role), where: await whereText(ctx, i.location_id) }), reads: [read], locationId: i.location_id ?? null, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("person_role", { id, person_id: i.person_id, role_id: await roleId(ctx, i.role), location_id: i.location_id ?? null });
    await ctx.emit("role.assigned", { person_id: i.person_id, role: i.role });
    return { person_role_id: id };
  },
});

export const roleRemove = defineAction({
  name: "role.remove", version: 1, strongAuth: true,
  input: z.object({ person_id: z.uuid(), role: roleKey, location_id: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const { row: person } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const rid = await roleId(ctx, i.role);
    const pr = await ctx.db.selectFrom("person_role").selectAll().where("person_id", "=", i.person_id).where("role_id", "=", rid).where("active", "=", true)
      .$if(Boolean(i.location_id), (q) => q.where("location_id", "=", i.location_id!)).$if(!i.location_id, (q) => q.where("location_id", "is", null)).executeTakeFirst();
    if (!pr) throw new KumiError("error.not_found", { thing: both("thing.role") }, 404);
    if (i.role === "owner") {
      const owners = await ctx.db.selectFrom("person_role").select((eb) => eb.fn.countAll<string>().as("n")).where("role_id", "=", rid).where("active", "=", true).executeTakeFirstOrThrow();
      if (Number(owners.n) <= 1) throw new KumiError("error.last_owner");   // a rule no setting can turn off
    }
    return { title: both("action.role.remove"), summary: both("plan.role.remove", { person: person.display_name, role: roleText(i.role), where: await whereText(ctx, i.location_id) }), reads: [{ entity: "person_role", id: pr.id, version: pr.version }], locationId: i.location_id ?? null, undo: { kind: "reversible" }, details: { person_role_id: pr.id } };
  },
  async apply(ctx, _i, p) {
    const id = (p.details as { person_role_id: string }).person_role_id;
    await ctx.update("person_role", id, { active: false });
    return null;
  },
});

export const personUpdateProfile = defineAction({
  name: "person.update_profile", version: 1,
  input: z.object({ person_id: z.uuid(), display_name: z.optional(z.string().check(z.minLength(1))), locale: z.optional(lang) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const { person_id, ...rest } = i;
    return { title: both("action.person.update_profile"), summary: both("plan.person.update_profile", { fields: fieldList(changed(row, rest)) }), reads: [read], ownerIds: await withManagers(ctx.db, [person_id]), undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const { person_id, ...rest } = i;
    await ctx.update("person", person_id, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
    return null;
  },
});

export const passkeyAdd = defineAction({
  name: "person.passkey_add", version: 1, internal: true,
  input: z.object({ person_id: z.uuid(), credential_id: z.string().check(z.minLength(8)), public_key: z.string(), counter: z.number(), transports: z.optional(z.array(z.string())), name: z.optional(z.string()) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    return { title: both("action.person.passkey_add"), summary: both("plan.person.passkey_add", { name: i.name ?? "" }), reads: [read], ownerIds: [i.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.insert("passkey", { credential_id: i.credential_id, person_id: i.person_id, public_key: Buffer.from(i.public_key, "base64url"), counter: String(i.counter), transports: i.transports ?? null, name: i.name ?? null });
    await ctx.emit("person.passkey_added", { person_id: i.person_id, name: i.name ?? null });
    return { credential_id: i.credential_id };
  },
});

export const passkeyRemove = defineAction({
  name: "person.passkey_remove", version: 1, strongAuth: true,
  input: z.object({ person_id: z.uuid(), credential_id: z.string() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "passkey", i.credential_id, "thing.passkey");
    if (row.person_id !== i.person_id || row.revoked_at) throw new KumiError("error.not_found", { thing: both("thing.passkey") }, 404);
    return { title: both("action.person.passkey_remove"), summary: both("plan.person.passkey_remove", { name: row.name ?? "" }), reads: [read], ownerIds: [i.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.update("passkey", i.credential_id, { revoked_at: ctx.now });
    await ctx.emit("person.passkey_removed", { person_id: i.person_id });
    return null;
  },
});
