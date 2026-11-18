// The Connectors page's read (the WebConnectors board), and the reads of plugin cards in the apps' slots
// (plugin_cards.ts). Connectors: everything the club plugs into as one kind of card, the built-in services (Stripe,
// Resend, Twilio, Playtomic, offsite backups, judged by `openpadel doctor`'s own checks) and the installed plugins
// (their status, health, permissions and keys), with the club's agents and assistants. The same read answers an agent
// asking "what's connected, and is it healthy?" (`openpadel connectors`, the `connectors` tool). Never a secret: a key
// reads "added, ends in 4F2A" or missing, and the settings file's own keys only whether they're there.
import { Hono, type Context } from "hono";
import { both, type Key, type Lang, type Text } from "@kumi/i18n";
import { cardsFor, clubAgents, KumiError, type CardSlot, type Db } from "@kumi/core";
import { doctor, type Check } from "./doctor.ts";
import { pluginsWithHealth } from "./plugins.ts";

export type ConnectorStatus = "on" | "waiting" | "attention" | "off";
type Env = Record<string, string | undefined>;

/** The built-in services: the doctor checks that judge each (the first is its own), the settings it needs on the
 *  server, where its guide is, and where the staff app looks after it. */
export const BUILT_INS = [
  { key: "stripe", name: "Stripe", checks: ["payments", "wallets", "currency"], settings: ["KUMI_STRIPE_SECRET_KEY", "KUMI_STRIPE_PUBLISHABLE_KEY", "KUMI_STRIPE_WEBHOOK_SECRET"],
    doc: "docs/setup/accounts/stripe.md", page: "/payments", sees: "processor.stripe.gets" },
  { key: "resend", name: "Resend", checks: ["email", "email_domain", "email_reports"], settings: ["KUMI_RESEND_API_KEY", "KUMI_MAIL_FROM", "KUMI_RESEND_WEBHOOK_SECRET"],
    doc: "docs/setup/accounts/resend.md", page: null, sees: "processor.resend.gets" },
  { key: "twilio", name: "Twilio", checks: ["texts"], settings: ["KUMI_TWILIO_ACCOUNT_SID", "KUMI_TWILIO_AUTH_TOKEN", "KUMI_TWILIO_MESSAGING_SERVICE_SID"],
    doc: "docs/setup/accounts/twilio.md", page: "/settings#texting", sees: "processor.twilio.gets" },
  { key: "playtomic", name: "Playtomic", checks: ["playtomic"], settings: ["KUMI_PLAYTOMIC_CLIENT_ID", "KUMI_PLAYTOMIC_SECRET", "KUMI_PLAYTOMIC_TENANT_ID"],
    doc: "docs/setup/accounts/playtomic.md", page: "/playtomic", sees: null },
  { key: "offsite", name: "Offsite backups", checks: ["offsite", "backups", "restore_test"], settings: ["KUMI_OFFSITE_BUCKET", "KUMI_OFFSITE_ACCESS_KEY_ID", "KUMI_OFFSITE_SECRET_ACCESS_KEY", "KUMI_BACKUP_KEY"],
    doc: "docs/setup/accounts/offsite-backups.md", page: null, sees: "processor.offsite.gets" },
] as const;
/** Settings whose last four aren't shown even so: the keys that open the club's backups and sealed secrets, which the
 *  owner keeps in a password manager and nobody else reads (AGENTS.md). */
const NEVER_LAST4 = new Set(["KUMI_BACKUP_KEY", "KUMI_SECRET_KEY", "KUMI_MAIL_FROM"]);

/** One doctor check as a connector's status: a failure needs attention; off is off; a warning that it's practice, still
 *  waiting (a registration, a first sync) or never run yet is waiting; any other warning needs attention. */
export function statusOf(c: Pick<Check, "state" | "key">): ConnectorStatus {
  const k = c.key ?? "";
  if (c.state === "fail") return "attention";
  if (c.state === "off" || /\.(off|none|no_domain|off_setting)$/.test(k)) return "off";
  if (c.state === "ok") return "on";
  return /practice|\.test$|waiting|reg_|no_sender|never/.test(k) ? "waiting" : "attention";
}
/** A connector's status from its checks: its own (the first found) says on, waiting or off, and any other that needs
 *  attention says so, unless it's off. */
