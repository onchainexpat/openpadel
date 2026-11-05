// Chat between players: a thread inside a game people play together, a court booking with named players (an open
// match is one) or a program's date (a clinic, a social night, a league night). Everyone in the game reads and
// posts; someone who leaves it keeps reading, without posting, until it ends. Juniors don't see chats in this
// version (a parent in the same game reads it as themselves). There are no messages between members outside a
// shared game, and no list of members.
//
// Posting, editing and taking a message back aren't actions: they aren't in the change log, and no assistant can
// do them (an assistant reads its person's chats, nothing more). The club's moderation is: a player's report,
// which the staff hear about once per message, the staff hiding a message and stopping someone posting for a
// while, each in Changes. A chat is kept until 90 days after its game, then deleted with everything in it.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, pickLang, t, type Key, type Lang, type Params, type Text } from "@kumi/i18n";
import { defineAction, readRow } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { hasPushDevice } from "./push.ts";
import { quietUntil } from "./messages.ts";
import { leavingOn } from "./leaving.ts";
import { excerpt } from "./questions.ts";

export type ChatKind = "booking" | "session";
export const CHAT_KINDS: ChatKind[] = ["booking", "session"];
/** Kept this long after the game. */
export const CHAT_KEEP_DAYS = 90;
export const CHAT_MAX_CHARS = 1000;
/** Its author can change a message this long after posting it (taking it back works any time). */
export const CHAT_EDIT_MINUTES = 5;
/** At most this many posts by one person in this many minutes, across every chat. */
export const CHAT_RATE = { posts: 20, minutes: 10 };
/** A player's phone hears about one chat at most once in this many minutes; the app's badge counts the rest. */
export const CHAT_PUSH_MINUTES = 5;
/** A chat's push isn't worth showing after this long (a phone that was off, or quiet hours). */
const PUSH_STALE_MINUTES = 15;
const DAY = 86400_000;

// ---- The game a chat belongs to ----

export interface Game {
  kind: ChatKind; id: string; title: string; starts_at: Date; ends_at: Date; location_id: string | null; cancelled: boolean;
  /** In it now (the organiser and named players; those with a place, and the coach). */
  current: Set<string>;
  /** Were in it and left. */
  former: Set<string>;
}

export async function gameOf(db: Db | Trx, kind: ChatKind, id: string): Promise<Game | null> {
  const current = new Set<string>(), former = new Set<string>();
  if (kind === "booking") {
    const b = await db.selectFrom("booking").select(["organiser_id", "status", "location_id"]).where("id", "=", id).executeTakeFirst();
    if (!b) return null;
    // Every court time the booking ever had: a cancelled booking keeps its retired ones, and still has a time.
    const span = await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id")
      .select([sql<Date | null>`min(lower(court_time.during))`.as("starts"), sql<Date | null>`max(upper(court_time.during))`.as("ends"), sql<string | null>`min(court.name)`.as("court")])
      .where("court_time.booking_id", "=", id).executeTakeFirst();
    if (!span?.starts || !span.ends) return null;
    if (b.organiser_id) current.add(b.organiser_id);
    for (const p of await db.selectFrom("booking_player").select(["person_id", "removed_at"]).where("booking_id", "=", id).where("person_id", "is not", null).execute())
      (p.removed_at ? former : current).add(p.person_id!);
    for (const p of current) former.delete(p);
    return { kind, id, title: span.court ?? "", starts_at: new Date(span.starts), ends_at: new Date(span.ends), location_id: b.location_id, cancelled: b.status === "cancelled", current, former };
  }
  const s = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id")
    .select(["session.program_id", "session.starts_at", "session.ends_at", "session.status", "session.coach_id", "program.name", "program.location_id", "program.status as program_status"])
    .where("session.id", "=", id).executeTakeFirst();
  if (!s) return null;
  // A place for this date, or for the whole program; a waitlist isn't a place.
  for (const e of await db.selectFrom("enrolment").select(["person_id", "status"]).where("program_id", "=", s.program_id)
    .where((w) => w.or([w("session_id", "=", id), w("session_id", "is", null)])).execute()) {
    if (e.status === "booked" || e.status === "attended" || e.status === "no_show") current.add(e.person_id);
    else if (e.status === "cancelled") former.add(e.person_id);
  }
  if (s.coach_id) current.add(s.coach_id);
  for (const p of current) former.delete(p);
  return { kind, id, title: s.name, starts_at: new Date(s.starts_at), ends_at: new Date(s.ends_at), location_id: s.location_id,
    cancelled: s.status === "cancelled" || s.program_status === "cancelled", current, former };
}

// ---- Who reads and who posts ----

export interface Access { read: boolean; post: boolean; why: Key | null; whyParams: Params; game: Game | null }
const no = (why: Key, game: Game | null = null): Access => ({ read: false, post: false, why, whyParams: {}, game });

