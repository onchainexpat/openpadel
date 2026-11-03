// Email that can't arrive (migration 072). The email service (Resend) reports through its signed webhook
// (apps/server/src/email_events.ts): an address whose mail server refused the club's email for good (a hard bounce),
// a member marking it as spam (a complaint), or an address the service itself won't send to any more. Sending to
// those again only hurts the club's sending name (and on a host's shared email account, every club's), so each is
// kept in the club's own database. Messages to it are dropped, never queued (the in-app copy stays); the member's
// apps say their email isn't arriving, the desk sees it on the person's page and clears it once the address is fixed.
// Sign-in codes are never held back by it: the person has just asked for one, and the sign-in answer can't say why a
// code didn't come without saying whether the address is the club's.
import * as z from "zod/mini";
import { both, type Key } from "@kumi/i18n";
import { sql } from "kysely";
import { defineAction, readRow } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";

export type SuppressionReason = "bounce" | "complaint" | "provider";
const lower = (e: string) => e.trim().toLowerCase();

/** One report the club acts on, read from the email service's webhook body. */
export interface EmailReport { reason: SuppressionReason; addresses: string[]; email_id: string | null; detail: string | null; at: string }

/**
 * What a Resend webhook says, as a report, or why it isn't one. Only a hard bounce, a complaint, or an address the
 * service won't send to is acted on; a bounce that may clear (a full mailbox) and every other event are left alone.
 */
export function readEmailReport(body: unknown): EmailReport | { ignored: string } {
  const b = body as { type?: unknown; created_at?: unknown; data?: Record<string, any> } | null;
  const type = typeof b?.type === "string" ? b.type : "", d = b?.data ?? {};
  const to = (Array.isArray(d.to) ? d.to : typeof d.to === "string" ? [d.to] : []).filter((a: unknown): a is string => typeof a === "string" && a.includes("@")).map(lower);
  const at = typeof b?.created_at === "string" && !Number.isNaN(Date.parse(b.created_at)) ? new Date(b.created_at).toISOString() : new Date().toISOString();
  const email_id = typeof d.email_id === "string" ? d.email_id : null;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
  if (!to.length) return { ignored: type ? `${type} without an address` : "not an email event" };
  if (type === "email.bounced") {
    const kind = String(d.bounce?.type ?? "");
    if (kind !== "Permanent") return { ignored: `a bounce that may clear (${kind || "no type"})` };
    return { reason: "bounce", addresses: to, email_id, at, detail: text(d.bounce?.message) ?? text(d.bounce?.subType) };
  }
  if (type === "email.complained") return { reason: "complaint", addresses: to, email_id, at, detail: null };
  if (type === "email.suppressed") return { reason: "provider", addresses: to, email_id, at, detail: text(d.suppressed?.message) ?? text(d.suppressed?.type) };
  return { ignored: type || "no type" };
}

