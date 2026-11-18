// The club's commands for the command line, made from the same catalogue the assistant door (mcp.ts) and the apps
// use, never written by hand: each action an assistant may ever be offered is `openpadel <thing> <verb>` (program.create
// is `openpadel program create`), and each read is `openpadel <read>` (free_courts is `openpadel free-courts`). Their flags come
// from the action's input schema. docs/cli/reference.md is made from here too (tools/gen_cli_reference.ts), and a
// test fails when it's out of date.
import * as z from "zod/mini";
import { toJSONSchema } from "zod/v4/core";
import { actions, PLUGIN_ONLY, specificity, type ActionDef } from "@kumi/core";
import { both, COMMAND, en, type Key, type Params, type Text } from "@kumi/i18n";
import { doorAction, READS, slim, toolBase } from "./mcp.ts";

export type Entity = "person" | "coach" | "court" | "location" | "program" | "plan";
export type PropType = "string" | "integer" | "number" | "boolean" | "array" | "object";
export interface Prop {
  key: string; type: PropType; items?: PropType; format?: string; pattern?: string; enum?: string[]; nullable: boolean; required: boolean;
  description?: string; minimum?: number; maximum?: number;
  /** A person, coach, court, location, program or plan: given by name as well as by id. */
  entity?: Entity;
  /** For a flag that takes JSON: a whole example of it, as it's typed (in single quotes), and a note on its numbers. */
  json?: { example: string; note?: Text };
}
export interface Command {
  kind: "action" | "read"; words: string[]; tool: string; action?: string; title: Text; description: string;
  schema: Record<string, unknown>; props: Prop[]; staff?: boolean; planKey?: Key;
}

/** Which inputs name something the command line can find by name, and what. */
const ENTITY_OF: Record<string, Entity> = {
  person_id: "person", to_person_id: "person", partner_id: "person", person_a: "person", person_b: "person", given_by: "person",
  coach_id: "coach", court_id: "court", court_ids: "court", location_id: "location", program_id: "program", plan_id: "plan", plan_ids: "plan",
};
export const kebab = (s: string) => s.replace(/_/g, "-");
/** The flag for an input, as the docs show it: `--location` for location_id (a name or an id), `--courts` for court_ids. */
export function flagOf(p: Prop): string {
  if (p.entity && p.key.endsWith("_ids")) return kebab(p.key.slice(0, -4)) + "s";
  if (p.entity && p.key.endsWith("_id")) return kebab(p.key.slice(0, -3));
  return kebab(p.key);
}
/** Every spelling a flag answers to: location, location-id, location_id. */
export function spellings(p: Prop): string[] { return [...new Set([flagOf(p), kebab(p.key), p.key])]; }

function propsOf(schema: any, name = ""): Prop[] {
  const req = new Set<string>(schema.required ?? []);
  return Object.entries<any>(schema.properties ?? {}).map(([key, v]) => {
    const alts: any[] = v.anyOf ?? v.oneOf ?? [v];
    const t = alts.find((x) => x.type !== "null") ?? {};
    const nullable = alts.some((x) => x.type === "null");
    const type: PropType = t.type === "integer" || t.type === "number" || t.type === "boolean" || t.type === "array" || t.type === "object" ? t.type : "string";
    const items = type === "array" ? (["integer", "number", "boolean", "object", "array"].includes(t.items?.type) ? t.items.type : "string") as PropType : undefined;
    const format = type === "array" ? t.items?.format : t.format;
    const json = type === "object" || (type === "array" && (items === "object" || items === "array")) ? jsonExample(key, t, name) : undefined;
    return { key, type, items, format, pattern: t.pattern, enum: t.enum ?? t.items?.enum, nullable, required: req.has(key), description: v.description ?? t.description,
      minimum: t.minimum, maximum: t.maximum, entity: ENTITY_OF[key] && format === "uuid" ? ENTITY_OF[key] : undefined, ...(json ? { json } : {}) };
  });
}