/** The club stopping someone posting, if it's still running. */
export async function activeStop(db: Db | Trx, personId: string, now: Date) {
  return (await db.selectFrom("chat_stop").select(["id", "until", "reason"]).where("person_id", "=", personId).where("ended_at", "is", null).where("until", ">", now)
    .orderBy("until", "desc").limit(1).executeTakeFirst()) ?? null;
}

/** Why someone in the game can't post right now, or null. */
async function postBlock(db: Db | Trx, personId: string, game: Game, now: Date): Promise<{ why: Key; params: Params } | null> {
  if (game.cancelled) return { why: "error.chat_cancelled", params: {} };
  const c = await db.selectFrom("club").select(["read_only_since", "moved_at", "time_zone"]).executeTakeFirstOrThrow();
  if (c.moved_at) return { why: "error.chat_moved", params: {} };
  if (c.read_only_since) return { why: "error.chat_read_only", params: {} };
  if (await leavingOn(db)) return { why: "error.chat_leaving", params: {} };
  const stop = await activeStop(db, personId, now);
  if (stop) return { why: "error.chat_stopped", params: { until: { en: dateTime(new Date(stop.until), "en", c.time_zone), es: dateTime(new Date(stop.until), "es", c.time_zone) } } };
  return null;
}

async function threadOf(db: Db | Trx, kind: ChatKind, id: string) {
  return (await db.selectFrom("chat_thread").select(["id", "ends_at"]).where("kind", "=", kind).where("ref_id", "=", id).executeTakeFirst()) ?? null;
}

/** Whether this person read the chat or posted in it before (someone who left keeps reading until the game ends). */
async function wasIn(db: Db | Trx, personId: string, kind: ChatKind, id: string): Promise<boolean> {
  const th = await threadOf(db, kind, id);
  if (!th) return false;
  if (await db.selectFrom("chat_seen").select("person_id").where("thread_id", "=", th.id).where("person_id", "=", personId).executeTakeFirst()) return true;
  return Boolean(await db.selectFrom("chat_message").select("id").where("thread_id", "=", th.id).where("person_id", "=", personId).limit(1).executeTakeFirst());
}

export async function chatAccess(db: Db | Trx, personId: string, kind: ChatKind, id: string, now: Date): Promise<Access> {
  const club = await db.selectFrom("club").select("players_chat").executeTakeFirst();
  if (!club?.players_chat) return no("error.chat_off");
  const p = await db.selectFrom("person").select(["junior", "redacted_at"]).where("id", "=", personId).executeTakeFirst();
  if (!p || p.redacted_at) return no("error.chat_not_in");
  // Juniors (with a login of their own) don't read or post in chats in this version.
  if (p.junior) return no("error.chat_junior");
  const game = await gameOf(db, kind, id);
  if (!game) return no("error.chat_not_in");
  if (game.current.has(personId)) {
    const block = await postBlock(db, personId, game, now);
    return { read: true, post: !block, why: block?.why ?? null, whyParams: block?.params ?? {}, game };
  }
  if ((game.former.has(personId) || await wasIn(db, personId, kind, id)) && now < game.ends_at) return { read: true, post: false, why: "error.chat_left", whyParams: {}, game };
  return no("error.chat_not_in", game);
}

/** Its thread, made with its first message (or the first mute); kept until 90 days after the game, which a move later
 *  pushes out. */
async function ensureThread(db: Db, game: Game, now: Date): Promise<string> {
  const r = await db.insertInto("chat_thread").values({ id: uuidv7(now.getTime()), kind: game.kind, ref_id: game.id, ends_at: game.ends_at })
    .onConflict((oc) => oc.columns(["kind", "ref_id"]).doUpdateSet({ ends_at: game.ends_at })).returning("id").executeTakeFirstOrThrow();
  return r.id;
}

/** Plain text: control characters out (new lines kept), trimmed, at least one character and at most CHAT_MAX_CHARS. */
export function chatText(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const s = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) throw new KumiError("error.chat_empty", {}, 400);
  if ([...s].length > CHAT_MAX_CHARS) throw new KumiError("error.chat_too_long", { max: CHAT_MAX_CHARS }, 400);
  return s;
}

