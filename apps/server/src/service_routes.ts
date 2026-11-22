// A club service's settings, set in the app or by the owner's agent (core service_settings.ts). Two ways in, both the
// same action (vault.service_set), previewed first:
//   the owner pastes it on the service's card (Settings, Connectors): POST /staff/connectors/:service/stage seals each
//   value into the vault's waiting room, and the app previews and confirms naming those uploads;
//   the agent pipes it in (`openpadel connect <service> --set FIELD --from-stdin`): the command line, signed in as the
//   owner on a device the owner allowed with a second step minutes ago, sends it to /mcp/connect/:service/plan with its
//   token, and confirms the run on the owner's say-so (/mcp/connect/confirm).
// No value ever comes back from here: a card reads "set, ending 4f2a", in the app or on the server. A test call on the
// card (Resend: an email to the owner; Stripe: the account) says whether the service takes what was set.
import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { both, t, type Lang } from "@kumi/i18n";
import { apply, connectorLinkService, CONNECTOR_LINK_MINUTES, getAction, KumiError, makeConnectorLink, plan, serviceOf, serviceSetting, serviceStatus, SERVICES, stageServiceValue,
  type Actor, type Db } from "@kumi/core";
import { ownerOnly } from "./vault.ts";
import { bearerPerson } from "./oauth.ts";
import { ResendMailer } from "./mailer.ts";
import { previewWords } from "./preview_words.ts";
import { forgetConnectorChecks } from "./connectors.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
/** How recently the owner must have allowed the command line, with a second step, for it to change a service's keys. */
export const CONNECT_FRESH_MINUTES = 30;
const SERVICE_ACTIONS = new Set(["vault.service_set", "vault.service_remove"]);

export interface ServiceRouteDeps {
  db: Db; now: () => Date; publicUrl: string; production: boolean; fetch?: Fetch;
  me: (c: Context<any>) => { id: string; method?: string } | null; lang: (c: Context<any>) => Lang;
  /** The addresses the command line's tokens are for (the club's /mcp). */
  resources: string[];
}

