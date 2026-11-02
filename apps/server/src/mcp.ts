// The MCP endpoint: tools generated from the action registry, for the person behind the token.
// Each action is a pair: *_preview returns the plan and a run id, *_confirm applies that run id.
// So an assistant can never apply something different from what it showed the person.
import * as z from "zod/mini";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { both, en, isLang, type Key, type Lang, type Text } from "@kumi/i18n";
import { money } from "@kumi/i18n";
import { actions, apply, appOnly, mayEverDo, plan, weekSpent, APP_ONLY_YES, KumiError, type Actor, type Db } from "@kumi/core";

const toolBase = (action: string) => action.replace(/\./g, "_");

/** What an assistant can read: the same answers the members' app gets, for the person behind the token. */
const ymd = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/), z.describe("A club date, YYYY-MM-DD"));
const READS: { name: string; title: Text; description: string; input: Record<string, z.ZodMiniType>; path: (a: any) => string }[] = [
  { name: "booking_options", title: { en: "Where and how to book", es: "Dónde y cómo reservar" }, input: {}, path: () => "/booking-options",
    description: "The club's locations (with their ids), the lengths a court can be booked for, how many days ahead you may book, and the deadlines for sharing the cost and cancelling." },
  { name: "free_courts", title: { en: "Free courts", es: "Pistas libres" }, path: (a) => `/availability?${new URLSearchParams({ location_id: a.location_id, date: a.date, minutes: String(a.minutes) })}`,
    input: { location_id: z.uuid(), date: ymd, minutes: z.number().check(z.int(), z.describe("60, 90 or 120, as booking_options lists")) },
    description: "Each court at a location that is free on a date for a length, with every start time it's free (UTC). Use a court id and start from here in booking_request_preview." },
  { name: "court_price", title: { en: "What a court costs", es: "Cuánto cuesta una pista" }, path: (a) => `/quote?${new URLSearchParams({ court_id: a.court_id, starts_at: a.starts_at, minutes: String(a.minutes) })}`,
    input: { court_id: z.uuid(), starts_at: z.string().check(z.describe("ISO time, as free_courts gives it")), minutes: z.number().check(z.int()) },
    description: "The price of a court at a time and length for this person (their member price, if they have one), with tax." },
  { name: "open_programs", title: { en: "Clinics, courses and socials", es: "Clínicas, cursos y sociales" }, input: {}, path: () => "/open-programs",
    description: "Clinics, courses and socials open for sign-up: dates, places left, level band and this person's price. Programs signed up date by date list each date's places." },
  { name: "open_matches", title: { en: "Open matches", es: "Partidos abiertos" }, input: {}, path: () => "/open-matches",
    description: "Open matches this person can join or ask to join: court, time, level band, places left and the price of a place." },
  { name: "my_places", title: { en: "My bookings and places", es: "Mis reservas y plazas" }, input: {}, path: () => "/my/places",
    description: "This person's court bookings, matches, lessons and program places to come, with what they owe." },
  { name: "my_level", title: { en: "My level", es: "Mi nivel" }, input: {}, path: () => "/my/level",
    description: "This person's level, how it moved and why, and their games." },
  { name: "my_membership", title: { en: "My membership", es: "Mi membresía" }, input: {}, path: () => "/my/membership",
    description: "This person's membership: the plan, its perks and the next payment." },
  { name: "club_answers", title: { en: "The club's answers", es: "Las respuestas del club" }, path: (a) => `/my/facts?${new URLSearchParams({ q: a.q ?? "" })}`,
    input: { q: z.optional(z.string().check(z.describe("Words to search for; empty lists them all"))) },
    description: "The club's own answers to common questions (hours, parking, prices, rules), word for word. Quote them; for anything else, question_ask_preview asks the staff." },
  { name: "lesson_coaches", title: { en: "Coaches for lessons", es: "Entrenadores para clases" }, input: {}, path: () => "/my/lessons/coaches",
    description: "The coaches who give private lessons, with their ids and rates by length." },
  { name: "lesson_times", title: { en: "A coach's lesson times", es: "Horarios de un entrenador" }, path: (a) => `/my/lessons/times?${new URLSearchParams({ coach_id: a.coach_id, date: a.date, minutes: String(a.minutes) })}`,
    input: { coach_id: z.uuid(), date: ymd, minutes: z.number().check(z.int()) },
    description: "When a coach gives a lesson of a length on a date, with a court free. Use a time from here in lesson_request_preview." },
];
const titleOf = (action: string): Text => (`action.${action}` in en ? both(`action.${action}` as Key) : { en: action, es: action });

/** A tool's input schema without what only validation needs: the converter's long patterns for ids and times,
 *  the widest integer bounds and the $schema line. Every argument is still checked in full when a tool runs. */
