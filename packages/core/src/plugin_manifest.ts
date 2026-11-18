// A plugin's manifest, openpadel-plugin.json (docs/plugins/manifest.md): everything it asks of the club, declared up
// front and checked strictly. A plugin is a separate program that acts only through the door, so the manifest is what
// the club agrees to: the actions it may plan and the parts of the club it reads (its role), the events it gets, the
// keys it needs from the vault, its settings, what member data it sends where, what it costs, the cards it shows,
// where its health is checked, and how it runs (remote, at its publisher's address; or local, a pinned release on the
// club's own server). Anything else in the file, or anything missing, and it isn't installed.
import { createHash } from "node:crypto";
import * as z from "zod/mini";
import { both, type Key, type Text } from "@kumi/i18n";
import { actions, appOnly, getAction } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { specificity } from "./permissions.ts";
import { AREAS, areaOf, grantableActions } from "./roles.ts";
import { WEBHOOK_TOPICS, WEBHOOK_TOPIC_NAMES } from "./webhooks.ts";

export const MANIFEST_FILE = "openpadel-plugin.json";
export const MANIFEST_MAX_BYTES = 64_000;
/** Where a plugin may show a card (Round C renders them): a game's page, a court's tile on Today, a member's profile,
 *  the Money page, the Connectors page. */
export const CARD_SLOTS = ["game", "court_tile", "member_profile", "money", "connectors"] as const;
/** The message channels a plugin may send for the club (whatsapp.ts). */
export const CHANNEL_KINDS = ["whatsapp"] as const;
export const AREA_KEYS = AREAS.map((a) => a.key) as [string, ...string[]];
/** What no plugin is ever given, whatever its manifest says: making or changing agents, plugins, webhooks, the vault,
 *  roles, assistants and support access. Its own webhook and keys come with it, through plugin.* actions a person
 *  confirms. (Most of these aren't in a club's role anyway; this says so even if a club's manager role changes.) */
export const PLUGIN_NEVER = ["agent.*", "plugin.*", "webhook.*", "vault.*", "role.*", "assistant.*", "support.*", "privacy.*", "club.*"];

const noDash = (s: string) => !/[\u2014\u2013]/.test(s);
/** No control characters (a line break, a tab, C0 or C1): every field is one line of words, and none can start a new
 *  line in anything it's written into (a service's unit file, a header, a log). */
const oneLine = (s: string) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s);
const words = (max: number) => z.string().check(z.minLength(1), z.maxLength(max), z.refine(noDash, "no em or en dashes"), z.refine(oneLine, "one line, no control characters"));
/** Words in both of the club's languages. */
const text = (max = 300) => z.strictObject({ en: words(max), es: words(max) });
/** Words in both languages under the manifest's rules (one line, no dashes, a length cap), for what a plugin sends at
 *  run time too (its cards, plugin_cards.ts). */
export const bothWords = text;
const httpUrl = z.string().check(z.maxLength(500), z.refine(oneLine, "one line, no control characters"), z.refine((s) => { try { const u = new URL(s); return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !u.hash; } catch { return false; } }, "an http(s) address"));
const settingKey = z.string().check(z.regex(/^[a-z][a-z0-9_]{0,39}$/));
const common = { key: settingKey, label: text(80), help: z.optional(text(300)), required: z.optional(z.boolean()) };

const settingField = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("string"), ...common, default: z.optional(z.string().check(z.maxLength(500))), max_length: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
    // The one address on the club's own network a local plugin may reach (club_network.ts): at most one per manifest.
    club_network: z.optional(z.boolean()) }),
  z.strictObject({ type: z.literal("integer"), ...common, default: z.optional(z.number().check(z.int())), minimum: z.optional(z.number().check(z.int())), maximum: z.optional(z.number().check(z.int())) }),
  z.strictObject({ type: z.literal("boolean"), key: settingKey, label: text(80), help: z.optional(text(300)), default: z.optional(z.boolean()) }),
  z.strictObject({ type: z.literal("choice"), ...common, default: z.optional(z.string()),
    choices: z.array(z.strictObject({ value: z.string().check(z.regex(/^[a-z0-9_-]{1,40}$/)), label: text(80) })).check(z.minLength(2), z.maxLength(30)) }),
  z.strictObject({ type: z.literal("courts"), ...common }),
]);
export type SettingField = z.infer<typeof settingField>;