export function serviceRoutes(deps: ServiceRouteDeps) {
  const app = new Hono();
  const { db } = deps;
  const fetchFn: Fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  // Practice is the server's: production with OPENPADEL_PRACTICE=1 still is, and so is anything outside production.
  const env = () => ({ ...process.env, NODE_ENV: deps.production ? "production" : "development" });
  const said = (c: Context<any>, p: Awaited<ReturnType<typeof plan>>) => {
    const w = previewWords(p.plan, deps.lang(c), null);
    return { run_id: p.runId, status: p.status, title: w.title, summary: w.summary, undo: p.plan.undo.kind, expires_at: p.expiresAt };
  };
  const linkUrl = (service: string, token: string) => `${deps.publicUrl.replace(/\/$/, "")}/connectors?set=${service}&link=${token}#connector-${service}`;

  // ---- The staff app: the owner, signed in with a second step (as the vault) ----
  app.post("/staff/connectors/:service/stage", async (c) => {
    const m = await ownerOnly(db, deps.me(c));
    const service = serviceOf(c.req.param("service")).key;
    const b = await c.req.json().catch(() => ({})) as { values?: unknown };
    const values = b.values && typeof b.values === "object" ? Object.entries(b.values as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v.trim()) : [];
    if (!values.length || values.length > 8) throw new KumiError("error.invalid_input", {}, 400);
    const staged = [];
    for (const [field, value] of values) staged.push(await stageServiceValue(db, m.id, service, field, value as string, { env: env(), now: deps.now() }));
    // Only which upload is which, and how each will be shown: never a value.
    return c.json({ service, values: staged.map((s) => ({ field: s.field, upload_id: s.upload_id })) });
  });
  app.get("/staff/connectors/:service/settings", async (c) => {
    await ownerOnly(db, deps.me(c));
    return c.json({ service: serviceOf(c.req.param("service")).key, settings: await serviceStatus(db, c.req.param("service")) });
  });
  // A link from `openpadel connect <service> --link`: which form it opens, for the owner, while it lasts.
  app.get("/staff/connectors/link/:token", async (c) => {
    await ownerOnly(db, deps.me(c));
    const service = await connectorLinkService(db, sha(c.req.param("token")), deps.now());
    if (!service) throw new KumiError("error.connector_link_gone", {}, 410);
    return c.json({ service });
  });
  // The card's test: one cheap call that says whether the service takes what was set. Changes nothing at the club.
  app.post("/staff/connectors/:service/test", async (c) => {
    const m = await ownerOnly(db, deps.me(c)), l = deps.lang(c);
    const service = serviceOf(c.req.param("service")).key;
    const r = await testService(db, service, m.id, l, fetchFn);
    forgetConnectorChecks();
    return c.json(r);
  });

  // ---- The command line, signed in as the owner (cli_remote.ts, `openpadel connect`) ----
  /** The owner's device, allowed with a second step in the last half hour: never a club agent's token, never an assistant
   *  connected long ago, never a manager. */
  const ownerDevice = async (c: Context<any>, fresh: boolean) => {
    const who = await bearerPerson(db, c.req.header("authorization"), deps.resources, deps.now());
    if (!who) throw new KumiError("error.signed_out", {}, 401);
    if (who.agent_id) throw new KumiError("error.vault_not_for_agents", {}, 403);
    const isOwner = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key").where("person_role.person_id", "=", who.id)
      .where("person_role.active", "=", true).where("role.key", "=", "owner").executeTakeFirst();
    if (!isOwner) throw new KumiError("error.service_owner_only", {}, 403);
    if (fresh) {
      const g = await db.selectFrom("oauth_grant").select(["second_step", "created_at"]).where("id", "=", who.grant_id).executeTakeFirstOrThrow();
      if (!g.second_step || deps.now().getTime() - new Date(g.created_at).getTime() > CONNECT_FRESH_MINUTES * 60_000) throw new KumiError("error.connect_fresh_step", { minutes: CONNECT_FRESH_MINUTES }, 403);
    }
    const lang: Lang = who.locale === "es" ? "es" : "en";
    const actor: Actor = { personId: who.id, via: `cli:${who.client_name ?? "openpadel"}`, lang, auth: fresh ? "device_step" : "oauth" };
    return { who, actor };
  };
  // What's set and where: for anyone on the staff who may read Connectors (owners and managers), never a value.
  app.get("/mcp/connect", async (c) => {
    const who = await bearerPerson(db, c.req.header("authorization"), deps.resources, deps.now());
    if (!who) throw new KumiError("error.signed_out", {}, 401);
    const boss = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key").where("person_role.person_id", "=", who.id)
      .where("person_role.active", "=", true).where("role.key", "in", ["owner", "manager"]).executeTakeFirst();
    if (!boss) throw new KumiError("error.staff_only", {}, 403);
    return c.json({ services: await Promise.all(SERVICES.map(async (s) => ({ service: s.key, settings: await serviceStatus(db, s.key) }))) });
  });
  app.post("/mcp/connect/:service/plan", async (c) => {
    const { who, actor } = await ownerDevice(c, true);
    const service = serviceOf(c.req.param("service")).key;
    const b = await c.req.json().catch(() => ({})) as { set?: unknown; remove?: unknown };
    if (Array.isArray(b.remove)) {
      const p = await plan(db, "vault.service_remove", { service, ...(b.remove.length ? { fields: b.remove.map(String) } : {}) }, actor, { now: deps.now() });
      return c.json(said(c, p));
    }
    const set = Array.isArray(b.set) ? b.set as { field?: unknown; value?: unknown }[] : [];
    if (!set.length || set.length > 8 || set.some((x) => typeof x.field !== "string" || typeof x.value !== "string")) throw new KumiError("error.invalid_input", {}, 400);
    const values = [];
    for (const x of set) values.push(await stageServiceValue(db, who.id, service, x.field as string, x.value as string, { env: env(), now: deps.now() }));
    const p = await plan(db, "vault.service_set", { service, values: values.map((v) => ({ field: v.field, upload_id: v.upload_id })) }, actor, { now: deps.now() });
    return c.json(said(c, p));
  });
  app.post("/mcp/connect/confirm", async (c) => {
    const { actor } = await ownerDevice(c, true);
    const b = await c.req.json().catch(() => ({})) as { run_id?: unknown };
    const id = typeof b.run_id === "string" && /^[0-9a-f-]{36}$/i.test(b.run_id) ? b.run_id : null;
    const run = id ? await db.selectFrom("action_run").select(["action", "actor_person_id"]).where("id", "=", id).executeTakeFirst() : null;
    // Only the changes this door previews: its second step is for a service's settings, nothing else.
    if (!run || !SERVICE_ACTIONS.has(run.action) || run.actor_person_id !== actor.personId) throw new KumiError("error.not_found", { thing: both("thing.change") }, 404);
    getAction(run.action);
    const result = await apply(db, id!, actor, { now: deps.now(), idempotencyKey: c.req.header("idempotency-key") ?? undefined });
    forgetConnectorChecks();
    return c.json({ status: "applied", result });
  });
  app.post("/mcp/connect/:service/link", async (c) => {
    const { who } = await ownerDevice(c, false);
    const service = serviceOf(c.req.param("service")).key, token = randomBytes(24).toString("base64url");
    const r = await makeConnectorLink(db, who.id, service, { now: deps.now(), token, hash: sha });
    return c.json({ link: linkUrl(service, token), expires_at: r.expires_at, minutes: CONNECTOR_LINK_MINUTES });
  });
  return app;
}

