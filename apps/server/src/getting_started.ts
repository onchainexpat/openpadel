// Getting started as the staff app's Today and an agent read it (core getting_started.ts): each step with whether it's
// done, its words in the reader's language, and the page where it's done. The steps that are the server's settings
// (card payments, email, practice mode) are judged by `openpadel doctor`'s own checks, the minute's answer
// (connectors.ts checksNow), so Today, Connectors and doctor never disagree.
import { both, type Key, type Lang } from "@kumi/i18n";
import { gettingStarted, setStartOutside, type Db, type StartKey } from "@kumi/core";
import { checksNow, statusOf } from "./connectors.ts";
import { setting } from "@kumi/core";

type Env = Record<string, string | undefined>;
/** Where each step is done in the staff app. Practice mode is turned off on the server, with the owner's say-so (setup
 *  guide, step 9): no page does it, so its words say where. The members' app's link is the staff app's to show. */
const PAGES: Record<StartKey, string | null> = {
  club: "/settings#club-details", courts: "/settings#courts", prices: "/settings#prices", payments: "/connectors#connector-stripe",
  email: "/connectors#connector-resend", membership: "/memberships", staff: "/people", members: "/people", live: null,
};

/** The server's settings for Getting started, from doctor's checks: set up counts while it's still practice (test
 *  Stripe keys, email only to test addresses), since turning practice off is a step of its own. */
export function startFromChecks(db: Db, env: Env = process.env): void {
  setStartOutside(async () => {
    const checks = await checksNow(db, env, false), of = (id: string) => checks.find((c) => c.id === id);
    const working = (id: string) => { const c = of(id); return Boolean(c) && ["on", "waiting"].includes(statusOf(c!)); };
    // A host's Stripe Connect: the club's own account takes payments once Stripe says it can.
    const connect = setting("STRIPE_CONNECT", env) === "1" ? Boolean((await db.selectFrom("club").select("stripe_charges_enabled").executeTakeFirst())?.stripe_charges_enabled) : true;
    return { payments: working("payments") && connect, email: working("email"), live: of("practice")?.state === "ok" };
  });
}

export async function gettingStartedView(db: Db, l: Lang) {
  const g = await gettingStarted(db);
  // No location yet: courts, hours and prices start with adding one.
  const located = Boolean(await db.selectFrom("location").select("id").where("archived_at", "is", null).executeTakeFirst());
  return { ...g, items: g.items.map((x) => ({ ...x, title: both(`start.${x.key}` as Key)[l], how: both(`start.${x.key}_how` as Key)[l],
    page: !located && ["courts", "prices"].includes(x.key) ? "/settings#new-location" : PAGES[x.key] })) };
}