const run = z.discriminatedUnion("mode", [
  // Remote: it runs at its publisher's address. The club POSTs its registration to <url>/register, events to
  // <url>/events and what arrives at /plugins/<name>/hook to <url>/hook.
  z.strictObject({ mode: z.literal("remote"), url: httpUrl }),
  // Local: a release pinned by its SHA-256, run as its own service on the club's server: <entry> from the unpacked
  // archive (a systemd unit), or `image`, pinned by digest, on a Docker install.
  z.strictObject({ mode: z.literal("local"), release_url: httpUrl, sha256: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
    entry: z.string().check(z.regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,120}$/)),
    image: z.optional(z.string().check(z.regex(/^[a-z0-9][a-z0-9./_-]{0,200}(:[\w.-]{1,60})?@sha256:[0-9a-f]{64}$/))) }),
]);

export const manifestSchema = z.strictObject({
  $schema: z.optional(z.string().check(z.maxLength(300), z.refine(oneLine, "one line, no control characters"))),
  manifest_version: z.literal(1),
  name: z.string().check(z.regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/)),
  publisher: words(80),
  version: z.string().check(z.regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.-]{1,40})?$/)),
  homepage: httpUrl,
  licence: z.string().check(z.regex(/^[A-Za-z0-9.+() -]{2,80}$/)),
  description: text(500),
  /** Its role: the actions it may plan, each outright or asking a person first. */
  grants: z.array(z.strictObject({ action: z.string().check(z.regex(/^[a-z_]+\.[a-z_]+$/)), mode: z.enum(["allow", "ask"]), scope: z.optional(z.enum(["any", "own"])) })).check(z.maxLength(100)),
  /** And the parts of the club it reads (roles.ts AREAS) beyond what its actions cover. */
  reads: z.array(z.enum(AREA_KEYS)).check(z.maxLength(AREA_KEYS.length)),
  events: z.array(z.enum(WEBHOOK_TOPIC_NAMES as [string, ...string[]])).check(z.maxLength(WEBHOOK_TOPIC_NAMES.length)),
  secrets: z.array(z.strictObject({ name: z.string().check(z.regex(/^[A-Z][A-Z0-9_]{1,63}$/)), label: text(80), where: text(300),
    /** Not asked of the owner when it's installed: one the plugin needs only in some setups (a QuickBooks key, for a
     *  club on Xero), and says on its card when it's missing. */
    optional: z.optional(z.boolean()),
    /** Asked of the owner only when one of the plugin's settings has this value (its Xero keys, when the accounting
     *  system chosen is Xero); not asked otherwise, like an optional one. */
    needed_when: z.optional(z.strictObject({ setting: settingKey, is: z.union([z.string().check(z.maxLength(200)), z.boolean(), z.number()]) })),
    /** The plugin's own to write (plugin.secret_keep): a key it's handed and that changes as it's used, such as an
     *  OAuth refresh token. Never asked of the owner; shown as "kept by <plugin>". */
    kept_by_plugin: z.optional(z.boolean()) })).check(z.maxLength(20)),
  /** Its options, in the order a person sets them. */
  settings: z.array(settingField).check(z.maxLength(20)),
  /** What member data it sends where, in plain words (the processors list and the privacy policy take it from here). */
  data_out: text(600),
  cost: z.strictObject({ charges: z.boolean(), note: text(300) }),
  cards: z.array(z.strictObject({ slot: z.enum(CARD_SLOTS), title: text(80) })).check(z.maxLength(10)),
  /** Where its health is checked: a path on its own address ("/health"). */
  health: z.string().check(z.regex(/^\/[A-Za-z0-9._~/-]{0,200}$/)),
  /** What posts to /plugins/<name>/hook, if anything does (a camera saying a highlight is ready). `challenge`: the
   *  sender checks the address first with a GET (Meta's webhook check), whose query the club passes on to the plugin. */
  hook: z.optional(z.strictObject({ from: text(200), challenge: z.optional(z.boolean()) })),
  /** A message channel it sends for the club (whatsapp.ts): the club decides who gets what (each member's yes, quiet
   *  hours, STOP) and hands it each message to send. `address_setting`: the string setting with the club's own number on
   *  that channel, shown to members so they can write to it. */
  channel: z.optional(z.strictObject({ kind: z.enum(CHANNEL_KINDS), address_setting: settingKey })),
  /** Who sends a browser back to /plugins/<name>/callback (an OAuth sign-in's redirect, such as Xero's), if anyone:
   *  the club passes the address's query on to the plugin and shows its own page, never the plugin's. */
  callback: z.optional(z.strictObject({ for: text(200) })),
  run,
});
export type Manifest = z.infer<typeof manifestSchema>;

