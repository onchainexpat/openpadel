// Push copies of messages: the devices a person turned notifications on for, the club's signing keys, and the
// job that sends what's due. A dead device (the push service says it's gone) is dropped; a message with no
// device left to go to is dropped too, not retried. Devices, like sign-in sessions, are written here rather
// than through actions: they belong to the person's browser, not the club, and each person only ever turns
// their own on or off. The delivery log (outbound_message) is the messages code's, as for email.
import type { Db } from "./db.ts";
import { uuidv7 } from "./ids.ts";
import { generateVapidKeys, isPushEndpoint, sendPush, type VapidKeys } from "./webpush.ts";
import { openText, sealText } from "./sealed.ts";
import { skipRepeatsAfterRestore } from "./repeats.ts";
import { movedAway } from "./club_exit.ts";
import { t } from "@kumi/i18n";
import { plainName, shortText } from "./plain_text.ts";

/** A chat's push keeps no words (chat.ts): they're read now, and a message taken back, hidden, deleted with its chat,
 *  or written by an account since deleted, sends nothing. */
export async function chatPushWords(db: Db, messageId: string | null, lang: "en" | "es"): Promise<string | null> {
  if (!messageId) return null;
  const c = await db.selectFrom("chat_message").innerJoin("person", "person.id", "chat_message.person_id")
    .select(["chat_message.body", "chat_message.removed_at", "chat_message.hidden_at", "person.display_name", "person.redacted_at"]).where("chat_message.id", "=", messageId).executeTakeFirst();
  if (!c || c.removed_at || c.hidden_at || c.redacted_at || !c.body) return null;
  return t(lang, "msg.chat_message.body", { name: plainName(c.display_name), text: shortText(c.body, 120) });
}

/** The club's push keys, made (once, whichever server process gets there first) the first time they're needed.
 *  The private half is sealed with the server's key (sealed.ts). */
export async function pushKeys(db: Db): Promise<VapidKeys> {
  const k = await db.selectFrom("push_key").select(["public_key", "private_key"]).executeTakeFirst();
  if (k) return { publicKey: k.public_key, privateKey: openText(k.private_key) };
  const fresh = generateVapidKeys();
  await db.insertInto("push_key").values({ public_key: fresh.publicKey, private_key: sealText(fresh.privateKey) }).onConflict((oc) => oc.column("singleton").doNothing()).execute();
  const won = await db.selectFrom("push_key").select(["public_key", "private_key"]).executeTakeFirstOrThrow();
  return { publicKey: won.public_key, privateKey: openText(won.private_key) };
}

