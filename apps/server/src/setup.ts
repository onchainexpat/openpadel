// Setting a club up from club.yaml: the club and its owner, its currency, locations (with their opening hours and one
// simple court price), courts and staff. `plan` says what
// would change and changes nothing; `apply` makes the changes through the same actions the apps use, so
// each one is checked, audited and can be undone. Running it again only adds what's new: nothing in the
// file removes or renames anything (that's done in the staff app, where the preview shows what it affects).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import * as z from "zod/mini";
import { parse } from "yaml";
import { both, currencyProblem, fromMajor, money, type Key, type Lang, type Text } from "@kumi/i18n";
import { assistantNameInput, clubPhone, hoursText, KumiError, pageUrl, readLogo, run, runAsSystem, type Actor, type Db } from "@kumi/core";
import { COMING_FROM, DEFAULT_COMING_FROM } from "@kumi/i18n/presets";
import { AMENITIES } from "@kumi/i18n/amenities";

const name = z.string().check(z.minLength(1));
/** The weekdays as club.yaml names them; each one's place is its number (0 is Sunday), as the hours actions take them. */
export const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const clock = z.string().check(z.regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "a time like 07:00 or 22:30"));
// A location's opening hours: the days each line covers, and its times. A day no line names is closed.
const hours = z.array(z.object({ days: z.array(z.enum(WEEKDAY_NAMES)).check(z.minLength(1)), opens: clock, closes: clock })).check(z.minLength(1), z.maxLength(7));
const court = z.union([name, z.object({ name, kind: z.optional(z.enum(["indoor", "covered_outdoor", "outdoor"])) })]);
// For registering texting with US carriers (`kumi texting`, texting.ts): the business as it's registered. Every
// field is optional here; `kumi texting plan` says which are still missing. No keys: those stay in the settings file.
export const TextingDetails = z.object({
  number: z.optional(z.string().check(z.regex(/^\+1\d{10}$/))),
  business_name: z.optional(name),
  doing_business_as: z.optional(name),
  business_type: z.optional(z.enum(["private_profit", "public_profit", "non_profit", "government", "sole_proprietor"])),
  registration_number: z.optional(name),
  website: z.optional(z.url()),
  privacy_policy_url: z.optional(z.url()),
  terms_url: z.optional(z.url()),
  address: z.optional(z.object({ street: name, street2: z.optional(z.string()), city: name, state: name, postal_code: name, country: z.optional(z.enum(["US", "CA"])) })),
  contact: z.optional(z.object({ first_name: name, last_name: name, email: z.email(), phone: z.string().check(z.regex(/^\+\d{8,15}$/)) })),
  notification_email: z.optional(z.email()),
  monthly_texts: z.optional(z.number().check(z.int(), z.minimum(1))),
  opt_in_image_urls: z.optional(z.array(z.url())),
  use_case_summary: z.optional(z.string().check(z.minLength(40), z.maxLength(1000))),
  // Texting through a host's Twilio account: the club's own Secondary Customer Profile in Twilio's Trust Hub, if the
  // host made one (docs/setup/accounts/twilio.md).
  customer_profile_sid: z.optional(z.string().check(z.regex(/^BU[0-9a-f]{32}$/))),
});
export type TextingDetails = z.infer<typeof TextingDetails>;
export const ClubFile = z.object({
  // The club's own terms and privacy policy for members, on its website (docs/templates): the app links them.
  // staff_second_step: owners, managers and the club's own roles give a second step at every sign-in (Settings, "Sign-in
  // and roles"); left out, the club's setting stays as it is (off for a new club).
  // coming_from: the software staff used before (none or playtomic), for the staff app's words, menu order and first
  // page; brand_colour: the club's colour (#rrggbb) in both apps. Left out, each stays as it is. logo: a path to the
  // club's logo (SVG, PNG or JPEG, from the file's own folder when it's relative) and logo_for: the background it's
  // made for (light or dark; left out, read from the logo). Left out, the logo stays as it is. phone, website and
  // amenities: how members reach the club and what it has (keys from AMENITIES), set when the club has none yet.
  // assistant_name: what staff and members call the club's AI assistant ("Ask Kumi"); left out, it stays as it is (the
  // install's name, openPadel or Kumi, for a new club).
  // currency: the club's currency as its three-letter code (USD, the default, EUR, GBP, MXN...); set while the club has
  // taken no payment (Stripe can't convert what's already paid).
  club: z.object({ currency: z.optional(z.string().check(z.regex(/^[A-Za-z]{3}$/, "a three-letter code like USD or EUR"))), phone: z.optional(z.string().check(z.minLength(1), z.maxLength(40))), website: z.optional(pageUrl), amenities: z.optional(z.array(z.enum(AMENITIES))), logo: z.optional(name), logo_for: z.optional(z.enum(["light", "dark"])), name, time_zone: name, default_language: z.optional(z.enum(["en", "es"])), terms_url: z.optional(pageUrl), privacy_policy_url: z.optional(pageUrl),
    staff_second_step: z.optional(z.boolean()), coming_from: z.optional(z.enum(COMING_FROM)), brand_colour: z.optional(z.string().check(z.regex(/^#[0-9A-Fa-f]{6}$/, "a colour like #0B5A55"))),
    assistant_name: z.optional(assistantNameInput) }),
  owner: z.object({ name, email: z.email() }),
  // hours: the location's opening hours (set when it has none yet). price_per_hour: one price for every court there, every
  // day at every hour, in the club's currency (a rule set when the location has no prices yet; peak times and member
  // prices are added in the staff app's Settings).
  locations: z.optional(z.array(z.object({ name, address: z.optional(z.string()), time_zone: z.optional(name), courts: z.optional(z.array(court)),
    hours: z.optional(hours), price_per_hour: z.optional(z.number().check(z.minimum(0), z.maximum(100000))) }))),
  staff: z.optional(z.array(z.object({ name, email: z.email(), role: z.enum(["owner", "manager", "front_desk", "coach", "accountant"]), location: z.optional(name) }))),
  texting: z.optional(TextingDetails),
});
export type ClubFile = z.infer<typeof ClubFile>;

export class ClubFileError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(problems.join("; ")); this.problems = problems; }
}

/** Read and check club.yaml; every problem is listed with where it is in the file. */
export function readClubFile(path: string): ClubFile {
  let raw: unknown;
  try { raw = parse(readFileSync(path, "utf8")); } catch (e) { throw new ClubFileError([(e as Error).message.split("\n")[0]!]); }
  const r = ClubFile.safeParse(raw);
  if (!r.success) throw new ClubFileError(r.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`));
  const tzs = [r.data.club.time_zone, ...(r.data.locations ?? []).map((l) => l.time_zone).filter((t): t is string => Boolean(t))];
  const bad = tzs.filter((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return false; } catch { return true; } });
  if (bad.length) throw new ClubFileError(bad.map((tz) => `time_zone: "${tz}" isn't a time zone (use a name like America/Los_Angeles)`));
  const cur = r.data.club.currency?.toUpperCase();
  if (cur && currencyProblem(cur)) throw new ClubFileError([`club.currency: ${cur} isn't a currency openPadel takes (use a three-letter code like USD, EUR or GBP)`]);
  if (cur) r.data.club.currency = cur;
  for (const [n, l] of (r.data.locations ?? []).entries()) {
    const problems: string[] = [], seen = new Set<string>();
    for (const [k, h] of (l.hours ?? []).entries()) {
      if (h.closes <= h.opens) problems.push(`locations.${n}.hours.${k}: closes (${h.closes}) must be after opens (${h.opens})`);
      for (const d of h.days) { if (seen.has(d)) problems.push(`locations.${n}.hours.${k}: ${d} is in two lines`); seen.add(d); }
    }
    if (problems.length) throw new ClubFileError(problems);
  }
  // The logo's path, from the file's own folder.
  if (r.data.club.logo) {
    const at = resolve(dirname(path), r.data.club.logo);
    if (!existsSync(at)) throw new ClubFileError([`club.logo: there's no file at ${at}`]);
    r.data.club.logo = at;
  }
  return r.data;
}

/** The club's first owner, acting from the server itself: what kumi's commands run as after setup. */
export async function ownerActor(db: Db, lang: Lang): Promise<Actor | null> {
  const o = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.person_id")
    .where("role.key", "=", "owner").where("person_role.active", "=", true).orderBy("person_role.id").executeTakeFirst();
  return o ? { personId: o.person_id, via: "setup", lang, auth: "system" } : null;
}

export interface Step { action: string; text: Text }
export interface SetupResult { steps: Step[]; notes: Text[]; applied: boolean }
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export async function setupClub(db: Db, file: ClubFile, opts: { apply: boolean; lang: Lang }): Promise<SetupResult> {
  const steps: Step[] = [], notes: Text[] = [];
  // In a plan nothing runs; in apply each step runs as it's listed, so later steps can use what earlier ones made.
  const step = async <T>(action: string, text: Text, go: () => Promise<T>): Promise<T | null> => { steps.push({ action, text }); return opts.apply ? go() : null; };
  const ok = <T>(r: { status: string; result: unknown }) => { if (r.status !== "planned") throw new Error(`needs approval: ${r.status}`); return r.result as T; };

  const club = await db.selectFrom("club").selectAll().executeTakeFirst();
  let ownerId: string | null = null;
  if (!club) {
    const r = await step("club.setup", both("cli.step.club_setup", { name: file.club.name, tz: file.club.time_zone, owner: file.owner.name, email: file.owner.email }),
      () => runAsSystem(db, "club.setup", { name: file.club.name, time_zone: file.club.time_zone, owner_email: file.owner.email, owner_name: file.owner.name, default_language: file.club.default_language }, "setup"));
    ownerId = (r?.result as { owner_person_id?: string } | null)?.owner_person_id ?? null;
  } else {
    if (!same(club.name, file.club.name)) notes.push(both("cli.note.club_exists", { have: club.name }));
    const owners = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").innerJoin("person", "person.id", "person_role.person_id")
      .select(["person.id", "person.email"]).where("role.key", "=", "owner").where("person_role.active", "=", true).execute();
    const named = owners.find((o) => o.email && same(o.email, file.owner.email));
    if (!named) notes.push(both("cli.note.owner_missing", { email: file.owner.email }));
    ownerId = (named ?? owners[0])?.id ?? null;
  }
  // Everything after the club is done as its owner. The command runs on the server itself, with the
  // database's own access, so it counts as a strong sign-in.
  const owner: Actor = { personId: ownerId, via: "setup", lang: opts.lang, auth: "system" };
  const tz = file.club.time_zone;

  // The currency, when the file names one that isn't the club's (a new club starts in US dollars). Once the club has taken a
  // payment it can't change (club.update refuses it): the plan says so instead.
  const currency = file.club.currency;
  const hadCurrency = club ? (await db.selectFrom("club").select("currency").executeTakeFirstOrThrow()).currency : "USD";
  if (currency && currency !== hadCurrency.toUpperCase()) {
    if (club && await db.selectFrom("payment").select("id").limit(1).executeTakeFirst()) notes.push(both("cli.note.currency_paid", { have: hadCurrency, want: currency }));
    else await step("club.update", both("cli.step.currency", { currency }), async () => ok(await run(db, "club.update", { currency }, owner)));
  }
  const inCurrency = currency ?? hadCurrency;

  // The terms and privacy links: set when the club has none yet. Older files named them only under texting, so
  // those count too. A club that has its own already changes them in Settings.
  const have = club ? await db.selectFrom("club").select(["terms_url", "privacy_policy_url"]).executeTakeFirstOrThrow() : { terms_url: null, privacy_policy_url: null };
  const want = { terms_url: file.club.terms_url ?? file.texting?.terms_url, privacy_policy_url: file.club.privacy_policy_url ?? file.texting?.privacy_policy_url };
  const links: { terms_url?: string; privacy_policy_url?: string } = {};
  for (const k of ["terms_url", "privacy_policy_url"] as const) {
    const w = want[k];
    if (!w || w === have[k]) continue;
    if (have[k]) notes.push(both("cli.note.policies_differ", { field: both(`field.${k}`) }));
    else if (pageUrl.safeParse(w).success) links[k] = w;
  }
  if (links.terms_url || links.privacy_policy_url) await step("club.update", both("cli.step.club_policies", { links: [links.terms_url, links.privacy_policy_url].filter(Boolean).join(", ") }),
    async () => ok(await run(db, "club.update", links, owner)));
  // The club's phone, website and amenities: each set when the club has none yet (older files named the website only
  // under texting, so that counts too); one the club has already changes in Settings.
  const reach = club ? await db.selectFrom("club").select(["phone", "website", "amenities", "country"]).executeTakeFirstOrThrow() : { phone: null, website: null, amenities: [] as string[], country: "US" };
  const contact: { phone?: string; website?: string; amenities?: string[] } = {};
  const wantPhone = file.club.phone, wantSite = file.club.website ?? file.texting?.website;
  if (wantPhone) {
    const p = clubPhone(wantPhone, reach.country ?? "US");
    if (!p) throw new KumiError("error.club_phone_bad", { phone: wantPhone }, 400);
    if (reach.phone && reach.phone !== p) notes.push(both("cli.note.policies_differ", { field: both("field.phone") }));
    else if (!reach.phone) contact.phone = p;
  }
  if (wantSite && wantSite !== reach.website) {
    if (reach.website) notes.push(both("cli.note.policies_differ", { field: both("field.website") }));
    else if (pageUrl.safeParse(wantSite).success) contact.website = wantSite;
  }
  if (file.club.amenities?.length) {
    if (reach.amenities.length && [...reach.amenities].sort().join() !== [...new Set(file.club.amenities)].sort().join()) notes.push(both("cli.note.policies_differ", { field: both("field.amenities") }));
    else if (!reach.amenities.length) contact.amenities = [...new Set(file.club.amenities)];
  }
  if (Object.keys(contact).length) await step("club.update", both("cli.step.club_contact", { what: [contact.phone, contact.website, contact.amenities?.join(", ")].filter(Boolean).join("; ") }),
    async () => ok(await run(db, "club.update", contact, owner)));
  // The second step at sign-in, when the file says and the club differs (a new club starts with it off).
  const secondStep = file.club.staff_second_step;
  const hadSecondStep = club ? (await db.selectFrom("club").select("second_step_sign_in").executeTakeFirstOrThrow()).second_step_sign_in : false;
  if (secondStep !== undefined && secondStep !== hadSecondStep) await step("club.update", both(secondStep ? "cli.step.second_step_on" : "cli.step.second_step_off"),
    async () => ok(await run(db, "club.update", { second_step_sign_in: secondStep }, owner)));
  // The software staff used before and the brand colour, each when the file names one that differs from the club's
  // (so, like staff_second_step, the file wins again over a later change in Settings: the plan shows it first).
  const look = club ? await db.selectFrom("club").select(["coming_from", "brand_colour", "assistant_name"]).executeTakeFirstOrThrow() : { coming_from: DEFAULT_COMING_FROM, brand_colour: "#0B5A55", assistant_name: null };
  const from = file.club.coming_from;
  if (from !== undefined && from !== look.coming_from) await step("club.update", both("cli.step.coming_from", { name: both(`preset.name_${from}`) }),
    async () => ok(await run(db, "club.update", { coming_from: from }, owner)));
  const colour = file.club.brand_colour;
  if (colour !== undefined && colour.toLowerCase() !== look.brand_colour.toLowerCase()) await step("club.update", both("cli.step.brand_colour", { colour }),
    async () => ok(await run(db, "club.update", { brand_colour: colour }, owner)));
  // The assistant's name, the same way: set again by each apply while the file names one.
  const named = file.club.assistant_name;
  if (named !== undefined && named !== look.assistant_name) await step("club.update", both("cli.step.assistant_name", { name: named }),
    async () => ok(await run(db, "club.update", { assistant_name: named }, owner)));

  // The logo, when the file names one that isn't the club's logo already (the same file, and made for the same
  // background). It's checked in the plan too, so a logo that can't be used says why before anything is applied.
  if (file.club.logo) {
    const bytes = readFileSync(file.club.logo), sha = createHash("sha256").update(bytes).digest("hex");
    const now = club?.logo_id ? await db.selectFrom("club_logo").select("source_sha256").where("id", "=", club.logo_id).executeTakeFirst() : undefined;
    // logo_for left out of the file leaves the club's choice (Settings) as it is.
    const forWhat = file.club.logo_for;
    if (now?.source_sha256 !== sha || (forWhat !== undefined && forWhat !== (club?.logo_for ?? null))) {
      if (!opts.apply) await readLogo(bytes);
      await step("club.set_logo", both("cli.step.logo", { file: basename(file.club.logo) }),
        async () => ok(await run(db, "club.set_logo", { logo: bytes.toString("base64"), ...(forWhat ? { logo_for: forWhat } : {}) }, owner)));
    }
  }

  const locations = club ? await db.selectFrom("location").select(["id", "name"]).where("archived_at", "is", null).execute() : [];
  const locationIds = new Map<string, string | null>();
  for (const l of file.locations ?? []) {
    const have = locations.find((x) => same(x.name, l.name));
    let id = have?.id ?? null;
    if (!have) {
      const r = await step("location.create", both("plan.location.create", { name: l.name, tz: l.time_zone ?? tz }),
        () => run(db, "location.create", { name: l.name, time_zone: l.time_zone ?? tz, address: l.address }, owner));
      id = r ? ok<{ location_id: string }>(r).location_id : null;
    }
    locationIds.set(l.name.toLowerCase(), id);
    const courts = id && have ? await db.selectFrom("court").select("name").where("location_id", "=", id).execute() : [];
    for (const c of l.courts ?? []) {
      const cname = typeof c === "string" ? c : c.name, kind = typeof c === "string" ? undefined : c.kind;
      if (courts.some((x) => same(x.name, cname))) continue;
      await step("court.create", both("plan.court.create", { name: cname, location: l.name }),
        async () => ok(await run(db, "court.create", { location_id: locationIds.get(l.name.toLowerCase())!, name: cname, kind }, owner)));
    }
    const where = () => locationIds.get(l.name.toLowerCase())!;
    // The opening hours, when the location has none yet; hours it has already change in Settings.
    if (l.hours) {
      const days = WEEKDAY_NAMES.map((_, w) => { const h = l.hours!.find((x) => x.days.includes(WEEKDAY_NAMES[w]!)); return { weekday: w, opens: h?.opens ?? null, closes: h?.closes ?? null }; });
      const had = id && have ? await db.selectFrom("opening_hours").select(["weekday", "opens", "closes"]).where("location_id", "=", id).where("opens", "is not", null).execute() : [];
      const hhmm = (v: unknown) => (v ? String(v).slice(0, 5) : null);
      const differs = days.some((d) => { const x = had.find((h) => h.weekday === d.weekday); return (x ? hhmm(x.opens) : null) !== d.opens || (x ? hhmm(x.closes) : null) !== d.closes; });
      if (!had.length) await step("hours.set", both("cli.step.hours", { location: l.name, hours: { en: hoursText(days, "en"), es: hoursText(days, "es") } }),
        async () => ok(await run(db, "hours.set", { location_id: where(), days }, owner)));
      else if (differs) notes.push(both("cli.note.hours_differ", { location: l.name }));
    }
    // One price for every court, every day at every hour, when the location has no prices yet.
    if (l.price_per_hour !== undefined) {
      const cents = fromMajor(l.price_per_hour, inCurrency);
      const rules = id && have ? await db.selectFrom("price_rule").select("cents_per_hour").where("location_id", "=", id).where("active", "=", true).execute() : [];
      const amount = { en: money(cents, "en", inCurrency), es: money(cents, "es", inCurrency) };
      const lang = file.club.default_language ?? "en", other = lang === "en" ? "es" : "en";
      const names = { en: "Court time", es: "Tiempo de cancha" };
      if (!rules.length) await step("price.rule_set", both("cli.step.price", { location: l.name, amount }),
        async () => ok(await run(db, "price.rule_set", { location_id: where(), name: names[lang], translations: { [other]: { name: names[other] } }, cents_per_hour: cents }, owner)));
      else if (!rules.some((r) => r.cents_per_hour === cents)) notes.push(both("cli.note.prices_differ", { location: l.name }));
    }
  }

  for (const s of file.staff ?? []) {
    const person = club ? await db.selectFrom("person").select(["id", "display_name"]).where((eb) => eb(eb.fn("lower", ["email"]), "=", s.email.trim().toLowerCase())).executeTakeFirst() : undefined;
    let pid = person?.id ?? null;
    if (!person) {
      const r = await step("person.create", both("plan.person.create", { name: s.name, email: s.email }),
        () => run(db, "person.create", { display_name: s.name, email: s.email, locale: file.club.default_language }, owner));
      pid = r ? ok<{ person_id: string }>(r).person_id : null;
    }
    // A location from this same file counts even before it exists (in a plan, its id is still null).
    const key = s.location?.toLowerCase(), fromFile = key !== undefined && locationIds.has(key);
    const at = key ? locationIds.get(key) ?? (await db.selectFrom("location").select("id").where((eb) => eb(eb.fn("lower", ["name"]), "=", key)).executeTakeFirst())?.id : undefined;
    if (s.location && !fromFile && at === undefined) { notes.push(both("cli.note.no_location", { location: s.location, person: s.name })); continue; }
    const hasRole = pid && person ? await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id")
      .where("person_role.person_id", "=", pid).where("role.key", "=", s.role).where("person_role.active", "=", true)
      .$if(Boolean(at), (q) => q.where("person_role.location_id", "=", at!)).$if(!at, (q) => q.where("person_role.location_id", "is", null)).executeTakeFirst() : undefined;
    if (hasRole) continue;
    await step("role.assign", both("plan.role.assign", { person: s.name, role: both(`role.${s.role}` as Key), where: s.location ? both("where.at", { location: s.location }) : both("where.everywhere") }),
      async () => ok(await run(db, "role.assign", { person_id: pid!, role: s.role, location_id: at ?? undefined }, owner)));
  }
  return { steps, notes, applied: opts.apply };
}
