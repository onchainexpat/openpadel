// Asking the club (v1 scope, Help): the club's approved answers ("club facts"), and members' questions
// as threads the staff answer from one inbox. A member sees the common questions first, searched by
// plain words; what they still ask goes to the staff, and front desk hears once if it waits longer than
// the club's setting, counted in opening hours.
//
// "Ask the club" puts a decision model in front later (decisions.md): the answerer below is given the
// question and the switched-on facts, and either picks one fact to send word for word or hands the
// question to staff. The one set by default always hands it to staff. Whatever it decides is kept with
// the version of its questions, and a member's "that didn't answer it" is kept on the decision as a label.
import * as z from "zod/mini";
import { both, pickLang, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, runAsSystem, type ApplyCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { localDate } from "./clock.ts";
import { openingOn } from "./bookings.ts";
import { managersOf, withManagers } from "./households.ts";

export const FACT_TOPICS = ["general", "hours", "prices", "bookings", "memberships", "programs", "lessons", "juniors", "rules", "parking", "facilities"] as const;
export type FactTopic = typeof FACT_TOPICS[number];
/** New questions one person can start in a day. */
export const QUESTIONS_PER_DAY = 5;
/** How long the answerer has before the question simply goes to staff (a slow model never holds a member up). */
export const ANSWER_TIMEOUT_MS = 3000;

const body = z.string().check(z.trim(), z.minLength(2), z.maxLength(2000));
const factText = z.optional(z.nullable(z.string().check(z.trim(), z.maxLength(2000))));
const topic = z.enum(FACT_TOPICS);

/** The first words of a text, for a line that names it. */
export function excerpt(s: string, max = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}
async function nameOf(db: Db | Trx, id: string) { return (await readRow(db, "person", id, "thing.person")).row.display_name as string; }
async function langOf(db: Db | Trx, personId: string): Promise<Lang> {
  const p = await db.selectFrom("person").select("locale").where("id", "=", personId).executeTakeFirst();
  const club = await db.selectFrom("club").select("default_language").executeTakeFirstOrThrow();
  return pickLang(p?.locale, pickLang(club.default_language));
}

// ---- Facts ----
export type FactRow = { id: string; topic: string; question_en: string | null; answer_en: string | null; question_es: string | null; answer_es: string | null; active: boolean; public: boolean };
/** A fact in one language: that one if the club wrote it, otherwise the other. */
export function factIn(f: FactRow, lang: Lang): { question: string; answer: string } {
  const en = f.question_en ? { question: f.question_en, answer: f.answer_en! } : null, es = f.question_es ? { question: f.question_es, answer: f.answer_es! } : null;
  return (lang === "es" ? es ?? en : en ?? es)!;
}
const bothOf = (f: FactRow): { question: Text; answer: Text } => {
  const en = factIn(f, "en"), es = factIn(f, "es");
  return { question: { en: en.question, es: es.question }, answer: { en: en.answer, es: es.answer } };
};
async function clubLanguages(db: Db | Trx): Promise<Lang[]> {
  return ((await db.selectFrom("club").select("languages").executeTakeFirstOrThrow()).languages as string[]).filter((l): l is Lang => l === "en" || l === "es");
}
/** Each of the club's languages needs both the question and the answer; a language it doesn't use may be left out. */
async function checkFact(db: Db | Trx, f: { question_en: string | null; answer_en: string | null; question_es: string | null; answer_es: string | null }) {
  for (const l of ["en", "es"] as const) if (Boolean(f[`question_${l}`]) !== Boolean(f[`answer_${l}`])) throw new KumiError("error.fact_half", { lang: both(`lang.word_${l}`) });
  for (const l of await clubLanguages(db)) if (!f[`question_${l}`]) throw new KumiError("error.fact_needs_lang", { lang: both(`lang.word_${l}`) });
  if (!f.question_en && !f.question_es) throw new KumiError("error.fact_needs_lang", { lang: both("lang.word_en") });
}

/** Lower case, no accents, no punctuation: "¿Dónde aparco?" and "donde aparco" are the same words. */
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const STOP = new Set(("a an and are at be can could do does for from have how i if in is it its me my of on or our the there to we what when where which who why will with you your " +
  "al como con cual cuando de del donde el en es esta este hay la las lo los me mi mis o para por puedo que se si son su sus te tengo un una y yo").split(" "));
const words = (s: string) => [...new Set(fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOP.has(w)))];
/** Two forms of one word: they share their first five letters, or all of a four-letter one ("park" and
 *  "parking", "estacionar" and "estaciono"). */