// ---- Examples for the flags that take JSON (docs/cli/reference.md and `openpadel help <command>`) ----
/** Hand-made where a made-up one would mislead (a week of hours, places that are either a member or a guest); otherwise
 *  made from the input's own schema. Keyed by the input's name and the shape it has, so a different shape gets its own. */
const JSON_EXAMPLES: Record<string, unknown> = {
  // A whole week: Monday to Friday 07:00 to 22:00, Saturday 08:00 to 20:00, closed on Sunday.
  "hours.set:days": [...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })), { weekday: 6, opens: "08:00", closes: "20:00" }, { weekday: 0, opens: null, closes: null }],
  // An outdoor court that closes at dusk on the weekend; the other days follow the location.
  "court.hours_set:days": [{ weekday: 6, opens: "08:00", closes: "18:00" }, { weekday: 0, opens: "08:00", closes: "18:00" }],
  "stretches:weekday": [{ weekday: 1, starts: "09:00", ends: "13:00" }, { weekday: 1, starts: "16:00", ends: "20:00" }, { weekday: 3, starts: "09:00", ends: "13:00" }],
  "places:person_id": [{ person_id: "<id>", paid: true }, { guest_name: "Sam Diaz" }],
  "refund:outcome": { outcome: "partial", cents: 1500, note: "Left a week in" },
  "open:level_min": { level_min: 3, level_max: 4.5, rated: true },
  "courts:court_id": [{ court_id: "<id>", starts_at: "2026-11-20T18:00:00-08:00", minutes: 90 }, { court_id: "<id>", starts_at: "2026-11-20T18:00:00-08:00", minutes: 90 }],
  "rates:minutes": [{ minutes: 60, cents: 6000 }, { minutes: 90, cents: 8500 }],
  "filters:membership": { membership: "member", level_min: 3, level_max: 4.5 },
  "settings:*": { "<setting>": "<value>" },
};
function sampleOf(s: any, key: string): unknown {
  const alts: any[] | undefined = s?.anyOf ?? s?.oneOf;
  if (alts) s = alts.find((x) => x.type !== "null") ?? alts[0];
  if (s?.enum) return s.enum[0];
  const type = Array.isArray(s?.type) ? s.type.find((x: string) => x !== "null") : s?.type;
  if (type === "object") {
    const props = Object.entries<any>(s.properties ?? {});
    if (!props.length) return { "<name>": "<value>" };
    const req = new Set<string>(s.required ?? []);
    // A text in the other language: the Spanish one, say.
    if (key === "translations") { const es = props.find(([k]) => k === "es"); return es ? { es: sampleOf(es[1], "es") } : {}; }
    const shown = req.size ? props.filter(([k]) => req.has(k)) : props.slice(0, 2);
    return Object.fromEntries(shown.map(([k, v]) => [k, sampleOf(v, k)]));
  }
  if (type === "array") return [sampleOf(s.items, key)];
  if (type === "boolean") return true;
  if (type === "integer" || type === "number") {
    if (key === "weekday") return 1;
    if (key === "us" || key === "a") return 6;
    if (key === "them" || key === "b") return 4;
    if (/cents/.test(key)) return 1500;
    if (/level/.test(key)) return 3.5;
    if (/minutes/.test(key)) return 60;
    return s.minimum ?? 1;
  }
  if (s?.format === "uuid") return "<id>";
  if (s?.format === "date-time") return "2026-11-20T18:00:00-08:00";
  if (typeof s?.pattern === "string" && s.pattern.includes(":[0-5]")) return "09:00";
  return "...";
}
function jsonExample(key: string, s: any, action: string): { example: string; note?: Text } {
  const first = s.type === "array" ? s.items : s;
  const shapeKey = Object.keys(first?.properties ?? {})[0] ?? "*";
  const value = JSON_EXAMPLES[`${action}:${key}`] ?? JSON_EXAMPLES[`${key}:${shapeKey}`] ?? sampleOf(s, key);
  const text = JSON.stringify(value);
  return { example: `'${text}'`, ...(text.includes('"weekday"') ? { note: both("cli.weekdays") } : {}) };
}
const titleOf = (action: string): Text => (`action.${action}` in en ? both(`action.${action}` as Key) : { en: action, es: action });

