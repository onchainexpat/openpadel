// Stripe Connect: the club links its own Stripe account, and card payments go straight into it. Where
// the money goes is the most sensitive thing in Kumi, so setting it is the owner's (a manager can ask),
// needs a passkey sign-in from anyone who has one, and is announced through the outbox.
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction, readRow, run, runAsSystem, type Actor } from "./actions.ts";
import type { Db } from "./db.ts";
import { KumiError } from "./errors.ts";
import { everDoable } from "./permissions.ts";
import type { ConnectedAccount, StripeProvider } from "./stripe.ts";

const accountId = z.string().check(z.regex(/^acct_[A-Za-z0-9]+$/));
const tail = (id: string | null | undefined) => (id ? `…${id.slice(-4)}` : "");

export const paymentAccountSet = defineAction({
  name: "club.payment_account_set", version: 1, strongAuth: true,
  input: z.object({ stripe_account_id: accountId }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "club", "singleton");
    if (row.stripe_account_id === i.stripe_account_id) throw new KumiError("error.nothing_changed");
    return { title: both("action.club.payment_account_set"),
      summary: row.stripe_account_id ? both("plan.club.payment_account_move", { from: tail(row.stripe_account_id), to: tail(i.stripe_account_id) }) : both("plan.club.payment_account_set", { to: tail(i.stripe_account_id) }),
      reads: [read], undo: { kind: "none", note: both("reason.payment_account") } };
  },
  async apply(ctx, i) {
    const before = await ctx.trx.selectFrom("club").select("stripe_account_id").executeTakeFirstOrThrow();
    await ctx.update("club", "singleton", { stripe_account_id: i.stripe_account_id, stripe_charges_enabled: false, stripe_details_submitted: false });
    await ctx.emit("club.payment_account_changed", { from: before.stripe_account_id, to: i.stripe_account_id });
    return null;
  },
});

/** What Stripe says about the club's account, recorded when it changes (after setup, or from a webhook). */
export const paymentAccountStatus = defineAction({
  name: "club.payment_account_status", version: 1, system: true, internal: true,
  input: z.object({ stripe_account_id: accountId, charges_enabled: z.boolean(), details_submitted: z.boolean() }),
  async plan(_ctx, i) {
    return { title: both("action.club.payment_account_status"), summary: both(i.charges_enabled ? "plan.club.payments_on" : "plan.club.payments_off", { account: tail(i.stripe_account_id) }), reads: [], undo: { kind: "none", note: both("reason.no_way_back") } };
  },
  async apply(ctx, i) {
    const club = await ctx.trx.selectFrom("club").select(["stripe_account_id", "stripe_charges_enabled"]).forUpdate().executeTakeFirstOrThrow();
    if (club.stripe_account_id !== i.stripe_account_id) return { ignored: "not the club's account" };
    await ctx.update("club", "singleton", { stripe_charges_enabled: i.charges_enabled, stripe_details_submitted: i.details_submitted });
    if (i.charges_enabled !== club.stripe_charges_enabled) await ctx.emit(i.charges_enabled ? "club.payments_on" : "club.payments_off", { account: i.stripe_account_id });
    return null;
  },
});

/** For StripeProvider under Connect: the club's account, read fresh for every new payment. */
export function clubStripeAccount(db: Db): ConnectedAccount {
  return async () => {
    const c = await db.selectFrom("club").select(["stripe_account_id", "stripe_charges_enabled"]).executeTakeFirstOrThrow();
    return { id: c.stripe_account_id, ready: c.stripe_charges_enabled };
  };
}

/**
 * "Connect with Stripe": the club's Stripe account is made the first time (Stripe returns the same one if
 * asked again), set as the club's by the person asking, and they're sent to Stripe's own setup pages.
 * A manager's ask waits for the owner; nothing is linked until then.
 */
export async function connectStripe(db: Db, stripe: StripeProvider, actor: Actor, urls: { refresh: string; return: string }, email?: string | null)
  : Promise<{ url: string } | { awaiting_approval: string }> {
  // Nothing is asked of Stripe for someone who could never set the club's account (owners do; managers ask).
  if (!actor.personId || !(await everDoable(db, actor.personId, { memberOnly: actor.memberOnly }))("club.payment_account_set")) throw new KumiError("error.forbidden", {}, 403);
  const club = await db.selectFrom("club").select(["stripe_account_id", "country"]).executeTakeFirstOrThrow();
  let account = club.stripe_account_id;
  if (!account) {
    // The retry key must be this club's own: the platform key is shared by every hosted club, and Stripe
    // would hand a second club the first one's account. The run that set the club up is unique to it.
    const setup = await db.selectFrom("action_run").select("id").where("action", "=", "club.setup").orderBy("id").limit(1).executeTakeFirstOrThrow();
    // The country is in the key (an account can't change country); a US club keeps the key it always had.
    account = await stripe.createAccount({ country: club.country, email, idempotencyKey: `club:${setup.id}${club.country === "US" ? "" : `:${club.country}`}` });
    const r = await run(db, "club.payment_account_set", { stripe_account_id: account }, actor);
    if (r.status === "awaiting_approval") return { awaiting_approval: r.runId };
  }
  return { url: await stripe.accountLink(account, urls) };
}

/** Ask Stripe whether the club's account can take payments, and record it if that changed. */
export async function refreshStripeAccount(db: Db, stripe: StripeProvider) {
  const club = await db.selectFrom("club").select(["stripe_account_id", "stripe_charges_enabled", "stripe_details_submitted"]).executeTakeFirstOrThrow();
  if (!club.stripe_account_id) return null;
  const a = await stripe.getAccount(club.stripe_account_id);
  if (a.chargesEnabled !== club.stripe_charges_enabled || a.detailsSubmitted !== club.stripe_details_submitted)
    await runAsSystem(db, "club.payment_account_status", { stripe_account_id: a.id, charges_enabled: a.chargesEnabled, details_submitted: a.detailsSubmitted }, "stripe");
  return { id: a.id, chargesEnabled: a.chargesEnabled, detailsSubmitted: a.detailsSubmitted, name: a.name };
}