/** A manifest as text or a parsed value, checked on its own (the club's catalogue is checked by checkManifestAtClub). */
export function parseManifest(raw: unknown): Manifest {
  let v = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw) > MANIFEST_MAX_BYTES) throw new KumiError("error.plugin_manifest", { details: `over ${MANIFEST_MAX_BYTES} bytes` }, 400);
    try { v = JSON.parse(raw); } catch { throw new KumiError("error.plugin_manifest", { details: "not JSON" }, 400); }
  }
  const r = z.safeParse(manifestSchema, v);
  if (!r.success) {
    const details = r.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ");
    throw new KumiError("error.plugin_manifest", { details }, 400);
  }
  const m = r.data, problems: string[] = [];
  const dup = <T>(xs: T[]) => xs.find((x, n) => xs.indexOf(x) !== n);
  const d1 = dup(m.grants.map((g) => g.action)); if (d1) problems.push(`grants: ${d1} twice`);
  const d2 = dup(m.secrets.map((s) => s.name)); if (d2) problems.push(`secrets: ${d2} twice`);
  const d3 = dup(m.events); if (d3) problems.push(`events: ${d3} twice`);
  const d4 = dup(m.reads); if (d4) problems.push(`reads: ${d4} twice`);
  const d5 = dup(m.settings.map((f) => f.key)); if (d5) problems.push(`settings: ${d5} twice`);
  if (m.settings.filter((f) => f.type === "string" && f.club_network).length > 1) problems.push("settings: only one may be club_network");
  if (m.channel && !m.settings.some((f) => f.key === m.channel!.address_setting && f.type === "string")) problems.push(`channel: address_setting names no string setting (${m.channel.address_setting})`);
  if (m.channel && !m.hook) problems.push("channel: a channel's replies and STOP come in through its hook, so it needs one");
  for (const k of m.secrets) {
    if (k.kept_by_plugin && (k.optional || k.needed_when)) problems.push(`secrets.${k.name}: kept_by_plugin is never asked for, so it isn't optional or needed_when too`);
    if (k.optional && k.needed_when) problems.push(`secrets.${k.name}: needed_when already makes it optional otherwise; not both`);
    if (k.needed_when) {
      const f = m.settings.find((x) => x.key === k.needed_when!.setting), is = k.needed_when.is;
      if (!f) problems.push(`secrets.${k.name}: needed_when names a setting the manifest doesn't have (${k.needed_when.setting})`);
      else if (f.type === "choice" ? !f.choices.some((c) => c.value === is) : f.type === "boolean" ? typeof is !== "boolean" : f.type === "integer" ? typeof is !== "number" : f.type === "string" ? typeof is !== "string" : true)
        problems.push(`secrets.${k.name}: needed_when's value isn't one ${k.needed_when.setting} can have`);
    }
  }
  for (const f of m.settings) {
    const k = f.key;
    if (f.type === "integer" && f.minimum !== undefined && f.maximum !== undefined && f.minimum > f.maximum) problems.push(`settings.${k}: minimum over maximum`);
    if (f.type === "choice" && f.default !== undefined && !f.choices.some((c) => c.value === f.default)) problems.push(`settings.${k}: default isn't a choice`);
    if (f.type === "integer" && f.default !== undefined && ((f.minimum !== undefined && f.default < f.minimum) || (f.maximum !== undefined && f.default > f.maximum))) problems.push(`settings.${k}: default out of range`);
  }
  if (problems.length) throw new KumiError("error.plugin_manifest", { details: problems.join("; ") }, 400);
  return m;
}
/** The fingerprint of a manifest as installed (its JSON with keys in order), to tell versions apart. */
export function manifestSha256(m: Manifest): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(sorted(m))).digest("hex");
}