async function tooFast(db: Db, personId: string, now: Date) {
  const r = await db.selectFrom("chat_message").select((x) => x.fn.countAll<string>().as("n")).where("person_id", "=", personId)
    .where("created_at", ">", new Date(now.getTime() - CHAT_RATE.minutes * 60_000)).executeTakeFirstOrThrow();
  if (Number(r.n) >= CHAT_RATE.posts) throw new KumiError("error.chat_too_fast", { minutes: CHAT_RATE.minutes }, 429);
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
export function chatKind(k: string): ChatKind {
  if (!CHAT_KINDS.includes(k as ChatKind)) throw new KumiError("error.not_found", { thing: both("thing.chat") }, 404);
  return k as ChatKind;
}
export function chatId(id: string): string {
  if (!isUuid(id)) throw new KumiError("error.not_found", { thing: both("thing.chat") }, 404);
  return id;
}

// ---- Posting, changing and taking back ----

export async function postChat(db: Db, personId: string, kind: ChatKind, id: string, raw: unknown, now = new Date()): Promise<{ id: string }> {
  const body = chatText(raw);
  const a = await chatAccess(db, personId, kind, id, now);
  if (!a.post) throw new KumiError(a.why ?? "error.chat_not_in", a.whyParams, a.read ? 403 : 404);
  await tooFast(db, personId, now);
  const game = a.game!, tid = await ensureThread(db, game, now), mid = uuidv7(now.getTime());
  await db.insertInto("chat_message").values({ id: mid, thread_id: tid, person_id: personId, body, created_at: now }).execute();
  // Everyone in the game has a place in the thread from its first message, so their badge counts what they haven't read.
  const readers = await db.selectFrom("person").select("id").where("id", "in", [...game.current]).where("junior", "=", false).where("redacted_at", "is", null).execute();
  await db.insertInto("chat_seen").values(readers.map((r) => ({ thread_id: tid, person_id: r.id, read_at: r.id === personId ? now : null })))
    .onConflict((oc) => oc.columns(["thread_id", "person_id"]).doNothing()).execute();
  await db.updateTable("chat_seen").set({ read_at: now }).where("thread_id", "=", tid).where("person_id", "=", personId).execute();
  await tellPhones(db, game, tid, personId, body, now);
  return { id: mid };
}

/** A push to each player's phone (never a text or an email): at most one per chat in CHAT_PUSH_MINUTES, none for a
 *  muted chat, and none during the club's quiet hours (it goes stale before they end). */
async function tellPhones(db: Db, game: Game, threadId: string, from: string, body: string, now: Date) {
  const club = await db.selectFrom("club").select(["time_zone", "default_language"]).executeTakeFirstOrThrow();
  const wait = quietUntil(now, club.time_zone), stale = new Date(now.getTime() + PUSH_STALE_MINUTES * 60_000);
  if (wait && wait >= stale) return;
  const author = (await db.selectFrom("person").select("display_name").where("id", "=", from).executeTakeFirstOrThrow()).display_name;
  const since = new Date(now.getTime() - CHAT_PUSH_MINUTES * 60_000);
  const to = await db.selectFrom("chat_seen").innerJoin("person", "person.id", "chat_seen.person_id").select(["person.id", "person.locale"])
    .where("chat_seen.thread_id", "=", threadId).where("chat_seen.person_id", "!=", from).where("chat_seen.person_id", "in", [...game.current]).where("chat_seen.muted", "=", false)
    .where("person.junior", "=", false).where("person.redacted_at", "is", null).where("person.status", "!=", "archived")
    .where((w) => w.or([w("chat_seen.pushed_at", "is", null), w("chat_seen.pushed_at", "<", since)])).execute();
  for (const p of to) {
    if (!(await hasPushDevice(db, p.id))) continue;
    const lang: Lang = pickLang(p.locale, pickLang(club.default_language));
    await db.insertInto("outbound_message").values({
      id: uuidv7(now.getTime()), event_id: null, person_id: p.id, kind: "chat_message", channel: "push", purpose: "account", essential: false, lang,
      subject: t(lang, "msg.chat_message.subject", { game: game.title, when: dateTime(game.starts_at, lang, club.time_zone) }),
      body: t(lang, "msg.chat_message.body", { name: author, text: excerpt(body, 120) }), link: `/chats/${game.kind}/${game.id}`,
      status: "waiting", send_after: wait ?? now, stale_at: stale,
    }).execute();
    await db.updateTable("chat_seen").set({ pushed_at: now }).where("thread_id", "=", threadId).where("person_id", "=", p.id).execute();
  }
}

async function ownMessage(db: Db, personId: string, messageId: string) {
  const m = isUuid(messageId) ? await db.selectFrom("chat_message").innerJoin("chat_thread", "chat_thread.id", "chat_message.thread_id")
    .select(["chat_message.id", "chat_message.person_id", "chat_message.created_at", "chat_message.removed_at", "chat_message.hidden_at", "chat_thread.kind", "chat_thread.ref_id"])
    .where("chat_message.id", "=", messageId).executeTakeFirst() : undefined;
  if (!m || m.person_id !== personId) throw new KumiError("error.not_found", { thing: both("thing.chat_message") }, 404);
  return m;
}

/** Its author changes a message within CHAT_EDIT_MINUTES of posting it, while they may still post. */
export async function editChat(db: Db, personId: string, messageId: string, raw: unknown, now = new Date()) {
  const body = chatText(raw), m = await ownMessage(db, personId, messageId);
  if (m.removed_at || m.hidden_at) throw new KumiError("error.chat_gone", {}, 409);
  if (now.getTime() - new Date(m.created_at).getTime() > CHAT_EDIT_MINUTES * 60_000) throw new KumiError("error.chat_edit_window", { minutes: CHAT_EDIT_MINUTES }, 409);
  const a = await chatAccess(db, personId, m.kind, m.ref_id, now);
  if (!a.post) throw new KumiError(a.why ?? "error.chat_not_in", a.whyParams, 403);
  await db.updateTable("chat_message").set((eb) => ({ body, edited_at: now, version: eb("version", "+", 1) })).where("id", "=", m.id).where("removed_at", "is", null).where("hidden_at", "is", null).execute();
}

/** Its author takes a message back, any time (even after leaving the game, or while posting is stopped): its words go. */
export async function removeChat(db: Db, personId: string, messageId: string, now = new Date()) {
  const m = await ownMessage(db, personId, messageId);
  if (m.removed_at) return;
  await db.updateTable("chat_message").set((eb) => ({ body: "", removed_at: now, version: eb("version", "+", 1) })).where("id", "=", m.id).execute();
}

/** Read up to now (only when the app shows it: an assistant reading a chat doesn't mark it read). */
export async function chatSeen(db: Db, personId: string, kind: ChatKind, id: string, now = new Date()) {
  const a = await chatAccess(db, personId, kind, id, now);
  if (!a.read) throw new KumiError(a.why ?? "error.chat_not_in", a.whyParams, 404);
  const th = await threadOf(db, kind, id);
  if (!th) return;
  await db.insertInto("chat_seen").values({ thread_id: th.id, person_id: personId, read_at: now })
    .onConflict((oc) => oc.columns(["thread_id", "person_id"]).doUpdateSet({ read_at: now })).execute();
}

/** No pushes from this chat (the app still shows what's new). */
export async function chatMute(db: Db, personId: string, kind: ChatKind, id: string, muted: boolean, now = new Date()) {
  const a = await chatAccess(db, personId, kind, id, now);
  if (!a.read) throw new KumiError(a.why ?? "error.chat_not_in", a.whyParams, 404);
  const tid = await ensureThread(db, a.game!, now);
  await db.insertInto("chat_seen").values({ thread_id: tid, person_id: personId, muted })
    .onConflict((oc) => oc.columns(["thread_id", "person_id"]).doUpdateSet({ muted })).execute();
}

// ---- What a player sees ----

type Row = { id: string; person_id: string; body: string; created_at: Date; edited_at: Date | null; removed_at: Date | null; hidden_at: Date | null; display_name: string };
const stateOf = (m: Pick<Row, "removed_at" | "hidden_at">) => (m.removed_at ? "removed" : m.hidden_at ? "hidden" : "shown") as "removed" | "hidden" | "shown";

async function messagesOf(db: Db, threadId: string, limit = 500): Promise<Row[]> {
  const rows = await db.selectFrom("chat_message").innerJoin("person", "person.id", "chat_message.person_id")
    .select(["chat_message.id", "chat_message.person_id", "chat_message.body", "chat_message.created_at", "chat_message.edited_at", "chat_message.removed_at", "chat_message.hidden_at", "person.display_name"])
    .where("chat_message.thread_id", "=", threadId).orderBy("chat_message.created_at", "desc").orderBy("chat_message.id", "desc").limit(limit).execute();
  return rows.reverse();
}

/** Names of who's in the game now (not juniors, who don't see the chat). */
async function inIt(db: Db, game: Game): Promise<string[]> {
  if (!game.current.size) return [];
  return (await db.selectFrom("person").select("display_name").where("id", "in", [...game.current]).where("junior", "=", false).where("redacted_at", "is", null).orderBy("display_name").execute()).map((p) => p.display_name);
}

export async function chatThread(db: Db, personId: string, kind: ChatKind, id: string, lang: Lang, now = new Date()) {
  const a = await chatAccess(db, personId, kind, id, now);
  if (!a.read) throw new KumiError(a.why ?? "error.chat_not_in", a.whyParams, a.why === "error.chat_not_in" ? 404 : 403);
  const game = a.game!, th = await threadOf(db, kind, id);
  const rows = th ? await messagesOf(db, th.id) : [];
  const seen = th ? await db.selectFrom("chat_seen").select(["read_at", "muted"]).where("thread_id", "=", th.id).where("person_id", "=", personId).executeTakeFirst() : undefined;
  const reported = new Set(th && rows.length ? (await db.selectFrom("chat_report").select("message_id").where("person_id", "=", personId).where("message_id", "in", rows.map((r) => r.id)).execute()).map((r) => r.message_id) : []);
  return {
    kind, id, title: game.title, starts_at: game.starts_at, ends_at: game.ends_at, people: await inIt(db, game),
    can_post: a.post, cannot_post: a.post ? null : t(lang, a.why ?? "error.chat_not_in", a.whyParams), muted: Boolean(seen?.muted), read_at: seen?.read_at ?? null,
    edit_minutes: CHAT_EDIT_MINUTES, max_chars: CHAT_MAX_CHARS,
    messages: rows.map((m) => {
      const mine = m.person_id === personId, state = stateOf(m);
      return { id: m.id, mine, author: mine ? null : m.display_name, at: m.created_at, edited: Boolean(m.edited_at) && state === "shown", state, body: state === "shown" ? m.body : null,
        can_edit: mine && state === "shown" && a.post && now.getTime() - new Date(m.created_at).getTime() <= CHAT_EDIT_MINUTES * 60_000,
        can_remove: mine && state !== "removed", can_report: !mine && state === "shown" && !reported.has(m.id), reported: reported.has(m.id) };
    }),
  };
}

/** The games this person plays in with a chat worth showing: any with messages in the last 90 days, and those from a
 *  week ago to two weeks ahead (a chat starts with a game's first message). */
async function myGames(db: Db, personId: string, now: Date): Promise<{ kind: ChatKind; id: string }[]> {
  const from = new Date(now.getTime() - 7 * DAY), to = new Date(now.getTime() + 14 * DAY), kept = new Date(now.getTime() - CHAT_KEEP_DAYS * DAY);
  const withThread = await db.selectFrom("chat_seen").innerJoin("chat_thread", "chat_thread.id", "chat_seen.thread_id").select(["chat_thread.kind", "chat_thread.ref_id"])
    .where("chat_seen.person_id", "=", personId).where("chat_thread.ends_at", ">", kept).execute();
  const bookings = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").select("booking.id").distinct()
    .where((w) => w.or([w("booking.organiser_id", "=", personId), w.exists(w.selectFrom("booking_player").select("booking_player.id").whereRef("booking_player.booking_id", "=", "booking.id")
      .where("booking_player.person_id", "=", personId).where("booking_player.removed_at", "is", null))]))
    .where("booking.status", "in", ["confirmed", "completed"]).where(sql<boolean>`court_time.during && tstzrange(${from}, ${to})`).limit(40).execute();
  const sessions = await db.selectFrom("session").innerJoin("enrolment", "enrolment.program_id", "session.program_id").select("session.id").distinct()
    .where("enrolment.person_id", "=", personId).where("enrolment.status", "in", ["booked", "attended", "no_show"])
    .where((w) => w.or([w("enrolment.session_id", "is", null), w("enrolment.session_id", "=", w.ref("session.id"))]))
    .where("session.status", "!=", "cancelled").where("session.ends_at", ">", from).where("session.starts_at", "<", to).limit(40).execute();
  const coached = await db.selectFrom("session").select("id").where("coach_id", "=", personId).where("status", "!=", "cancelled").where("ends_at", ">", from).where("starts_at", "<", to).limit(20).execute();
  const out = new Map<string, { kind: ChatKind; id: string }>();
  for (const g of [...withThread.map((x) => ({ kind: x.kind, id: x.ref_id })), ...bookings.map((b) => ({ kind: "booking" as const, id: b.id })),
    ...sessions.map((s) => ({ kind: "session" as const, id: s.id })), ...coached.map((s) => ({ kind: "session" as const, id: s.id }))]) out.set(`${g.kind}:${g.id}`, g);
  return [...out.values()];
}

/** Unread in a thread for this person: others' messages since they last read it, not taken back or hidden. */
async function unreadIn(db: Db, threadId: string, personId: string, readAt: Date | null): Promise<{ unread: number; last_at: Date | null }> {
  const r = await db.selectFrom("chat_message").select([
    sql<string>`count(*) FILTER (WHERE person_id <> ${personId} AND removed_at IS NULL AND hidden_at IS NULL AND created_at > ${readAt ?? new Date(0)})`.as("unread"),
    (x) => x.fn.max("created_at").as("last_at"),
  ]).where("thread_id", "=", threadId).executeTakeFirstOrThrow();
  return { unread: Number(r.unread), last_at: r.last_at ? new Date(r.last_at as any) : null };
}

export async function myChats(db: Db, personId: string, now = new Date()) {
  const club = await db.selectFrom("club").select("players_chat").executeTakeFirst();
  if (!club?.players_chat) return { off: true, junior: false, chats: [] };
  const p = await db.selectFrom("person").select("junior").where("id", "=", personId).executeTakeFirst();
  if (p?.junior) return { off: false, junior: true, chats: [] };
  const chats = [];
  for (const g of await myGames(db, personId, now)) {
    const a = await chatAccess(db, personId, g.kind, g.id, now);
    if (!a.read) continue;
    const th = await threadOf(db, g.kind, g.id);
    const seen = th ? await db.selectFrom("chat_seen").select(["read_at", "muted"]).where("thread_id", "=", th.id).where("person_id", "=", personId).executeTakeFirst() : undefined;
    const u = th ? await unreadIn(db, th.id, personId, seen?.read_at ?? null) : { unread: 0, last_at: null };
    chats.push({ kind: g.kind, id: g.id, title: a.game!.title, starts_at: a.game!.starts_at, unread: u.unread, last_at: u.last_at, muted: Boolean(seen?.muted), can_post: a.post });
  }
  // What's new first, then the games coming up soonest, then the rest most recent first.
  const t0 = now.getTime(), at = (d: Date) => new Date(d).getTime();
  chats.sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0)
    || (at(a.starts_at) >= t0 ? 0 : 1) - (at(b.starts_at) >= t0 ? 0 : 1)
    || (at(a.starts_at) >= t0 ? at(a.starts_at) - at(b.starts_at) : at(b.starts_at) - at(a.starts_at)));
  return { off: false, junior: false, chats };
}