function near(a: string, b: string): boolean {
  const short = Math.min(a.length, b.length);
  if (short < 4) return false;
  let n = 0;
  while (n < short && a[n] === b[n]) n++;
  return n >= Math.min(5, short);
}
/** How well a fact matches the words asked: a word in its question counts twice, in its answer once. */
function score(f: FactRow, asked: string[]): number {
  const q = words([f.question_en, f.question_es].filter(Boolean).join(" ")), a = words([f.answer_en, f.answer_es].filter(Boolean).join(" "));
  const hit = (list: string[], w: string) => list.some((x) => x === w || near(x, w));
  return asked.reduce((n, w) => n + (hit(q, w) ? 2 : hit(a, w) ? 1 : 0), 0);
}
/** The switched-on facts, best match first; with no words, all of them by topic. `publicOnly` for the club's page. */
export async function searchFacts(db: Db | Trx, query: string, o: { publicOnly?: boolean; limit?: number; all?: boolean } = {}) {
  const rows = await db.selectFrom("club_fact").select(["id", "topic", "question_en", "answer_en", "question_es", "answer_es", "active", "public", "created_at"])
    .$if(!o.all, (q) => q.where("active", "=", true)).$if(Boolean(o.publicOnly), (q) => q.where("public", "=", true)).orderBy("created_at").execute();
  const byTopic = (x: FactRow, y: FactRow) => FACT_TOPICS.indexOf(x.topic as FactTopic) - FACT_TOPICS.indexOf(y.topic as FactTopic);
  const asked = words(query);
  if (!asked.length) return rows.sort(byTopic).slice(0, o.limit ?? rows.length);
  return rows.map((r) => ({ r, s: score(r, asked) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s || byTopic(x.r, y.r)).slice(0, o.limit ?? 10).map((x) => x.r);
}

const factInput = { topic, question_en: factText, answer_en: factText, question_es: factText, answer_es: factText, public: z.optional(z.boolean()) };
const clean = (v: string | null | undefined) => (v ?? "").trim() || null;

export const factCreate = defineAction({
  name: "fact.create", version: 1,
  input: z.object({ ...factInput, from_message_id: z.optional(z.uuid()) }),
  async plan(ctx, i) {
    const f = { question_en: clean(i.question_en), answer_en: clean(i.answer_en), question_es: clean(i.question_es), answer_es: clean(i.answer_es) };
    await checkFact(ctx.db, f);
    const shown = factIn({ ...f, id: "", topic: i.topic, active: true, public: Boolean(i.public) }, ctx.actor.lang);
    return { title: both("action.fact.create"), reads: [], undo: { kind: "reversible" },
      summary: both("plan.fact.create", { topic: both(`ui.topic_${i.topic}`), question: shown.question, public: i.public ? both("plan.fact.public_too") : { en: "", es: "" } }) };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("club_fact", { id, topic: i.topic, question_en: clean(i.question_en), answer_en: clean(i.answer_en), question_es: clean(i.question_es), answer_es: clean(i.answer_es),
      public: i.public ?? false, created_by: ctx.actor.personId, created_at: ctx.now });
    return { fact_id: id };
  },
});

export const factUpdate = defineAction({
  name: "fact.update", version: 1,
  input: z.object({ fact_id: z.uuid(), topic: z.optional(topic), question_en: factText, answer_en: factText, question_es: factText, answer_es: factText,
    public: z.optional(z.boolean()), active: z.optional(z.boolean()) }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "club_fact", i.fact_id, "thing.fact");
    const next = { ...row } as FactRow;
    for (const k of ["question_en", "answer_en", "question_es", "answer_es"] as const) if (i[k] !== undefined) next[k] = clean(i[k]);
    await checkFact(ctx.db, next);
    const fields = (["topic", "question_en", "answer_en", "question_es", "answer_es", "public", "active"] as const)
      .filter((k) => i[k] !== undefined && (k.startsWith("question") || k.startsWith("answer") ? clean(i[k] as string) !== row[k] : i[k] !== row[k]));
    if (!fields.length) throw new KumiError("error.nothing_changed");
    const question = factIn(row as FactRow, ctx.actor.lang).question;
    const named = [...new Set(fields.map((k) => k.replace(/_(en|es)$/, "")))].map((k) => both(`field.fact_${k}` as "field.fact_topic"));
    const summary = fields.length === 1 && fields[0] === "active"
      ? both(i.active ? "plan.fact.on" : "plan.fact.off", { question })
      : both("plan.fact.update", { question, fields: { en: named.map((x) => x.en).join(", "), es: named.map((x) => x.es).join(", ") } });
    return { title: both("action.fact.update"), summary, reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const { fact_id, ...rest } = i;
    const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === "string" || v === null ? clean(v as string | null) : v]));
    await ctx.update("club_fact", fact_id, patch);
    return null;
  },
});

