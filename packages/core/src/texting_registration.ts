// The club's texting registration with US carriers (`kumi texting`, the server's texting.ts makes the calls to
// Twilio): toll-free first. One row records the number, the Messaging Service it's in and the toll-free
// verification sent for it, as each step happens and as Twilio's review moves. When the review is decided, the
// owner and managers hear once (a resubmission starts that over). Once approved, texts go from that Messaging
// Service unless the settings file names a sender of its own.
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { uuidv7 } from "./ids.ts";

export type TextingStatus = "started" | "submitted" | "in_review" | "approved" | "rejected";
export interface Rejection { reason: string; code: number | null }

const sid = (prefix: string) => z.string().check(z.regex(new RegExp(`^${prefix}[0-9a-f]{32}$`)));
const when = z.nullable(z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}T/)));

/** What Twilio said, or a step that was done. Only what changed is given; the rest stays. */
export const textingRecord = defineAction({
  name: "texting.registration_record", version: 1, system: true, internal: true,
  input: z.object({
    phone_number: z.optional(z.string().check(z.regex(/^\+\d{8,15}$/))),
    phone_number_sid: z.optional(sid("PN")),
    bought: z.optional(z.boolean()),
    messaging_service_sid: z.optional(sid("MG")),
    verification_sid: z.optional(z.nullable(sid("HH"))),
    status: z.optional(z.enum(["started", "submitted", "in_review", "approved", "rejected"])),
    twilio_status: z.optional(z.nullable(z.string().check(z.maxLength(40)))),
    rejection: z.optional(z.nullable(z.array(z.object({ reason: z.string().check(z.maxLength(2000)), code: z.nullable(z.number()) })))),
    edit_allowed: z.optional(z.nullable(z.boolean())),
    edit_expires_at: z.optional(when),
    submitted: z.optional(z.nullable(z.record(z.string(), z.unknown()))),
    submitted_at: z.optional(when),
    checked_at: z.optional(when),
  }),
  async plan(_ctx, i) {
    return { title: both("action.texting.registration_record"), summary: both("plan.texting.registration_record", { status: i.status ?? "" }), reads: [],
      undo: { kind: "none", note: both("reason.undo_final") } };
  },
  async apply(ctx, i) {
    const row = await ctx.trx.selectFrom("texting_registration").selectAll().forUpdate().executeTakeFirst();
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(i)) if (v !== undefined) patch[k] = k === "rejection" || k === "submitted" ? (v === null ? null : JSON.stringify(v)) : v;
    // Sent again after a rejection: the owner and managers will hear about the new decision.
    if (i.status === "submitted") patch.told_status = null;
    const decided = (i.status === "approved" || i.status === "rejected") && row?.told_status !== i.status;
    if (decided) patch.told_status = i.status;
    const saved = row ? await ctx.update("texting_registration", row.id, patch) : await ctx.insert("texting_registration", { id: uuidv7(ctx.now.getTime()), ...patch });
    if (decided) await ctx.emit("texting.reviewed", { status: i.status, number: saved.phone_number ?? "", reasons: i.rejection ?? (row?.rejection as Rejection[] | null) ?? [] });
    return { id: saved.id };
  },
});

export type TextingRegistration = Awaited<ReturnType<typeof textingRegistration>>;
/** The registration, if one was started. */
export async function textingRegistration(db: Db | Trx) {
  const r = await db.selectFrom("texting_registration").selectAll().executeTakeFirst();
  return r ? { ...r, rejection: (r.rejection as Rejection[] | null) ?? null, submitted: (r.submitted as Record<string, unknown> | null) ?? null } : null;
}

/** Who texts go from once the registration is approved: its Messaging Service. */
export async function registeredSender(db: Db): Promise<string | null> {
  const r = await db.selectFrom("texting_registration").select(["status", "messaging_service_sid"]).executeTakeFirst().catch(() => undefined);
  return r?.status === "approved" && r.messaging_service_sid ? r.messaging_service_sid : null;
}