/** A link for the owner made on the server, as root (`openpadel connect <service> --link`). */
export async function serverConnectorLink(db: Db, publicUrl: string, service: string, now = new Date()) {
  const token = randomBytes(24).toString("base64url");
  const r = await makeConnectorLink(db, null, service, { now, token, hash: sha });
  return { link: `${publicUrl.replace(/\/$/, "")}/connectors?set=${service}&link=${token}#connector-${service}`, expires_at: r.expires_at, minutes: CONNECTOR_LINK_MINUTES };
}

export type ServiceTest = { ok: boolean; text: string };
/** One cheap call to the service with what's set now (the settings file first, then the app). */
export async function testService(db: Db, service: string, ownerId: string, l: Lang, fetchFn: Fetch = globalThis.fetch.bind(globalThis)): Promise<ServiceTest> {
  const get = async (name: string) => (await serviceSetting(db, name)).value?.trim();
  if (service === "resend") {
    const key = await get("RESEND_API_KEY"), from = await get("MAIL_FROM");
    if (!key || !from) return { ok: false, text: t(l, "service.test.not_set") };
    const to = (await db.selectFrom("person").select("email").where("id", "=", ownerId).executeTakeFirst())?.email;
    if (!to) return { ok: false, text: t(l, "service.test.no_owner_email") };
    try {
      // To the owner's own address only, whatever practice mode says: it's the owner, not a member.
      await new ResendMailer({ apiKey: key, from, fetch: fetchFn }).send({ to, subject: t(l, "service.test.email_subject"), text: t(l, "service.test.email_text") });
      return { ok: true, text: t(l, "service.test.email_sent", { to }) };
    } catch (e) { return { ok: false, text: t(l, "service.test.failed", { why: plainWhy(e) }) }; }
  }
  if (service === "stripe") {
    const key = await get("STRIPE_SECRET_KEY");
    if (!key) return { ok: false, text: t(l, "service.test.not_set") };
    try {
      const r = await fetchFn("https://api.stripe.com/v1/account", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      const d = await r.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
      if (!r.ok) return { ok: false, text: t(l, "service.test.failed", { why: `Stripe ${r.status}${d.error?.message ? `: ${d.error.message}` : ""}` }) };
      return { ok: true, text: t(l, key.includes("_live_") ? "service.test.stripe_live" : "service.test.stripe_test", { account: d.id ?? "" }) };
    } catch (e) { return { ok: false, text: t(l, "service.test.failed", { why: plainWhy(e) }) }; }
  }
  return { ok: false, text: t(l, "service.test.none") };
}
/** A failure's words with nothing in them that could be a key (a provider never echoes one, but just in case). */
const plainWhy = (e: unknown) => String((e as Error)?.message ?? e).replace(/\b(sk|rk|pk|re|whsec)_[A-Za-z0-9_]+/g, "$1_...").slice(0, 200);