let cached: Command[] | null = null;
export function commands(): Command[] {
  if (cached) return cached;
  const out: Command[] = [];
  for (const a of actions()) {
    // A plugin's own cards are its token's alone (plugin_cards.ts): never a command a person is offered.
    if (!doorAction(a) || PLUGIN_ONLY.includes(a.name)) continue;
    const schema = slim(toJSONSchema(a.input as any)) as Record<string, unknown>;
    const planKey = `plan.${a.name}` in en ? (`plan.${a.name}` as Key) : undefined;
    out.push({ kind: "action", words: a.name.split(".").map(kebab), tool: toolBase(a.name), action: a.name, title: titleOf(a.name), description: titleOf(a.name).en,
      schema, props: propsOf(schema, a.name), planKey });
  }
  for (const r of READS) {
    const schema = slim(toJSONSchema(z.object(r.input) as any)) as Record<string, unknown>;
    out.push({ kind: "read", words: r.words ?? [kebab(r.name)], tool: r.name, title: r.title, description: r.description, schema, props: propsOf(schema), staff: r.staff });
  }
  // The door's descriptions name its tools (booking_request_preview, free_courts): here, the commands they are.
  const byTool = new Map(out.map((c) => [c.tool, `${COMMAND} ${c.words.join(" ")}`]));
  const forCli = (text: string) => text.replace(/\b([a-z]+(?:_[a-z]+)+?)(_preview|_confirm)?\b/g, (all, base: string, end?: string) =>
    byTool.get(base) && (end || out.some((c) => c.kind === "read" && c.tool === base)) ? byTool.get(base)! : all);
  for (const c of out) { c.description = forCli(c.description); for (const p of c.props) if (p.description) p.description = forCli(p.description); }
  return (cached = out);
}
/** A time given as text: an ISO time, or one on the club's clock without a zone ("2026-11-20 18:00"). */
export const isTime = (p: Prop) => p.type === "string" && (p.format === "date-time" || (!p.format && !p.pattern && /(^|_)(starts|ends)?_?at$/.test(p.key)));
/** Every action the catalogue has, whether or not the door offers it: to tell "only in the app" from "no such thing". */
export function catalogueAction(name: string): ActionDef<any> | null { return actions().find((a) => a.name === name) ?? null; }

/** The command named by the first words of argv (longest match; dashes and underscores alike), and what's left. */
export function findCommand(argv: string[]): { cmd: Command; rest: string[] } | null {
  const words: string[] = [];
  for (const a of argv) { if (a.startsWith("--")) break; words.push(a.replace(/_/g, "-").toLowerCase()); }
  for (let n = Math.min(words.length, 3); n > 0; n--) {
    const want = words.slice(0, n).join(" ");
    const cmd = commands().find((c) => c.words.join(" ") === want);
    if (cmd) {
      // What follows the command's own words: the arguments, in order (positional and flags alike).
      let skipped = 0;
      const rest = argv.filter((a) => (skipped < n && !a.startsWith("--") ? (skipped++, false) : true));
      return { cmd, rest };
    }
  }
  return null;
}
/** The action a few words would be, even one the door never offers (for "only in the app"). */
export function actionNamed(argv: string[]): string | null {
  const words = argv.filter((a) => !a.startsWith("--")).slice(0, 3).map((w) => w.replace(/-/g, "_").toLowerCase());
  for (let n = words.length; n > 1; n--) { const name = words.slice(0, n).join("."); if (catalogueAction(name)) return name; }
  return null;
}

// ---- Reading the flags ----