/** The domain an email address or a sender ("Club <hello@mail.club.example>") is on, lowercase. */
export function emailDomain(from: string): string | null {
  const m = /@([^>\s]+)>?\s*$/.exec(from.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** The address's suppression while it holds (not cleared), or null. */
export async function emailSuppressed(db: Db | Trx, address: string): Promise<{ reason: SuppressionReason; since: Date; detail: string | null } | null> {
  const r = await db.selectFrom("email_suppression").select(["reason", "last_at", "detail"]).where("address", "=", lower(address)).where("cleared_at", "is", null).executeTakeFirst();
  return r ? { reason: r.reason, since: r.last_at, detail: r.detail } : null;
}

/** A person's own address, when the club's email can't reach it: for their apps and the desk. */
export async function personEmailProblem(db: Db | Trx, personId: string): Promise<{ reason: SuppressionReason; since: string; detail: string | null } | null> {
  const p = await db.selectFrom("person").select("email").where("id", "=", personId).executeTakeFirst();
  if (!p?.email) return null;
  const s = await emailSuppressed(db, p.email);
  return s ? { reason: s.reason, since: s.since.toISOString(), detail: s.detail } : null;
}

/** For `kumi doctor`: addresses held back now, and the reports of the last 30 days by reason. */
export async function suppressionCounts(db: Db, now = new Date()): Promise<{ held: number; bounce: number; complaint: number; provider: number }> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const rows = (await sql<{ reason: SuppressionReason; held: string; recent: string }>`SELECT reason, count(*) FILTER (WHERE cleared_at IS NULL) AS held,
    count(*) FILTER (WHERE last_at >= ${since}) AS recent FROM email_suppression GROUP BY reason`.execute(db)).rows;
  const out = { held: 0, bounce: 0, complaint: 0, provider: 0 };
  for (const r of rows) { out.held += Number(r.held); out[r.reason] = Number(r.recent); }
  return out;
}

/** The email service's report, recorded: the address held back from now on, and the message it was about marked as
 *  not arrived. A report older than a clear (delivered late, or replayed) leaves the clear standing. */
export const emailReport = defineAction({
  name: "email.report", version: 1, system: true, internal: true,
  input: z.object({ reason: z.enum(["bounce", "complaint", "provider"]), address: z.string().check(z.maxLength(320)), email_id: z.nullable(z.string().check(z.maxLength(200))),
    detail: z.nullable(z.string().check(z.maxLength(300))), at: z.iso.datetime() }),
  async plan(_ctx, i) { return { title: both("action.email.report"), summary: both("plan.email.report", { address: i.address, reason: both(`email.reason_${i.reason}` as Key) }), reads: [], undo: { kind: "none", note: both("reason.undo_final") } }; },
  async apply(ctx, i) {
    const address = lower(i.address), at = new Date(i.at);
    await sql`INSERT INTO email_suppression AS s (address, reason, detail, first_at, last_at) VALUES (${address}, ${i.reason}, ${i.detail}, ${at}, ${at})
      ON CONFLICT (address) DO UPDATE SET
        reason = CASE WHEN EXCLUDED.last_at >= s.last_at THEN EXCLUDED.reason ELSE s.reason END,
        detail = CASE WHEN EXCLUDED.last_at >= s.last_at THEN EXCLUDED.detail ELSE s.detail END,
        last_at = greatest(s.last_at, EXCLUDED.last_at), times = s.times + 1,
        cleared_at = CASE WHEN s.cleared_at IS NOT NULL AND EXCLUDED.last_at > s.cleared_at THEN NULL ELSE s.cleared_at END,
        cleared_by = CASE WHEN s.cleared_at IS NOT NULL AND EXCLUDED.last_at > s.cleared_at THEN NULL ELSE s.cleared_by END,
        version = s.version + 1`.execute(ctx.trx);
    let message = false;
    if (i.email_id) {
      const why = i.reason === "bounce" ? "bounced" : i.reason === "complaint" ? "marked as spam" : "the email service wouldn't send it";
      const r = await ctx.trx.updateTable("outbound_message").set({ status: "failed", failure: `${why}${i.detail ? `: ${i.detail}` : ""}`.slice(0, 500) })
        .where("provider_ref", "=", i.email_id).where("channel", "=", "email").where("status", "=", "sent").executeTakeFirst();
      message = Number(r.numUpdatedRows) > 0;
    }
    return { address, reason: i.reason, message };
  },
});

/** The desk clears it, once the member says the address works (or it's been fixed at their end): email goes to it
 *  again, until the next report. Changing the member's address needs nothing of this: a new address has no report. */
export const emailUnsuppress = defineAction({
  name: "person.email_unsuppress", version: 1,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const { row: p, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    if (!p.email) throw new KumiError("error.email_not_held");
    const s = await ctx.db.selectFrom("email_suppression").select(["address", "reason", "cleared_at"]).where("address", "=", lower(p.email)).executeTakeFirst();
    if (!s || s.cleared_at) throw new KumiError("error.email_not_held");
    const { read: held } = await readRow(ctx.db, "email_suppression", s.address, "thing.change");
    // The email service's own list (a host's shared account): clearing it here lets Kumi try, the service may still refuse.
    const summary = both(s.reason === "provider" ? "plan.person.email_unsuppress_provider" : "plan.person.email_unsuppress", { name: p.display_name, email: p.email, reason: both(`email.reason_${s.reason}` as Key) });
    return { title: both("action.person.email_unsuppress"), summary, reads: [read, held], ownerIds: [i.person_id], undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    const p = await ctx.trx.selectFrom("person").select("email").where("id", "=", i.person_id).executeTakeFirstOrThrow();
    await ctx.update("email_suppression", lower(p.email!), { cleared_at: ctx.now, cleared_by: ctx.actor.personId });
    return { address: lower(p.email!) };
  },
});
