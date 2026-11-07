// The first actions: setting up the club, its details, locations, roles and profiles.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, capFor, currencyProblem, money, setClubFormat, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, type PlanCtx } from "./actions.ts";
import { KumiError } from "./errors.ts";
import type { Db, Trx } from "./db.ts";
import { mergeTranslations, translationsInput } from "./club_text.ts";
import { withManagers } from "./households.ts";
import { checkAssign, roleLabel } from "./roles.ts";
import { uuidv7 } from "./ids.ts";
import { showPhone } from "./texts.ts";
import { nameInput } from "./plain_text.ts";

const isTimeZone = (v: string) => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } };
const timeZone = z.string().check(z.refine(isTimeZone, { message: "Not a time zone (use an IANA name such as America/Los_Angeles)" }));
const lang = z.enum(["en", "es"]);
/** A page on the club's own website (its terms, its privacy policy): http or https only, since members open it. */
export const pageUrl = z.url({ protocol: /^https?$/, hostname: z.regexes.domain }).check(z.maxLength(2000));
export const ROLE_KEYS = ["owner", "manager", "front_desk", "coach", "accountant", "member"] as const;
// A built-in role (ROLE_KEYS) or one the club made (custom_...).
const roleKey = z.string().check(z.minLength(1), z.maxLength(40));

/** "the name and the time zone", in each language. */
function fieldList(fields: string[]): Text {
  const keys = fields.map((f) => `field.${f}` as Key);
  return { en: keys.map((k) => both(k).en).join(", "), es: keys.map((k) => both(k).es).join(", ") };
}
const changed = (row: Record<string, unknown>, input: Record<string, unknown>) =>
  Object.keys(input).filter((k) => input[k] !== undefined && JSON.stringify(row[k]) !== JSON.stringify(input[k]));