/** Something wrong with the command as typed: worded in both languages, like the club's own errors. */
export class UsageError extends Error {
  readonly key: Key; readonly params: Params; readonly text: Text;
  constructor(key: Key, params: Params = {}) { const text = both(key, params); super(text.en); this.key = key; this.params = params; this.text = text; }
}
export interface Parsed { input: Record<string, unknown>; names: { key: string; entity: Entity; values: string[]; array: boolean }[]; times: string[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function value(p: Prop, type: PropType, raw: string, flag: string): unknown {
  if (raw === "null" && p.nullable) return null;
  if (type === "integer" || type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) throw new UsageError(type === "integer" ? "cli.flag_whole" : "cli.flag_number", { flag, value: raw });
    return n;
  }
  if (type === "boolean") {
    if (/^(true|yes|1|on)$/i.test(raw)) return true;
    if (/^(false|no|0|off)$/i.test(raw)) return false;
    throw new UsageError("cli.flag_yes_no", { flag, value: raw });
  }
  if (type === "object" || type === "array") {
    try { return JSON.parse(raw); } catch { throw new UsageError("cli.flag_json", { flag }); }
  }
  if (p.enum && !p.enum.includes(raw)) throw new UsageError("cli.flag_one_of", { flag, list: p.enum.join(", "), value: raw });
  return raw;
}

/** argv after the command's words into its input. `base`: input given whole (--input), which flags then change. */
export function parseInput(cmd: Command, argv: string[], base: Record<string, unknown> = {}): Parsed {
  const input: Record<string, unknown> = { ...base };
  const names: Parsed["names"] = [], times: string[] = [];
  const bySpelling = new Map<string, Prop>();
  for (const p of cmd.props) for (const s of spellings(p)) bySpelling.set(s, p);
  const positional: string[] = [];
  const put = (p: Prop, raw: string | true, shown: string) => {
    if (raw === true) { if (p.type !== "boolean") throw new UsageError("cli.flag_needs_value", { flag: shown }); input[p.key] = true; return; }
    if (p.entity) {
      const parts = p.type === "array" ? raw.split(",").map((x) => x.trim()).filter(Boolean) : [raw.trim()];
      const ids = parts.filter((x) => UUID.test(x)), named = parts.filter((x) => !UUID.test(x));
      if (named.length) names.push({ key: p.key, entity: p.entity, values: named, array: p.type === "array" });
      input[p.key] = p.type === "array" ? [...((input[p.key] as string[] | undefined) ?? []), ...ids] : (ids[0] ?? input[p.key]);
      return;
    }
    if (p.type === "array" && !raw.trim().startsWith("[")) {
      input[p.key] = raw.split(",").map((x) => x.trim()).filter(Boolean).map((x) => value(p, p.items ?? "string", x, shown));
      return;
    }
    const v = value(p, p.type, raw, shown);
    input[p.key] = v;
    if (isTime(p) && typeof v === "string") times.push(p.key);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    let name = eq > 0 ? a.slice(2, eq) : a.slice(2), raw: string | true = eq > 0 ? a.slice(eq + 1) : true;
    let negate = false;
    if (!bySpelling.has(name) && name.startsWith("no-") && bySpelling.get(name.slice(3))?.type === "boolean") { negate = true; name = name.slice(3); }
    const p = bySpelling.get(name);
    if (!p) {
      const known = cmd.props.map((x) => `--${flagOf(x)}`).join(", ");
      throw new UsageError("cli.flag_unknown", { command: cmd.words.join(" "), flag: name, list: known || "-" });
    }
    if (negate) { input[p.key] = false; continue; }
    if (raw === true && p.type !== "boolean") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError("cli.flag_needs_value", { flag: name });
      raw = next; i++;
    }
    put(p, raw, name);
  }
  // A plain word fills the one input the command has to have, or what a search reads (q).
  if (positional.length) {
    const required = cmd.props.filter((p) => p.required && input[p.key] === undefined);
    const target = required.length === 1 ? required[0] : cmd.props.find((p) => p.key === "q" && input.q === undefined);
    if (!target || positional.length > 1) throw new UsageError("cli.flag_positional", { command: cmd.words.join(" "), value: positional.join(" ") });
    put(target, positional[0]!, flagOf(target));
  }
  const missing = cmd.props.filter((p) => p.required && input[p.key] === undefined && !names.some((n) => n.key === p.key));
  if (missing.length) throw new UsageError("cli.flags_missing", { command: cmd.words.join(" "), list: missing.map((p) => `--${flagOf(p)}`).join(", ") });
  return { input, names, times };
}

