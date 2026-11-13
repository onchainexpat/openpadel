// The first actions: setting up the club, its details, locations, roles and profiles.
import { sql } from "kysely";
import { erasedMatcher, markRejoined } from "./playtomic_erased.ts";
import * as z from "zod/mini";
import { both, capFor, currencyProblem, en, money, setClubFormat, type Key, type Text } from "@kumi/i18n";
import { defineAction, readRow, type PlanCtx } from "./actions.ts";
import { KumiError } from "./errors.ts";
import { holdsRole } from "./permissions.ts";
import type { Db, Trx } from "./db.ts";
import { mergeTranslations, translationsInput } from "./club_text.ts";
import { withManagers } from "./households.ts";
import { checkAssign, roleLabel } from "./roles.ts";
import { uuidv7 } from "./ids.ts";
import { anyPhone, showPhone } from "./texts.ts";
import { nameInput } from "./plain_text.ts";
import { localDate } from "./clock.ts";
import { activeImports, startSigma, writeImport } from "./level_import.ts";
import { SELF_ADJUST_GAMES } from "./level_tools.ts";
import { dayText } from "./memberships.ts";
import { loadRating } from "./ratings.ts";
import { COMING_FROM, comingFrom } from "@kumi/i18n/presets";
import { brandColours } from "@kumi/ui/brand";
import { DARK_TILE, drawLogo, LOGO_MAX_BYTES, logoTile, readLogo } from "./logo.ts";

const isTimeZone = (v: string) => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } };
const timeZone = z.string().check(z.refine(isTimeZone, { message: "Not a time zone (use an IANA name such as America/Los_Angeles)" }));
const lang = z.enum(["en", "es"]);
/** A page on the club's own website (its terms, its privacy policy): http or https only, since members open it. */
export const pageUrl = z.url({ protocol: /^https?$/, hostname: z.regexes.domain }).check(z.maxLength(2000));
export const ROLE_KEYS = ["owner", "manager", "front_desk", "coach", "accountant", "member"] as const;
// A built-in role (ROLE_KEYS) or one the club made (custom_...).
const roleKey = z.string().check(z.minLength(1), z.maxLength(40));

/** How a field and its value are said: going to it ("the legal name to ..."), or going back ("the legal name goes
 *  back to ..."), with the words for a yes-or-no, a value not worth reading out, and an empty one. */
type Says = { to: Key; yes: Key; no: Key; plain?: Key; none?: Key };
const FORWARD: Says = { to: "plan.field_to", yes: "plan.field_yes", no: "plan.field_no" };
const BACK: Says = { to: "plan.field_back", yes: "plan.field_back_yes", no: "plan.field_back_no", plain: "plan.field_back_plain", none: "plan.field_back_none" };

/** "the name and the time zone", in each language. */
function fieldList(fields: string[], values?: Record<string, unknown>, currency = "USD", says = FORWARD): Text {
  const parts = fields.map((f) => {
    const name = both(`field.${f}` as Key), raw = values?.[f];
    // A yes-or-no setting reads "whether members book courts in the app (yes)"; the rest "the legal name to ...".
    if (values && typeof raw === "boolean") return both(raw ? says.yes : says.no, { field: name });
    if (values && says.none && (raw === null || raw === "")) return both(says.none, { field: name });
    const v = values ? shownValue(f, raw, currency) : null;
    return v ? both(says.to, { field: name, value: v }) : says.plain ? both(says.plain, { field: name }) : name;
  });
  return { en: parts.map((p) => p.en).join(", "), es: parts.map((p) => p.es).join(", ") };
}
/** A sentence ends once, even where the value it ends on has its own full stop ("Kestrel Padel Co."). */
const endOnce = (t: Text): Text => ({ en: t.en.replace(/\.\.$/, "."), es: t.es.replace(/\.\.$/, ".") });
/** What a club setting changes to, in words for its preview ("the legal name to Kestrel Padel LLC"), or null where a
 *  value isn't worth reading out (a long text, the other language's words, a code nobody reads). */