/** The parts of the club a plugin reads: its manifest's reads, and the areas its actions are in. */
export function readsOf(m: Manifest): string[] {
  const all = new Set([...m.reads, ...m.grants.map((g) => areaOf(g.action))]);
  return AREA_KEYS.filter((k) => all.has(k));
}
const never = (action: string) => PLUGIN_NEVER.some((p) => specificity(p, action) >= 0);

/** Checked against this club: each action is real and one a club's role may hold (what a manager does without asking),
 *  never one no plugin is given or one only done in the app, and each event is in a part of the club it reads. */
export async function checkManifestAtClub(db: Db | Trx, m: Manifest): Promise<void> {
  const grantable = new Set(await grantableActions(db)), known = new Set(actions().map((a) => a.name)), problems: string[] = [];
  for (const g of m.grants) {
    if (!known.has(g.action)) problems.push(`${g.action} isn't an openPadel action`);
    else if (never(g.action) || appOnly(getAction(g.action))) problems.push(`${g.action} is never a plugin's`);
    else if (!grantable.has(g.action)) problems.push(`${g.action} is only the owner's`);
  }
  const reads = readsOf(m);
  for (const e of m.events) if (!reads.includes(WEBHOOK_TOPICS[e]!)) problems.push(`event ${e} needs reads of ${WEBHOOK_TOPICS[e]}`);
  if (problems.length) throw new KumiError("error.plugin_manifest", { details: problems.join("; ") }, 400);
}

// ---- In words, for the preview ----
const actionText = (name: string): Text => {
  const w = both(`action.${name}` as Key);
  return w.en === `action.${name}` ? { en: name, es: name } : w;
};
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const list = (xs: string[]) => xs.join("; ");
const each = (f: (l: "en" | "es") => string): Text => ({ en: f("en"), es: f("es") });
/** "book a court; block a court (asks a person first)". */
export function grantsText(grants: Manifest["grants"]): Text {
  return each((l) => list(grants.map((g) => `${lower(actionText(g.action)[l])}${g.mode === "ask" ? ` ${both("plan.plugin.asks_first")[l]}` : ""}`)));
}
export const areasText = (areas: string[]): Text => each((l) => areas.map((a) => lower(both(`area.${a}` as Key)[l])).join(", "));
/** Each key in words: "Xero app's client id (XERO_CLIENT_ID) (only when Accounting system is Xero)". */
export const secretsText = (m: Pick<Manifest, "secrets"> & Partial<Pick<Manifest, "settings">>): Text => each((l) => list(m.secrets.map((s) => `${s.label[l]} (${s.name})${whenText(m, s, l)}`)));
function whenText(m: Partial<Pick<Manifest, "settings">>, s: Manifest["secrets"][number], l: "en" | "es"): string {
  if (s.needed_when) {
    const f = m.settings?.find((x) => x.key === s.needed_when!.setting);
    const value = f?.type === "choice" ? f.choices.find((c) => c.value === s.needed_when!.is)?.label[l] ?? String(s.needed_when.is) : String(s.needed_when.is);
    return ` ${both("plan.plugin.key_when", { setting: f?.label[l] ?? s.needed_when.setting, value })[l]}`;
  }
  return s.optional ? ` ${both("plan.plugin.key_optional")[l]}` : "";
}
/** A setting's value as the plugin has it: what the club gave, or the manifest's default. */
const settingValue = (m: Partial<Pick<Manifest, "settings">>, values: Record<string, unknown>, key: string) => {
  if (Object.hasOwn(values, key) && values[key] !== null && values[key] !== "") return values[key];
  const f = m.settings?.find((x) => x.key === key);
  return f && "default" in f ? f.default : undefined;
};
/** Whether the owner is asked for this key now, with these settings: never one the plugin keeps; one marked needed_when
 *  when its setting has that value; an optional one never; any other always. */