/** A club time written without a zone ("2026-11-20 18:00") as the moment it is in the club's time zone. */
export function clubTime(raw: string, tz: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) return raw;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number];
  const wanted = Date.UTC(y, mo - 1, d, h, mi, s);
  // The zone's offset at that moment, found by reading the guess back on the club's clock (twice, for a change of
  // offset in between).
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(guess)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
    const shown = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
    guess += wanted - shown;
  }
  return new Date(guess).toISOString();
}

// ---- Finding something by its name ----

export interface Candidate { id: string; name: string; hint?: string }
/** Where each kind of thing is listed: a staff read, and for a member the members' read that lists it (if any). */
export const FINDERS: Record<Entity, { staff?: { tool: string; args?: (v: string) => Record<string, unknown>; list: (d: any) => Candidate[] }; member?: { tool: string; list: (d: any) => Candidate[] } }> = {
  person: { staff: { tool: "people", args: (v) => ({ q: v, limit: 50 }), list: (d) => (d as any[]).map((p) => ({ id: p.id, name: p.display_name, hint: p.email ?? undefined })) } },
  coach: { staff: { tool: "coaches", list: (d) => (d.coaches ?? []).map((c: any) => ({ id: c.id, name: c.name })) },
    member: { tool: "lesson_coaches", list: (d) => (d.coaches ?? []).map((c: any) => ({ id: c.id ?? c.person_id, name: c.name ?? c.display_name })) } },
  court: { staff: { tool: "courts", list: (d) => (d as any[]).map((c) => ({ id: c.id, name: c.name, hint: c.kind })) } },
  location: { staff: { tool: "locations", list: (d) => (d as any[]).map((l) => ({ id: l.id, name: l.name })) },
    member: { tool: "booking_options", list: (d) => (d.locations ?? []).map((l: any) => ({ id: l.id, name: l.name })) } },
  program: { staff: { tool: "programs", list: (d) => (d as any[]).map((p) => ({ id: p.id, name: p.name, hint: [p.kind, p.first_start ? String(p.first_start).slice(0, 10) : null].filter(Boolean).join(", ") })) },
    member: { tool: "open_programs", list: (d) => (Array.isArray(d) ? d : d.programs ?? []).map((p: any) => ({ id: p.id, name: p.name, hint: p.kind })) } },
  plan: { staff: { tool: "memberships", list: (d) => (d.plans ?? []).map((p: any) => ({ id: p.id, name: p.name })) } },
};
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
/** The one candidate a name means: the same name, or failing that the only one whose name contains it. */
export function match(name: string, list: Candidate[]): { found: Candidate } | { none: true } | { several: Candidate[] } {
  const want = fold(name);
  const same = list.filter((c) => fold(c.name) === want);
  if (same.length === 1) return { found: same[0]! };
  if (same.length > 1) return { several: same };
  const part = list.filter((c) => fold(c.name).includes(want));
  if (part.length === 1) return { found: part[0]! };
  return part.length ? { several: part } : { none: true };
}

// ---- The reference (docs/cli/reference.md) ----

