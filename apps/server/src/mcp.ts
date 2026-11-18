// The MCP endpoint: tools generated from the action registry, for the person behind the token.
// Each action is a pair: *_preview returns the plan and a run id, *_confirm applies that run id.
// So an assistant can never apply something different from what it showed the person.
import * as z from "zod/mini";
import { sql } from "kysely";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { both, en, isLang, type Key, type Lang, type Text } from "@kumi/i18n";
import { money } from "@kumi/i18n";
import { actions, agentActor, agentWeekSpent, AGENT_OWN, PLUGIN_OWN, apply, appOnly, everDoable, plan, pluginOfAgent, pluginSecretFor, pluginSecrets, weekSpent, APP_ONLY_YES, KumiError, type ActionDef, type Actor, type Db, type Limited, type Manifest } from "@kumi/core";
import { VERSION } from "./version.ts";

export const toolBase = (action: string) => action.replace(/\./g, "_");
/** An action the assistant door can ever offer (to someone allowed it): not Kumi's own, not the app's alone. */
export const doorAction = (a: ActionDef<any>) => !a.system && !a.internal && !a.name.startsWith("test.") && !appOnly(a);

/** What an assistant can read: the same answers the members' app gets, for the person behind the token, and for
 *  staff the staff app's main screens. */