export function keyAsked(m: Partial<Pick<Manifest, "settings">>, s: Manifest["secrets"][number], values: Record<string, unknown> = {}): boolean {
  if (s.kept_by_plugin) return false;
  if (s.needed_when) return settingValue(m, values, s.needed_when.setting) === s.needed_when.is;
  return !s.optional;
}
/** The keys the owner adds (not the ones the plugin keeps itself). */
export const ownerKeys = (m: Pick<Manifest, "secrets">) => m.secrets.filter((s) => !s.kept_by_plugin);
const keptKeys = (m: Pick<Manifest, "secrets">) => m.secrets.filter((s) => s.kept_by_plugin);
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
/** Where it runs, in words. */
export function runText(m: Manifest): Text {
  return m.run.mode === "remote" ? both("plan.plugin.runs_remote", { host: hostOf(m.run.url), publisher: m.publisher })
    : both("plan.plugin.runs_local", { host: hostOf(m.run.release_url), sha: m.run.sha256.slice(0, 12) });
}

/** Everything the manifest asks for, line by line ("It will be able to ... It sends ... Needs ..."): the preview's rows. */
export function manifestRows(m: Manifest): { label: Text; text: Text }[] {
  const rows: { label: Text; text: Text }[] = [];
  const reads = readsOf(m);
  rows.push({ label: both("plan.plugin.row_does"), text: m.description });
  rows.push({ label: both("plan.plugin.row_able"), text: m.grants.length ? grantsText(m.grants) : both("plan.plugin.no_actions") });
  rows.push({ label: both("plan.plugin.row_reads"), text: reads.length ? areasText(reads) : both("plan.plugin.reads_nothing") });
  if (m.events.length) rows.push({ label: both("plan.plugin.row_events"), text: { en: m.events.join(", "), es: m.events.join(", ") } });
  rows.push({ label: both("plan.plugin.row_sends"), text: m.data_out });
  rows.push({ label: both("plan.plugin.row_needs"), text: ownerKeys(m).length ? both("plan.plugin.needs_keys", { keys: secretsText({ secrets: ownerKeys(m), settings: m.settings }) }) : both("plan.plugin.needs_nothing") });
  if (keptKeys(m).length) rows.push({ label: both("plan.plugin.row_keeps"), text: both("plan.plugin.keeps_keys", { keys: secretsText({ secrets: keptKeys(m) }) }) });
  rows.push({ label: both("plan.plugin.row_cost"), text: m.cost.charges ? both("plan.plugin.cost_charges", { note: m.cost.note }) : both("plan.plugin.cost_free", { note: m.cost.note }) });
  rows.push({ label: both("plan.plugin.row_runs"), text: runText(m) });
  if (m.hook) rows.push({ label: both("plan.plugin.row_hook"), text: both("plan.plugin.hook", { from: m.hook.from, name: m.name }) });
  if (m.callback) rows.push({ label: both("plan.plugin.row_callback"), text: both("plan.plugin.callback", { for: m.callback.for, name: m.name }) });
  if (m.channel) rows.push({ label: both("plan.plugin.row_channel"), text: both(`plan.plugin.channel_${m.channel.kind}` as Key) });
  if (m.cards.length) rows.push({ label: both("plan.plugin.row_cards"), text: each((l) => m.cards.map((c) => `${c.title[l]} (${both(`plan.plugin.slot_${c.slot}` as Key)[l]})`).join(", ")) });
  return rows;
}
/** The rows as one summary, for the command line and assistants ("It will be able to: ... It sends: ..."). */
export function rowsText(head: Text, rows: { label: Text; text: Text }[]): Text {
  return each((l) => [head[l], ...rows.map((r) => `${r.label[l]}: ${r.text[l]}.`.replace(/\.\.$/, "."))].join(" "));
}