async function roleId(ctx: PlanCtx, key: string): Promise<string> {
  const r = await ctx.db.selectFrom("role").select("id").where("key", "=", key).where("active", "=", true).executeTakeFirst();
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
  input: z.object({ name: z.string().check(z.minLength(1)), time_zone: timeZone, owner_email: z.email(), owner_name: nameInput(), default_language: z.optional(lang) }),
  async plan(ctx, i) {
    if (await ctx.db.selectFrom("club").select("name").executeTakeFirst()) throw new KumiError("error.forbidden_reason", { reason: both("reason.owner_only") }, 403);
    return { title: { en: `Set up ${i.name}`, es: `Configurar ${i.name}` }, summary: { en: `Create ${i.name} with ${i.owner_name} as owner.`, es: `Crear ${i.name} con ${i.owner_name} como propietario.` }, reads: [], undo: { kind: "none", note: both("reason.no_way_back") } };
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

/** A currency the club may change to: a real one Kumi takes, and only before any payment (amounts already taken are in
 *  the old currency, and Stripe can't convert them). */
async function currencyChange(db: Db | Trx, code: string) {
  const problem = currencyProblem(code);
  if (problem) throw new KumiError(problem === "three_decimals" ? "error.currency_three_decimals" : problem === "whole_in_two" ? "error.currency_whole_in_two" : "error.currency_unknown", { currency: code.toUpperCase() }, 400);
  if (await db.selectFrom("payment").select("id").limit(1).executeTakeFirst()) throw new KumiError("error.currency_has_payments", {}, 409);
}

/** The club's currency and formats for this server's money and dates (format.ts): read as the server starts and again
 *  on each round of jobs, so a change made anywhere reaches every message. */
export async function loadClubFormat(db: Db): Promise<void> {
  const c = await db.selectFrom("club").select(["currency", "format_locale", "country"]).executeTakeFirst();
  if (c) setClubFormat({ currency: c.currency, locale: c.format_locale, country: c.country });
}

export const clubUpdate = defineAction({
  name: "club.update", version: 1, strongAuth: true,
  input: z.object({
    name: z.optional(z.string().check(z.minLength(1))), legal_name: z.optional(z.string()), time_zone: z.optional(timeZone),
    languages: z.optional(z.array(lang).check(z.minLength(1))), default_language: z.optional(lang),
    brand_colour: z.optional(z.string().check(z.regex(/^#[0-9A-Fa-f]{6}$/))), sign_up_open: z.optional(z.boolean()),
    court_bookings: z.optional(z.boolean()),
    // Members book the same court every week in the app (booking_series.ts), for at most this many weeks.
    weekly_bookings: z.optional(z.boolean()), weekly_max_weeks: z.optional(z.number().check(z.int(), z.minimum(2), z.maximum(26))),
    tax_rate_bp: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(3000))),
    // Prices entered and shown include the tax (VAT, IVA, GST), and what the tax is called on receipts.
    // The club's country (ISO 3166-1 alpha-2): phone numbers typed without a + are read in it, and Stripe opens the
    // club's own account there.
    country: z.optional(z.string().check(z.regex(/^[A-Za-z]{2}$/))),
    prices_include_tax: z.optional(z.boolean()), tax_label: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(20)))),
    // The club's currency (ISO 4217). It can't change once the club has taken a payment.
    currency: z.optional(z.string().check(z.regex(/^[A-Za-z]{3}$/))),
    // How dates, times, numbers and amounts are written (a BCP 47 locale: en-US, es-ES, en-GB...).
    format_locale: z.optional(z.string().check(z.regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/), z.refine((l) => { try { return Intl.getCanonicalLocales(l).length === 1; } catch { return false; } }, "a locale like en-US or es-ES"))),
    // Players message each other inside the games they play together (chat.ts); off, no chat anywhere.
    players_chat: z.optional(z.boolean()),
    // Gift cards (gift_cards.ts): sold in the app and at the desk, for amounts from the minimum to the maximum.
    gift_cards: z.optional(z.boolean()), gift_card_min_cents: z.optional(z.number().check(z.int(), z.minimum(100))), gift_card_max_cents: z.optional(z.number().check(z.int(), z.maximum(1_000_000_000))),
    public_page: z.optional(z.boolean()), about: z.optional(z.nullable(z.string().check(z.maxLength(600)))),
    // The club's own terms and privacy policy for members (docs/templates): linked where members join, beside the
    // yes to texts, on the profile and the public pages. Someone who joins after they're set agrees to them.
    terms_url: z.optional(z.nullable(pageUrl)), privacy_policy_url: z.optional(z.nullable(pageUrl)),
    // The public page's blurb in the other language: { es: { about } }.
    translations: translationsInput("club"),
    question_alert_hours: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(72))),
    auto_answers: z.optional(z.boolean().check(z.describe("Kumi answers a new question from the club's facts by itself, when a decision model is set up on the server."))),
    broadcast_daily_cap: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100000))), broadcast_copy_managers: z.optional(z.boolean()),
    program_decide_hours: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(336), z.describe("A program's minimum is decided this many hours before its first date, unless it sets its own."))),
    program_heads_up_hours: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(336), z.describe("Staff hear this many hours before that decision if a program is short (0: no heads-up)."))),
    // Who signs in with two steps. It can't be switched off here ('off' is for practice and test databases).
    two_factor: z.optional(z.enum(["owner_manager", "all_staff"]).check(z.describe("Who signs in with two steps: owners, managers and the club's own roles (owner_manager), or every staff role (all_staff)."))),
  }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "club", "singleton");
    const fields = changed(row, i);
    const langs = i.languages ?? row.languages;
    if (!langs.includes(i.default_language ?? row.default_language)) throw new KumiError("error.invalid_input", { details: "The default language must be one of the club's languages." }, 400);
    // Weekly bookings (or court bookings) switched off pause the members' weekly courts (booking_series.ts): say how many.
    const pausing = (row.weekly_bookings && i.weekly_bookings === false) || (row.court_bookings && i.court_bookings === false)
      ? Number((await ctx.db.selectFrom("booking_series").select(sql<string>`count(*)`.as("n")).where("ended_at", "is", null).where("source", "=", "app").where("paused_at", "is", null).executeTakeFirstOrThrow()).n) : 0;
    if (i.currency !== undefined && i.currency.toUpperCase() !== row.currency) await currencyChange(ctx.db, i.currency);
    // The club's Stripe account was opened in its country, which Stripe can't change afterwards.
    if (i.country !== undefined && i.country.toUpperCase() !== row.country && row.stripe_account_id) throw new KumiError("error.country_after_stripe", { country: row.country });
    // A gift card is at most about $5,000, in the club's currency.
    const cur = (i.currency ?? row.currency).toUpperCase();
    if (i.gift_card_max_cents !== undefined && i.gift_card_max_cents > capFor(500000, cur)) throw new KumiError("error.amount_range", { min: money(capFor(100, cur), "en", cur), max: money(capFor(500000, cur), "en", cur) });
    const summary = both("plan.club.update", { fields: fieldList(fields) });
    return { title: both("action.club.update"), summary: pausing ? { en: `${summary.en} ${both("plan.club.weekly_pause", { count: pausing }).en}`, es: `${summary.es} ${both("plan.club.weekly_pause", { count: pausing }).es}` } : summary,
      reads: [read], undo: { kind: "reversible" }, details: { fields } };
  },
  async apply(ctx, i) {
    const { translations, ...rest } = i;
    const patch: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (i.currency !== undefined) {
      patch.currency = i.currency.toUpperCase();
      if (patch.currency !== (await ctx.trx.selectFrom("club").select("currency").executeTakeFirstOrThrow()).currency) await currencyChange(ctx.trx, i.currency);
    }
    if (translations) patch.translations = JSON.stringify(mergeTranslations((await ctx.trx.selectFrom("club").select("translations").executeTakeFirstOrThrow()).translations, translations));
    if (i.format_locale !== undefined) patch.format_locale = Intl.getCanonicalLocales(i.format_locale)[0];
    if (i.country !== undefined) patch.country = i.country.toUpperCase();
    await ctx.update("club", "singleton", patch); await ctx.emit("club.updated", {});
    if (patch.currency || patch.format_locale || patch.country) setClubFormat({ currency: patch.currency as string | undefined, locale: patch.format_locale as string | undefined, country: patch.country as string | undefined });
    return null;
  },
});