// ---- The answerer: where a decision model plugs in ----
export interface AnswerChoice { outcome: "fact" | "staff"; factId?: string; confidence: number | null; detail?: unknown }
export interface Answerer {
  /** Kept on each decision: which answerer, and the version of the questions and thresholds it asks. */
  name: string; version: string;
  /** How long it may take before the question goes to staff instead; ANSWER_TIMEOUT_MS when not given. */
  timeoutMs?: number;
  decide(question: { text: string; lang: Lang }, facts: { id: string; topic: string; question: Text; answer: Text }[]): Promise<AnswerChoice>;
}
/** Until a decision model is set up, every question goes to the staff. */
export const staffOnly: Answerer = { name: "staff_only", version: "1", decide: async () => ({ outcome: "staff", confidence: null }) };
let current: Answerer = staffOnly;
export function setAnswerer(a: Answerer): void { current = a; }

/** Ask the answerer about one member message, keep what it decided, and send the fact if it picked one.
 *  A failure or a slow answer hands the question to staff: it never blocks a member (decisions.md). */
async function answerWith(ctx: ApplyCtx, q: { id: string; asked_by: string }, messageId: string, text: string): Promise<"fact" | "staff"> {
  const facts = await searchFacts(ctx.trx, "");
  const lang = await langOf(ctx.trx, q.asked_by);
  let choice: AnswerChoice;
  if (!facts.length || current === staffOnly) choice = { outcome: "staff", confidence: null };
  else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      choice = await Promise.race([current.decide({ text, lang }, facts.map((f) => ({ id: f.id, topic: f.topic, ...bothOf(f) }))),
        new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("timed out")), current.timeoutMs ?? ANSWER_TIMEOUT_MS); })]);
    } catch (e) { choice = { outcome: "staff", confidence: null, detail: { error: String((e as Error).message).slice(0, 200) } }; }
    finally { clearTimeout(timer); }
  }
  const fact = choice.outcome === "fact" ? facts.find((f) => f.id === choice.factId) : undefined;
  await ctx.trx.insertInto("answer_decision").values({ id: uuidv7(), question_id: q.id, message_id: messageId, answerer: current.name, questions_version: current.version,
    outcome: fact ? "fact" : "staff", fact_id: fact?.id ?? null, confidence: choice.confidence === null ? null : choice.confidence.toFixed(4),
    detail: choice.detail === undefined ? null : JSON.stringify(choice.detail), created_at: ctx.now }).execute();
  if (!fact) return "staff";
  const words = factIn(fact, lang);
  await ctx.insert("question_message", { id: uuidv7(), question_id: q.id, side: "club", author_id: null, body: words.answer, fact_id: fact.id, created_at: ctx.now });
  await ctx.update("question", q.id, { status: "answered", waiting_since: null });
  await ctx.emit("question.club_answered", { question_id: q.id, to: q.asked_by, question: excerpt(text), fact: bothOf(fact).question, answer: bothOf(fact).answer });
  return "fact";
}

