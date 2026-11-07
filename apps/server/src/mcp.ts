// The MCP endpoint: tools generated from the action registry, for the person behind the token.
// Each action is a pair: *_preview returns the plan and a run id, *_confirm applies that run id.
// So an assistant can never apply something different from what it showed the person.
import * as z from "zod/mini";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { both, en, isLang, type Key, type Lang, type Text } from "@kumi/i18n";
import { money } from "@kumi/i18n";
import { actions, apply, appOnly, everDoable, plan, weekSpent, APP_ONLY_YES, KumiError, type ActionDef, type Actor, type Db } from "@kumi/core";
import { VERSION } from "./version.ts";

export const toolBase = (action: string) => action.replace(/\./g, "_");
/** An action the assistant door can ever offer (to someone allowed it): not Kumi's own, not the app's alone. */
export const doorAction = (a: ActionDef<any>) => !a.system && !a.internal && !a.name.startsWith("test.") && !appOnly(a);

/** What an assistant can read: the same answers the members' app gets, for the person behind the token, and for
 *  staff the staff app's main screens. */
const ymd = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/), z.describe("A club date, YYYY-MM-DD"));
export interface DoorRead { name: string; title: Text; description: string; input: Record<string, z.ZodMiniType>; path: (a: any) => string; /** A staff screen's read, offered to staff only. */ staff?: boolean }
const qs = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])).toString();
export const READS: DoorRead[] = [
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
  { name: "my_chats", title: { en: "Chats in my games", es: "Chats de mis partidos" }, input: {}, path: () => "/my/chats",
    description: "The chats in the games the person plays in (court bookings with named players, open matches, program dates), with how many messages are unread. Reading only: an assistant never posts in a chat." },
  { name: "game_chat", title: { en: "A game's chat", es: "El chat de un partido" }, input: { kind: z.enum(["booking", "session"]), id: z.string() }, path: (a) => `/my/chats/${encodeURIComponent(a.kind)}/${encodeURIComponent(a.id)}`,
    description: "One game's chat, as the person reads it (kind and id from my_chats). Reading only: it doesn't mark anything read, and an assistant never posts." },
  { name: "my_places", title: { en: "My bookings and places", es: "Mis reservas y plazas" }, input: {}, path: () => "/my/places",
    description: "This person's court bookings, matches, lessons and program places to come, with what they owe." },
  { name: "my_competitions", title: { en: "My tournaments and leagues", es: "Mis torneos y ligas" }, input: {}, path: () => "/my/competitions",
    description: "This person's tournament and league entries: invitations to answer, their partner, their next matches (court and time), results, scores to confirm, and the group or league table. Scores go through fixture_enter_preview, result_confirm_preview or result_dispute_preview." },
  { name: "my_credit", title: { en: "My club credit", es: "Mi crédito del club" }, input: {}, path: () => "/my/credit",
    description: "This person's club credit: what they hold and what came and went. Read only: credit is spent in the members' app, never through an assistant." },
  { name: "my_gift_cards", title: { en: "My gift cards", es: "Mis tarjetas regalo" }, input: {}, path: () => "/my/gift-cards?codes=0",
    description: "Gift cards this person bought or redeemed, with whether each is ready to give, used or voided (never their codes: those are in the members' app, where redeeming is too)." },
  { name: "my_passes", title: { en: "My passes", es: "Mis bonos" }, input: {}, path: () => "/my/passes",
    description: "This person's passes (uses left, what each covers, any date to use it by) and the passes the club sells. Read only: a pass is spent in the members' app, never through an assistant; buying one is pass.buy." },
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
  // What staff read, as the staff app shows it, through the same checks (reads.ts): a coach still sees only their own
  // work, a role the club made only its areas, and support access never reaches here. Emails and phone numbers come
  // shortened: enough to tell two people apart, never a way to reach them from outside the club's apps.
  { name: "people", staff: true, title: { en: "People", es: "Personas" }, path: (a) => `/staff/people?${qs({ q: a.q ?? "", role: a.role, limit: a.limit })}`,
    input: { q: z.optional(z.string().check(z.describe("A name (or part of one) to search for; empty lists the first ones by name. Emails and phone numbers aren't searched here"))),
      role: z.optional(z.string().check(z.describe("staff, or one role's key: owner, manager, front_desk, coach, accountant"))), limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))) },
    description: "The club's people whose name matches, with their ids, roles and tags (emails shortened). Use an id from here wherever a change asks for a person." },
  { name: "person_page", staff: true, title: { en: "A person's page", es: "La página de una persona" }, input: { person_id: z.uuid() }, path: (a) => `/staff/people/${encodeURIComponent(a.person_id)}`,
    description: "One person's page, as the staff app shows it: bookings, places, membership, family, what they owe and what's owed back (contact details shortened)." },
  { name: "locations", staff: true, title: { en: "Locations", es: "Sedes" }, input: {}, path: () => "/staff/locations",
    description: "The club's locations, with their ids and time zones." },
  { name: "courts", staff: true, title: { en: "Courts", es: "Canchas" }, input: { location_id: z.optional(z.uuid()) }, path: (a) => `/staff/courts?${qs({ location_id: a.location_id })}`,
    description: "The club's courts (or one location's), with their ids, location and kind." },
  { name: "coaches", staff: true, title: { en: "Coaches", es: "Entrenadores" }, input: {}, path: () => "/staff/coaches",
    description: "The coaches, with their ids, profiles, lesson hours and time off (a coach sees only their own)." },
  { name: "programs", staff: true, title: { en: "Programs", es: "Programas" }, input: {}, path: () => "/staff/programs",
    description: "The club's clinics, courses, socials, leagues and tournaments (the latest 100), with their ids, places booked and waitlisted, and first date." },
  { name: "program_page", staff: true, title: { en: "A program", es: "Un programa" }, input: { program_id: z.uuid() }, path: (a) => `/staff/programs/${encodeURIComponent(a.program_id)}`,
    description: "One program: its dates (with their ids, courts and coach), roster and waitlist." },
  { name: "day", staff: true, title: { en: "The day at a location", es: "El día en una sede" }, input: { location_id: z.uuid(), date: z.optional(ymd) }, path: (a) => `/staff/grid?${qs({ location_id: a.location_id, date: a.date })}`,
    description: "A location's courts for a day (today unless a date is given): each booking, block and program date, who's playing and what's owed, as the desk's Courts page shows it." },
  { name: "alerts", staff: true, title: { en: "Alerts", es: "Avisos" }, input: {}, path: () => "/staff/alerts",
    description: "What needs someone at the club now: places left empty at the last minute, questions waiting, money owed, programs short of their minimum, refunds that failed." },
  { name: "reports", staff: true, title: { en: "Reports", es: "Informes" }, input: { location_id: z.uuid(), from: ymd, to: ymd }, path: (a) => `/staff/reports?${qs({ location_id: a.location_id, from: a.from, to: a.to })}`,
    description: "A location's money and use, day by day, between two dates (both included), as the Reports page shows it." },
  { name: "memberships", staff: true, title: { en: "Memberships", es: "Membresías" }, input: {}, path: () => "/staff/memberships",
    description: "The membership plans, how many hold each, and the members on them (emails shortened)." },
  { name: "questions", staff: true, title: { en: "Members' questions", es: "Preguntas de los miembros" }, input: { view: z.optional(z.enum(["waiting", "answered", "closed"])) }, path: (a) => `/staff/questions?${qs({ view: a.view })}`,
    description: "Members' questions to the club: waiting for an answer (the default), answered or closed." },
];
/** An email or phone number as a staff read through the door shows it: the first letter and the domain, or the last
 *  two digits. */