/** The nav's badge: what's unread in chats this person may read and didn't mute. */
export async function chatUnread(db: Db, personId: string, now = new Date()): Promise<number> {
  const club = await db.selectFrom("club").select("players_chat").executeTakeFirst();
  if (!club?.players_chat) return 0;
  const rows = await db.selectFrom("chat_seen").innerJoin("chat_thread", "chat_thread.id", "chat_seen.thread_id").select(["chat_thread.id", "chat_thread.kind", "chat_thread.ref_id", "chat_seen.read_at"])
    .where("chat_seen.person_id", "=", personId).where("chat_seen.muted", "=", false).where("chat_thread.ends_at", ">", new Date(now.getTime() - CHAT_KEEP_DAYS * DAY))
    .where((w) => w.exists(w.selectFrom("chat_message").select("chat_message.id").whereRef("chat_message.thread_id", "=", "chat_thread.id")
      .where("chat_message.person_id", "!=", personId).where("chat_message.removed_at", "is", null).where("chat_message.hidden_at", "is", null)
      .where(sql<boolean>`chat_message.created_at > coalesce(chat_seen.read_at, 'epoch'::timestamptz)`)))
    .limit(50).execute();
  let n = 0;
  // Only the threads with something new are checked (someone who left reads only until the game ends).
  for (const r of rows) if ((await chatAccess(db, personId, r.kind, r.ref_id, now)).read) n += (await unreadIn(db, r.id, personId, r.read_at)).unread;
  return n;
}