// ---- Threads ----
/** Whose thread it is, for "own" grants: who asked, the person it's about, and the adults who manage them. */
async function threadOwners(db: Db | Trx, q: { person_id: string; asked_by: string }) {
  return [...new Set([q.asked_by, ...(await withManagers(db, [q.person_id]))])];
}
async function threadOf(db: Db | Trx, id: string) {
  const { row, read } = await readRow(db, "question", id, "thing.question");
  return { q: row as { id: string; person_id: string; asked_by: string; status: "open" | "answered" | "closed"; assigned_to: string | null; waiting_since: Date | null; alerted_at: Date | null; version: number }, read };
}
async function firstWords(db: Db | Trx, questionId: string) {
  const m = await db.selectFrom("question_message").select("body").where("question_id", "=", questionId).where("side", "=", "member").orderBy("created_at").orderBy("id").limit(1).executeTakeFirst();
  return excerpt(m?.body ?? "");
}

export const questionAsk = defineAction({
  name: "question.ask", version: 1,
  input: z.object({ person_id: z.uuid(), body }),
  async plan(ctx, i) {
    const asker = ctx.actor.personId;
    if (!asker) throw new KumiError("error.signed_out", {}, 401);
    const since = new Date(ctx.now.getTime() - 24 * 3600_000);
    const n = await ctx.db.selectFrom("question").select((eb) => eb.fn.countAll<string>().as("n")).where("asked_by", "=", asker).where("created_at", ">", since).executeTakeFirstOrThrow();
    if (Number(n.n) >= QUESTIONS_PER_DAY) throw new KumiError("error.too_many_questions", { count: QUESTIONS_PER_DAY });
    const about = i.person_id === asker ? { en: "", es: "" } : both("plan.question.about", { name: await nameOf(ctx.db, i.person_id) });
    // A parent asks about their junior; anyone else, about themselves.
    return { title: both("action.question.ask"), reads: [], ownerIds: i.person_id === asker ? [asker] : (await managersOf(ctx.db, i.person_id)), undo: { kind: "none" },
      summary: both("plan.question.ask", { body: excerpt(i.body, 200), about }) };
  },
  async apply(ctx, i) {
    const id = uuidv7(), msg = uuidv7(), asker = ctx.actor.personId!;
    await ctx.insert("question", { id, person_id: i.person_id, asked_by: asker, status: "open", waiting_since: ctx.now, created_at: ctx.now });
    await ctx.insert("question_message", { id: msg, question_id: id, side: "member", author_id: asker, body: i.body, created_at: ctx.now });
    const how = await answerWith(ctx, { id, asked_by: asker }, msg, i.body);
    return { question_id: id, answered_by: how === "fact" ? "club" : "staff" };
  },
});

export const questionReply = defineAction({
  name: "question.reply", version: 1,
  input: z.object({ question_id: z.uuid(), body }),
  async plan(ctx, i) {
    const { q, read } = await threadOf(ctx.db, i.question_id);
    return { title: both("action.question.reply"), reads: [read], ownerIds: await threadOwners(ctx.db, q), undo: { kind: "none" },
      summary: both(q.status === "closed" ? "plan.question.reply_reopen" : "plan.question.reply", { body: excerpt(i.body, 200) }) };
  },
  async apply(ctx, i) {
    const { q } = await threadOf(ctx.trx, i.question_id);
    const msg = uuidv7();
    await ctx.insert("question_message", { id: msg, question_id: q.id, side: "member", author_id: ctx.actor.personId, body: i.body, created_at: ctx.now });
    // Waiting for the staff again (or still, from the first message it waited on).
    await ctx.update("question", q.id, { status: "open", waiting_since: q.status === "open" && q.waiting_since ? q.waiting_since : ctx.now, closed_at: null });
    return null;
  },
});

