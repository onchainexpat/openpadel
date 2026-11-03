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

/** Send the push copies that are due: each to the person's devices for the app it opens in (staff alerts to
 *  the staff app, the rest to the members' app). Stale ones are dropped, not sent late. */
export async function sendPushes(db: Db, o: { subject: string; now?: Date; fetch?: Fetch; limit?: number }): Promise<{ sent: number; dropped: number; failed: number }> {
  const now = o.now ?? new Date(), out = { sent: 0, dropped: 0, failed: 0 };
  await skipRepeatsAfterRestore(db, now);   // after a restore, nothing the database before it had sent goes twice
  const due = await db.selectFrom("outbound_message").select(["id", "person_id", "purpose", "kind", "subject", "body", "link", "stale_at", "attempts"])
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
    if ((m.stale_at && m.stale_at <= now) || consent?.granted === false || !subs.length) {
      await db.updateTable("outbound_message").set({ status: "dropped", sent_at: null }).where("id", "=", m.id).execute(); out.dropped++; continue;
    }
    let ok = 0, retry = false;
    for (const s of subs) {
      if (!isPushEndpoint(s.endpoint)) { await db.updateTable("push_subscription").set({ revoked_at: now }).where("id", "=", s.id).execute(); continue; }
      try {
        const r = await sendPush(s, { title: m.subject, body: m.body, url: m.link ?? "/", tag: m.kind }, keys, o.subject, { fetch: o.fetch, now, urgency: m.purpose === "staff" ? "high" : "normal" });
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