/** An address written as it is where the club is: the street in address, then a postal code, a region (state,
 *  province, county) and a country, each optional. */
const addressParts = {
  postal_code: z.optional(z.nullable(z.string().check(z.maxLength(16)))), region: z.optional(z.nullable(z.string().check(z.maxLength(60)))),
  country: z.optional(z.nullable(z.string().check(z.regex(/^[A-Za-z]{2}$/)))),
};

export const locationCreate = defineAction({
  name: "location.create", version: 1,
  input: z.object({ name: z.string().check(z.minLength(1)), time_zone: timeZone, address: z.optional(z.string()), ...addressParts }),
  async plan(_ctx, i) {
    return { title: both("action.location.create"), summary: both("plan.location.create", { name: i.name, tz: i.time_zone }), reads: [], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("location", { id, name: i.name, time_zone: i.time_zone, address: i.address ?? null, postal_code: i.postal_code ?? null, region: i.region ?? null, country: i.country?.toUpperCase() ?? null });
    await ctx.emit("location.created", { location_id: id });
    return { location_id: id };
  },
});

export const locationUpdate = defineAction({
  name: "location.update", version: 1,
  input: z.object({ location_id: z.uuid(), name: z.optional(z.string().check(z.minLength(1))), time_zone: z.optional(timeZone), address: z.optional(z.string()), ...addressParts }),
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
  input: z.object({ display_name: nameInput(), email: z.optional(z.email()), locale: z.optional(lang) }),
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
  input: z.object({ rows: z.array(z.object({ display_name: nameInput(80), email: z.optional(z.email()), locale: z.optional(lang) })).check(z.minLength(1), z.maxLength(5000)) }),
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

/** Someone joins by themselves, after proving their email address or (by a texted code) their mobile number.
 *  Their answer about club news is kept as consent evidence, when they were asked: someone who joined by phone
 *  has no email to send news to, so they weren't. Messages about their own sign-ups and payments need no consent.
 *  When the club links its own terms and privacy policy, joining agrees to them: `policies` is what the page
 *  showed, which must still be the club's (or the page is behind and they look again), and it's kept with the time. */
export const SIGN_UP_FORM = "sign-up-1";
const shownLink = z.nullable(z.string().check(z.maxLength(2000)));
export const personSignUp = defineAction({
  name: "person.sign_up", version: 1, system: true, internal: true,
  input: z.object({ email: z.optional(z.email()), phone: z.optional(z.string().check(z.regex(/^\+1\d{10}$/))), display_name: nameInput(80), locale: lang,
    club_news: z.boolean(), policies: z.optional(z.object({ terms_url: shownLink, privacy_policy_url: shownLink })) }),
  async plan(ctx, i) {
    if (Boolean(i.email) === Boolean(i.phone)) throw new KumiError("error.invalid_input", { details: "an email or a phone number, not both" });
    const name = i.display_name.trim();
    const policies = await ctx.db.selectFrom("club").select(["terms_url", "privacy_policy_url"]).executeTakeFirstOrThrow();
    const linked = Boolean(policies.terms_url || policies.privacy_policy_url);
    if (linked && (i.policies?.terms_url !== policies.terms_url || i.policies?.privacy_policy_url !== policies.privacy_policy_url)) throw new KumiError("error.policies_changed", {}, 409);
    const details = { policies: linked ? policies : null };
    if (i.phone) {
      if (await ctx.db.selectFrom("auth_identity").select("id").where("kind", "=", "phone").where("value", "=", i.phone).executeTakeFirst()
        || await ctx.db.selectFrom("person").select("id").where("phone", "=", i.phone).executeTakeFirst()) throw new KumiError("error.phone_taken");
      return { title: both("action.person.sign_up"), summary: both("plan.person.sign_up_phone", { name, phone: showPhone(i.phone) }), reads: [], undo: { kind: "none" }, details };
    }
    const email = i.email!.trim().toLowerCase();
    if (await ctx.db.selectFrom("person").select("id").where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).executeTakeFirst()) throw new KumiError("error.duplicate_email");
    return { title: both("action.person.sign_up"), summary: both("plan.person.sign_up", { name, email }), reads: [], undo: { kind: "none" }, details };
  },
  async apply(ctx, i, plan) {
    const id = uuidv7(), email = i.email ? i.email.trim().toLowerCase() : null;
    await ctx.insert("person", { id, display_name: i.display_name.trim(), email, phone: i.phone ?? null, locale: i.locale, created_via: "signup" });
    await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: id, kind: email ? "email" : "phone", value: email ?? i.phone!, verified_at: ctx.now }).execute();
    const member = await ctx.trx.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
    await ctx.insert("person_role", { id: uuidv7(), person_id: id, role_id: member.id, location_id: null });
    if (email) await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: id, channel: "email", purpose: "club_news", granted: i.club_news, source: "sign_up", form_version: SIGN_UP_FORM, evidence: JSON.stringify({ at: ctx.now.toISOString() }) }).execute();
    const agreed = (plan.details as { policies: { terms_url: string | null; privacy_policy_url: string | null } | null }).policies;
    if (agreed) await ctx.trx.insertInto("policy_acceptance").values({ id: uuidv7(), person_id: id, ...agreed, lang: i.locale, source: "sign_up", accepted_at: ctx.now }).execute();
    await ctx.emit("person.signed_up", { person_id: id });
    return { person_id: id };
  },
});