export function statusOfAll(checks: Pick<Check, "state" | "key">[]): ConnectorStatus {
  if (!checks.length) return "off";
  const own = statusOf(checks[0]!);
  if (own === "off") return "off";
  return checks.some((c) => statusOf(c) === "attention") ? "attention" : own;
}

let cache: { at: number; checks: Check[] } | null = null;
/** doctor's checks, kept a minute: the page and an agent asking again don't ask Stripe and Twilio each time. */
async function checksNow(db: Db, env: Env, fresh: boolean): Promise<Check[]> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.checks;
  const checks = await doctor(db, env);
  cache = { at: Date.now(), checks };
  return checks;
}
export function forgetConnectorChecks(): void { cache = null; }

/** Everything the club plugs into, in the reader's language. */
export async function connectors(db: Db, l: Lang, o: { production: boolean; env?: Env; fresh?: boolean; now?: Date }) {
  const env = o.env ?? process.env, checks = await checksNow(db, env, Boolean(o.fresh));
  const said = (t: Text) => t[l];
  const builtIns = BUILT_INS.map((b) => {
    const mine = b.checks.map((id) => checks.find((c) => c.id === id)).filter((c): c is Check => Boolean(c));
    const status = statusOfAll(mine);
    return { key: b.key, name: b.key === "offsite" ? both("connector.offsite.name")[l] : b.name, kind: both(`connector.${b.key}.kind` as Key)[l], does: both(`connector.${b.key}.does` as Key)[l],
      sees: b.sees ? both(b.sees as Key)[l] : null, status, health: mine[0] ? said(mine[0].text) : both("connector.not_checked")[l],
      checks: mine.map((c) => ({ id: c.id, state: c.state, status: statusOf(c), text: said(c.text), ...(c.doc ? { doc: c.doc } : {}) })),
      settings: b.settings.map((name) => {
        const v = env[name]?.trim();
        return { name, added: Boolean(v), last4: v && !NEVER_LAST4.has(name) && v.length >= 12 ? v.slice(-4) : null };
      }),
      doc: b.doc, page: b.page };
  });
  const plugins = (await pluginsWithHealth(db, l, o.production)).filter((p) => p.status !== "removed").map((p) => {
    const missing = p.keys.filter((k) => !k.added);
    const status: ConnectorStatus = p.status === "paused" ? "off" : p.status === "waiting" ? "waiting" : p.health?.state === "down" || missing.length ? "attention" : "on";
    return { ...p, connector_status: status };
  });
  const cards = await cardsFor(db, "connectors", null, l);
  const { agents, assistants } = await clubAgents(db, l, o.now ?? new Date());
  const all = [...builtIns.map((b) => b.status), ...plugins.map((p) => p.connector_status)];
  const count = (s: ConnectorStatus) => all.filter((x) => x === s).length;
  return {
    summary: { on: count("on"), attention: count("attention"), waiting: count("waiting"), off: count("off") },
    built_ins: builtIns,
    plugins: plugins.map((p) => ({ ...p, cards: cards.filter((c) => c.plugin === p.name) })),
    agents: agents.filter((a) => !a.revoked_at).map((a) => ({ id: a.id, name: a.name, role: a.role_name, can: a.can, last_used_at: a.last_used_at, token_last4: a.token_last4,
      weekly_cap_cents: a.weekly_cap_cents, spent_cents: a.spent_cents, webhooks: a.webhooks })),
    assistants: assistants.map((a) => ({ id: a.id, name: a.name, person: a.person, roles: a.roles, last_used_at: a.last_used_at })),
    // What to give the club's agent to connect something, and what to ask Ask openPadel.
    ask: { commands: pluginCommands(l), prompt: both("connector.ask_prompt")[l] },
  };
}

/** Owners and managers only, like Settings, Agents and the plugin list (plugins.ts). */
async function ownerOrManager(db: Db, personId: string) {
  const boss = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key").where("person_role.person_id", "=", personId)
    .where("person_role.active", "=", true).where("role.active", "=", true).where("role.key", "in", ["owner", "manager"]).executeTakeFirst();
  if (!boss) throw new KumiError("error.staff_only", {}, 403);
}

