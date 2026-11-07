// Chat between players: a thread inside a game people play together, a court booking with named players (an open
// match is one) or a program's date (a clinic, a social night, a league night). Everyone in the game reads and
// posts. Someone who leaves it reads what was said up to the moment they left, without posting; someone the
// organiser or the staff took off reads nothing. A place saved for someone and not yet taken isn't in the game, nor
// is a waitlist. Juniors don't see chats in this version (a parent in the same game reads it as themselves). There
// are no messages between members outside a shared game, and no list of members.
//
// Posting, editing and taking a message back aren't actions: they aren't in the change log, and no assistant can
// do them (an assistant reads its person's chats, nothing more). The club's moderation is: a player's report, which
// the staff hear about (once an hour per chat at most), the staff hiding a message, or showing it again, and
// stopping someone posting for a while, each in Changes. A reported message keeps its words for the staff until
// they've looked, even if its author takes it back, and can't be changed meanwhile. Posting closes two days after
// the game; a chat is deleted 90 days after it, with everything in it.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both, dateTime, type Key, type Lang, type Params, type Text, t } from "@kumi/i18n";
import { defineAction, forgetStaleInputs, readRow } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { quietUntil } from "./messages.ts";
import { leavingOn } from "./leaving.ts";
import { plainName, plainText, visible } from "./plain_text.ts";

export type ChatKind = "booking" | "session";
export const CHAT_KINDS: ChatKind[] = ["booking", "session"];
/** Kept this long after the game. */
export const CHAT_KEEP_DAYS = 90;
/** Posting stays open this long after the game (the score, who left a racket); reading goes on until the chat goes. */
export const CHAT_OPEN_DAYS = 2;
export const CHAT_MAX_CHARS = 1000;
/** Its author can change a message this long after posting it (taking it back works any time). */
export const CHAT_EDIT_MINUTES = 5;
/** At most this many posts by one person in this many minutes, across every chat. */
export const CHAT_RATE = { posts: 20, minutes: 10 };
/** A player's phone hears about one chat at most once in this many minutes; the app's badge counts the rest. */
export const CHAT_PUSH_MINUTES = 5;
/** The staff hear about reports in one chat at most once in this many minutes; the Chats list counts the rest. */
export const CHAT_ALERT_MINUTES = 60;
/** A chat's push isn't worth showing after this long (a phone that was off, or quiet hours). */
const PUSH_STALE_MINUTES = 15;
const DAY = 86400_000;

// ---- The game a chat belongs to ----

export interface Game {
  kind: ChatKind; id: string; title: string; starts_at: Date; ends_at: Date; location_id: string | null; cancelled: boolean;
  /** In it now (the organiser and named players; those with a place, and the coach). */
  current: Set<string>;
  /** Left it themselves, and when: they read what was said up to then. */
  former: Map<string, Date>;
}

/** Who took each of these booking places off, from the change log: the player themselves, or someone else. */
async function removedBySelf(db: Db | Trx, seats: { id: string; person_id: string }[]): Promise<Set<string>> {
  if (!seats.length) return new Set();
  const rows = await db.selectFrom("entity_change").innerJoin("action_run", "action_run.id", "entity_change.action_run_id")
    .select(["entity_change.entity_id", "action_run.actor_person_id"]).where("entity_change.entity", "=", "booking_player").where("entity_change.op", "=", "update")
    .where("entity_change.entity_id", "in", seats.map((s) => s.id)).where(sql<boolean>`(entity_change.after->>'removed_at') IS NOT NULL AND (entity_change.before->>'removed_at') IS NULL`).execute();
  const by = new Map(rows.map((r) => [r.entity_id, r.actor_person_id]));
  return new Set(seats.filter((s) => by.get(s.id) === s.person_id).map((s) => s.id));
}