/** Turn notifications on for one device. The same device used by someone else since is theirs now. */
export async function subscribePush(db: Db, personId: string, app: "member" | "staff", s: { endpoint: string; p256dh: string; auth: string }, userAgent: string | null) {
  await db.insertInto("push_subscription").values({ id: uuidv7(), person_id: personId, app, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, user_agent: userAgent?.slice(0, 200) ?? null })
    .onConflict((oc) => oc.column("endpoint").doUpdateSet({ person_id: personId, app, p256dh: s.p256dh, auth: s.auth, user_agent: userAgent?.slice(0, 200) ?? null, revoked_at: null })).execute();
}
export async function unsubscribePush(db: Db, personId: string, endpoint: string) {
  await db.updateTable("push_subscription").set({ revoked_at: new Date() }).where("person_id", "=", personId).where("endpoint", "=", endpoint).execute();
}
/** Whether someone has a device with notifications on (for the app their messages open in). */
export async function hasPushDevice(db: Db, personId: string): Promise<boolean> {
  return Boolean(await db.selectFrom("push_subscription").select("id").where("person_id", "=", personId).where("revoked_at", "is", null).executeTakeFirst());
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const MAX_ATTEMPTS = 5;

/** What matters within minutes goes at high urgency, so a phone asleep gets it now rather than at its next wake-up:
 *  a place offered or handed on, a court booked for you or lost, a match about to start or changed, money that needs
 *  you. Staff alerts always do. The rest goes at normal urgency. */
const URGENT = new Set(["offered", "place_open", "match_place_offered", "passed_to_you", "match_ask", "match_running_late", "match_not_filled", "match_place_given",
  "match_seat_released", "booked", "booked_to_pay", "booking_lost", "booking_player_added", "booking_courts", "booking_reminder", "lesson_reminder", "dates_changed",
  "removed", "payment_failed", "membership_payment_failed", "membership_payment_unfinished", "kid_pay_needed", "kid_asked", "booking_balance_due", "unpaid_reminder",
  "sign_in_reset"]);
const DAY = 24 * 3600, MAX_TTL = 28 * DAY;
/** How urgent a push is, and how long the push service keeps it for a phone that's off: until the message goes stale
 *  (an offer's push is no use once the offer has gone), else a day. */
export function pushTiming(m: { purpose: string; kind: string; stale_at: Date | null }, now: Date): { urgency: "high" | "normal"; ttlSeconds: number } {
  const urgency = m.purpose === "staff" || URGENT.has(m.kind) ? "high" : "normal";
  const ttlSeconds = m.stale_at ? Math.max(60, Math.min(MAX_TTL, Math.floor((m.stale_at.getTime() - now.getTime()) / 1000))) : DAY;
  return { urgency, ttlSeconds };
}

/** Send the push copies that are due: each to the person's devices for the app it opens in (staff alerts to
 *  the staff app, the rest to the members' app). Stale ones are dropped, not sent late. */
export async function sendPushes(db: Db, o: { subject: string; now?: Date; fetch?: Fetch; limit?: number }): Promise<{ sent: number; dropped: number; failed: number }> {
  const now = o.now ?? new Date(), out = { sent: 0, dropped: 0, failed: 0 };
  await skipRepeatsAfterRestore(db, now);   // after a restore, nothing the database before it had sent goes twice
  if (await movedAway(db)) return out;      // moved to another server (club_exit.ts): that one reaches members now
  const due = await db.selectFrom("outbound_message").select(["id", "person_id", "purpose", "kind", "subject", "body", "link", "stale_at", "attempts", "lang", "chat_message_id"])
    .where("status", "=", "waiting").where("channel", "=", "push").where("send_after", "<=", now).orderBy("send_after").limit(o.limit ?? 50).execute();
  if (!due.length) return out;
  const keys = await pushKeys(db);
  for (const m of due) {
    // Claimed first, so two server processes never send the same one.
    const claimed = await db.updateTable("outbound_message").set({ status: "sent", sent_at: now }).where("id", "=", m.id).where("status", "=", "waiting").executeTakeFirst();
    if (!Number(claimed.numUpdatedRows)) continue;
    const consent = await db.selectFrom("channel_consent").select("granted").where("person_id", "=", m.person_id).where("channel", "=", "push").where("purpose", "=", m.purpose)
      .orderBy("at", "desc").limit(1).executeTakeFirst();
    const subs = await db.selectFrom("push_subscription").select(["id", "endpoint", "p256dh", "auth"]).where("person_id", "=", m.person_id).where("revoked_at", "is", null)
      .where("app", "=", m.purpose === "staff" ? "staff" : "member").execute();
    const chat = m.kind === "chat_message" ? await chatPushWords(db, m.chat_message_id, m.lang === "es" ? "es" : "en") : null;
    if ((m.stale_at && m.stale_at <= now) || consent?.granted === false || !subs.length || (m.kind === "chat_message" && !chat)) {
      await db.updateTable("outbound_message").set({ status: "dropped", sent_at: null }).where("id", "=", m.id).execute(); out.dropped++; continue;
    }
    let ok = 0, retry = false;
    for (const s of subs) {
      if (!isPushEndpoint(s.endpoint)) { await db.updateTable("push_subscription").set({ revoked_at: now }).where("id", "=", s.id).execute(); continue; }
      try {
        const r = await sendPush(s, { title: m.subject, body: chat ?? m.body, url: m.link ?? "/", tag: m.kind }, keys, o.subject, { fetch: o.fetch, now, ...pushTiming(m, now) });
        if (r.ok) { ok++; await db.updateTable("push_subscription").set({ last_ok_at: now }).where("id", "=", s.id).execute(); }
        else if (r.gone) await db.updateTable("push_subscription").set({ revoked_at: now }).where("id", "=", s.id).execute();
        else retry = true;
      } catch { retry = true; }   // the network: try again later
    }
    if (ok) { out.sent++; continue; }
    if (retry && m.attempts + 1 < MAX_ATTEMPTS) {
      await db.updateTable("outbound_message").set({ status: "waiting", sent_at: null, attempts: m.attempts + 1, send_after: new Date(now.getTime() + 60_000 * 2 ** m.attempts) }).where("id", "=", m.id).execute();
      out.failed++;
    } else { await db.updateTable("outbound_message").set({ status: retry ? "failed" : "dropped", sent_at: null, failure: retry ? "push service kept failing" : "no device" }).where("id", "=", m.id).execute(); out.dropped++; }
  }
  return out;
}
