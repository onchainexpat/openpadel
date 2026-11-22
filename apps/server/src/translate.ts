// "Offer a draft": the club's own words (a plan's description, a program's name, the waiver, a coach's bio) put
// into the club's other language by Claude Haiku, through the same Anthropic key ask the club uses
// (OPENPADEL_ANTHROPIC_API_KEY). The draft lands in the staff form's field: a person reads it, changes what needs
// changing and saves it. Nothing is saved from here. Only the text to translate leaves the server. Each draft
// counts on the club's monthly meter (usage.ts), and past the club's limit there are none until the 1st.
import Anthropic from "@anthropic-ai/sdk";
import { Hono, type Context } from "hono";
import { countAi, KumiError, supportRoleKeys, usageAllows, type Db } from "@kumi/core";
import { isLang, type Lang } from "@kumi/i18n";
import { HAIKU_MODEL } from "./answerer.ts";
import { setting } from "@kumi/core";

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** The draft, and what it used (for the meter). */
export type Translator = (text: string, from: Lang, to: Lang) => Promise<{ text: string; tokens: { input: number; output: number } }>;

const NAMES: Record<Lang, string> = { en: "English (United States)", es: "Spanish (as spoken in the United States)" };
const SYSTEM = (from: Lang, to: Lang) => `You translate a padel club's own text for its members: a membership plan, a program's name, the club's waiver, a coach's bio, a price's name or the club's short description. Translate from ${NAMES[from]} into ${NAMES[to]}.
Keep the meaning exactly: every amount, time, date, age, number, name of a person or place, and line break stays as it is. Add nothing and leave nothing out. Use the plain, friendly words the club would use, the usual padel terms in that language, and no em dashes. A legal text such as a waiver stays as formal and complete as the original.
Return only the translation in the "translation" field.`;

let current: Translator | null = null;
export function setTranslator(t: Translator | null) { current = t; }
export const translatorOn = () => current !== null;

export function haikuTranslator(key: string, fetchFn?: Fetch): Translator {
  const client = new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 1, ...(fetchFn ? { fetch: fetchFn as never } : {}) });
  return async (text, from, to) => {
    const schema = { type: "object", additionalProperties: false, required: ["translation"], properties: { translation: { type: "string" } } };
    const m = await client.messages.create({ model: HAIKU_MODEL, max_tokens: 8000, system: SYSTEM(from, to), thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema } }, messages: [{ role: "user", content: text }] });
    if (m.stop_reason !== "end_turn") throw new Error(`stopped: ${m.stop_reason}`);
    const block = m.content.find((b) => b.type === "text");
    const out = (JSON.parse(block && block.type === "text" ? block.text : "") as { translation?: unknown }).translation;
    if (typeof out !== "string" || !out.trim()) throw new Error("no translation");
    return { text: out.trim(), tokens: { input: m.usage.input_tokens, output: m.usage.output_tokens } };
  };
}
/** The translator the server's settings turn on: Haiku when an Anthropic key is set, otherwise none (no button). */
export function translatorFromEnv(env: Env, fetchFn?: Fetch): Translator | null {
  const key = setting("ANTHROPIC_API_KEY", env)?.trim();
  return key ? haikuTranslator(key, fetchFn) : null;
}

const PER_HOUR = 40;
type Me = { id: string } | null;
export function translateRoutes(db: Db, me: (c: Context<any>) => Me, opts: { now?: () => Date } = {}) {
  const app = new Hono(), used = new Map<string, number[]>(), now = opts.now ?? (() => new Date());
  // POST { text, from, to } -> { draft }. Staff only, a few dozen an hour each.
  app.post("/staff/translate", async (c) => {
    const m = me(c);
    if (!m) throw new KumiError("error.signed_out", {}, 401);
    const staff = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", m.id).where("person_role.active", "=", true).where("role.active", "=", true).where("role.key", "!=", "member").executeTakeFirst();
    if (!staff && !(await supportRoleKeys(db, m.id)).length) throw new KumiError("error.staff_only", {}, 403);
    if (!current) throw new KumiError("error.no_drafts", {}, 404);
    const b = await c.req.json().catch(() => ({})) as { text?: unknown; from?: unknown; to?: unknown };
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text || text.length > 20_000 || !isLang(b.from) || !isLang(b.to) || b.from === b.to) throw new KumiError("error.invalid_input", { details: "text, from and to" }, 400);
    const at = now().getTime(), mine = (used.get(m.id) ?? []).filter((t) => t > at - 3_600_000);
    if (mine.length >= PER_HOUR) throw new KumiError("error.too_many_drafts", {}, 429);
    if (!(await usageAllows(db, "can_wait", 0, now()))) throw new KumiError("error.drafts_paused", {}, 429);
    used.set(m.id, [...mine, at]);
    let d: Awaited<ReturnType<Translator>>;
    try { d = await current(text, b.from, b.to); }
    catch { throw new KumiError("error.draft_failed", {}, 502); }
    await countAi(db, "ai_drafts", "haiku", d.tokens, now()).catch(() => {});
    return c.json({ draft: d.text });
  });
  return app;
}