function slim(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(slim);
  if (!node || typeof node !== "object") return node;
  const o = node as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "$schema" && typeof v === "string") continue;
    if (k === "pattern" && typeof v === "string" && (o.format === "uuid" || o.format === "date-time" || o.format === "date")) continue;
    if ((k === "minimum" && v === Number.MIN_SAFE_INTEGER) || (k === "maximum" && v === Number.MAX_SAFE_INTEGER)) continue;
    out[k] = slim(v);
  }
  return out;
}
/** The tool list an assistant reads into its context on every turn, kept small (see slim). */
function slimToolList(server: McpServer): void {
  type Handler = (req: unknown, extra: unknown) => Promise<{ tools: { inputSchema?: unknown; execution?: { taskSupport?: string } }[] }>;
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const list = handlers.get("tools/list");
  if (list) handlers.set("tools/list", async (req, extra) => {
    const r = await list(req, extra);
    return { ...r, tools: r.tools.map(({ execution, ...t }: { execution?: { taskSupport?: string }; inputSchema?: unknown }) =>
      ({ ...t, inputSchema: slim(t.inputSchema), ...(execution && execution.taskSupport !== "forbidden" ? { execution } : {}) })) };   // "forbidden" is the default
  });
}

export async function mcpServerFor(db: Db, who: { id: string; display_name: string; locale: string; client_name: string | null; grant_id: string }, now: () => Date,
  read?: (path: string) => Promise<unknown>): Promise<McpServer> {
  const lang: Lang = isLang(who.locale) ? who.locale : "en";
  const actor: Actor = { personId: who.id, via: `mcp:${who.client_name ?? "client"}`, lang, auth: "oauth", grantId: who.grant_id };
  const server = new McpServer({ name: "kumi", version: "0.1.0" }, { instructions: `You act for ${who.display_name} at their padel club. Every change is two steps: call a *_preview tool, show the person the summary in their words, and only after they agree call the matching *_confirm tool with the run_id. Anything that costs them money must fit the weekly limit they set for you (whoami says what's left); over it, the preview fails and they do it in the club's app. Some things are only ever done in the app: their limit for you, how they sign in, accepting a waiver, moving their own level, downloading their data, the family card and saying yes to texts or club news. Reply in ${lang === "es" ? "Spanish" : "English"}.` });
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
  const fail = (e: unknown) => {
    if (e instanceof KumiError) return { isError: true, content: [{ type: "text" as const, text: e.text[lang] }] };
    throw e;
  };

  server.registerTool("whoami", { title: lang === "es" ? "Quién soy" : "Who am I", description: "The signed-in person, their roles and the club.", annotations: { readOnlyHint: true } }, async () => {
    const club = await db.selectFrom("club").select(["name", "time_zone"]).executeTakeFirstOrThrow();
    const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(["role.key", "person_role.location_id"]).where("person_role.person_id", "=", who.id).where("person_role.active", "=", true).execute();
    const g = await db.selectFrom("oauth_grant").select("weekly_cap_cents").where("id", "=", who.grant_id).executeTakeFirstOrThrow();
    const spent = await weekSpent(db, who.grant_id, now());
    return text({ person: who.display_name, language: lang, roles, club,
      spending: { weekly_limit: money(g.weekly_cap_cents, lang), spent_this_week: money(spent, lang), left: money(Math.max(0, g.weekly_cap_cents - spent), lang) } });
  });

  if (read) for (const r of READS) {
    server.registerTool(r.name, { title: r.title[lang], description: r.description, inputSchema: r.input, annotations: { readOnlyHint: true } }, async (args: unknown) => {
      try { return text(await read(r.path(args ?? {}))); } catch (e) { return fail(e); }
    });
  }

  for (const a of actions()) {
    // A tool you may never use doesn't exist for you. Undo is checked against the original change.
    const listed = a.name === "action.undo" || (await mayEverDo(db, who.id, a.name));
    if (a.system || a.internal || a.name.startsWith("test.") || !listed || appOnly(a)) continue;   // never offered: see APP_ONLY
    const base = toolBase(a.name), title = titleOf(a.name);
    const onlyOff = APP_ONLY_YES.has(a.name) ? " Only to turn it off: saying yes is done in the club's app." : "";
    server.registerTool(`${base}_preview`, {
      title: `${title[lang]} (${lang === "es" ? "vista previa" : "preview"})`,
      description: `${title.en}: preview. Gives a summary to show the person and a run_id; nothing changes until ${base}_confirm.${onlyOff}`,
      inputSchema: a.input.shape, annotations: { readOnlyHint: true },
    }, async (args: unknown) => {
      try {
        const p = await plan(db, a.name, args, actor, { now: now() });
        return text({ run_id: p.runId, status: p.status, summary: p.plan.summary[lang], undo: p.plan.undo.kind, expires_at: p.expiresAt,
          next: p.status === "awaiting_approval" ? "This needs a staff member's approval; it will happen once they approve." : `Show the person the summary. If they agree, call ${base}_confirm with this run_id.` });
      } catch (e) { return fail(e); }
    });
    server.registerTool(`${base}_confirm`, {
      title: `${title[lang]} (${lang === "es" ? "confirmar" : "confirm"})`,
      description: `${title.en}: do it, once the person agreed to the ${base}_preview summary. Takes its run_id.`,
      inputSchema: { run_id: z.uuid() }, annotations: { readOnlyHint: false, idempotentHint: true },
    }, async (args: { run_id: string }) => {
      try { return text({ done: true, result: await apply(db, args.run_id, actor, { now: now(), idempotencyKey: `mcp:${args.run_id}` }) }); }
      catch (e) { return fail(e); }
    });
  }
  slimToolList(server);
  return server;
}

export async function handleMcp(req: Request, server: McpServer): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}