const ymd = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/), z.describe("A club date, YYYY-MM-DD"));
export interface DoorRead { name: string; title: Text; description: string; input: Record<string, z.ZodMiniType>; path: (a: any) => string; /** A staff screen's read, offered to staff only. */ staff?: boolean;
  /** Its command line words when not its name's (`openpadel plugin search`). */ words?: string[] }
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
    description: "A location's courts for a day (today unless a date is given): each booking, block and program date, who's playing and what's owed, as the staff app's Schedule shows it." },
  { name: "alerts", staff: true, title: { en: "Alerts", es: "Avisos" }, input: {}, path: () => "/staff/alerts",
    description: "What needs someone at the club now: places left empty at the last minute, questions waiting, money owed, programs short of their minimum, refunds that failed." },
  { name: "reports", staff: true, title: { en: "Reports", es: "Informes" }, input: { location_id: z.uuid(), from: ymd, to: ymd }, path: (a) => `/staff/reports?${qs({ location_id: a.location_id, from: a.from, to: a.to })}`,
    description: "A location's money and use, day by day, between two dates (both included), as the Reports page shows it." },
  { name: "money_books", words: ["money", "books"], staff: true, title: { en: "The books, day by day", es: "La contabilidad, día por día" }, input: { from: ymd, to: ymd },
    path: (a) => `/staff/money/books?${qs({ from: a.from, to: a.to })}`,
    description: "The club's books for each club day between two dates (both included, at most 31): what the ledger moved by kind of account (takings and refunds by kind, tax, club credit, gift cards, passes, card payments, cash, what's owed), the card provider's fees and the payouts that reached the bank. Signed cents (positive a debit), each day balanced; amounts and kinds only, no people." },
  { name: "memberships", staff: true, title: { en: "Memberships", es: "Membresías" }, input: {}, path: () => "/staff/memberships",
    description: "The membership plans, how many hold each, and the members on them (emails shortened)." },
  { name: "questions", staff: true, title: { en: "Members' questions", es: "Preguntas de los miembros" }, input: { view: z.optional(z.enum(["waiting", "answered", "closed"])) }, path: (a) => `/staff/questions?${qs({ view: a.view })}`,
    description: "Members' questions to the club: waiting for an answer (the default), answered or closed." },
  { name: "moving_in", staff: true, title: { en: "Moving in", es: "La mudanza" }, input: {}, path: () => "/staff/move-in/steps",
    description: "Where the club is in its move from Playtomic, Playbypoint or spreadsheets (connect, review, practice run, switch-over, wrap up): the step, what each step sees for itself, the items staff tick (move_check_preview), and the practice run's comparison of the old records with what has come over. For the owner and managers." },
  // The club-news list (reads.ts): who said yes to club news by email. Emails come whole only to a plugin whose manifest
  // reads club_news (a marketing sync needs the address); everyone else through the door sees them shortened.
  { name: "club_news_list", words: ["club-news", "list"], staff: true, title: { en: "The club news list", es: "La lista de novedades del club" },
    input: { after: z.optional(z.uuid().check(z.describe("The `next` of the page before, for the page after it"))), limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))) },
    path: (a) => `/staff/club-news/list?${qs({ after: a.after, limit: a.limit })}`,
    description: "The members whose latest answer to club news by email is yes (adults with an account and an email), 500 at a time in id order: each one's id, email, first name and language, and nothing else, with how many there are and `next` for the following page. Who said no, never answered, was deleted or is a junior isn't in it. Emails come shortened, except to a plugin whose manifest reads club_news." },
  // Plugins (plugins.ts): the catalog, one plugin in it, what's installed, and the services that see member data.
  { name: "plugin_search", words: ["plugin", "search"], staff: true, title: { en: "Search the plugin catalog", es: "Buscar en el catálogo de plugins" }, input: { q: z.optional(z.string().check(z.maxLength(100), z.describe("Words to look for (cameras, lights, accounting); empty lists them all"))) },
    path: (a) => `/staff/plugins/catalog?${qs({ q: a.q })}`,
    description: "Plugins in the club's catalog (openPadel's reviewed one) whose name, publisher or description has the words: what each does, whether it charges, whether it's installed, and the command to install it." },
  { name: "plugin_info", words: ["plugin", "info"], staff: true, title: { en: "A plugin in the catalog", es: "Un plugin del catálogo" }, input: { name: z.string().check(z.regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/), z.describe("Its name, as plugin_search gives it")) },
    path: (a) => `/staff/plugins/catalog/${encodeURIComponent(a.name)}`,
    description: "Everything a plugin's manifest asks for, in words to show the owner before installing: what it does, what it will be able to do and read, the events it gets, what member data it sends where, the keys it needs (and where the owner gets each), its cost, where it runs and its settings. Then plugin_install_preview." },
  { name: "plugins", words: ["plugin", "list"], staff: true, title: { en: "Installed plugins", es: "Plugins instalados" }, input: {}, path: () => "/staff/plugins",
    description: "The club's installed plugins: status (waiting for its registration, on, paused), health, its keys (added, with the last four characters, or still needed), settings, and what each may do and sends. A key is never shown: the owner adds it in the vault." },
  // The Connectors page (connectors.ts): what's connected and whether it's healthy.
  { name: "connectors", words: ["connectors"], staff: true, title: { en: "Connectors", es: "Conectores" }, input: { fresh: z.optional(z.boolean().check(z.describe("Check every service again now, rather than the last minute's answer"))) },
    path: (a) => `/staff/connectors?${qs({ fresh: a.fresh ? "1" : undefined })}`,
    description: "Everything the club plugs into and whether it's working: the built-in services (Stripe, Resend for email, Twilio for texts, Playtomic, offsite backups) judged by openpadel doctor's checks, and each installed plugin, each with its status (on, waiting, attention, off), what it does and may do, its health and last event, and its keys (added with their last four, or missing: never the key). Then the club's agents and people's assistants, and how to connect something new (plugin_search, plugin_info, plugin_install_preview). For the owner and managers." },
  { name: "processors", words: ["processors"], staff: true, title: { en: "Services that see member data", es: "Servicios que ven datos de miembros" }, input: {}, path: () => "/staff/processors",
    description: "The outside services that see member data, with each installed plugin's data out added automatically: for the club's privacy policy (rows, and the same as Markdown table rows)." },
];
/** An email or phone number as a staff read through the door shows it: the first letter and the domain, or the last
 *  two digits. */