export interface GrantRow { role: string; pattern: string; mode: "allow" | "ask" | "no"; rows_scope: "any" | "own"; time_scope: "any_time" | "on_shift" }
const ROLE_WORDS: [string, string][] = [["owner", "owner"], ["manager", "manager"], ["front_desk", "front desk"], ["coach", "coach"], ["accountant", "accountant"], ["member", "member"]];
/** Who may do an action with the club's built-in roles, as they come (a club can change them in Settings, Roles). */
export function whoMay(action: string, grants: GrantRow[]): string {
  const parts: string[] = [];
  for (const [key, word] of ROLE_WORDS) {
    const g = grants.filter((x) => x.role === key && specificity(x.pattern, action) >= 0).sort((a, b) => specificity(b.pattern, action) - specificity(a.pattern, action))[0];
    if (!g || g.mode === "no") continue;
    const notes = [g.rows_scope === "own" ? "their own" : null, g.time_scope === "on_shift" ? "on shift" : null, g.mode === "ask" ? "with approval" : null].filter(Boolean);
    parts.push(notes.length ? `${word} (${notes.join(", ")})` : word);
  }
  return parts.length ? parts.join(", ") : "no built-in role (a role the club makes can be given it)";
}
const EXAMPLE_NAMES: Record<Entity, string> = { person: "Maria Lopez", coach: "Ana Ruiz", court: "Court 1", location: "Main", program: "Tuesday drills", plan: "Monthly" };
function exampleValue(p: Prop): string {
  const q = (s: string) => (/^[\w.:/@+-]+$/.test(s) ? s : `"${s}"`);
  if (p.entity) return q(p.type === "array" ? `${EXAMPLE_NAMES[p.entity]},${p.entity === "court" ? "Court 2" : "Sam Diaz"}` : EXAMPLE_NAMES[p.entity]);
  if (p.enum) return p.enum[0]!;
  if (p.type === "boolean") return "";
  if (p.type === "integer" || p.type === "number") {
    if (p.key.endsWith("_cents")) return "3000";
    if (/minutes/.test(p.key)) return "90";
    if (/capacity|places|count|weeks|max/.test(p.key)) return "8";
    if (/level/.test(p.key)) return "3.5";
    if (/percent/.test(p.key)) return "50";
    if (/hours/.test(p.key)) return "24";
    return String(p.minimum ?? 1);
  }
  if (p.json) return p.json.example;
  if (p.type === "array") return p.items === "integer" ? "1,3" : p.format === "uuid" ? "<id>,<id>" : "'[...]'";
  if (p.type === "object") return "'{...}'";
  if (p.format === "uuid") return "<id>";
  if (isTime(p)) return q("2026-11-20 18:00");
  if (p.format === "email") return "maria@example.com";
  if (p.pattern?.includes("\\d{4}-\\d{2}-\\d{2}")) return "2026-11-20";
  if (p.pattern?.includes("\\d{2}:\\d{2}")) return "09:00";
  if (p.key === "time_zone") return "America/Los_Angeles";
  // A plugin's name (plugins.ts): its pattern says so.
  if ((p.key === "plugin" || p.key === "name") && p.pattern?.startsWith("^[a-z][a-z0-9-]")) return "court-lights";
  if (p.key === "name") return q("Tuesday drills");
  if (/reason|note|body|text|message/.test(p.key)) return q("Rain on the outdoor courts");
  return q("...");
}
export function example(cmd: Command): string {
  const flags = cmd.props.filter((p) => p.required).map((p) => (p.type === "boolean" ? `--${flagOf(p)}` : `--${flagOf(p)} ${exampleValue(p)}`));
  return `${COMMAND} ${cmd.words.join(" ")}${flags.length ? " " + flags.join(" ") : ""}`;
}
export function typeWords(p: Prop): string {
  if (p.entity) return p.type === "array" ? `${p.entity}s: names or ids, with commas` : `${p.entity}: a name or an id`;
  if (p.enum) return p.enum.join(" | ");
  if (isTime(p)) return "time: \"YYYY-MM-DD HH:MM\" on the club's clock, or ISO";
  if (p.format === "uuid") return p.type === "array" ? "ids, with commas" : "id";
  if (p.type === "array") return p.items === "object" ? "JSON list" : `${p.items ?? "text"}s, with commas`;
  if (p.type === "object") return "JSON";
  if (p.type === "integer") return p.key.endsWith("_cents") ? "whole number (cents)" : "whole number";
  if (p.type === "boolean") return "yes/no (the flag alone is yes)";
  if (p.pattern?.includes("\\d{4}-\\d{2}-\\d{2}")) return "date YYYY-MM-DD";
  if (p.pattern?.includes("\\d{2}:\\d{2}")) return "time HH:MM";
  return p.type === "number" ? "number" : "text";
}
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
function planWords(k: Key): string {
  const v = (en as Record<string, unknown>)[k];
  return typeof v === "string" ? v : v && typeof v === "object" ? String((v as Record<string, string>).other ?? Object.values(v)[0]) : "";
}