// ---- The staff's view ----

/** Chats with something in the last 30 days, a report waiting first. */
export async function staffChats(db: Db, now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY);
  const rows = await db.selectFrom("chat_thread").select(["chat_thread.id", "chat_thread.kind", "chat_thread.ref_id", "chat_thread.ends_at"])
    .select((eb) => [
      eb.selectFrom("chat_message").select((x) => x.fn.max("created_at").as("m")).whereRef("chat_message.thread_id", "=", "chat_thread.id").as("last_at"),
      eb.selectFrom("chat_message").select((x) => x.fn.countAll<string>().as("n")).whereRef("chat_message.thread_id", "=", "chat_thread.id").as("messages"),
      eb.selectFrom("chat_report").innerJoin("chat_message", "chat_message.id", "chat_report.message_id").select((x) => x.fn.countAll<string>().as("n"))
        .whereRef("chat_message.thread_id", "=", "chat_thread.id").where("chat_message.hidden_at", "is", null).where("chat_message.removed_at", "is", null).as("reports"),
    ])
    .where((w) => w.exists(w.selectFrom("chat_message").select("chat_message.id").whereRef("chat_message.thread_id", "=", "chat_thread.id").where("chat_message.created_at", ">", since)))
    .limit(200).execute();
  const out = [];
  for (const r of rows) {
    const g = await gameOf(db, r.kind, r.ref_id);
    out.push({ id: r.id, kind: r.kind, ref_id: r.ref_id, title: g?.title ?? "", starts_at: g?.starts_at ?? r.ends_at, last_at: r.last_at, messages: Number(r.messages ?? 0), reports: Number(r.reports ?? 0) });
  }
  out.sort((a, b) => (b.reports > 0 ? 1 : 0) - (a.reports > 0 ? 1 : 0) || new Date(b.last_at as any).getTime() - new Date(a.last_at as any).getTime());
  return out;
}