/** The staff reads (reads.ts mounts them behind its area checks): Connectors, and each slot's cards where its area
 *  is read: a court's tile under bookings (/staff/grid/...), a game under bookings, a person under members, Money under
 *  money. */
export function staffConnectorRoutes(db: Db, me: (c: Context<any>) => { id: string } | null, lang: (c: Context<any>) => Lang, o: { production: boolean }) {
  const app = new Hono();
  const who = (c: Context<any>) => { const m = me(c); if (!m) throw new KumiError("error.signed_out", {}, 401); return m.id; };
  app.get("/staff/connectors", async (c) => {
    await ownerOrManager(db, who(c));
    return c.json(await connectors(db, lang(c), { production: o.production, fresh: c.req.query("fresh") === "1" }));
  });
  // Each court's tile: the courts with cards on them (all the club's, or those asked for).
  app.get("/staff/grid/cards", async (c) => {
    const asked = (c.req.query("courts") ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/.test(x));
    const courts = await db.selectFrom("court").select(["id", "name", "location_id"]).where("archived_at", "is", null).$if(asked.length > 0, (q) => q.where("id", "in", asked)).orderBy("name").execute();
    const cards = await cardsFor(db, "court_tile", courts.map((x) => x.id), lang(c));
    return c.json(courts.map((x) => ({ court_id: x.id, court: x.name, location_id: x.location_id, cards: cards.filter((k) => k.subject === x.id) })).filter((x) => x.cards.length));
  });
  const one = (slot: CardSlot, subjects: (id: string) => Promise<string[]>) => async (c: Context<any>) => {
    const id = c.req.param("id")!;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new KumiError("error.not_found", { thing: both("thing.plugin") }, 404);
    return c.json(await cardsFor(db, slot, await subjects(id), lang(c)));
  };
  app.get("/staff/bookings/:id/cards", one("game", (id) => gameSubjects(db, id)));
  app.get("/staff/people/:id/cards", one("member_profile", async (id) => [id]));
  app.get("/staff/reports/cards", async (c) => c.json(await cardsFor(db, "money", null, lang(c))));
  return app;
}

/** A game's cards may be put on its booking or on a game played on it. */
async function gameSubjects(db: Db, bookingId: string): Promise<string[]> {
  const games = await db.selectFrom("game").select("id").where("booking_id", "=", bookingId).execute();
  return [bookingId, ...games.map((g) => g.id)];
}

/** The members' reads (member.ts mounts them): a game's cards for its organiser and players, and a member's own
 *  profile cards for them alone. */
export function memberCardRoutes(db: Db, who: (c: Context<any>) => string, lang: (c: Context<any>) => Lang) {
  const app = new Hono();
  app.get("/matches/:id/cards", async (c) => {
    const pid = who(c), id = c.req.param("id");
    const mine = /^[0-9a-f-]{36}$/.test(id) && await db.selectFrom("booking").select("booking.id").where("booking.id", "=", id)
      .where((w) => w.or([w("booking.organiser_id", "=", pid),
        w.exists(w.selectFrom("booking_player").select("booking_player.id").whereRef("booking_player.booking_id", "=", "booking.id").where("booking_player.person_id", "=", pid).where("booking_player.removed_at", "is", null))]))
      .executeTakeFirst();
    // Someone not in the game hears the same as for a game that isn't there.
    if (!mine) throw new KumiError("error.not_found", { thing: { en: "match", es: "el partido" } }, 404);
    return c.json(await cardsFor(db, "game", await gameSubjects(db, id), lang(c)));
  });
  app.get("/my/cards", async (c) => c.json(await cardsFor(db, "member_profile", [who(c)], lang(c))));
  return app;
}

/** The commands to give the club's agent, with their blanks in the page's language. */
function pluginCommands(l: string): string[] {
  const [what, name] = l === "es" ? ["<qué>", "<nombre>"] : ["<what>", "<name>"];
  return [`openpadel plugin search ${what}`, `openpadel plugin info --name ${name}`, `openpadel plugin install --name ${name}`];
}