export function referenceMarkdown(grants: GrantRow[]): string {
  const cmds = commands();
  const lines: string[] = [
    "# openpadel: every club command",
    "",
    "Made by `node tools/gen_cli_reference.ts` from the actions and reads the assistant door offers; don't edit it by hand",
    "(`apps/server/test/cli_reference.test.ts` fails when it's out of date). How to sign in, the flags every command",
    "takes and the exit codes are in [README.md](README.md).",
    "",
    "Who may: with the club's built-in roles as they come (Settings, Roles changes them). Whatever the role, a command is",
    "only ever offered to someone allowed it, never does more than the person could in the app, and some changes are",
    "only ever made in the app (accepting a waiver, the family card, money handed over at the desk): those aren't here.",
    "",
    "## Reads",
    "",
  ];
  for (const c of cmds.filter((x) => x.kind === "read")) {
    lines.push(`### ${COMMAND} ${c.words.join(" ")}`, "", `${c.title.en}. ${c.description}`, "", `Who may: ${c.staff ? "staff (each sees what their staff screens show)" : "anyone signed in, about themselves"}.`, "");
    if (c.props.length) lines.push(...flagTable(c), "");
    lines.push("```", example(c), "```", "");
  }
  lines.push("## Changes", "", "Each one previews first (exit code 10) and changes nothing until `openpadel confirm <run_id>`, or the same command with `--yes`.", "");
  const groups = new Map<string, Command[]>();
  for (const c of cmds.filter((x) => x.kind === "action")) groups.set(c.words[0]!, [...(groups.get(c.words[0]!) ?? []), c]);
  for (const [g, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${g}`, "");
    for (const c of list.sort((a, b) => a.words.join(" ").localeCompare(b.words.join(" ")))) {
      lines.push(`#### ${COMMAND} ${c.words.join(" ")}`, "", `${c.title.en}. Who may: ${whoMay(c.action!, grants)}.`, "");
      if (c.planKey) lines.push(`Its preview reads: "${cell(planWords(c.planKey))}"`, "");
      if (c.props.length) lines.push(...flagTable(c), "");
      lines.push("```", example(c), "```", "");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
function flagTable(c: Command): string[] {
  const json = c.props.filter((p) => p.json);
  return ["| Flag | Takes | | What it is |", "|---|---|---|---|",
    ...c.props.map((p) => `| \`--${flagOf(p)}\` | ${cell(typeWords(p))} | ${p.required ? "needed" : ""} | ${cell(p.description ?? "")} |`),
    // A needed one is in the command's example below already: only what its numbers mean, if anything.
    ...(json.length ? ["", ...json.flatMap((p) => p.required ? (p.json!.note ? [`\`--${flagOf(p)}\`: ${p.json!.note.en}.`, ""] : [])
      : [`\`--${flagOf(p)}\` takes JSON, for example${p.json!.note ? ` (${p.json!.note.en})` : ""}:`, "", "```", `--${flagOf(p)} ${p.json!.example}`, "```", ""])] : [])];
}