/** One chat as the staff see it: a hidden message's words too (to judge it), who reported what, who's stopped. */
export async function staffChat(db: Db, threadId: string, now = new Date()) {
  const th = isUuid(threadId) ? await db.selectFrom("chat_thread").selectAll().where("id", "=", threadId).executeTakeFirst() : undefined;
  if (!th) throw new KumiError("error.not_found", { thing: both("thing.chat") }, 404);
  const g = await gameOf(db, th.kind, th.ref_id), rows = await messagesOf(db, th.id, 1000);
  const reports = rows.length ? await db.selectFrom("chat_report").innerJoin("person", "person.id", "chat_report.person_id")
    .select(["chat_report.message_id", "chat_report.reason", "chat_report.created_at", "person.display_name"]).where("chat_report.message_id", "in", rows.map((r) => r.id)).orderBy("chat_report.created_at").execute() : [];
  const authors = [...new Set(rows.map((r) => r.person_id))];
  const stops = new Map<string, Date>();
  for (const a of authors) { const s = await activeStop(db, a, now); if (s) stops.set(a, new Date(s.until)); }
  return {
    id: th.id, kind: th.kind, ref_id: th.ref_id, title: g?.title ?? "", starts_at: g?.starts_at ?? th.ends_at, ends_at: th.ends_at, location_id: g?.location_id ?? null, people: g ? await inIt(db, g) : [],
    messages: rows.map((m) => ({ id: m.id, person_id: m.person_id, author: m.display_name, at: m.created_at, edited: Boolean(m.edited_at), state: stateOf(m),
      body: m.removed_at ? null : m.body, author_stopped_until: stops.get(m.person_id) ?? null,
      reports: reports.filter((r) => r.message_id === m.id).map((r) => ({ by: r.display_name, at: r.created_at, reason: r.reason })) })),
  };
}