export function shortContact(kind: "email" | "phone", v: unknown): unknown {
  if (typeof v !== "string" || !v) return v;
  if (kind === "email") { const at = v.indexOf("@"); return at > 0 ? `${v[0]}...${v.slice(at)}` : "..."; }
  return `...${v.replace(/\D/g, "").slice(-2)}`;
}
const CONTACT: Record<string, "email" | "phone"> = { email: "email", contact_email: "email", reply_to: "email", phone: "phone", contact_phone: "phone" };
// An email (josé@example.test too), or a phone number as people write one, inside any text: an alert, a note, why an
// address is held back. Never inside another word or number, never a date, never a field that names an id.
// A phone is written one of these ways:
// - with a + and its country code: +1 415 555 0142, +14155550142, +44 20 7946 0958 (8 to 15 digits);
// - in groups, with the spaces, dashes, dots or brackets phones are written with, one group of 3 digits or more,
//   9 to 15 digits in all: (415) 555-0142, 415-5550142, 07700 900123, 020 7946 0958, 612 345 678;
// - bare, only as a US or Canadian number (10 digits, or 11 starting with 1, its area code and exchange 2-9) right
//   after a word that says it's one ("call 4155550142", "móvil 4155550142"). A bare run is otherwise left alone: it's
//   usually an invoice, an order or a member number ("invoice 123456789", "member number 12345678901").
const EMAIL_IN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const PHONE_IN = /(?<![\p{L}\p{N}_./:+#-])(?:\+\d{1,3}[ .-]?)?\(?\d{2,5}\)?(?:[ .-]?\(?\d{2,5}\)?){1,5}(?![\p{L}\p{N}_/:-]|[.,]\d)/gu;
const PHONE_WORD = /(?:call|ring|phone|tel|text|mobile|cell|sms|whats ?app|number is|reach me|teléfono|telefono|móvil|movil|celular|llama|llámame|llamame|mensaje)\W{0,4}(?:\p{L}+\W{1,3}){0,2}$/iu;
function phoneLike(m: string, before: string): boolean {
  const t = m.trim(), digits = t.replace(/\D/g, ""), n = digits.length;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return false;
  if (t.startsWith("+")) return n >= 8 && n <= 15;
  if (/[\s().-]/.test(t)) return n >= 9 && n <= 15 && /\d{3}/.test(t);
  return /^1?[2-9]\d{2}[2-9]\d{6}$/.test(digits) && PHONE_WORD.test(before.slice(-40));
}
/** A date or a time on its own (2026-11-07, 2026-11-07T18:00:00.000Z), as most of a read's digits come. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** Digits in a text, up to 8 (all that's needed to know there's no phone in it). */
const someDigits = (s: string) => { let n = 0; for (let i = 0; i < s.length && n < 8; i++) { const c = s.charCodeAt(i); if (c >= 48 && c <= 57) n++; } return n; };
/** A field whose name says it holds an id (id, event_id, run_ids, ref): passed through whole, whatever its digits. */
const ID_KEY = /^(id|ids|ref)$|_(id|ids|ref)$/;
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
  // Most of what a staff read returns (names, ids, times, amounts) has no @ and too few digits: left as it is at once.
  const at = text.includes("@"), digits = someDigits(text) >= 8 && !ISO_TIME.test(text);
  if (!at && !digits) return text;
  let out = at ? text.replace(EMAIL_IN, (m) => given.has(m.toLowerCase()) ? m : String(shortContact("email", m))) : text;
  if (digits) out = out.replace(PHONE_IN, (m: string, at: number, whole: string) => !phoneLike(m, whole.slice(0, at)) || given.has(m.replace(/\D/g, "")) ? m : String(shortContact("phone", m)));
  return out;
}
/** A staff read, a preview or a result as the door returns it: emails and phones shortened, by field and in text. */
export function shortenContacts(v: unknown, given: Set<string> = new Set()): unknown {
  if (typeof v === "string") return shortenInText(v, given);
  if (Array.isArray(v)) return v.map((x) => shortenContacts(x, given));
  if (!v || typeof v !== "object" || v instanceof Date) return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ID_KEY.test(k) ? x
    : CONTACT[k] && !(typeof x === "string" && given.has(CONTACT[k] === "email" ? x.toLowerCase() : x.replace(/\D/g, ""))) ? shortContact(CONTACT[k]!, x) : shortenContacts(x, given)]));
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

