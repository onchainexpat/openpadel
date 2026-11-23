// A person's own assistants (Claude, ChatGPT and the like, connected through the MCP door): what each has
// spent this week against the cap they set for it, a new cap, and disconnecting one. The cap and how it's
// counted are in assistant_spend.ts.
import * as z from "zod/mini";
import { both, money } from "@kumi/i18n";
import { defineAction, readRow } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { weekSpent } from "./assistant_spend.ts";
import { HOSTED_CLIENT_ID, hostedName } from "./assistant_chats.ts";

/** The highest weekly cap a person can set: $500. */
export const MAX_WEEKLY_CAP_CENTS = 50_000;
const usd = (c: number) => ({ en: money(c, "en"), es: money(c, "es") });

/** A person's connected assistants, newest first, with this week's spending. */
export async function assistantsOf(db: Db | Trx, personId: string, now: Date) {
  const rows = await db.selectFrom("oauth_grant").innerJoin("oauth_client", "oauth_client.client_id", "oauth_grant.client_id")
    .select(["oauth_grant.id", "oauth_client.client_id", "oauth_client.name", "oauth_grant.weekly_cap_cents", "oauth_grant.created_at",
      (eb) => eb.selectFrom("oauth_token").select((t) => t.fn.max("created_at").as("m")).whereRef("oauth_token.grant_id", "=", "oauth_grant.id").as("last_used")])
    .where("oauth_grant.person_id", "=", personId).where("oauth_grant.revoked_at", "is", null).orderBy("oauth_grant.created_at", "desc").execute();
  return Promise.all(rows.map(async (r) => ({ id: r.id, name: r.client_id === HOSTED_CLIENT_ID ? hostedName() : r.name ?? "An assistant", weekly_cap_cents: r.weekly_cap_cents, spent_cents: await weekSpent(db, r.id, now),
    connected_at: r.created_at, last_used_at: (r.last_used as Date | null) ?? null })));
}

/** Whose a connection is, for ActionDef.owners: nobody's when there's none. */
async function grantHolder(db: Db | Trx, id: string): Promise<string[]> {
  const g = await db.selectFrom("oauth_grant").select("person_id").where("id", "=", id).executeTakeFirst();
  return g ? [g.person_id] : [];
}
async function grantOf(ctx: { db: Db | Trx }, id: string) {
  const { row, read } = await readRow(ctx.db, "oauth_grant", id, "thing.assistant");
  if (row.revoked_at) throw new KumiError("error.assistant_disconnected", {}, 409);
  const c = await ctx.db.selectFrom("oauth_client").select("name").where("client_id", "=", row.client_id).executeTakeFirst();
  return { row, read, name: row.client_id === HOSTED_CLIENT_ID ? hostedName() : c?.name ?? "An assistant" };
}

export const assistantSetCap = defineAction({
  name: "assistant.set_cap", version: 1,
  input: z.object({ grant_id: z.uuid(), weekly_cap_cents: z.number().check(z.int(), z.minimum(0), z.maximum(MAX_WEEKLY_CAP_CENTS)) }),
  owners: (db, i) => grantHolder(db, i.grant_id),   // its cap ("nothing changed") and whether it's disconnected are theirs
  async plan(ctx, i) {
    const g = await grantOf(ctx, i.grant_id);
    if (g.row.weekly_cap_cents === i.weekly_cap_cents) throw new KumiError("error.nothing_changed");
    return { title: both("action.assistant.set_cap"), summary: both(i.weekly_cap_cents ? "plan.assistant.set_cap" : "plan.assistant.cap_none", { client: g.name, cap: usd(i.weekly_cap_cents) }),
      reads: [g.read], ownerIds: [g.row.person_id], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    await ctx.update("oauth_grant", i.grant_id, { weekly_cap_cents: i.weekly_cap_cents });
    return null;
  },
});

export const assistantDisconnect = defineAction({
  name: "assistant.disconnect", version: 1,
  input: z.object({ grant_id: z.uuid() }),
  owners: (db, i) => grantHolder(db, i.grant_id),
  async plan(ctx, i) {
    // An assistant may disconnect itself, never another one.
    if (ctx.actor.auth === "oauth" && ctx.actor.grantId !== i.grant_id) throw new KumiError("error.assistant_in_app", {}, 403);
    const g = await grantOf(ctx, i.grant_id);
    const someoneElse = g.row.person_id !== ctx.actor.personId
      ? (await ctx.db.selectFrom("person").select("display_name").where("id", "=", g.row.person_id).executeTakeFirst())?.display_name ?? "" : null;
    return { title: both("action.assistant.disconnect"),
      summary: someoneElse === null ? both("plan.assistant.disconnect", { client: g.name }) : both("plan.assistant.disconnect_for", { client: g.name, name: someoneElse }), reads: [g.read], ownerIds: [g.row.person_id],
      undo: { kind: "none", note: both("reason.assistant_reconnects") } };
  },
  async apply(ctx, i) {
    await ctx.update("oauth_grant", i.grant_id, { revoked_at: ctx.now });
    await ctx.trx.updateTable("oauth_token").set({ revoked_at: ctx.now }).where("grant_id", "=", i.grant_id).where("revoked_at", "is", null).execute();
    return null;
  },
});