/** What a new version asks for that the old one didn't (and what it no longer asks for), for plugin.update. */
export function manifestDiff(a: Manifest, b: Manifest): { label: Text; text: Text }[] {
  const rows: { label: Text; text: Text }[] = [];
  const key = (g: Manifest["grants"][number]) => `${g.action}:${g.mode}`;
  const oldG = new Map(a.grants.map((g) => [g.action, g])), newG = new Map(b.grants.map((g) => [g.action, g]));
  // New actions, or ones it did only by asking that it now does outright.
  const more = b.grants.filter((g) => !oldG.has(g.action) || (oldG.get(g.action)!.mode === "ask" && g.mode === "allow"));
  const fewer = a.grants.filter((g) => !newG.has(g.action) || (g.mode === "allow" && newG.get(g.action)!.mode === "ask"));
  if (more.length) rows.push({ label: both("plan.plugin.diff_able_more"), text: grantsText(more) });
  if (fewer.length) rows.push({ label: both("plan.plugin.diff_able_less"), text: grantsText(fewer.map((g) => newG.get(g.action) && key(newG.get(g.action)!) !== key(g) ? newG.get(g.action)! : g)) });
  const ra = readsOf(a), rb = readsOf(b);
  const readsMore = rb.filter((x) => !ra.includes(x)), readsLess = ra.filter((x) => !rb.includes(x));
  if (readsMore.length) rows.push({ label: both("plan.plugin.diff_reads_more"), text: areasText(readsMore) });
  if (readsLess.length) rows.push({ label: both("plan.plugin.diff_reads_less"), text: areasText(readsLess) });
  const evMore = b.events.filter((x) => !a.events.includes(x)), evLess = a.events.filter((x) => !b.events.includes(x));
  if (evMore.length) rows.push({ label: both("plan.plugin.diff_events_more"), text: { en: evMore.join(", "), es: evMore.join(", ") } });
  if (evLess.length) rows.push({ label: both("plan.plugin.diff_events_less"), text: { en: evLess.join(", "), es: evLess.join(", ") } });
  const secMore = ownerKeys(b).filter((s) => !a.secrets.some((x) => x.name === s.name));
  if (secMore.length) rows.push({ label: both("plan.plugin.diff_needs_more"), text: secretsText({ secrets: secMore, settings: b.settings }) });
  // A key it may now keep itself, that it didn't before (or one the owner added that it may now overwrite).
  const keepsMore = keptKeys(b).filter((s) => !a.secrets.some((x) => x.name === s.name && x.kept_by_plugin));
  if (keepsMore.length) rows.push({ label: both("plan.plugin.row_keeps"), text: both("plan.plugin.keeps_keys", { keys: secretsText({ secrets: keepsMore }) }) });
  if (JSON.stringify(a.data_out) !== JSON.stringify(b.data_out)) rows.push({ label: both("plan.plugin.diff_sends"), text: b.data_out });
  if (JSON.stringify(a.cost) !== JSON.stringify(b.cost)) rows.push({ label: both("plan.plugin.row_cost"), text: b.cost.charges ? both("plan.plugin.cost_charges", { note: b.cost.note }) : both("plan.plugin.cost_free", { note: b.cost.note }) });
  if (JSON.stringify(a.run) !== JSON.stringify(b.run)) rows.push({ label: both("plan.plugin.row_runs"), text: runText(b) });
  if (!a.hook && b.hook) rows.push({ label: both("plan.plugin.row_hook"), text: both("plan.plugin.hook", { from: b.hook.from, name: b.name }) });
  if (!a.callback && b.callback) rows.push({ label: both("plan.plugin.row_callback"), text: both("plan.plugin.callback", { for: b.callback.for, name: b.name }) });
  if (b.channel && a.channel?.kind !== b.channel.kind) rows.push({ label: both("plan.plugin.row_channel"), text: both(`plan.plugin.channel_${b.channel.kind}` as Key) });
  return rows;
}