// ---- The club's say ----

async function messageForAction(db: Db | Trx, messageId: string) {
  const m = await db.selectFrom("chat_message").innerJoin("chat_thread", "chat_thread.id", "chat_message.thread_id").innerJoin("person", "person.id", "chat_message.person_id")
    .select(["chat_message.id", "chat_message.person_id", "chat_message.thread_id", "chat_message.removed_at", "chat_message.hidden_at", "chat_thread.kind", "chat_thread.ref_id", "person.display_name"])
    .where("chat_message.id", "=", messageId).executeTakeFirst();
  if (!m) throw new KumiError("error.not_found", { thing: both("thing.chat_message") }, 404);
  return m;
}
const gameText = (g: Game | null, tz: string): Text => g ? { en: `${g.title}, ${dateTime(g.starts_at, "en", tz)}`, es: `${g.title}, ${dateTime(g.starts_at, "es", tz)}` } : { en: "", es: "" };
const zone = async (db: Db | Trx) => (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;

/** A player tells the club about a message in a chat they read. The staff hear once per message (a staff alert). */
export const chatReport = defineAction({
  name: "chat.report", version: 1,
  input: z.object({ message_id: z.uuid(), reason: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const m = await messageForAction(ctx.db, i.message_id);
    const pid = ctx.actor.personId;
    if (!pid) throw new KumiError("error.signed_out", {}, 401);
    const a = await chatAccess(ctx.db, pid, m.kind, m.ref_id, ctx.now);
    if (!a.read) throw new KumiError("error.not_found", { thing: both("thing.chat_message") }, 404);
    if (m.person_id === pid) throw new KumiError("error.chat_report_own");
    if (m.removed_at || m.hidden_at) throw new KumiError("error.chat_gone");
    if (await ctx.db.selectFrom("chat_report").select("id").where("message_id", "=", m.id).where("person_id", "=", pid).executeTakeFirst()) throw new KumiError("error.chat_reported");
    // The message's words aren't copied into the plan (the change log keeps plans).
    return { title: both("action.chat.report"), summary: both("plan.chat.report", { name: m.display_name, game: gameText(a.game, await zone(ctx.db)) }), reads: [], ownerIds: [pid],
      locationId: a.game?.location_id ?? null, undo: { kind: "none", note: both("reason.undo_final") }, details: { thread_id: m.thread_id } };
  },
  async apply(ctx, i) {
    const m = await messageForAction(ctx.trx, i.message_id);
    const first = !(await ctx.trx.selectFrom("chat_report").select("id").where("message_id", "=", m.id).executeTakeFirst());
    try { await ctx.insert("chat_report", { id: uuidv7(), message_id: m.id, person_id: ctx.actor.personId, reason: i.reason?.trim() || null, created_at: ctx.now }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.chat_reported"); throw e; }
    if (first) await ctx.emit("chat.reported", { thread_id: m.thread_id, message_id: m.id, kind: m.kind, ref_id: m.ref_id, author: m.display_name, by: ctx.actor.personId });
    return null;
  },
});

/** The staff hide a message (players see "hidden by the club"; the staff still see its words), or show it again. */
export const chatHide = defineAction({
  name: "chat.hide", version: 1,
  input: z.object({ message_id: z.uuid(), hidden: z.boolean() }),
  async plan(ctx, i) {
    const m = await messageForAction(ctx.db, i.message_id);
    if (m.removed_at) throw new KumiError("error.chat_gone");
    if (Boolean(m.hidden_at) === i.hidden) throw new KumiError(i.hidden ? "error.chat_already_hidden" : "error.chat_not_hidden");
    const { read } = await readRow(ctx.db, "chat_message", m.id, "thing.chat_message");
    const g = await gameOf(ctx.db, m.kind, m.ref_id);
    return { title: both(i.hidden ? "action.chat.hide" : "action.chat.show"), summary: both(i.hidden ? "plan.chat.hide" : "plan.chat.show", { name: m.display_name, game: gameText(g, await zone(ctx.db)) }),
      reads: [read], locationId: g?.location_id ?? null, undo: { kind: "reversible" }, details: { thread_id: m.thread_id } };
  },
  async apply(ctx, i) {
    await ctx.update("chat_message", i.message_id, { hidden_at: i.hidden ? ctx.now : null, hidden_by: i.hidden ? ctx.actor.personId : null });
    return null;
  },
});

/** The staff stop someone posting in every chat for a while; they still read. */
export const chatStop = defineAction({
  name: "chat.stop", version: 1, clubWide: true,
  input: z.object({ person_id: z.uuid(), days: z.number().check(z.int(), z.minimum(1), z.maximum(90)), reason: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const p = await ctx.db.selectFrom("person").select(["display_name", "redacted_at"]).where("id", "=", i.person_id).executeTakeFirst();
    if (!p || p.redacted_at) throw new KumiError("error.not_found", { thing: both("thing.person") }, 404);
    const until = new Date(ctx.now.getTime() + i.days * DAY), tz = await zone(ctx.db);
    return { title: both("action.chat.stop"), summary: both("plan.chat.stop", { name: p.display_name, until: { en: dateTime(until, "en", tz), es: dateTime(until, "es", tz) } }),
      reads: [], ownerIds: [i.person_id], undo: { kind: "reversible" }, details: { until } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("chat_stop", { id, person_id: i.person_id, until: new Date(ctx.now.getTime() + i.days * DAY), reason: i.reason?.trim() || null, created_by: ctx.actor.personId, created_at: ctx.now });
    return { stop_id: id };
  },
});

/** The staff let someone post again before their stop runs out. */
export const chatAllow = defineAction({
  name: "chat.allow", version: 1, clubWide: true,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const p = await ctx.db.selectFrom("person").select("display_name").where("id", "=", i.person_id).executeTakeFirst();
    if (!p) throw new KumiError("error.not_found", { thing: both("thing.person") }, 404);
    const stops = await ctx.db.selectFrom("chat_stop").select("id").where("person_id", "=", i.person_id).where("ended_at", "is", null).where("until", ">", ctx.now).execute();
    if (!stops.length) throw new KumiError("error.chat_not_stopped");
    const reads = await Promise.all(stops.map(async (s) => (await readRow(ctx.db, "chat_stop", s.id)).read));
    return { title: both("action.chat.allow"), summary: both("plan.chat.allow", { name: p.display_name }), reads, ownerIds: [i.person_id], undo: { kind: "reversible" }, details: { stops: stops.map((s) => s.id) } };
  },
  async apply(ctx, _i, plan) {
    for (const id of (plan.details as { stops: string[] }).stops) await ctx.update("chat_stop", id, { ended_at: ctx.now });
    return null;
  },
});

// ---- Keeping ----

/** Chats go 90 days after their game, with every message, report and read mark in them (a game moved later keeps
 *  its chat longer). Stops long over go too. */
export async function tidyChats(db: Db, now = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - CHAT_KEEP_DAYS * DAY);
  let deleted = 0;
  for (const th of await db.selectFrom("chat_thread").select(["id", "kind", "ref_id"]).where("ends_at", "<", cutoff).limit(200).execute()) {
    const g = await gameOf(db, th.kind, th.ref_id);
    if (g && g.ends_at >= cutoff) { await db.updateTable("chat_thread").set({ ends_at: g.ends_at }).where("id", "=", th.id).execute(); continue; }
    await db.deleteFrom("chat_thread").where("id", "=", th.id).execute();
    deleted++;
  }
  await db.deleteFrom("chat_stop").where("until", "<", cutoff).execute();
  return { deleted };
}

/** A person's own messages, for their Download data. */
export async function chatsOf(db: Db | Trx, personId: string) {
  const rows = await db.selectFrom("chat_message").innerJoin("chat_thread", "chat_thread.id", "chat_message.thread_id")
    .select(["chat_thread.kind", "chat_thread.ref_id", "chat_message.body", "chat_message.created_at", "chat_message.edited_at", "chat_message.removed_at", "chat_message.hidden_at"])
    .where("chat_message.person_id", "=", personId).orderBy("chat_message.created_at").execute();
  return rows.map((m) => ({ game: m.kind, game_id: m.ref_id, at: m.created_at, text: m.removed_at ? null : m.body, edited_at: m.edited_at, taken_back_at: m.removed_at, hidden_by_the_club: Boolean(m.hidden_at) }));
}

/** Deleting an account (privacy.ts): their words go (each message shows "message removed", under "Former member"),
 *  with their read marks; their reports keep no reason, and the club's stops on them no reason either. */
export async function eraseChats(db: Trx, personId: string, now: Date) {
  await db.updateTable("chat_message").set({ body: "", removed_at: sql`coalesce(removed_at, ${now})` }).where("person_id", "=", personId).execute();
  await db.deleteFrom("chat_seen").where("person_id", "=", personId).execute();
  await db.updateTable("chat_report").set({ reason: null }).where("person_id", "=", personId).execute();
  await db.updateTable("chat_stop").set({ reason: null }).where("person_id", "=", personId).execute();
}