/** An email address, proven with a code, for an account that has none (someone who joined by phone): their
 *  receipts and messages can go there, and it's a second way to sign in if they lose the phone. Changing an
 *  address the account already has is email.change. */
export const emailAdd = defineAction({
  name: "email.add", version: 1, system: true, internal: true,
  input: z.object({ person_id: z.uuid(), email: z.email(), by: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const email = i.email.trim().toLowerCase();
    if (row.email) throw new KumiError("error.email_already_set");
    if (await ctx.db.selectFrom("person").select("id").where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).executeTakeFirst()
      || await ctx.db.selectFrom("auth_identity").select("id").where("kind", "=", "email").where((eb) => eb(eb.fn("lower", ["value"]), "=", email)).executeTakeFirst()) throw new KumiError("error.duplicate_email");
    return { title: both("action.email.add"), summary: both("plan.email.add", { email }), reads: [read], ownerIds: [i.person_id], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const email = i.email.trim().toLowerCase();
    await ctx.update("person", i.person_id, { email });
    await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: i.person_id, kind: "email", value: email, verified_at: ctx.now }).execute();
    return null;
  },
});

/** A new address for an account that has one, proven with a code to the new address by the person themselves
 *  (auth.ts); the old address is told, with a link to put it back. Also how that link puts it back. */
export const emailChange = defineAction({
  name: "email.change", version: 1, system: true, internal: true,
  input: z.object({ person_id: z.uuid(), email: z.email(), by: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const email = i.email.trim().toLowerCase();
    if (!row.email) throw new KumiError("error.not_found", { thing: both("thing.email") }, 404);
    if (row.email.toLowerCase() === email) throw new KumiError("error.nothing_changed");
    if (await ctx.db.selectFrom("person").select("id").where("id", "!=", i.person_id).where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).executeTakeFirst()
      || await ctx.db.selectFrom("auth_identity").select("id").where("person_id", "!=", i.person_id).where("kind", "=", "email").where((eb) => eb(eb.fn("lower", ["value"]), "=", email)).executeTakeFirst()) throw new KumiError("error.duplicate_email");
    return { title: both("action.email.change"), summary: both("plan.email.change", { email }), reads: [read], ownerIds: [i.person_id], undo: { kind: "none" }, details: { from: row.email } };
  },
  async apply(ctx, i) {
    const email = i.email.trim().toLowerCase();
    await ctx.update("person", i.person_id, { email });
    const had = await ctx.trx.updateTable("auth_identity").set({ value: email, verified_at: ctx.now }).where("person_id", "=", i.person_id).where("kind", "=", "email").returning("id").execute();
    if (!had.length) await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: i.person_id, kind: "email", value: email, verified_at: ctx.now }).execute();
    return null;
  },
});