// ---- Settings ----
/** The settings a person gives, checked against the manifest's schema: unknown ones refused, each of its type, required
 *  ones present (from `before` or the default), courts named by id or by name. Gives back the values to keep and how each
 *  reads ("Courts: Court 1, Court 2"). */
export async function checkSettings(db: Db | Trx, m: Manifest, given: Record<string, unknown>, before: Record<string, unknown> = {}):
  Promise<{ values: Record<string, unknown>; lines: Text[] }> {
  const problems: Text[] = [], values: Record<string, unknown> = {}, lines: Text[] = [];
  for (const k of Object.keys(given)) if (!m.settings.some((f) => f.key === k)) problems.push(both("plan.plugin.setting_unknown", { key: k }));
  const courts = await db.selectFrom("court").select(["id", "name"]).where("archived_at", "is", null).execute();
  for (const f of m.settings) {
    const k = f.key, has = Object.hasOwn(given, k), v = has ? given[k] : Object.hasOwn(before, k) ? before[k] : "default" in f ? f.default : undefined;
    const bad = () => problems.push(both("plan.plugin.setting_bad", { label: f.label }));
    if (v === undefined || v === null || v === "") {
      if ("required" in f && f.required) problems.push(both("plan.plugin.setting_missing", { label: f.label }));
      continue;
    }
    let shown: Text;
    switch (f.type) {
      case "string": {
        if (typeof v !== "string" || v.length > (f.max_length ?? 500) || /[\u0000-\u001f]/.test(v)) { bad(); continue; }
        values[k] = v.trim(); shown = { en: v.trim(), es: v.trim() }; break;
      }
      case "integer": {
        const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v;
        if (typeof n !== "number" || !Number.isInteger(n) || (f.minimum !== undefined && n < f.minimum) || (f.maximum !== undefined && n > f.maximum)) { bad(); continue; }
        values[k] = n; shown = { en: String(n), es: String(n) }; break;
      }
      case "boolean": {
        const b = v === "true" ? true : v === "false" ? false : v;
        if (typeof b !== "boolean") { bad(); continue; }
        values[k] = b; shown = both(b ? "plan.plugin.yes" : "plan.plugin.no"); break;
      }
      case "choice": {
        const c = f.choices.find((x) => x.value === v);
        if (!c) { bad(); continue; }
        values[k] = c.value; shown = c.label; break;
      }
      case "courts": {
        const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
        if (!raw || raw.length > 100) { bad(); continue; }
        const found = raw.map((x) => String(x).trim()).filter(Boolean).map((x) => courts.find((c) => c.id === x) ?? courts.find((c) => c.name.toLowerCase() === x.toLowerCase()));
        if (found.some((c) => !c)) { problems.push(both("plan.plugin.setting_court", { label: f.label })); continue; }
        const ids = [...new Set(found.map((c) => c!.id))];
        values[k] = ids; const names = ids.map((id) => courts.find((c) => c.id === id)!.name).join(", "); shown = { en: names, es: names }; break;
      }
    }
    lines.push(each((l) => `${f.label[l]}: ${shown[l]}`));
  }
  if (problems.length) throw new KumiError("error.plugin_settings", { details: each((l) => problems.map((p) => p[l]).join(" ")) }, 400);
  return { values, lines };
}