function shownValue(field: string, v: unknown, currency: string): Text | string | null {
  if (v === undefined || ["about", "translations", "two_factor"].includes(field)) return null;
  if (v === null || v === "") return both("plan.value_none");
  if (field === "coming_from" && typeof v === "string") return both(`preset.name_${comingFrom(v)}` as Key);
  if (field === "tax_rate_bp" && typeof v === "number") return `${(v / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  if (field.endsWith("_cents") && typeof v === "number") return { en: money(v, "en", currency), es: money(v, "es", currency) };
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 79)}...` : v;
  return null;
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
    // The software the club's staff used before (presets.ts): the staff app's words, menu order, first page and table
    // columns follow it. Words and order only, never what a role may see or do.
    coming_from: z.optional(z.enum(COMING_FROM).check(z.describe("The software the club's staff used before: the staff app uses its words, menu order, first page and table column order. none: openPadel's own plain words. Never changes what anyone may see or do."))),
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
    // A level a player brings from another app above this waits for staff (level_import.ts); at or below it, it starts.
    level_import_line: z.optional(z.number().check(z.minimum(0), z.maximum(7), z.describe("A level a player brings from another app above this waits for staff to check."))),
    // Who signs in with two steps. It can't be switched off here ('off' is for practice and test databases).
    two_factor: z.optional(z.enum(["owner_manager", "all_staff"]).check(z.describe("Who gives a second step (a passkey or an authenticator app) for the club's most sensitive changes, and at sign-in when second_step_sign_in is on: owners, managers and the club's own roles (owner_manager), or every staff role (all_staff)."))),
    // Whether those roles give it at every sign-in too (off: the emailed or texted code is enough to sign in). The owner's.
    second_step_sign_in: z.optional(z.boolean().check(z.describe("Staff in the roles two_factor names must give a second step at every sign-in, not only for sensitive changes. The owner's to change."))),
  }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "club", "singleton");
    const fields = changed(row, i);
    // How staff sign in is the owner's to say: a manager can't turn the second step at sign-in off (or on), or ask to.
    if (i.second_step_sign_in !== undefined && i.second_step_sign_in !== row.second_step_sign_in && ctx.actor.personId && !(await holdsRole(ctx.db, ctx.actor, ["owner"])))
      throw new KumiError("error.owner_only_setting", { field: both("field.second_step_sign_in") }, 403);
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
    // What each changes to, so whoever says yes reads the new value, not only which setting.
    const summary = endOnce(both("plan.club.update", { fields: fieldList(fields, i as Record<string, unknown>, cur) }));
    return { title: both("action.club.update"), summary: pausing ? { en: `${summary.en} ${both("plan.club.weekly_pause", { count: pausing }).en}`, es: `${summary.es} ${both("plan.club.weekly_pause", { count: pausing }).es}` } : summary,
      reads: [read], undo: { kind: "reversible" }, details: { fields } };
  },
  // Its undo says what goes back, as the change said what it changed to: "the legal name goes back to Kestrel Padel Co.".
  async undoSummary(changes) {
    const c = changes.find((x) => x.entity === "club" && x.op === "update");
    if (!c?.before) return null;
    const before = c.before as Record<string, unknown>, after = c.after as Record<string, unknown>;
    const fields = Object.keys(after).filter((k) => `field.${k}` in en && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (!fields.length) return null;
    return endOnce(both("plan.undo_fields", { fields: fieldList(fields, before, String(before.currency ?? "USD"), BACK) }));
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

/** Where a logo shows, in words for its preview: on the club's colour, on a tile, or on its own background. */
const logoWhere = (tile: string | null, backed: string | null): Text =>
  both(backed ? "plan.club.logo_on_own" : tile === null ? "plan.club.logo_on_colour" : tile === DARK_TILE ? "plan.club.logo_on_dark" : "plan.club.logo_on_light");
/** The preview's picture: the logo as a start screen shows it, on the club's colour (or its tile). */
const logoPicture = async (logo: { png: Buffer }, fill: string, tile: string | null) =>
  `data:image/png;base64,${(await drawLogo(logo, { w: 640, h: 400, bg: fill, tile, box: { size: 256, cx: 320, cy: 200 }, fit: 0.84 })).toString("base64")}`;

export const clubSetLogo = defineAction({
  name: "club.set_logo", version: 1, strongAuth: true,
  // The file as base64 (SVG, PNG or JPEG, at most 1 MB), or null to take the logo off. It's checked and drawn as a PNG
  // here (logo.ts); the file itself is never served, and it's taken out of the change's input once applied. logo_for:
  // the background the logo is made for (a light logo is for dark ones); null: as read from the logo; left out: as
  // the club has it now.
  input: z.object({
    logo: z.optional(z.nullable(z.string().check(z.maxLength(Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4), z.describe("The logo file as base64: SVG (shapes only, text turned into outlines), PNG or JPEG, at most 1 MB. null takes the logo off.")))),
    logo_for: z.optional(z.nullable(z.enum(["light", "dark"]).check(z.describe("The background the logo is made for: dark for a light logo, light for a dark one. null: read from the logo.")))),
  }),
  forget: ["logo"],
  async plan(ctx, i) {
    if (i.logo === undefined && i.logo_for === undefined) throw new KumiError("error.nothing_changed", {}, 400);
    const { row, read } = await readRow(ctx.db, "club", "singleton");
    const fill = brandColours(row.brand_colour)?.fill ?? row.brand_colour;
    const undo = { kind: "reversible" as const };
    if (i.logo === null) {
      if (!row.logo_id) throw new KumiError("error.nothing_changed", {}, 400);
      return { title: both("action.club.set_logo"), summary: both("plan.club.logo_off"), reads: [read], undo };
    }
    if (i.logo !== undefined) {
      const logo = await readLogo(Buffer.from(i.logo, "base64")), tile = logoTile(fill, logo, i.logo_for === undefined ? row.logo_for : i.logo_for);
      return { title: both("action.club.set_logo"), summary: both("plan.club.logo", { width: logo.width, height: logo.height, where: logoWhere(tile, logo.backed) }),
        reads: [read], undo, image: await logoPicture(logo, fill, tile), details: { width: logo.width, height: logo.height, seems_for: logo.seems_for, tile } };
    }
    // Only which background it's for.
    const logo = row.logo_id ? await ctx.db.selectFrom("club_logo").selectAll().where("id", "=", row.logo_id).executeTakeFirst() : undefined;
    if (!logo) throw new KumiError("error.logo_none", {}, 400);
    if ((i.logo_for ?? null) === row.logo_for) throw new KumiError("error.nothing_changed", {}, 400);
    const tile = logoTile(fill, logo, i.logo_for ?? null);
    return { title: both("action.club.set_logo"), summary: both(i.logo_for === "dark" ? "plan.club.logo_for_dark" : i.logo_for === "light" ? "plan.club.logo_for_light" : "plan.club.logo_for_read", { where: logoWhere(tile, logo.backed) }),
      reads: [read], undo, image: await logoPicture(logo, fill, tile) };
  },
  async apply(ctx, i) {
    if (i.logo === null) { await ctx.update("club", "singleton", { logo_id: null, logo_for: null }); await ctx.emit("club.updated", {}); return { logo_id: null }; }
    let patch: Record<string, unknown> = i.logo_for === undefined ? {} : { logo_for: i.logo_for };
    if (i.logo !== undefined) {
      // Straight into its table, not through the change log: the bytes would swamp it. The club's change is logged.
      const logo = await readLogo(Buffer.from(i.logo, "base64")), id = uuidv7();
      await ctx.trx.insertInto("club_logo").values({ id, png: logo.png, width: logo.width, height: logo.height, ink: logo.ink, backed: logo.backed,
        seems_for: logo.seems_for, source_sha256: logo.source_sha256, created_by: ctx.actor.personId }).execute();
      patch = { ...patch, logo_id: id };
    }
    await ctx.update("club", "singleton", patch); await ctx.emit("club.updated", {});
    return { logo_id: patch.logo_id ?? null };
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
  name: "person.create", version: 1, clubWide: true,
  input: z.object({ display_name: nameInput(), email: z.optional(z.email()), locale: z.optional(lang) }),
  async plan(ctx, i) {
    const email = i.email?.trim().toLowerCase();
    if (email && await ctx.db.selectFrom("person").select("id").where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).executeTakeFirst()) throw new KumiError("error.duplicate_email");
    const base = both("plan.person.create", { name: i.display_name, email: email ?? "-" });
    // An address of an account deleted here: they may be standing at the desk, so they can be added; what Playtomic holds
    // of the deleted account stays out until they sign in themselves (playtomic_erased.ts). Nothing of it is named.
    const marked = email ? (await erasedMatcher(ctx.db, { ids: [], emails: [email] }))({ email }) : false;
    const summary = marked ? { en: `${base.en} ${both("plan.person.create_erased").en}`, es: `${base.es} ${both("plan.person.create_erased").es}` } : base;
    return { title: both("action.person.create"), summary, reads: [], undo: { kind: "compensating" } };
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

/** Many members at once, from a spreadsheet. Anyone already here (by their Playtomic id, else their email) keeps their
 *  name and email, and gets only what's new in the file: a Playtomic id, a phone number when they have none, a yes to
 *  club news when they've never answered, and a Playtomic level as a provisional start while they're new here
 *  (level_import.ts). Nobody is emailed: telling members about the app is the club's own announcement. */
const importRow = z.object({ display_name: nameInput(80), email: z.optional(z.email()), locale: z.optional(lang),
  phone: z.optional(z.string().check(z.maxLength(40))),
  // Only a yes counts: a file that says no, or nothing, adds no consent.
  club_news: z.optional(z.boolean()),
  playtomic_id: z.optional(z.string().check(z.minLength(1), z.maxLength(64))),
  level: z.optional(z.object({ value: z.number().check(z.minimum(0), z.maximum(7)), reliability: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(100))) })) });
type ImportRow = z.infer<typeof importRow>;
export const personImport = defineAction({
  name: "person.import", version: 1,
  input: z.object({ rows: z.array(importRow).check(z.minLength(1), z.maxLength(5000)) }),
  async plan(ctx, i) {
    const p = await importPlan(ctx.db, i.rows);
    const people = both("count.people", { count: p.add.length });
    const already = both("count.already_here", { count: p.skipped });
    const base = !p.add.length && !p.skipped ? both("plan.person.import_nobody") : !p.skipped ? both("plan.person.import", { people })
      : p.add.length ? both("plan.person.import_skipped", { people, already }) : both("plan.person.import_none", { already });
    const more = ([[p.updated, "count.import_updated"], [p.levels, "count.import_levels"], [p.news, "count.import_news"], [p.phoneBad, "count.import_phone_bad"], [p.phoneTaken, "count.import_phone_taken"],
      [p.gone, "count.import_erased"]] as const)
      .filter(([n]) => n > 0).map(([n, k]) => both(k, { count: n }));
    const summary = more.length ? { en: `${base.en} ${more.map((m) => m.en).join(" ")}`, es: `${base.es} ${more.map((m) => m.es).join(" ")}` } : base;
    return { title: both("action.person.import"), summary, reads: [], undo: { kind: "compensating" }, details: { add: p.add.length, skipped: p.skipped, updated: p.updated, levels: p.levels } };
  },
  async apply(ctx, i) {
    const p = await importPlan(ctx.trx, i.rows);   // again, in case someone joined meanwhile
    const member = await ctx.trx.selectFrom("role").select("id").where("key", "=", "member").executeTakeFirstOrThrow();
    const date = dayText(localDate(ctx.now, (await ctx.trx.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone));
    for (const r of p.rows) {
      let id = r.personId;
      if (!id) {
        id = uuidv7();
        await ctx.insert("person", { id, display_name: r.row.display_name.trim(), email: r.email ?? null, phone: r.phone, locale: r.row.locale ?? "en", created_via: "import" });
        if (r.email) await ctx.trx.insertInto("auth_identity").values({ id: uuidv7(), person_id: id, kind: "email", value: r.email, verified_at: null }).execute();
        await ctx.insert("person_role", { id: uuidv7(), person_id: id, role_id: member.id, location_id: null });
      } else if (r.phone) await ctx.update("person", id, { phone: r.phone });
      if (r.link) await ctx.trx.insertInto("external_ref").values({ entity: "person", entity_id: id, system: "playtomic", external_id: r.row.playtomic_id! }).execute();
      if (r.news) await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: id, channel: "email", purpose: "club_news", granted: true, source: "import", form_version: null,
        evidence: JSON.stringify({ via: "import", by: ctx.actor.personId }), at: ctx.now }).execute();
      if (r.level) {
        const conf = r.level.reliability !== undefined ? { reliability: r.level.reliability } : {};
        await writeImport(ctx, id, { platform: "playtomic", raw: r.level.value, conf, start_level: r.level.value, sigma: startSigma("playtomic", "club_data", conf)!, evidence: "club_data",
          external_id: r.row.playtomic_id ?? null }, both("level_import.how_club", { date }), ctx.actor.personId);
      }
    }
    await ctx.emit("person.imported", { count: p.add.length });
    return { added: p.add.length, ...(p.updated ? { updated: p.updated } : {}), ...(p.levels ? { levels: p.levels } : {}) };
  },
});
/** What each line of the file does: a new person, or one already here and what they get from it. */
async function importPlan(db: Db | Trx, rows: ImportRow[]) {
  const country = (await db.selectFrom("club").select("country").executeTakeFirstOrThrow()).country;
  const emails = [...new Set(rows.map((r) => r.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e)))];
  const ids = [...new Set(rows.map((r) => r.playtomic_id?.trim()).filter((e): e is string => Boolean(e)))];
  const byEmail = new Map(emails.length ? (await db.selectFrom("person").select(["id", sql<string>`lower(email)`.as("e")]).where(sql<string>`lower(email)`, "in", emails).execute()).map((r) => [r.e, r.id]) : []);
  const byPt = new Map(ids.length ? (await db.selectFrom("external_ref").select(["external_id", "entity_id"]).where("system", "=", "playtomic").where("entity", "=", "person").where("external_id", "in", ids).execute()).map((r) => [r.external_id, r.entity_id]) : []);
  const seenEmail = new Set<string>(), seenPt = new Set<string>(), seenPhone = new Set<string>();
  // A line for an account deleted here (by its Playtomic id or address, playtomic_erased.ts) is left out, counted and
  // never named: an import is staff's act, and never brings someone back (only their own act does).
  const erased = await erasedMatcher(db, { ids, emails });
  let gone = 0;
  const out: { row: ImportRow; personId: string | null; email?: string; phone: string | null; link: boolean; news: boolean; level: ImportRow["level"] | null }[] = [];
  let skipped = 0, updated = 0, phoneBad = 0, phoneTaken = 0, levels = 0, news = 0;
  for (const row of rows) {
    const email = row.email?.trim().toLowerCase(), pt = row.playtomic_id?.trim();
    if ((email && seenEmail.has(email)) || (pt && seenPt.has(pt))) { skipped++; continue; }   // the same person twice in the file
    if (erased({ id: pt ?? null, email: email ?? null })) { gone++; continue; }
    if (email) seenEmail.add(email);
    if (pt) seenPt.add(pt);
    const personId = (pt ? byPt.get(pt) : undefined) ?? (email ? byEmail.get(email) : undefined) ?? null;
    const p = personId ? await db.selectFrom("person").select(["phone", "junior"]).where("id", "=", personId).executeTakeFirstOrThrow() : null;
    // A phone number, read in the club's country; only for someone with none, and nobody else's.
    let phone: string | null = null;
    if (row.phone?.trim() && !p?.junior && !p?.phone) {
      const e164 = anyPhone(row.phone, country);
      if (!e164) phoneBad++;
      else if (seenPhone.has(e164) || await db.selectFrom("person").select("id").where("phone", "=", e164).$if(Boolean(personId), (q) => q.where("id", "!=", personId!)).executeTakeFirst()) phoneTaken++;
      else { phone = e164; seenPhone.add(e164); }
    }
    const link = Boolean(pt) && !(personId && byPt.get(pt!) === personId)
      && !(personId && await db.selectFrom("external_ref").select("external_id").where("system", "=", "playtomic").where("entity", "=", "person").where("entity_id", "=", personId).executeTakeFirst());
    const yes = row.club_news === true && !(personId && await db.selectFrom("channel_consent").select("id").where("person_id", "=", personId).where("purpose", "=", "club_news").executeTakeFirst());
    // A Playtomic level: a provisional start for someone new here; again only if it changed and they haven't played yet.
    let level: ImportRow["level"] | null = null;
    if (row.level) {
      if (!personId) level = row.level;
      else {
        const r = await loadRating(db, personId), had = (await activeImports(db, personId)).find((x) => x.factors.platform === "playtomic");
        if (r.games < SELF_ADJUST_GAMES && (!had || (r.games === 0 && Number(had.factors.raw) !== row.level.value))) level = row.level;
      }
    }
    if (level) levels++;
    if (yes) news++;
    if (personId && !(phone || link || yes || level)) { skipped++; continue; }
    if (personId) updated++;
    out.push({ row, personId, ...(email ? { email } : {}), phone, link, news: yes, level });
  }
  return { rows: out, add: out.filter((r) => !r.personId), skipped, updated, phoneBad, phoneTaken, levels, news, gone };
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
    // Their own act: someone whose account here was deleted, signing up again, comes back from today (playtomic_erased.ts).
    await markRejoined(ctx.trx, id, ctx.now);
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
    // Proven by the person themselves (not staff at the desk): an address of a deleted account comes back from now.
    if (!i.by || i.by === i.person_id) await markRejoined(ctx.trx, i.person_id, ctx.now);
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
    // Proven by the person themselves (not staff at the desk): an address of a deleted account comes back from now.
    if (!i.by || i.by === i.person_id) await markRejoined(ctx.trx, i.person_id, ctx.now);
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
    // An assistant they connected before keeps the reach they allowed it then (assistant_reach.ts): a wider role
    // reaches through it only once they allow it again.
    return { title: both("action.role.assign"), summary: both("plan.role.assign", { person: person.display_name, role: await roleLabel(ctx.db, i.role), where: await whereText(ctx, i.location_id) }), reads: [read], locationId: i.location_id ?? null, undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("person_role", { id, person_id: i.person_id, role_id: await roleId(ctx, i.role), location_id: i.location_id ?? null });
    await ctx.emit("role.assigned", { person_id: i.person_id, role: i.role, location_id: i.location_id ?? null, by: ctx.actor.personId ?? null });
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
  owners: (db, i) => withManagers(db, [i.person_id]),   // "nothing changed" would tell someone else's name or language
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
  owners: async (_db, i) => [i.person_id],
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