export function shortContact(kind: "email" | "phone", v: unknown): unknown {
  if (typeof v !== "string" || !v) return v;
  if (kind === "email") { const at = v.indexOf("@"); return at > 0 ? `${v[0]}...${v.slice(at)}` : "..."; }
  return `...${v.replace(/\D/g, "").slice(-2)}`;
}
const CONTACT: Record<string, "email" | "phone"> = { email: "email", contact_email: "email", reply_to: "email", phone: "phone", contact_phone: "phone" };
// An email, or a phone number written as one (+1 415 555 0142, (415) 555-0142, 4155550142), inside any text: an alert, a note, why
// an address is held back. Never inside an id or a date (not after a letter, digit or hyphen, nor before one).
const EMAIL_IN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE_IN = /(?<![\w-])(?:\+\d[\d\s().-]{6,}\d|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}|\d{10,15})(?![\w-])/g;
/** What the asker gave in their own input (emails, and phones as digits): those come back as they were typed. */
export function givenContacts(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === "string") {
    for (const m of v.match(EMAIL_IN) ?? []) out.add(m.toLowerCase());
    const digits = v.replace(/\D/g, "");
    if (digits.length >= 7 && /^[+\d\s().-]+$/.test(v.trim())) out.add(digits);
  } else if (Array.isArray(v)) for (const x of v) givenContacts(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) givenContacts(x, out);
  return out;
}
export function shortenInText(text: string, given: Set<string> = new Set()): string {
  return text.replace(EMAIL_IN, (m) => given.has(m.toLowerCase()) ? m : String(shortContact("email", m)))
    .replace(PHONE_IN, (m) => given.has(m.replace(/\D/g, "")) ? m : String(shortContact("phone", m)));
}
/** A staff read, a preview or a result as the door returns it: emails and phones shortened, by field and in text. */
export function shortenContacts(v: unknown, given: Set<string> = new Set()): unknown {
  if (typeof v === "string") return shortenInText(v, given);
  if (Array.isArray(v)) return v.map((x) => shortenContacts(x, given));
  if (!v || typeof v !== "object" || v instanceof Date) return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, CONTACT[k] && !(typeof x === "string" && given.has(CONTACT[k] === "email" ? x.toLowerCase() : x.replace(/\D/g, ""))) ? shortContact(CONTACT[k]!, x) : shortenContacts(x, given)]));
}
const titleOf = (action: string): Text => (`action.${action}` in en ? both(`action.${action}` as Key) : { en: action, es: action });