export async function gameOf(db: Db | Trx, kind: ChatKind, id: string): Promise<Game | null> {
  const current = new Set<string>(), former = new Map<string, Date>();
  if (kind === "booking") {
    const b = await db.selectFrom("booking").select(["organiser_id", "status", "location_id"]).where("id", "=", id).executeTakeFirst();
    if (!b) return null;
    // Its court time now; a cancelled booking has only retired ones, and still has a time. A booking moved earlier
    // ends when it ends now, not at its old time.
    const span = await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id")
      .select([sql<Date | null>`coalesce(min(lower(court_time.during)) FILTER (WHERE court_time.active), min(lower(court_time.during)))`.as("starts"),
        sql<Date | null>`coalesce(max(upper(court_time.during)) FILTER (WHERE court_time.active), max(upper(court_time.during)))`.as("ends"),
        sql<string | null>`coalesce(min(court.name) FILTER (WHERE court_time.active), min(court.name))`.as("court")])
      .where("court_time.booking_id", "=", id).executeTakeFirst();
    if (!span?.starts || !span.ends) return null;
    if (b.organiser_id) current.add(b.organiser_id);
    const seats = await db.selectFrom("booking_player").select(["booking_player.id", "booking_player.person_id", "booking_player.removed_at", "booking_player.leaving_at", "booking_player.saved_by"])
      .select((eb) => eb.exists(eb.selectFrom("payment").select("payment.id").whereRef("payment.booking_player_id", "=", "booking_player.id").where("payment.status", "=", "succeeded")).as("paid"))
      .where("booking_id", "=", id).where("person_id", "is not", null).execute();
    // A place saved for someone (an open match's "save a place") is theirs once they take it, by paying.
    const taken = seats.filter((s) => !s.saved_by || s.paid);
    const self = await removedBySelf(db, taken.filter((s) => s.removed_at && !s.leaving_at).map((s) => ({ id: s.id, person_id: s.person_id! })));
    for (const s of taken) {
      if (!s.removed_at && !s.leaving_at) current.add(s.person_id!);
      else if (s.leaving_at) former.set(s.person_id!, new Date(s.leaving_at));
      else if (self.has(s.id)) former.set(s.person_id!, new Date(s.removed_at!));
    }
    for (const p of current) former.delete(p);
    return { kind, id, title: span.court ?? "", starts_at: new Date(span.starts), ends_at: new Date(span.ends), location_id: b.location_id, cancelled: b.status === "cancelled", current, former };
  }
  const s = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id")
    .select(["session.program_id", "session.starts_at", "session.ends_at", "session.status", "session.coach_id", "program.name", "program.location_id", "program.status as program_status"])
    .where("session.id", "=", id).executeTakeFirst();
  if (!s) return null;
  for (const e of await db.selectFrom("enrolment").select(["person_id", "status", "session_id", "waitlist_position", "left_how", "left_at"]).where("program_id", "=", s.program_id)
    .where((w) => w.or([w("session_id", "=", id), w("session_id", "is", null)])).execute()) {
    if (e.status === "booked" || e.status === "attended" || e.status === "no_show") { current.add(e.person_id); continue; }
    // Left a place they held, themselves (or passed it to a sub): never a waitlist, never someone the staff took
    // off, and for a whole program only the dates that had begun before they left.
    if (e.status !== "cancelled" || e.waitlist_position !== null || !e.left_at || !["left", "transferred"].includes(e.left_how ?? "")) continue;
    if (e.session_id === null && new Date(s.starts_at) >= new Date(e.left_at)) continue;
    const at = new Date(e.left_at), had = former.get(e.person_id);
    if (!had || had < at) former.set(e.person_id, at);
  }
  if (s.coach_id) current.add(s.coach_id);
  for (const p of current) former.delete(p);
  return { kind, id, title: s.name, starts_at: new Date(s.starts_at), ends_at: new Date(s.ends_at), location_id: s.location_id,
    cancelled: s.status === "cancelled" || s.program_status === "cancelled", current, former };
}

// ---- Who reads and who posts ----

/** `until`: someone who left reads what was said up to then. */
export interface Access { read: boolean; post: boolean; why: Key | null; whyParams: Params; game: Game | null; until: Date | null }
const no = (why: Key, game: Game | null = null): Access => ({ read: false, post: false, why, whyParams: {}, game, until: null });

/** The club stopping someone posting, if it's still running. */
export async function activeStop(db: Db | Trx, personId: string, now: Date) {
  return (await db.selectFrom("chat_stop").select(["id", "until", "reason"]).where("person_id", "=", personId).where("ended_at", "is", null).where("until", ">", now)
    .orderBy("until", "desc").limit(1).executeTakeFirst()) ?? null;
}