export const questionNotAnswered = defineAction({
  name: "question.not_answered", version: 1,
  input: z.object({ question_id: z.uuid() }),
  async plan(ctx, i) {
    const { q, read } = await threadOf(ctx.db, i.question_id);
    const last = await ctx.db.selectFrom("question_message").select("side").where("question_id", "=", q.id).orderBy("created_at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst();
    // The club's fact is the last word, and nobody's been asked to look at it since.
    if (last?.side !== "club" || q.status !== "answered") throw new KumiError("error.no_club_answer");
    return { title: both("action.question.not_answered"), summary: both("plan.question.not_answered"), reads: [read], ownerIds: await threadOwners(ctx.db, q), undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const { q } = await threadOf(ctx.trx, i.question_id);
    await ctx.update("question", q.id, { status: "open", waiting_since: ctx.now, closed_at: null });
    // A label for the answerer: this pick didn't answer it.
    await ctx.trx.updateTable("answer_decision").set({ corrected: "not_answered", corrected_at: ctx.now })
      .where("id", "=", ctx.trx.selectFrom("answer_decision").select("id").where("question_id", "=", q.id).where("outcome", "=", "fact").orderBy("created_at", "desc").orderBy("id", "desc").limit(1)).execute();
    return null;
  },
});

export const questionAnswer = defineAction({
  name: "question.answer", version: 1,
  input: z.object({ question_id: z.uuid(), body, close: z.optional(z.boolean()) }),
  async plan(ctx, i) {
    const { q, read } = await threadOf(ctx.db, i.question_id);
    const person = await nameOf(ctx.db, q.asked_by);
    return { title: both("action.question.answer"), reads: [read], undo: { kind: "none" },
      summary: both("plan.question.answer", { person, body: excerpt(i.body, 200), close: i.close ? both("plan.question.and_close") : { en: "", es: "" } }) };
  },
  async apply(ctx, i) {
    const { q } = await threadOf(ctx.trx, i.question_id);
    await ctx.insert("question_message", { id: uuidv7(), question_id: q.id, side: "staff", author_id: ctx.actor.personId, body: i.body, created_at: ctx.now });
    await ctx.update("question", q.id, { status: i.close ? "closed" : "answered", waiting_since: null, ...(i.close ? { closed_at: ctx.now } : {}),
      // Whoever answers an unassigned question takes it.
      ...(q.assigned_to ? {} : { assigned_to: ctx.actor.personId }) });
    await ctx.emit("question.answered", { question_id: q.id, to: q.asked_by, by: await nameOf(ctx.trx, ctx.actor.personId!), question: await firstWords(ctx.trx, q.id), answer: i.body });
    return null;
  },
});

export const questionAssign = defineAction({
  name: "question.assign", version: 1,
  input: z.object({ question_id: z.uuid(), to: z.nullable(z.uuid()) }),
  async plan(ctx, i) {
    const { q, read } = await threadOf(ctx.db, i.question_id);
    if (i.to === q.assigned_to) throw new KumiError("error.nothing_changed");
    if (i.to) {
      const staff = await ctx.db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
        .where("person_role.person_id", "=", i.to).where("person_role.active", "=", true).where("role.key", "in", ["owner", "manager", "front_desk"]).executeTakeFirst();
      if (!staff) throw new KumiError("error.assign_desk_only");
    }
    const person = await nameOf(ctx.db, q.asked_by);
    return { title: both("action.question.assign"), reads: [read], undo: { kind: "reversible" },
      summary: i.to ? both("plan.question.assign", { person, to: await nameOf(ctx.db, i.to) }) : both("plan.question.unassign", { person }) };
  },
  async apply(ctx, i) {
    const { q } = await threadOf(ctx.trx, i.question_id);
    await ctx.update("question", q.id, { assigned_to: i.to });
    if (i.to && i.to !== ctx.actor.personId)
      await ctx.emit("question.assigned", { question_id: q.id, to: i.to, by: await nameOf(ctx.trx, ctx.actor.personId!), person: await nameOf(ctx.trx, q.asked_by), question: await firstWords(ctx.trx, q.id) });
    return null;
  },
});

export const questionClose = defineAction({
  name: "question.close", version: 1,
  input: z.object({ question_id: z.uuid() }),
  async plan(ctx, i) {
    const { q, read } = await threadOf(ctx.db, i.question_id);
    if (q.status === "closed") throw new KumiError("error.question_closed");
    return { title: both("action.question.close"), summary: both("plan.question.close", { question: await firstWords(ctx.db, q.id) }), reads: [read],
      ownerIds: await threadOwners(ctx.db, q), undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.update("question", i.question_id, { status: "closed", waiting_since: null, closed_at: ctx.now });
    return null;
  },
});

// ---- Waiting too long: front desk hears once ----
/** Minutes the club was open between two instants: any location open counts once, special days included.
 *  A club with no opening hours set counts every minute. */
export async function openMinutes(db: Db | Trx, from: Date, to: Date): Promise<number> {
  if (to <= from) return 0;
  const locations = await db.selectFrom("location").select(["id", "time_zone"]).where("archived_at", "is", null).execute();
  const anyHours = await db.selectFrom("opening_hours").select("id").where("opens", "is not", null).limit(1).executeTakeFirst();
  if (!locations.length || !anyHours) return Math.floor((to.getTime() - from.getTime()) / 60_000);
  const spans: [number, number][] = [];
  for (const loc of locations) {
    // Day by day in the location's own time, at most a month back (a question waiting longer has long been due).
    let day = localDate(new Date(Math.max(from.getTime(), to.getTime() - 31 * 86400_000) - 86400_000), loc.time_zone);
    const last = localDate(to, loc.time_zone);
    for (let k = 0; k < 40 && day <= last; k++) {
      const o = await openingOn(db, loc.id, day);
      if (o) { const a = Math.max(o.opens.getTime(), from.getTime()), b = Math.min(o.closes.getTime(), to.getTime()); if (b > a) spans.push([a, b]); }
      const [y, m, d] = day.split("-").map(Number);
      day = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
    }
  }
  // Overlapping hours at two locations count once.
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0, end = -Infinity;
  for (const [a, b] of spans) { if (b <= end) continue; total += b - Math.max(a, end); end = b; }
  return Math.floor(total / 60_000);
}

/** Kumi tells front desk a question has waited past the club's setting: once per thread. */
export const questionAlert = defineAction({
  name: "question.alert", version: 1, system: true, internal: true,
  input: z.object({ question_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await threadOf(ctx.db, i.question_id);
    return { title: both("action.question.alert"), summary: both("action.question.alert"), reads: [read], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const q = await ctx.trx.selectFrom("question").selectAll().where("id", "=", i.question_id).forUpdate().executeTakeFirstOrThrow();
    if (q.alerted_at || q.status !== "open" || !q.waiting_since) return { already: true };
    await ctx.update("question", q.id, { alerted_at: ctx.now });
    const hours = (await ctx.trx.selectFrom("club").select("question_alert_hours").executeTakeFirstOrThrow()).question_alert_hours;
    await ctx.emit("question.unanswered", { question_id: q.id, person: await nameOf(ctx.trx, q.asked_by), asked_at: q.waiting_since, hours, question: await firstWords(ctx.trx, q.id),
      assigned_to: q.assigned_to });
    return null;
  },
});

/** The job: questions waiting for the staff longer than the club's setting, counted in opening hours. */
export async function alertUnanswered(db: Db, now = new Date()) {
  const hours = (await db.selectFrom("club").select("question_alert_hours").executeTakeFirstOrThrow()).question_alert_hours;
  if (!hours) return { alerted: 0 };
  // Opening hours are never more than the clock's, so only these can be due.
  const waiting = await db.selectFrom("question").select(["id", "waiting_since"]).where("status", "=", "open").where("alerted_at", "is", null)
    .where("waiting_since", "is not", null).where("waiting_since", "<=", new Date(now.getTime() - hours * 3600_000)).execute();
  let alerted = 0;
  for (const q of waiting) {
    if (await openMinutes(db, new Date(q.waiting_since!), now) < hours * 60) continue;
    const r = await runAsSystem(db, "question.alert", { question_id: q.id }, "jobs", { now });
    if (!r.result) alerted++;
  }
  return { alerted };
}

// ---- Reading threads ----
/** One thread as its member or the staff see it: the messages in order, with who wrote each. */
export async function questionThread(db: Db | Trx, id: string) {
  const q = await db.selectFrom("question").innerJoin("person as asker", "asker.id", "question.asked_by").innerJoin("person as about", "about.id", "question.person_id")
    .leftJoin("person as assignee", "assignee.id", "question.assigned_to")
    .select(["question.id", "question.person_id", "question.asked_by", "question.status", "question.assigned_to", "question.waiting_since", "question.alerted_at", "question.created_at", "question.closed_at",
      "asker.display_name as asker", "about.display_name as about", "about.junior", "assignee.display_name as assignee"])
    .where("question.id", "=", id).executeTakeFirst();
  if (!q) throw new KumiError("error.not_found", { thing: both("thing.question") }, 404);
  const messages = await db.selectFrom("question_message").leftJoin("person", "person.id", "question_message.author_id")
    .select(["question_message.id", "question_message.side", "question_message.body", "question_message.fact_id", "question_message.created_at", "person.display_name as author"])
    .where("question_id", "=", id).orderBy("question_message.created_at").orderBy("question_message.id").execute();
  return { ...q, messages };
}

/** Threads, newest first: a member's own (asked by them, or about them or a junior they manage), or for the staff by status. */
export async function questionList(db: Db | Trx, o: { mine?: string[]; askedBy?: string; status?: ("open" | "answered" | "closed")[]; limit?: number }) {
  const rows = await db.selectFrom("question").innerJoin("person as asker", "asker.id", "question.asked_by").innerJoin("person as about", "about.id", "question.person_id")
    .leftJoin("person as assignee", "assignee.id", "question.assigned_to")
    .select(["question.id", "question.person_id", "question.asked_by", "question.status", "question.waiting_since", "question.alerted_at", "question.created_at", "question.assigned_to",
      "asker.display_name as asker", "about.display_name as about", "assignee.display_name as assignee"])
    .select((eb) => [
      eb.selectFrom("question_message").select("body").whereRef("question_message.question_id", "=", "question.id").where("side", "=", "member").orderBy("created_at").orderBy("id").limit(1).as("first"),
      eb.selectFrom("question_message").select("side").whereRef("question_message.question_id", "=", "question.id").orderBy("created_at", "desc").orderBy("id", "desc").limit(1).as("last_side"),
      eb.selectFrom("question_message").select("created_at").whereRef("question_message.question_id", "=", "question.id").orderBy("created_at", "desc").orderBy("id", "desc").limit(1).as("last_at"),
    ])
    .$if(Boolean(o.mine), (q) => q.where((w) => w.or([w("question.asked_by", "=", o.askedBy!), w("question.person_id", "in", o.mine!)])))
    .$if(Boolean(o.status), (q) => q.where("question.status", "in", o.status!))
    .orderBy("question.created_at", "desc").limit(o.limit ?? 100).execute();
  return rows.map(({ first, ...r }) => ({ ...r, first: excerpt(first ?? "", 120) }));
}