export const roleAssign = defineAction({
  name: "role.assign", version: 1, strongAuth: true,
  input: z.object({ person_id: z.uuid(), role: roleKey, location_id: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const { row: person, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    if (person.junior) throw new KumiError("error.not_an_adult");   // a junior has no login, so no role
    await checkAssign(ctx, await roleId(ctx, i.role));
    // An assistant they connected before was allowed what they could do then: with a staff role it would reach the
    // staff's reads and changes without their saying so (or giving a second step), so it's disconnected and they
    // connect it again.
    const assistants = i.role === "member" ? 0 : (await connectedGrants(ctx.db, i.person_id)).length;
    return { title: both("action.role.assign"), summary: both("plan.role.assign", { person: person.display_name, role: await roleLabel(ctx.db, i.role), where: await whereText(ctx, i.location_id),
      assistants: assistants ? both("plan.role.assign_assistants", { count: assistants }) : { en: "", es: "" } }), reads: [read], locationId: i.location_id ?? null, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("person_role", { id, person_id: i.person_id, role_id: await roleId(ctx, i.role), location_id: i.location_id ?? null });
    let ended = 0;
    if (i.role !== "member") for (const g of await connectedGrants(ctx.trx, i.person_id)) {
      await ctx.update("oauth_grant", g.id, { revoked_at: ctx.now });
      await ctx.trx.updateTable("oauth_token").set({ revoked_at: ctx.now }).where("grant_id", "=", g.id).where("revoked_at", "is", null).execute();
      ended++;
    }
    await ctx.emit("role.assigned", { person_id: i.person_id, role: i.role, location_id: i.location_id ?? null, by: ctx.actor.personId ?? null, assistants_ended: ended });
    return { person_role_id: id };
  },
});

/** A person's connected assistants (not disconnected). */
const connectedGrants = (db: Db | Trx, personId: string) => db.selectFrom("oauth_grant").select("id").where("person_id", "=", personId).where("revoked_at", "is", null).execute();

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
    return { title: both("action.role.remove"), summary: both("plan.role.remove", { person: person.display_name, role: await roleLabel(ctx.db, i.role), where: await whereText(ctx, i.location_id) }), reads: [{ entity: "person_role", id: pr.id, version: pr.version }], locationId: i.location_id ?? null, undo: { kind: "reversible" }, details: { person_role_id: pr.id } };
  },
  async apply(ctx, i, p) {
    const id = (p.details as { person_role_id: string }).person_role_id;
    await ctx.update("person_role", id, { active: false });
    await ctx.emit("role.removed", { person_id: i.person_id, role: i.role, location_id: i.location_id ?? null, by: ctx.actor.personId ?? null });
    return null;
  },
});

export const personUpdateProfile = defineAction({
  name: "person.update_profile", version: 1,
  input: z.object({ person_id: z.uuid(), display_name: z.optional(nameInput()), locale: z.optional(lang) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    const { person_id, ...rest } = i;
    const fields = changed(row, rest);
    // Nothing different from what's saved: said plainly, with nothing to confirm (not "Change  on your profile").
    if (!fields.length) throw new KumiError("error.nothing_changed");
    const base = both("plan.person.update_profile", { fields: fieldList(fields) });
    // A new language says what it changes: everything Kumi says to them, from now on.
    const lang = fields.includes("locale") && i.locale ? both("plan.person.locale_to", { language: both(`lang.word_${i.locale}` as Key) }) : null;
    const summary = lang ? { en: `${base.en} ${lang.en}`, es: `${base.es} ${lang.es}` } : base;
    return { title: both("action.person.update_profile"), summary, reads: [read], ownerIds: await withManagers(ctx.db, [person_id]), undo: { kind: "reversible" } };
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