/** A tool's input schema without what only validation needs: the converter's long patterns for ids and times,
 *  the widest integer bounds and the $schema line. Every argument is still checked in full when a tool runs. */
export function slim(node: unknown): unknown {
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
  read?: (path: string) => Promise<unknown>, readStaff?: (path: string) => Promise<unknown>): Promise<McpServer> {
  const lang: Lang = isLang(who.locale) ? who.locale : "en";
  const actor: Actor = { personId: who.id, via: `mcp:${who.client_name ?? "client"}`, lang, auth: "oauth", grantId: who.grant_id };
  const server = new McpServer({ name: "kumi", version: VERSION }, { instructions: `You act for ${who.display_name} at their padel club. Every change is two steps: call a *_preview tool, show the person the summary in their words, and only after they agree call the matching *_confirm tool with the run_id. Anything that costs them money must fit the weekly limit they set for you (whoami says what's left); over it, the preview fails and they do it in the club's app. Some things are only ever done in the app: their limit for you, how they sign in, accepting a waiver, moving their own level, downloading their data, the family card and saying yes to texts or club news. Reply in ${lang === "es" ? "Spanish" : "English"}.` });
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
  // The words for the person, and for a program reading the answer (the command line) the failure's key and status.
  const fail = (e: unknown) => {
    if (e instanceof KumiError) return { isError: true, content: [{ type: "text" as const, text: e.text[lang] }], _meta: { "kumi/error": e.code, "kumi/status": e.status } };
    throw e;
  };

  server.registerTool("whoami", { title: lang === "es" ? "Quién soy" : "Who am I", description: "The signed-in person, their roles and the club.", annotations: { readOnlyHint: true } }, async () => {
    const club = await db.selectFrom("club").select(["name", "time_zone"]).executeTakeFirstOrThrow();
    const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(["role.key", "person_role.location_id"]).where("person_role.person_id", "=", who.id).where("person_role.active", "=", true).execute();
    const g = await db.selectFrom("oauth_grant").select("weekly_cap_cents").where("id", "=", who.grant_id).executeTakeFirstOrThrow();
    const spent = await weekSpent(db, who.grant_id, now());
    return text({ person: who.display_name, person_id: who.id, language: lang, roles, club, connection: { id: who.grant_id, name: who.client_name },
      spending: { weekly_limit: money(g.weekly_cap_cents, lang), spent_this_week: money(spent, lang), left: money(Math.max(0, g.weekly_cap_cents - spent), lang) } });
  });

  const staff = readStaff ? Boolean(await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key").where("person_role.person_id", "=", who.id)
    .where("person_role.active", "=", true).where("role.active", "=", true).where("role.key", "!=", "member").executeTakeFirst()) : false;
  for (const r of READS) {
    const from = r.staff ? (staff ? readStaff : undefined) : read;
    if (!from) continue;
    server.registerTool(r.name, { title: r.title[lang], description: r.description, inputSchema: r.input, annotations: { readOnlyHint: true } }, async (args: unknown) => {
      try { const v = await from(r.path(args ?? {})); return text(r.staff ? shortenContacts(v) : v); } catch (e) { return fail(e); }
    });
  }

  const may = await everDoable(db, who.id);
  for (const a of actions()) {
    // A tool you may never use doesn't exist for you. Undo is checked against the original change.
    const listed = a.name === "action.undo" || may(a.name);
    if (!doorAction(a) || !listed) continue;   // never offered: see APP_ONLY
    const base = toolBase(a.name), title = titleOf(a.name);
    const onlyOff = APP_ONLY_YES.has(a.name) ? " Only to turn it off: saying yes is done in the club's app." : "";
    server.registerTool(`${base}_preview`, {
      title: `${title[lang]} (${lang === "es" ? "vista previa" : "preview"})`,
      description: `${title.en}: preview. Gives a summary to show the person and a run_id; nothing changes until ${base}_confirm.${onlyOff}`,
      inputSchema: a.input.shape, annotations: { readOnlyHint: true },
    }, async (args: unknown) => {
      try {
        const p = await plan(db, a.name, args, actor, { now: now() });
        // A preview's words shortened as staff reads are: what it names that the asker didn't type comes back short.
        return text({ run_id: p.runId, status: p.status, summary: shortenInText(p.plan.summary[lang], givenContacts(args)), undo: p.plan.undo.kind, expires_at: p.expiresAt,
          next: p.status === "awaiting_approval" ? "This needs a staff member's approval; it will happen once they approve." : `Show the person the summary. If they agree, call ${base}_confirm with this run_id.` });
      } catch (e) { return fail(e); }
    });
    server.registerTool(`${base}_confirm`, {
      title: `${title[lang]} (${lang === "es" ? "confirmar" : "confirm"})`,
      description: `${title.en}: do it, once the person agreed to the ${base}_preview summary. Takes its run_id.`,
      inputSchema: { run_id: z.uuid() }, annotations: { readOnlyHint: false, idempotentHint: true },
    }, async (args: { run_id: string }) => {
      try { return text({ done: true, result: shortenContacts(await apply(db, args.run_id, actor, { now: now(), idempotencyKey: `mcp:${args.run_id}` })) }); }
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