/** Why someone in the game can't post right now, or null. */
async function postBlock(db: Db | Trx, personId: string, game: Game, now: Date): Promise<{ why: Key; params: Params } | null> {
  if (game.cancelled) return { why: "error.chat_cancelled", params: {} };
  if (now.getTime() > game.ends_at.getTime() + CHAT_OPEN_DAYS * DAY) return { why: "error.chat_closed", params: { days: CHAT_OPEN_DAYS } };
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

export async function chatAccess(db: Db | Trx, personId: string, kind: ChatKind, id: string, now: Date): Promise<Access> {
  const club = await db.selectFrom("club").select("players_chat").executeTakeFirst();
  if (!club?.players_chat) return no("error.chat_off");
  const p = await db.selectFrom("person").select(["junior", "redacted_at"]).where("id", "=", personId).executeTakeFirst();
  if (!p || p.redacted_at) return no("error.chat_not_in");
  // Juniors (with a login of their own) don't read or post in chats in this version.
  if (p.junior) return no("error.chat_junior");
  const game = await gameOf(db, kind, id);
  if (!game) return no("error.chat_not_in");
  // 90 days after the game the chat is gone, and nothing makes it again.
  if (now.getTime() > game.ends_at.getTime() + CHAT_KEEP_DAYS * DAY) return no("error.chat_expired", game);
  if (game.current.has(personId)) {
    const block = await postBlock(db, personId, game, now);
    return { read: true, post: !block, why: block?.why ?? null, whyParams: block?.params ?? {}, game, until: null };
  }
  const left = game.former.get(personId);
  if (left) return { read: true, post: false, why: "error.chat_left", whyParams: {}, game, until: left };
  return no("error.chat_not_in", game);
}

/** Its thread, made with its first message (or the first mute); kept until 90 days after the game, which a move later
 *  pushes out. */
async function ensureThread(db: Db | Trx, game: Game, now: Date): Promise<string> {
  const r = await db.insertInto("chat_thread").values({ id: uuidv7(now.getTime()), kind: game.kind, ref_id: game.id, ends_at: game.ends_at })
    .onConflict((oc) => oc.columns(["kind", "ref_id"]).doUpdateSet({ ends_at: game.ends_at })).returning("id").executeTakeFirstOrThrow();
  return r.id;
}

/** Plain text: control and invisible formatting characters out (new lines kept), something that can be seen, and at
 *  most CHAT_MAX_CHARS. */
export function chatText(raw: unknown): string {
  const s = plainText(String(raw ?? ""));
  if (!s || !visible(s)) throw new KumiError("error.chat_empty", {}, 400);
  if ([...s].length > CHAT_MAX_CHARS) throw new KumiError("error.chat_too_long", { max: CHAT_MAX_CHARS }, 400);
  return s;
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
  const game = a.game!;
  return db.transaction().execute(async (trx) => {
    // One person's posts one at a time, so the limit holds however many arrive at once.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kumi.chat:${personId}`}, 0))`.execute(trx);
    const r = await trx.selectFrom("chat_message").select((x) => x.fn.countAll<string>().as("n")).where("person_id", "=", personId)
      .where("created_at", ">", new Date(now.getTime() - CHAT_RATE.minutes * 60_000)).executeTakeFirstOrThrow();
    if (Number(r.n) >= CHAT_RATE.posts) throw new KumiError("error.chat_too_fast", { minutes: CHAT_RATE.minutes }, 429);
    const tid = await ensureThread(trx, game, now), mid = uuidv7(now.getTime());
    await trx.insertInto("chat_message").values({ id: mid, thread_id: tid, person_id: personId, body, created_at: now }).execute();
    // Everyone in the game has a place in the thread from its first message, so their badge counts what they haven't read.
    const readers = await trx.selectFrom("person").select("id").where("id", "in", [...game.current]).where("junior", "=", false).where("redacted_at", "is", null).execute();
    await trx.insertInto("chat_seen").values(readers.map((x) => ({ thread_id: tid, person_id: x.id, read_at: x.id === personId ? now : null })))
      .onConflict((oc) => oc.columns(["thread_id", "person_id"]).doNothing()).execute();
    await trx.updateTable("chat_seen").set({ read_at: now }).where("thread_id", "=", tid).where("person_id", "=", personId).execute();
    await tellPhones(trx, game, tid, mid, personId, now);
    return { id: mid };
  });
}

/** A push to each player's phone (never a text or an email): at most one per chat in CHAT_PUSH_MINUTES (claimed, so
 *  posts at once can't each send one), none for a muted chat, and none during the club's quiet hours (it goes stale
 *  before they end). The copy names the message and holds none of its words: they're read when it's sent (push.ts). */
async function tellPhones(db: Trx, game: Game, threadId: string, messageId: string, from: string, now: Date) {
  const club = await db.selectFrom("club").select(["time_zone", "default_language"]).executeTakeFirstOrThrow();
  const wait = quietUntil(now, club.time_zone), stale = new Date(now.getTime() + PUSH_STALE_MINUTES * 60_000);
  if (wait && wait >= stale) return;
  const since = new Date(now.getTime() - CHAT_PUSH_MINUTES * 60_000);
  const claimed = await db.updateTable("chat_seen").set({ pushed_at: now }).where("thread_id", "=", threadId).where("person_id", "!=", from).where("person_id", "in", [...game.current])
    .where("muted", "=", false).where((w) => w.or([w("pushed_at", "is", null), w("pushed_at", "<", since)]))
    .where((w) => w.exists(w.selectFrom("push_subscription").select("push_subscription.id").whereRef("push_subscription.person_id", "=", "chat_seen.person_id").where("push_subscription.revoked_at", "is", null)))
    .where((w) => w.exists(w.selectFrom("person").select("person.id").whereRef("person.id", "=", "chat_seen.person_id").where("person.junior", "=", false).where("person.redacted_at", "is", null).where("person.status", "!=", "archived")))
    .returning("person_id").execute();
  if (!claimed.length) return;
  const langs = await db.selectFrom("person").select(["id", "locale"]).where("id", "in", claimed.map((c) => c.person_id)).execute();
  for (const p of langs) {
    const lang: Lang = p.locale === "es" ? "es" : p.locale === "en" ? "en" : club.default_language === "es" ? "es" : "en";
    await db.insertInto("outbound_message").values({
      id: uuidv7(now.getTime()), event_id: null, person_id: p.id, kind: "chat_message", channel: "push", purpose: "account", essential: false, lang,
      subject: t(lang, "msg.chat_message.subject", { game: game.title, when: dateTime(game.starts_at, lang, club.time_zone) }), body: "", chat_message_id: messageId,
      link: `/chats/${game.kind}/${game.id}`, status: "waiting", send_after: wait ?? now, stale_at: stale,
    }).execute();
  }
}

/** Reports on a message the staff haven't dealt with yet. */
async function openReports(db: Db | Trx, messageId: string): Promise<number> {
  const r = await db.selectFrom("chat_report").select((x) => x.fn.countAll<string>().as("n")).where("message_id", "=", messageId).where("dealt_at", "is", null).executeTakeFirstOrThrow();
  return Number(r.n);
}

async function ownMessage(db: Db, personId: string, messageId: string) {
  const m = isUuid(messageId) ? await db.selectFrom("chat_message").innerJoin("chat_thread", "chat_thread.id", "chat_message.thread_id")
    .select(["chat_message.id", "chat_message.person_id", "chat_message.created_at", "chat_message.removed_at", "chat_message.hidden_at", "chat_thread.kind", "chat_thread.ref_id"])
    .where("chat_message.id", "=", messageId).executeTakeFirst() : undefined;
  if (!m || m.person_id !== personId) throw new KumiError("error.not_found", { thing: both("thing.chat_message") }, 404);
  return m;
}

/** Its author changes a message within CHAT_EDIT_MINUTES of posting it, while they may still post, and not while a
 *  report on it waits for the staff. */
export async function editChat(db: Db, personId: string, messageId: string, raw: unknown, now = new Date()) {
  const body = chatText(raw), m = await ownMessage(db, personId, messageId);
  if (m.removed_at || m.hidden_at) throw new KumiError("error.chat_gone", {}, 409);
  if (now.getTime() - new Date(m.created_at).getTime() > CHAT_EDIT_MINUTES * 60_000) throw new KumiError("error.chat_edit_window", { minutes: CHAT_EDIT_MINUTES }, 409);
  if (await openReports(db, m.id)) throw new KumiError("error.chat_report_waits", {}, 409);
  const a = await chatAccess(db, personId, m.kind, m.ref_id, now);
  if (!a.post) throw new KumiError(a.why ?? "error.chat_not_in", a.whyParams, 403);
  await db.updateTable("chat_message").set((eb) => ({ body, edited_at: now, version: eb("version", "+", 1) })).where("id", "=", m.id).where("removed_at", "is", null).where("hidden_at", "is", null).execute();
}

/** Its author takes a message back, any time (even after leaving the game, or while posting is stopped): its words go
 *  for everyone, except that a report the staff haven't looked at yet keeps them for the staff until they do. */
export async function removeChat(db: Db, personId: string, messageId: string, now = new Date()) {
  const m = await ownMessage(db, personId, messageId);
  if (m.removed_at) return;
  const keep = (await openReports(db, m.id)) > 0;
  await db.updateTable("chat_message").set((eb) => ({ ...(keep ? {} : { body: "" }), removed_at: now, version: eb("version", "+", 1) })).where("id", "=", m.id).execute();
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

async function messagesOf(db: Db, threadId: string, o: { limit?: number; until?: Date | null } = {}): Promise<Row[]> {
  const rows = await db.selectFrom("chat_message").innerJoin("person", "person.id", "chat_message.person_id")
    .select(["chat_message.id", "chat_message.person_id", "chat_message.body", "chat_message.created_at", "chat_message.edited_at", "chat_message.removed_at", "chat_message.hidden_at", "person.display_name"])
    .where("chat_message.thread_id", "=", threadId).$if(Boolean(o.until), (q) => q.where("chat_message.created_at", "<=", o.until!))
    .orderBy("chat_message.created_at", "desc").orderBy("chat_message.id", "desc").limit(o.limit ?? 500).execute();
  return rows.reverse().map((r) => ({ ...r, display_name: plainName(r.display_name) }));
}

/** Who's named in a chat: for a court booking (an open match too), its players, whom the players already see; for a
 *  program's date, only those who've written in it (the rest of the roster stays the club's). */
async function namesIn(db: Db, game: Game, threadId: string | null): Promise<{ people: string[]; players: number }> {
  const adults = game.current.size ? (await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", [...game.current]).where("junior", "=", false).where("redacted_at", "is", null).orderBy("display_name").execute()) : [];
  if (game.kind === "booking") return { people: adults.map((p) => plainName(p.display_name)).filter(Boolean), players: adults.length };
  const wrote = threadId ? new Set((await db.selectFrom("chat_message").select("person_id").distinct().where("thread_id", "=", threadId).execute()).map((r) => r.person_id)) : new Set<string>();
  return { people: adults.filter((p) => wrote.has(p.id)).map((p) => plainName(p.display_name)).filter(Boolean), players: adults.length };
}

export async function chatThread(db: Db, personId: string, kind: ChatKind, id: string, lang: Lang, now = new Date()) {
  const a = await chatAccess(db, personId, kind, id, now);
  if (!a.read) throw new KumiError(a.why ?? "error.chat_not_in", a.whyParams, a.why === "error.chat_not_in" || a.why === "error.chat_expired" ? 404 : 403);
  const game = a.game!, th = await threadOf(db, kind, id);
  const rows = th ? await messagesOf(db, th.id, { until: a.until }) : [];
  const seen = th ? await db.selectFrom("chat_seen").select(["read_at", "muted"]).where("thread_id", "=", th.id).where("person_id", "=", personId).executeTakeFirst() : undefined;
  const reported = new Set(th && rows.length ? (await db.selectFrom("chat_report").select("message_id").where("person_id", "=", personId).where("message_id", "in", rows.map((r) => r.id)).execute()).map((r) => r.message_id) : []);
  // Someone who left sees no roster: who's in it now isn't theirs to know.
  const names = a.until ? { people: [], players: 0 } : await namesIn(db, game, th?.id ?? null);
  return {
    kind, id, title: game.title, starts_at: game.starts_at, ends_at: game.ends_at, people: names.people, players: names.players,
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

/** Unread in a thread for this person: others' messages since they last read it (up to when they left), not taken
 *  back or hidden. */
async function unreadIn(db: Db, threadId: string, personId: string, readAt: Date | null, until: Date | null): Promise<{ unread: number; last_at: Date | null }> {
  const r = await db.selectFrom("chat_message").select([
    sql<string>`count(*) FILTER (WHERE person_id <> ${personId} AND removed_at IS NULL AND hidden_at IS NULL AND created_at > ${readAt ?? new Date(0)})`.as("unread"),
    (x) => x.fn.max("created_at").as("last_at"),
  ]).where("thread_id", "=", threadId).$if(Boolean(until), (q) => q.where("created_at", "<=", until!)).executeTakeFirstOrThrow();
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
    const u = th ? await unreadIn(db, th.id, personId, seen?.read_at ?? null, a.until) : { unread: 0, last_at: null };
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
  // Only the threads with something new are checked (someone who left counts only what came before they left).
  for (const r of rows) {
    const a = await chatAccess(db, personId, r.kind, r.ref_id, now);
    if (a.read) n += (await unreadIn(db, r.id, personId, r.read_at, a.until)).unread;
  }
  return n;
}

// ---- The staff's view ----

/** Chats with something in the last 30 days, the ones with reports waiting first, then the most recent. */
export async function staffChats(db: Db, now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY);
  const rows = await db.selectFrom("chat_thread").select(["chat_thread.id", "chat_thread.kind", "chat_thread.ref_id", "chat_thread.ends_at"])
    .select((eb) => [
      eb.selectFrom("chat_message").select((x) => x.fn.max("created_at").as("m")).whereRef("chat_message.thread_id", "=", "chat_thread.id").as("last_at"),
      eb.selectFrom("chat_message").select((x) => x.fn.countAll<string>().as("n")).whereRef("chat_message.thread_id", "=", "chat_thread.id").as("messages"),
      eb.selectFrom("chat_report").innerJoin("chat_message", "chat_message.id", "chat_report.message_id").select((x) => x.fn.countAll<string>().as("n"))
        .whereRef("chat_message.thread_id", "=", "chat_thread.id").where("chat_report.dealt_at", "is", null).as("reports"),
    ])
    .where((w) => w.or([
      w.exists(w.selectFrom("chat_message").select("chat_message.id").whereRef("chat_message.thread_id", "=", "chat_thread.id").where("chat_message.created_at", ">", since)),
      w.exists(w.selectFrom("chat_report").innerJoin("chat_message", "chat_message.id", "chat_report.message_id").select("chat_report.id").whereRef("chat_message.thread_id", "=", "chat_thread.id").where("chat_report.dealt_at", "is", null)),
    ]))
    .orderBy(sql`(SELECT count(*) FROM chat_report r JOIN chat_message m ON m.id = r.message_id WHERE m.thread_id = chat_thread.id AND r.dealt_at IS NULL)`, "desc")
    .orderBy(sql`(SELECT max(created_at) FROM chat_message m WHERE m.thread_id = chat_thread.id)`, "desc")
    .limit(200).execute();
  const out = [];
  for (const r of rows) {
    const g = await gameOf(db, r.kind, r.ref_id);
    out.push({ id: r.id, kind: r.kind, ref_id: r.ref_id, title: g?.title ?? "", starts_at: g?.starts_at ?? r.ends_at, last_at: r.last_at, messages: Number(r.messages ?? 0), reports: Number(r.reports ?? 0) });
  }
  return out;
}

/** One chat as the staff see it: a hidden message's words too (to judge it), a reported one's even if its author took
 *  it back, who reported what, who's stopped. */
export async function staffChat(db: Db, threadId: string, now = new Date()) {
  const th = isUuid(threadId) ? await db.selectFrom("chat_thread").selectAll().where("id", "=", threadId).executeTakeFirst() : undefined;
  if (!th) throw new KumiError("error.not_found", { thing: both("thing.chat") }, 404);
  const g = await gameOf(db, th.kind, th.ref_id), rows = await messagesOf(db, th.id, { limit: 1000 });
  const reports = rows.length ? await db.selectFrom("chat_report").innerJoin("person", "person.id", "chat_report.person_id")
    .select(["chat_report.message_id", "chat_report.reason", "chat_report.created_at", "chat_report.dealt_at", "person.display_name"]).where("chat_report.message_id", "in", rows.map((r) => r.id)).orderBy("chat_report.created_at").execute() : [];
  const authors = [...new Set(rows.map((r) => r.person_id))];
  const stops = new Map<string, Date>();
  for (const a of authors) { const s = await activeStop(db, a, now); if (s) stops.set(a, new Date(s.until)); }
  const names = g ? await namesIn(db, { ...g, kind: "booking" }, th.id) : { people: [], players: 0 };
  return {
    id: th.id, kind: th.kind, ref_id: th.ref_id, title: g?.title ?? "", starts_at: g?.starts_at ?? th.ends_at, ends_at: th.ends_at, location_id: g?.location_id ?? null, people: names.people,
    messages: rows.map((m) => ({ id: m.id, person_id: m.person_id, author: m.display_name, at: m.created_at, edited: Boolean(m.edited_at), state: stateOf(m),
      body: m.body === "" ? null : m.body, author_stopped_until: stops.get(m.person_id) ?? null,
      reports: reports.filter((r) => r.message_id === m.id).map((r) => ({ by: plainName(r.display_name), at: r.created_at, reason: r.reason, dealt: Boolean(r.dealt_at) })) })),
  };
}

// ---- The club's say ----

async function messageForAction(db: Db | Trx, messageId: string) {
  const m = await db.selectFrom("chat_message").innerJoin("chat_thread", "chat_thread.id", "chat_message.thread_id").innerJoin("person", "person.id", "chat_message.person_id")
    .select(["chat_message.id", "chat_message.person_id", "chat_message.thread_id", "chat_message.body", "chat_message.removed_at", "chat_message.hidden_at", "chat_thread.kind", "chat_thread.ref_id", "person.display_name"])
    .where("chat_message.id", "=", messageId).executeTakeFirst();
  if (!m) throw new KumiError("error.not_found", { thing: both("thing.chat_message") }, 404);
  return { ...m, display_name: plainName(m.display_name) };
}
/** A name to show in a preview: "A player" when nothing in the stored one can be seen. */
const shown = (name: string): string | Text => name || both("ui.chat_a_player");
const gameText = (g: Game | null, tz: string): Text => g ? { en: `${g.title}, ${dateTime(g.starts_at, "en", tz)}`, es: `${g.title}, ${dateTime(g.starts_at, "es", tz)}` } : { en: "", es: "" };
const zone = async (db: Db | Trx) => (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;

/** A player tells the club about a message in a chat they read. The staff hear once an hour per chat at most (a staff
 *  alert); the Chats list counts every report waiting. */
export const chatReport = defineAction({
  name: "chat.report", version: 1,
  // A reason someone typed is used once and not kept in the change log's copy of what was asked: it lives only on the
  // report, which an account deletion clears.
  forget: ["reason"],
  input: z.object({ message_id: z.uuid(), reason: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const m = await messageForAction(ctx.db, i.message_id);
    const pid = ctx.actor.personId;
    if (!pid) throw new KumiError("error.signed_out", {}, 401);
    const a = await chatAccess(ctx.db, pid, m.kind, m.ref_id, ctx.now);
    if (!a.read || (a.until && new Date((await ctx.db.selectFrom("chat_message").select("created_at").where("id", "=", m.id).executeTakeFirstOrThrow()).created_at) > a.until))
      throw new KumiError("error.not_found", { thing: both("thing.chat_message") }, 404);
    if (m.person_id === pid) throw new KumiError("error.chat_report_own");
    if (m.removed_at || m.hidden_at) throw new KumiError("error.chat_gone");
    if (await ctx.db.selectFrom("chat_report").select("id").where("message_id", "=", m.id).where("person_id", "=", pid).executeTakeFirst()) throw new KumiError("error.chat_reported");
    // The message's words aren't copied into the plan (the change log keeps plans).
    return { title: both("action.chat.report"), summary: both("plan.chat.report", { name: shown(m.display_name), game: gameText(a.game, await zone(ctx.db)) }), reads: [], ownerIds: [pid],
      locationId: a.game?.location_id ?? null, undo: { kind: "none", note: both("reason.no_way_back") }, details: { thread_id: m.thread_id } };
  },
  async apply(ctx, i) {
    const m = await messageForAction(ctx.trx, i.message_id);
    try { await ctx.insert("chat_report", { id: uuidv7(), message_id: m.id, person_id: ctx.actor.personId, reason: plainText(i.reason ?? "") || null, created_at: ctx.now }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.chat_reported"); throw e; }
    // The staff hear once an hour per chat at most; the rest wait counted on their Chats list.
    const due = await ctx.trx.updateTable("chat_thread").set({ alerted_at: ctx.now }).where("id", "=", m.thread_id)
      .where((w) => w.or([w("alerted_at", "is", null), w("alerted_at", "<", new Date(ctx.now.getTime() - CHAT_ALERT_MINUTES * 60_000))])).returning("id").execute();
    if (due.length) await ctx.emit("chat.reported", { thread_id: m.thread_id, message_id: m.id, kind: m.kind, ref_id: m.ref_id, author: m.display_name, by: ctx.actor.personId });
    return null;
  },
});

/** The staff hide a message (players see "hidden by the club"; the staff still see its words), or show it again; either
 *  way the reports on it are dealt with. A reported message its author took back is dealt with the same way, and then
 *  its words go. */
export const chatHide = defineAction({
  name: "chat.hide", version: 1,
  input: z.object({ message_id: z.uuid(), hidden: z.boolean() }),
  async plan(ctx, i) {
    const m = await messageForAction(ctx.db, i.message_id);
    const waiting = await openReports(ctx.db, m.id);
    if (m.removed_at && !waiting) throw new KumiError("error.chat_gone");
    if (Boolean(m.hidden_at) === i.hidden && !waiting) throw new KumiError(i.hidden ? "error.chat_already_hidden" : "error.chat_not_hidden");
    const { read } = await readRow(ctx.db, "chat_message", m.id, "thing.chat_message");
    const g = await gameOf(ctx.db, m.kind, m.ref_id);
    return { title: both(i.hidden ? "action.chat.hide" : "action.chat.show"), summary: both(i.hidden ? "plan.chat.hide" : "plan.chat.show", { name: shown(m.display_name), game: gameText(g, await zone(ctx.db)) }),
      reads: [read], locationId: g?.location_id ?? null, undo: { kind: "reversible" }, details: { thread_id: m.thread_id } };
  },
  async apply(ctx, i) {
    const m = await messageForAction(ctx.trx, i.message_id);
    await ctx.update("chat_message", i.message_id, { hidden_at: i.hidden ? ctx.now : null, hidden_by: i.hidden ? ctx.actor.personId : null, ...(m.removed_at ? { body: "" } : {}) });
    await ctx.trx.updateTable("chat_report").set({ dealt_at: ctx.now }).where("message_id", "=", i.message_id).where("dealt_at", "is", null).execute();
    return null;
  },
});

/** The staff stop someone posting in every chat for a while; they still read. */
export const chatStop = defineAction({
  name: "chat.stop", version: 1,
  forget: ["reason"], clubWide: true,
  input: z.object({ person_id: z.uuid(), days: z.number().check(z.int(), z.minimum(1), z.maximum(90)), reason: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    const p = await ctx.db.selectFrom("person").select(["display_name", "redacted_at"]).where("id", "=", i.person_id).executeTakeFirst();
    if (!p || p.redacted_at) throw new KumiError("error.not_found", { thing: both("thing.person") }, 404);
    const until = new Date(ctx.now.getTime() + i.days * DAY), tz = await zone(ctx.db);
    return { title: both("action.chat.stop"), summary: both("plan.chat.stop", { name: shown(plainName(p.display_name)), until: { en: dateTime(until, "en", tz), es: dateTime(until, "es", tz) } }),
      reads: [], ownerIds: [i.person_id], undo: { kind: "reversible" }, details: { until } };
  },
  async apply(ctx, i) {
    const id = uuidv7();
    await ctx.insert("chat_stop", { id, person_id: i.person_id, until: new Date(ctx.now.getTime() + i.days * DAY), reason: plainText(i.reason ?? "") || null, created_by: ctx.actor.personId, created_at: ctx.now });
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
    return { title: both("action.chat.allow"), summary: both("plan.chat.allow", { name: shown(plainName(p.display_name)) }), reads, ownerIds: [i.person_id], undo: { kind: "reversible" }, details: { stops: stops.map((s) => s.id) } };
  },
  async apply(ctx, _i, plan) {
    for (const id of (plan.details as { stops: string[] }).stops) await ctx.update("chat_stop", id, { ended_at: ctx.now });
    return null;
  },
});

// ---- Keeping ----

/** Chats go 90 days after their game, with every message, report and read mark in them (a game moved later keeps
 *  its chat longer); nothing makes them again (chatAccess). Stops long over go too. */
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
  // A report or a stop previewed and never confirmed (or refused) keeps no reason either (actions.ts, forget).
  await forgetStaleInputs(db, now);
  return { deleted };
}

/** A person's own messages, for their Download data. */
export async function chatsOf(db: Db | Trx, personId: string) {
  const rows = await db.selectFrom("chat_message").innerJoin("chat_thread", "chat_thread.id", "chat_message.thread_id")
    .select(["chat_thread.kind", "chat_thread.ref_id", "chat_message.body", "chat_message.created_at", "chat_message.edited_at", "chat_message.removed_at", "chat_message.hidden_at"])
    .where("chat_message.person_id", "=", personId).orderBy("chat_message.created_at").execute();
  // A message taken back while a report about it waits keeps its words for the staff (chat.remove): they're still the
  // club's, so they're in the author's own download too, marked as kept for a report.
  return rows.map((m) => {
    const held = Boolean(m.removed_at && m.body);
    return { game: m.kind, game_id: m.ref_id, at: m.created_at, text: m.removed_at && !held ? null : m.body, edited_at: m.edited_at, taken_back_at: m.removed_at,
      ...(held ? { kept_for_a_report: true } : {}), hidden_by_the_club: Boolean(m.hidden_at) };
  });
}

/** Deleting an account (privacy.ts): their words go (each message shows "message removed", under "Former member"),
 *  with their read marks; their reports keep no reason, and the club's stops on them no reason either, here or in the
 *  change log's copy of what was asked. */
export async function eraseChats(db: Trx, personId: string, now: Date) {
  await db.updateTable("chat_message").set({ body: "", removed_at: sql`coalesce(removed_at, ${now})` }).where("person_id", "=", personId).execute();
  await db.deleteFrom("chat_seen").where("person_id", "=", personId).execute();
  await db.updateTable("chat_report").set({ reason: null }).where("person_id", "=", personId).execute();
  await db.updateTable("chat_stop").set({ reason: null }).where("person_id", "=", personId).execute();
  await sql`UPDATE action_run SET input = input - 'reason' WHERE action IN ('chat.report', 'chat.stop') AND input ? 'reason' AND (actor_person_id = ${personId} OR input->>'person_id' = ${personId})`.execute(db);
}