/** Errors that would say whether an email or phone is someone's at the club: through the door, a plain refusal. */
const SAYS_WHO = new Set(["error.duplicate_email", "error.duplicate_phone", "error.phone_taken", "error.email_taken"]);

/** How the door is opened in-process, for Ask openPadel (assistant.ts): the `via` its runs carry; a change that needs
 *  someone else's yes only shown until the person says to ask, as the staff app's first look does (holdAsk); and the
 *  members' app's assistant held to a member's reach whatever roles the person has (memberOnly). */
export interface DoorOpts { via?: string; holdAsk?: boolean; memberOnly?: boolean }

/** `limited`: the connection works as a member's until it's allowed again (assistant_reach.ts), and why. */
/** `agent_id`: a club agent's connection (agents.ts), which acts as the agent, on behalf of the club. */
export async function mcpServerFor(db: Db, who: { id: string; display_name: string; locale: string; client_name: string | null; grant_id: string; agent_id?: string | null }, now: () => Date,
  read?: (path: string) => Promise<unknown>, readStaff?: (path: string) => Promise<unknown>, limited: Limited | null = null, opts: DoorOpts = {}): Promise<McpServer> {
  const lang: Lang = isLang(who.locale) ? who.locale : "en";
  const memberOnly = Boolean(limited) || Boolean(opts.memberOnly);
  const agent = who.agent_id ? { id: who.agent_id, name: who.display_name } : null;
  const actor: Actor = agent ? agentActor(agent, who.id, who.grant_id, lang) : { personId: who.id, via: opts.via ?? `mcp:${who.client_name ?? "client"}`, lang, auth: "oauth", grantId: who.grant_id, memberOnly };
  const server = new McpServer({ name: "kumi", version: VERSION }, { instructions: agent ? agentInstructions(who.display_name, lang) : `You act for ${who.display_name} at their padel club. Every change is two steps: call a *_preview tool, show the person the summary in their words, and only after they agree call the matching *_confirm tool with the run_id. Anything that costs them money must fit the weekly limit they set for you (whoami says what's left); over it, the preview fails and they do it in the club's app. Some things are only ever done in the app: their limit for you, how they sign in, accepting a waiver, moving their own level, downloading their data, the family card and saying yes to texts or club news. Reply in ${lang === "es" ? "Spanish" : "English"}.` });
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
  // The words for the person, and for a program reading the answer (the command line) the failure's key and status.
  const fail = (e: unknown) => {
    if (e instanceof KumiError && SAYS_WHO.has(e.code)) e = new KumiError("error.door_not_here", {}, 409);
    if (e instanceof KumiError) return { isError: true, content: [{ type: "text" as const, text: e.text[lang] }], _meta: { "kumi/error": e.code, "kumi/status": e.status } };
    throw e;
  };

  server.registerTool("whoami", { title: lang === "es" ? "Quién soy" : "Who am I", description: "The signed-in person, their roles and the club.", annotations: { readOnlyHint: true } }, async () => {
    const club = await db.selectFrom("club").select(["name", "time_zone"]).executeTakeFirstOrThrow();
    const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(["role.key", "person_role.location_id"]).where("person_role.person_id", "=", who.id).where("person_role.active", "=", true).execute();
    if (agent) {
      // A club agent: its role, and the money its changes moved this week against the club's limit for it.
      const a = await db.selectFrom("agent").select("weekly_cap_cents").where("id", "=", agent.id).executeTakeFirstOrThrow();
      const moved = await agentWeekSpent(db, agent.id, now());
      return text({ person: who.display_name, person_id: who.id, agent: { id: agent.id, name: agent.name }, language: lang, roles, club, connection: { id: who.grant_id, name: agent.name, kind: "club_agent" },
        spending: { weekly_limit: money(a.weekly_cap_cents, lang), spent_this_week: money(moved, lang), left: money(Math.max(0, a.weekly_cap_cents - moved), lang), counts: "money its changes move" } });
    }
    const g = await db.selectFrom("oauth_grant").select("weekly_cap_cents").where("id", "=", who.grant_id).executeTakeFirstOrThrow();
    const spent = await weekSpent(db, who.grant_id, now());
    return text({ person: who.display_name, person_id: who.id, language: lang, roles, club, connection: { id: who.grant_id, name: who.client_name },
      ...(limited ? { limited: { why: limited, note: both(limited === "widened" ? "consent.door_limited_widened" : "consent.door_limited_second_step")[lang] } } : {}),
      spending: { weekly_limit: money(g.weekly_cap_cents, lang), spent_this_week: money(spent, lang), left: money(Math.max(0, g.weekly_cap_cents - spent), lang) } });
  });

  // Whether anything one of the person's own changes made has been changed again since, by anyone: the command line
  // asks before it says a change asked for again is already done.
  server.registerTool("changed_since", { title: lang === "es" ? "Cambiado desde entonces" : "Changed since", description: "Whether anything one of your own changes (its run_id) made has been changed again since, by anyone, in the app or here.",
    inputSchema: { run_id: z.uuid() }, annotations: { readOnlyHint: true } }, async (args: { run_id: string }) => {
    const run = await db.selectFrom("action_run").select(["actor_person_id", "status"]).where("id", "=", args.run_id).executeTakeFirst();
    if (!run || run.actor_person_id !== who.id) return fail(new KumiError("error.not_found", { thing: both("thing.change") }, 404));
    const last = await db.selectFrom("entity_change").select((eb) => eb.fn.max("id").as("m")).where("action_run_id", "=", args.run_id).executeTakeFirst();
    if (!last?.m) return text({ changed: false, status: run.status });
    const later = await db.selectFrom("entity_change as ec").select("ec.id").where("ec.action_run_id", "!=", args.run_id).where(sql<boolean>`ec.id > ${last.m}::bigint`)
      .where(sql<boolean>`(ec.entity, ec.entity_id) IN (SELECT entity, entity_id FROM entity_change WHERE action_run_id = ${args.run_id})`).limit(1).executeTakeFirst();
    return text({ changed: Boolean(later), status: run.status });
  });

  // A plugin's agent (plugins.ts) reads its own settings and its own declared keys, by name, and nothing else of the vault.
  const plugin = agent ? await pluginOfAgent(db, agent.id) : null;
  if (plugin && agent) {
    server.registerTool("plugin_settings", { title: lang === "es" ? "Mi configuración" : "My settings", description: "This plugin's settings as the club set them, its status, and whether each key its manifest declares has been added (with its last four characters).",
      annotations: { readOnlyHint: true } }, async () => {
      const now_ = await pluginOfAgent(db, agent.id);
      if (!now_) return fail(new KumiError("error.not_found", { thing: both("thing.plugin") }, 404));
      const m = now_.manifest as Manifest;
      return text({ name: now_.name, version: now_.release, status: now_.status, settings: now_.settings, events: m.events,
        keys: (await pluginSecrets(db, now_.name, m, (now_.settings ?? {}) as Record<string, unknown>)).map((k) => ({ name: k.name, added: k.added, last4: k.last4, ...(k.kept_by_plugin ? { kept_by_plugin: true } : {}), ...(k.optional ? { optional: true } : {}) })) });
    });
    server.registerTool("plugin_secret", { title: lang === "es" ? "Una de mis claves" : "One of my keys", description: "One key this plugin's manifest declares, by its name (HA_TOKEN), from the club's vault. Each read is kept on record.",
      inputSchema: { name: z.string().check(z.regex(/^[A-Z][A-Z0-9_]{1,63}$/)) }, annotations: { readOnlyHint: true } }, async (args: { name: string }) => {
      try { const k = await pluginSecretFor(db, agent.id, args.name); return k ? text(k) : fail(new KumiError("error.not_found", { thing: both("thing.plugin") }, 404)); } catch (e) { return fail(e); }
    });
  }

  const staff = !memberOnly && readStaff ? Boolean(await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key").where("person_role.person_id", "=", who.id)
    .where("person_role.active", "=", true).where("role.active", "=", true).where("role.key", "!=", "member").executeTakeFirst()) : false;
  // A plugin whose manifest reads the club-news list gets its emails whole (the read itself checks it reads it).
  const whole = Boolean(plugin && ((plugin.manifest as Manifest).reads ?? []).includes("club_news"));
  for (const r of READS) {
    const from = r.staff ? (staff ? readStaff : undefined) : read;
    if (!from) continue;
    server.registerTool(r.name, { title: r.title[lang], description: r.description, inputSchema: r.input, annotations: { readOnlyHint: true } }, async (args: unknown) => {
      try { const v = await from(r.path(args ?? {})); return text(r.staff && !(whole && r.name === "club_news_list") ? shortenContacts(v) : v); } catch (e) { return fail(e); }
    });
  }

  const may = await everDoable(db, who.id, { memberOnly });
  for (const a of actions()) {
    // A tool you may never use doesn't exist for you. Undo is checked against the original change. A club agent looks
    // after its own webhooks whatever its role (AGENT_OWN), and never makes or changes agents.
    if (agent && a.name.startsWith("agent.")) continue;
    // A plugin's webhook and keys come with its manifest: it never subscribes, installs or changes plugins itself. Its
    // own cards (plugin_cards.ts) are its alone: listed for a plugin, and for nobody else whatever their role holds.
    const own = PLUGIN_OWN.includes(a.name);
    if (plugin ? !own && (a.name.startsWith("webhook.") || a.name.startsWith("plugin.")) : own) continue;
    const listed = a.name === "action.undo" || own || may(a.name) || (agent !== null && AGENT_OWN.includes(a.name));
    if (!doorAction(a) || !listed) continue;   // never offered: see APP_ONLY
    const base = toolBase(a.name), title = titleOf(a.name);
    const onlyOff = APP_ONLY_YES.has(a.name) ? " Only to turn it off: saying yes is done in the club's app." : "";
    server.registerTool(`${base}_preview`, {
      title: `${title[lang]} (${lang === "es" ? "vista previa" : "preview"})`,
      description: `${title.en}: preview. Gives a summary to show the person and a run_id; nothing changes until ${base}_confirm.${onlyOff}`,
      inputSchema: a.input.shape, annotations: { readOnlyHint: true },
    }, async (args: unknown) => {
      try {
        const p = await plan(db, a.name, args, actor, { now: now(), holdAsk: opts.holdAsk });
        // A preview's words shortened as staff reads are: what it names that the asker didn't type comes back short.
        return text({ run_id: p.runId, status: p.status, summary: shortenInText(p.plan.summary[lang], givenContacts(args)), undo: p.plan.undo.kind, expires_at: p.expiresAt, yeses_needed: p.yesesNeeded,
          next: p.status === "awaiting_approval" ? (p.yesesNeeded > 1 ? "This needs two different staff members' approval (the club's rule for this change); it will happen once both approve." : "This needs a staff member's approval; it will happen once they approve.") : `Show the person the summary. If they agree, call ${base}_confirm with this run_id.` });
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

/** What a club agent is told when it connects: it acts for the club, previews before it changes anything, and its
 *  asks wait for a person. */
function agentInstructions(name: string, lang: Lang): string {
  return `You are ${name}, a club agent at a padel club: you act for the club, not for any one person, within the role the club gave you. Every change is two steps: call a *_preview tool, then the matching *_confirm tool with its run_id. When a preview says it needs a staff member's approval, it waits in the club's Approvals until a person says yes: don't ask again. Changes that move money must fit the weekly limit the club set for you (whoami says what's left). You can subscribe to the club's events with webhook_subscribe_preview; each delivery is signed (openpadel-signature). Reply in ${lang === "es" ? "Spanish" : "English"}.`;
}

export async function handleMcp(req: Request, server: McpServer): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}
