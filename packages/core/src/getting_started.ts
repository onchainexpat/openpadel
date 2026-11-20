// Getting started: the short checklist a brand-new club's owner and managers see on Today until the club is ready,
// each tick read from the club's real state (what `openpadel doctor` and setup already know), never ticked by hand.
// The club's details and logo, its courts and opening hours, prices, card payments, email, a membership plan
// (optional), staff, members, and practice mode off. Card payments, email and practice mode are the server's settings
// (doctor.ts reads them): the server says how they stand (setStartOutside), so this file never reads the settings
// itself. Once every required step is done, the owner or a manager can put the list away (getting_started.hide).
import * as z from "zod/mini";
import { sql } from "kysely";
import { both } from "@kumi/i18n";
import { defineAction, readRow } from "./actions.ts";
import { KumiError } from "./errors.ts";
import type { Db, Trx } from "./db.ts";

export const START_KEYS = ["club", "courts", "prices", "payments", "email", "membership", "staff", "members", "live"] as const;
export type StartKey = (typeof START_KEYS)[number];
/** The steps a club can go live without. */
export const START_OPTIONAL: readonly StartKey[] = ["membership"];
/** How the server's own settings stand: card payments set up (Stripe's keys, and its webhook), email set up (Resend),
 *  and practice mode off. */
export interface StartOutside { payments: boolean; email: boolean; live: boolean }
let outside: () => Promise<StartOutside> = async () => ({ payments: false, email: false, live: false });
/** The server tells how its settings stand (app.ts, from doctor's checks). */
export function setStartOutside(f: () => Promise<StartOutside>): void { outside = f; }

export interface StartItem { key: StartKey; done: boolean; optional: boolean }
export interface GettingStarted { items: StartItem[]; done: number; required: number; required_done: number; ready: boolean; hidden_at: Date | null }

const count = async (q: Promise<{ n: string | number | bigint } | undefined>) => Number((await q)?.n ?? 0);

/** Where the club stands, step by step. */
export async function gettingStarted(db: Db | Trx): Promise<GettingStarted> {
  const club = await db.selectFrom("club").select(["name", "logo_id", "getting_started_hidden_at"]).executeTakeFirst();
  const courts = await count(db.selectFrom("court").select((eb) => eb.fn.countAll<string>().as("n")).where("archived_at", "is", null).executeTakeFirst());
  const hours = await count(db.selectFrom("opening_hours").select((eb) => eb.fn.countAll<string>().as("n")).where("opens", "is not", null).executeTakeFirst());
  const prices = await count(db.selectFrom("price_rule").select((eb) => eb.fn.countAll<string>().as("n")).where("active", "=", true).executeTakeFirst());
  const plans = await count(db.selectFrom("membership_plan").select((eb) => eb.fn.countAll<string>().as("n")).where("active", "=", true).executeTakeFirst());
  // People with a staff role (not a plugin's, not a club agent's): the owner and one more.
  const staff = await count(sql<{ n: string }>`SELECT count(DISTINCT pr.person_id) AS n FROM person_role pr JOIN role r ON r.id = pr.role_id JOIN person p ON p.id = pr.person_id
    WHERE pr.active AND r.active AND r.key <> 'member' AND NOT r.for_plugin AND p.status <> 'archived'
      AND NOT EXISTS (SELECT 1 FROM agent a WHERE a.person_id = pr.person_id)`.execute(db).then((r) => r.rows[0]));
  // Members: people with the member role and no staff role.
  const members = await count(sql<{ n: string }>`SELECT count(DISTINCT pr.person_id) AS n FROM person_role pr JOIN role r ON r.id = pr.role_id JOIN person p ON p.id = pr.person_id
    WHERE pr.active AND r.key = 'member' AND p.status <> 'archived'
      AND NOT EXISTS (SELECT 1 FROM person_role s JOIN role sr ON sr.id = s.role_id WHERE s.person_id = pr.person_id AND s.active AND sr.key <> 'member')
      AND NOT EXISTS (SELECT 1 FROM agent a WHERE a.person_id = pr.person_id)`.execute(db).then((r) => r.rows[0]));
  const out = await outside().catch(() => ({ payments: false, email: false, live: false }));
  const done: Record<StartKey, boolean> = { club: Boolean(club?.logo_id), courts: courts > 0 && hours > 0, prices: prices > 0, payments: out.payments, email: out.email,
    membership: plans > 0, staff: staff > 1, members: members > 0, live: out.live };
  const items = START_KEYS.map((key) => ({ key, done: done[key], optional: START_OPTIONAL.includes(key) }));
  const required = items.filter((x) => !x.optional);
  return { items, done: items.filter((x) => x.done).length, required: required.length, required_done: required.filter((x) => x.done).length,
    ready: required.every((x) => x.done), hidden_at: club?.getting_started_hidden_at ?? null };
}

export const gettingStartedHide = defineAction({
  name: "getting_started.hide", version: 1, clubWide: true,
  input: z.object({}),
  async plan(ctx) {
    const { read } = await readRow(ctx.db, "club", "singleton");
    const g = await gettingStarted(ctx.db);
    if (g.hidden_at) throw new KumiError("error.nothing_changed", {}, 400);
    if (!g.ready) throw new KumiError("error.getting_started_not_done", {}, 409);
    return { title: both("action.getting_started.hide"), summary: both("plan.getting_started.hide"), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx) {
    await ctx.update("club", "singleton", { getting_started_hidden_at: ctx.now });
    return { hidden: true };
  },
});
