// Plugins (docs/plugins/): extras a club installs, each a separate program that acts only through the door and gets
// events by signed webhook. It never runs inside the server and never touches the database. Its manifest
// (plugin_manifest.ts) says exactly what it may do, and installing it makes it a club agent (agents.ts) with:
//   - a role made from the manifest's grants and reads (role.for_plugin, nobody else's; roles.ts reads read_areas);
//   - one webhook (webhooks.ts) for the manifest's events, to <its address>/events;
//   - a token nobody who installs it ever sees. A remote plugin is sent it in a registration POST to <url>/register,
//     signed with the club's own Ed25519 key (its public half at /.well-known/openpadel-plugin-key); a local plugin
//     has it written into its service's environment on the server (`openpadel plugin service`).
// Its keys live in the club vault under "<plugin>/<NAME>", added by the owner; the plugin reads its own declared ones
// through the door, by name, and whoever installed it is told only "added, ends in 4F2A".
//
// Installing goes through the door like any change, so the club's agent can do it: the preview lists in words
// everything the manifest asks for, the person confirms on their yes (a manager or an agent asks; the owner says yes),
// and the plugin's role is never more than the installer's own.
import { createHmac, generateKeyPairSync, createPrivateKey, randomBytes, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import * as z from "zod/mini";
import { both, type Key, type Lang, type Text } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx, type PlanCtx } from "./actions.ts";
import { keepToken, newToken, revokeAgentRows, AGENT_CLIENT } from "./agents.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { backoffMs } from "./outbox.ts";
import { exceeds, heldBy, readAreas } from "./roles.ts";
import { openBytes, openText, sealText } from "./sealed.ts";
import { checkWebhookUrl, PLUGIN_CONFIGURED_TOPIC } from "./webhooks.ts";
import { areasText, checkManifestAtClub, checkSettings, grantsText, manifestDiff, manifestRows, manifestSha256, parseManifest, readsOf, rowsText, runText,
  MANIFEST_MAX_BYTES, type Manifest } from "./plugin_manifest.ts";

/** Local plugins listen on the server's loopback, one port each from here. */
export const LOCAL_PORT_FROM = 47100;
/** The largest message forwarded to a plugin from /plugins/<name>/hook, and how many a minute. */
export const HOOK_MAX_BYTES = 1_000_000, HOOK_PER_MINUTE = 120;
export const REGISTER_TOPIC = "plugin.registered";

// ---- Talking to plugins and catalogs: the server's rules (apps/server/src/plugins.ts) ----
export interface PluginIo {
  /** GET an address's text, at most `max` bytes, within the webhooks' address rules. */
  fetchText(url: string, max: number): Promise<string>;
  /** POST a body; the answer's status and (some of) its text. */
  post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
  /** Where the catalog's index is: an address or a file; null for the sample bundled with openPadel. */
  catalogUrl: string | null;
  /** The club's own address, for a plugin to reach the door and check the club's key. */
  publicUrl: string;
}
const devIo: PluginIo = {
  async fetchText(url, max) {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const t = await r.text();
    if (Buffer.byteLength(t) > max) throw new Error("too large");
    return t;
  },
  async post(url, body, headers) {
    const r = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(10_000), redirect: "error" });
    return { status: r.status, body: (await r.text()).slice(0, 2000) };
  },
  catalogUrl: null, publicUrl: "http://localhost:8787",
};
let io: PluginIo = devIo;
export function setPluginIo(next: Partial<PluginIo>): void { io = { ...io, ...next }; }
export function pluginIo(): PluginIo { return io; }

// ---- The catalog ----
/** openPadel's own reviewed catalog (its repository is round F's): the one a club's doctor doesn't warn about. */
export const OPENPADEL_CATALOG_URL = "https://plugins.openpadel.org/catalog.json";
/** Whether the catalog the server is set to is someone else's: everything in it would count as reviewed. */
export const ownCatalog = (url: string | null | undefined) => !url?.trim() || url.trim().replace(/\/+$/, "") === OPENPADEL_CATALOG_URL;
export interface CatalogEntry { manifest: Manifest }
const SAMPLE = new URL("./plugin_catalog.sample.json", import.meta.url);
let catalogCache: { at: number; url: string | null; entries: CatalogEntry[]; skipped: string[] } | null = null;
/** The catalog's plugins (the index at the configured address, or the bundled sample), each manifest checked; kept ten
 *  minutes. Entries that don't check are left out and named in `skipped`. */
export async function pluginCatalog(force = false): Promise<{ entries: CatalogEntry[]; skipped: string[]; source: string }> {
  const url = io.catalogUrl;
  if (!force && catalogCache && catalogCache.url === url && Date.now() - catalogCache.at < 10 * 60_000) return { entries: catalogCache.entries, skipped: catalogCache.skipped, source: url ?? "sample" };
  let raw: string;
  try {
    raw = !url ? readFileSync(SAMPLE, "utf8") : /^https?:\/\//.test(url) ? await io.fetchText(checkWebhookUrl(url), 2_000_000) : readFileSync(url.replace(/^file:\/\//, ""), "utf8");
  } catch (e) { throw new KumiError("error.plugin_catalog", { why: String((e as Error).message ?? e).slice(0, 200) }, 502); }
  let index: { plugins?: unknown };
  try { index = JSON.parse(raw); } catch { throw new KumiError("error.plugin_catalog", { why: "not JSON" }, 502); }
  const entries: CatalogEntry[] = [], skipped: string[] = [];
  for (const p of Array.isArray(index.plugins) ? index.plugins.slice(0, 500) : []) {
    const name = String((p as { manifest?: { name?: unknown } })?.manifest?.name ?? "?");
    try { entries.push({ manifest: parseManifest((p as { manifest: unknown }).manifest) }); } catch { skipped.push(name); }
  }
  catalogCache = { at: Date.now(), url, entries, skipped };
  return { entries, skipped, source: url ?? "sample" };
}
/** Plugins in the catalog whose name, publisher or description has every word asked for. */
export async function searchCatalog(q: string): Promise<CatalogEntry[]> {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const { entries } = await pluginCatalog();
  return entries.filter((e) => {
    const hay = `${e.manifest.name} ${e.manifest.publisher} ${e.manifest.description.en} ${e.manifest.description.es}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ---- The club's signing key ----
/** The club's Ed25519 key for what it sends plugins, made the first time it's needed. Its public half (a JWK) is
 *  published at /.well-known/openpadel-plugin-key. */
export async function pluginKey(db: Db | Trx): Promise<{ privatePem: string; jwk: Record<string, string> }> {
  const have = await db.selectFrom("plugin_key").select(["private_sealed", "public_jwk"]).executeTakeFirst();
  if (have) return { privatePem: openText(have.private_sealed), jwk: have.public_jwk as Record<string, string> };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, string>), use: "sig", alg: "EdDSA" };
  await db.insertInto("plugin_key").values({ private_sealed: sealText(privateKey.export({ format: "pem", type: "pkcs8" }) as string), public_jwk: JSON.stringify(jwk) })
    .onConflict((oc) => oc.doNothing()).execute();
  return pluginKey(db);
}
/** The openpadel-signature-ed25519 header: "t=<seconds>,ed25519=<base64url signature of '<t>.<body>'>". */
export async function signForPlugin(db: Db, body: string, t: number): Promise<string> {
  const k = await pluginKey(db);
  return `t=${t},ed25519=${edSign(null, Buffer.from(`${t}.${body}`, "utf8"), createPrivateKey(k.privatePem)).toString("base64url")}`;
}

// ---- Rows ----
export const PLUGIN_NAME = z.string().check(z.regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/), z.describe("The plugin's name, as its manifest and the catalog give it (court-lights)"));
const manifestOf = (row: { manifest: unknown }) => row.manifest as Manifest;
const hostOf = (url: string | null) => { try { return url ? new URL(url).host : ""; } catch { return url ?? ""; } };
/** A plugin that's installed (not removed), by name. */
async function livePlugin(db: Db | Trx, name: string) {
  const p = await db.selectFrom("plugin").select(["id"]).where("name", "=", name).where("status", "!=", "removed").executeTakeFirst();
  if (!p) throw new KumiError("error.plugin_not_installed", { name }, 404);
  const { row, read } = await readRow(db, "plugin", p.id, "thing.plugin");
  return { row, read, m: row.manifest as Manifest };
}
/** The vault name a plugin's key is kept under: its own, so a plugin never reads the club's other keys. */
export const pluginVaultName = (plugin: string, secret: string) => `${plugin}/${secret}`;
/** Each key a plugin's manifest declares: whether the vault has it, and its last four if so. */
export async function pluginSecrets(db: Db | Trx, plugin: string, m: Pick<Manifest, "secrets">) {
  const names = m.secrets.map((s) => pluginVaultName(plugin, s.name).toLowerCase());
  const have = names.length ? await db.selectFrom("vault_item").select(["name", "last4", "updated_at"]).where("kind", "=", "secret").where("active", "=", true)
    .where((eb) => eb(eb.fn("lower", ["name"]), "in", names)).execute() : [];
  return m.secrets.map((s) => {
    const v = have.find((h) => h.name.toLowerCase() === pluginVaultName(plugin, s.name).toLowerCase());
    return { name: s.name, vault_name: pluginVaultName(plugin, s.name), label: s.label, where: s.where, added: Boolean(v), last4: v?.last4 ?? null, added_at: v?.updated_at ?? null };
  });
}
/** A plugin's own key, by the name its manifest declares, for the plugin itself through the door (mcp.ts): nothing it
 *  didn't declare, nothing of another plugin's or the club's own. Each read is kept, like a document download. */
export async function pluginSecretFor(db: Db, agentId: string, name: string): Promise<{ name: string; value: string; last4: string | null } | null> {
  const p = await db.selectFrom("plugin").innerJoin("agent", "agent.id", "plugin.agent_id").select(["plugin.name", "plugin.manifest", "plugin.status", "agent.person_id"])
    .where("plugin.agent_id", "=", agentId).where("plugin.status", "in", ["waiting", "on"]).executeTakeFirst();
  if (!p) return null;
  const m = manifestOf(p);
  if (!m.secrets.some((s) => s.name === name)) throw new KumiError("error.plugin_secret_undeclared", { name }, 403);
  const r = await db.selectFrom("vault_item").innerJoin("vault_blob", "vault_blob.id", "vault_item.blob_id").select(["vault_item.id", "vault_item.last4", "vault_blob.bytes"])
    .where((eb) => eb(eb.fn("lower", ["vault_item.name"]), "=", pluginVaultName(p.name, name).toLowerCase())).where("vault_item.kind", "=", "secret").where("vault_item.active", "=", true).executeTakeFirst();
  if (!r) throw new KumiError("error.plugin_secret_missing", { name }, 404);
  await db.insertInto("vault_access").values({ id: uuidv7(), item_id: r.id, person_id: p.person_id! }).execute();
  return { name, value: openBytes(r.bytes).toString("utf8"), last4: r.last4 };
}
/** The plugin a club agent is (mcp.ts): its name, settings and manifest, or null for any other agent. */
export async function pluginOfAgent(db: Db | Trx, agentId: string) {
  const p = await db.selectFrom("plugin").select(["id", "name", "release", "status", "settings", "manifest", "mode"]).where("agent_id", "=", agentId).where("status", "!=", "removed").executeTakeFirst();
  return p ?? null;
}

// ---- Installing ----
type Source = { source: "catalog" | "url" | "file"; source_url: string | null; manifest: Manifest };
const installInput = {
  name: z.optional(PLUGIN_NAME),
  url: z.optional(z.string().check(z.minLength(8), z.maxLength(500), z.describe("A manifest's address (openpadel-plugin.json), for a plugin outside the catalog: the preview says so"))),
  manifest: z.optional(z.string().check(z.maxLength(MANIFEST_MAX_BYTES), z.describe("A manifest's JSON itself, for a plugin outside the catalog: the preview says so"))),
};
/** Where a manifest comes from: the catalog by name, an address, or the file itself. */
async function sourceOf(i: { name?: string; url?: string; manifest?: string }): Promise<Source> {
  const given = [i.name, i.url, i.manifest].filter((x) => x !== undefined).length;
  if (given !== 1) throw new KumiError("error.plugin_source", {}, 400);
  if (i.manifest !== undefined) return { source: "file", source_url: null, manifest: parseManifest(i.manifest) };
  if (i.url !== undefined) {
    const url = checkWebhookUrl(i.url);
    let text: string;
    try { text = await io.fetchText(url, MANIFEST_MAX_BYTES); } catch (e) { throw new KumiError("error.plugin_fetch", { url: new URL(url).host, why: String((e as Error).message ?? e).slice(0, 200) }, 502); }
    return { source: "url", source_url: url, manifest: parseManifest(text) };
  }
  const found = (await pluginCatalog()).entries.find((e) => e.manifest.name === i.name);
  if (!found) throw new KumiError("error.plugin_not_in_catalog", { name: i.name! }, 404);
  return { source: "catalog", source_url: io.catalogUrl, manifest: found.manifest };
}
/** The plugin's address checked by the webhooks' rules (https and public in production), or its release's. */
function checkRun(m: Manifest) {
  if (m.run.mode === "remote") checkWebhookUrl(m.run.url);
  else checkWebhookUrl(m.run.release_url);
  if (m.name !== m.name.toLowerCase()) throw new KumiError("error.plugin_manifest", { details: "name" }, 400);
}
/** Never more than the person (or agent) installing it holds: each action, as outright or asking as theirs, and each part
 *  of the club it reads. */
async function withinInstaller(ctx: PlanCtx, m: Manifest) {
  if (!ctx.actor.personId) return;
  for (const g of m.grants) if (exceeds({ mode: g.mode, scope: g.scope ?? "any" }, await heldBy(ctx.db, ctx.actor, g.action)))
    throw new KumiError("error.plugin_more_than_you", { action: both(`action.${g.action}` as Key) }, 403);
  const areas = await readAreas(ctx.db, ctx.actor.personId);
  if (areas !== null) for (const a of readsOf(m)) if (!areas.includes(a)) throw new KumiError("error.plugin_reads_more_than_you", { area: both(`area.${a}` as Key) }, 403);
}
/** The words for where it came from: the catalog, or (loudly) not. */
function sourceRow(s: Source): { label: Text; text: Text } {
  if (s.source === "catalog") return { label: both("plan.plugin.row_source"), text: both("plan.plugin.from_catalog", { publisher: s.manifest.publisher }) };
  const where = s.source_url ? new URL(s.source_url).host : both("plan.plugin.a_file");
  return { label: both("plan.plugin.row_not_reviewed"), text: both("plan.plugin.not_reviewed", { publisher: s.manifest.publisher, where }) };
}
/** How its token reaches it, never through whoever installs it. */
const tokenRow = (m: Manifest) => ({ label: both("plan.plugin.row_token"), text: m.run.mode === "remote" ? both("plan.plugin.token_remote", { host: new URL(m.run.url).host }) : both("plan.plugin.token_local", { name: m.name }) });

/** The base address the club reaches a plugin at. */
function baseUrlOf(m: Manifest, port: number | null): string {
  return m.run.mode === "remote" ? m.run.url.replace(/\/+$/, "") : `http://127.0.0.1:${port}`;
}
async function freePort(trx: Trx): Promise<number> {
  const used = new Set((await trx.selectFrom("plugin").select("local_port").where("local_port", "is not", null).execute()).map((r) => r.local_port!));
  let p = LOCAL_PORT_FROM;
  while (used.has(p)) p++;
  return p;
}
/** The role a plugin acts with, made from its manifest (or remade on an update). */
async function writeRole(ctx: ApplyCtx, m: Manifest, roleId: string | null): Promise<string> {
  if (!roleId) {
    const id = uuidv7();
    await ctx.insert("role", { id, key: `plugin_${m.name.replace(/-/g, "_")}_${randomBytes(3).toString("hex")}`, system: false, name: `${m.name} (plugin)`, based_on: null, for_plugin: true, read_areas: m.reads });
    for (const g of m.grants) await ctx.insert("role_grant", { id: uuidv7(), role_id: id, pattern: g.action, mode: g.mode, rows_scope: g.scope ?? "any" });
    return id;
  }
  await ctx.update("role", roleId, { read_areas: m.reads });
  const old = await ctx.trx.selectFrom("role_grant").select(["id", "pattern", "mode", "rows_scope"]).where("role_id", "=", roleId).where("active", "=", true).execute();
  const want = new Map(m.grants.map((g) => [g.action, { mode: g.mode, scope: g.scope ?? "any" }]));
  for (const g of old) {
    const w = want.get(g.pattern);
    if (w && w.mode === g.mode && w.scope === g.rows_scope) { want.delete(g.pattern); continue; }
    await ctx.update("role_grant", g.id, { active: false });
  }
  for (const [action, w] of want) await ctx.insert("role_grant", { id: uuidv7(), role_id: roleId, pattern: action, mode: w.mode, rows_scope: w.scope });
  return roleId;
}
const topicsOf = (m: Manifest) => [...new Set([...m.events, PLUGIN_CONFIGURED_TOPIC])].sort();
/** A note for the owners that keys are missing (messages.ts), when any are. */
async function askForKeys(ctx: ApplyCtx, pluginId: string, name: string, m: Manifest) {
  const missing = (await pluginSecrets(ctx.trx, name, m)).filter((s) => !s.added).map((s) => s.name);
  if (missing.length) await ctx.emit("plugin.secrets_needed", { plugin_id: pluginId, names: missing });
  return missing;
}

export const pluginInstall = defineAction({
  name: "plugin.install", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ ...installInput, settings: z.optional(z.record(z.string(), z.unknown()).check(z.describe("Its settings, as its manifest describes them (plugin info lists them); they can be given later with plugin configure"))) }),
  async plan(ctx, i) {
    const s = await sourceOf(i), m = s.manifest;
    await checkManifestAtClub(ctx.db, m);
    checkRun(m);
    if (await ctx.db.selectFrom("plugin").select("id").where("name", "=", m.name).where("status", "!=", "removed").executeTakeFirst()) throw new KumiError("error.plugin_installed", { name: m.name });
    await withinInstaller(ctx, m);
    // Settings: checked now when given; required ones not given yet are said, for plugin configure.
    let settings: Record<string, unknown> = {}, setRows: { label: Text; text: Text }[] = [];
    if (i.settings && Object.keys(i.settings).length) {
      const c = await checkSettings(ctx.db, m, i.settings);
      settings = c.values;
      setRows = [{ label: both("plan.plugin.row_settings"), text: { en: c.lines.map((l) => l.en).join("; "), es: c.lines.map((l) => l.es).join("; ") } }];
    } else {
      const todo = m.settings.filter((f) => "required" in f && f.required).map((f) => f.label);
      if (todo.length) setRows = [{ label: both("plan.plugin.row_settings"), text: both("plan.plugin.settings_later", { list: { en: todo.map((t) => t.en).join(", "), es: todo.map((t) => t.es).join(", ") }, name: m.name }) }];
    }
    const rows = [sourceRow(s), ...manifestRows(m), ...setRows, tokenRow(m)];
    const head = s.source === "catalog" ? both("plan.plugin.install", { name: m.name, version: m.version }) : both("plan.plugin.install_unreviewed", { name: m.name, version: m.version });
    return { title: both("action.plugin.install"), summary: rowsText(head, rows), rows, reads: [], undo: { kind: "none", note: both("reason.plugin_remove_instead") },
      details: { manifest: m, sha: manifestSha256(m), source: s.source, source_url: s.source_url, settings } };
  },
  async apply(ctx, _i, p) {
    const d = p.details as { manifest: Manifest; sha: string; source: Source["source"]; source_url: string | null; settings: Record<string, unknown> };
    const m = d.manifest;
    if (await ctx.trx.selectFrom("plugin").select("id").where("name", "=", m.name).where("status", "!=", "removed").executeTakeFirst()) throw new KumiError("error.plugin_installed", { name: m.name });
    const port = m.run.mode === "local" ? await freePort(ctx.trx) : null, base = baseUrlOf(m, port);
    const roleId = await writeRole(ctx, m, null);
    // Its agent, as agent.create makes one, but its token goes to the plugin, never to whoever installs it.
    const personId = uuidv7(), grantId = uuidv7(), agentId = uuidv7(), t = newToken(), agentName = `${m.name} (plugin)`;
    await ctx.trx.insertInto("oauth_client").values({ client_id: AGENT_CLIENT, kind: "agent", name: "Club agent", redirect_uris: [] }).onConflict((oc) => oc.doNothing()).execute();
    const lang = (await ctx.trx.selectFrom("club").select("default_language").executeTakeFirst())?.default_language ?? "en";
    await ctx.insert("person", { id: personId, display_name: agentName, created_via: "agent", locale: lang });
    await ctx.insert("person_role", { id: uuidv7(), person_id: personId, role_id: roleId, location_id: null });
    await ctx.insert("oauth_grant", { id: grantId, person_id: personId, client_id: AGENT_CLIENT, scopes: ["kumi"], revoked_at: null, weekly_cap_cents: 0, powers: null, second_step: true });
    await keepToken(ctx.trx, grantId, t.hash, ctx.now);
    await ctx.insert("agent", { id: agentId, kind: "club", name: agentName, capped_role_id: roleId, acts_for_person_id: null, person_id: personId, grant_id: grantId, created_by: ctx.actor.personId,
      created_at: ctx.now, weekly_cap_cents: 0, token_last4: t.last4, token_once: null, token_once_at: null });
    // Its one webhook: the manifest's events, and word when its settings change.
    const subId = uuidv7(), whsec = `whsec_${randomBytes(32).toString("base64url")}`;
    await ctx.insert("webhook_subscription", { id: subId, url: `${base}/events`, topics: topicsOf(m), person_id: personId, agent_id: agentId, secret_sealed: sealText(whsec),
      secret_last4: whsec.slice(-4), created_by: ctx.actor.personId, created_at: ctx.now });
    const id = uuidv7(), secret = `opps_${randomBytes(32).toString("base64url")}`;
    await ctx.insert("plugin", { id, name: m.name, release: m.version, manifest: JSON.stringify(m), manifest_sha256: d.sha, source: d.source, source_url: d.source_url, mode: m.run.mode,
      base_url: base, local_port: port, status: "waiting", settings: JSON.stringify(d.settings), agent_id: agentId, role_id: roleId, subscription_id: subId,
      secret_sealed: sealText(secret), secret_last4: secret.slice(-4), registration_sealed: sealText(JSON.stringify({ token: t.token })), registration_attempts: 0,
      registration_next_at: ctx.now, installed_by: ctx.actor.personId, installed_at: ctx.now, updated_at: ctx.now });
    const missing = await askForKeys(ctx, id, m.name, m);
    await ctx.emit("plugin.installed", { plugin_id: id, by: ctx.actor.personId });
    return { plugin_id: id, name: m.name, version: m.version, mode: m.run.mode, status: "waiting", keys_needed: missing };
  },
  // A remote plugin is sent its registration straight away (it's tried again later if it isn't there): the token goes
  // to the plugin, and what comes back here, to whoever installed it, says only whether it arrived.
  async after(db, _i, result) {
    const r = result as { plugin_id: string; mode: string };
    if (r.mode !== "remote") return { ...r, next: "openpadel plugin service" };
    const sent = await deliverRegistrations(db, new Date(), r.plugin_id);
    const row = await db.selectFrom("plugin").select(["status", "registration_error"]).where("id", "=", r.plugin_id).executeTakeFirst();
    return { ...r, registered: sent.sent > 0, status: row?.status ?? "waiting", ...(row?.registration_error ? { registration_error: row.registration_error } : {}) };
  },
});

export const pluginConfigure = defineAction({
  name: "plugin.configure", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ plugin: PLUGIN_NAME, settings: z.record(z.string(), z.unknown()).check(z.describe("The settings to change, by name, as plugin info lists them (courts by name or id)")) }),
  async plan(ctx, i) {
    const { row, read, m } = await livePlugin(ctx.db, i.plugin);
    const before = (row.settings ?? {}) as Record<string, unknown>;
    const c = await checkSettings(ctx.db, m, i.settings, before);
    const same = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    if (same(c.values, before)) throw new KumiError("error.nothing_changed");
    const list = { en: c.lines.map((l) => l.en).join("; "), es: c.lines.map((l) => l.es).join("; ") };
    return { title: both("action.plugin.configure"), summary: both("plan.plugin.configure", { name: m.name, settings: list }), reads: [read], undo: { kind: "reversible" }, details: { values: c.values } };
  },
  async apply(ctx, i, p) {
    const { values } = p.details as { values: Record<string, unknown> };
    const pl = await ctx.trx.selectFrom("plugin").select(["id", "subscription_id", "name"]).where("name", "=", i.plugin).where("status", "!=", "removed").executeTakeFirstOrThrow();
    await ctx.update("plugin", pl.id, { settings: JSON.stringify(values), updated_at: ctx.now });
    // The plugin hears at once, signed like its events (it can also read them through the door: plugin_settings).
    if (pl.subscription_id) {
      const body = JSON.stringify({ id: `cfg_${uuidv7()}`, type: PLUGIN_CONFIGURED_TOPIC, created_at: ctx.now.toISOString(), data: { plugin: pl.name, settings: values } });
      await ctx.trx.insertInto("webhook_delivery").values({ subscription_id: pl.subscription_id, event_id: null, topic: PLUGIN_CONFIGURED_TOPIC, body, next_attempt_at: ctx.now }).execute();
    }
    return null;
  },
});

export const pluginUpdate = defineAction({
  name: "plugin.update", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ plugin: PLUGIN_NAME, url: installInput.url, manifest: installInput.manifest }),
  async plan(ctx, i) {
    const { row, read, m: old } = await livePlugin(ctx.db, i.plugin);
    const s = await sourceOf({ name: i.url || i.manifest ? undefined : i.plugin, url: i.url, manifest: i.manifest }), m = s.manifest;
    if (m.name !== old.name) throw new KumiError("error.plugin_other_name", { name: m.name, installed: old.name });
    if (m.run.mode !== old.run.mode) throw new KumiError("error.plugin_mode_changed", { name: m.name });
    const sha = manifestSha256(m);
    if (sha === row.manifest_sha256) throw new KumiError("error.plugin_same_version", { name: m.name, version: m.version });
    await checkManifestAtClub(ctx.db, m);
    checkRun(m);
    await withinInstaller(ctx, m);
    // Its settings carried over as far as the new schema takes them.
    const before = (row.settings ?? {}) as Record<string, unknown>, kept: Record<string, unknown> = {};
    for (const k of Object.keys(before)) if (m.settings.some((f) => f.key === k)) kept[k] = before[k];
    let values = kept;
    try { values = (await checkSettings(ctx.db, m, {}, kept)).values; } catch { /* a setting it needs now: configure says which */ }
    const diff = manifestDiff(old, m);
    const rows = [...(s.source === "catalog" ? [] : [sourceRow(s)]), { label: both("plan.plugin.row_version"), text: both("plan.plugin.version_from_to", { from: old.version, to: m.version }) },
      ...(diff.length ? diff : [{ label: both("plan.plugin.row_asks"), text: both("plan.plugin.asks_nothing_new") }])];
    const urlChanged = old.run.mode === "remote" && m.run.mode === "remote" && old.run.url !== m.run.url;
    if (urlChanged) rows.push(tokenRow(m));
    return { title: both("action.plugin.update"), summary: rowsText(both("plan.plugin.update", { name: m.name, from: old.version, to: m.version }), rows), rows, reads: [read],
      undo: { kind: "none", note: both("reason.plugin_update_back") }, details: { manifest: m, sha, source: s.source, source_url: s.source_url, settings: values, new_token: urlChanged } };
  },
  async apply(ctx, i, p) {
    const d = p.details as { manifest: Manifest; sha: string; source: Source["source"]; source_url: string | null; settings: Record<string, unknown>; new_token: boolean };
    const m = d.manifest;
    const pl = await ctx.trx.selectFrom("plugin").selectAll().where("name", "=", i.plugin).where("status", "!=", "removed").executeTakeFirstOrThrow();
    await writeRole(ctx, m, pl.role_id);
    const base = baseUrlOf(m, pl.local_port);
    if (pl.subscription_id) await ctx.update("webhook_subscription", pl.subscription_id, { topics: topicsOf(m), url: `${base}/events` });
    let registration: Record<string, unknown> = {};
    if (d.new_token && pl.agent_id) {
      // A new address gets a new token: the old one stops, and the new one goes to the new address, signed.
      const a = await ctx.trx.selectFrom("agent").select("grant_id").where("id", "=", pl.agent_id).executeTakeFirstOrThrow();
      const t = newToken();
      await ctx.trx.updateTable("oauth_token").set({ revoked_at: ctx.now }).where("grant_id", "=", a.grant_id!).where("revoked_at", "is", null).execute();
      await keepToken(ctx.trx, a.grant_id!, t.hash, ctx.now);
      await ctx.update("agent", pl.agent_id, { token_last4: t.last4 });
      registration = { registration_sealed: sealText(JSON.stringify({ token: t.token })), registration_attempts: 0, registration_next_at: ctx.now, registration_error: null, registered_at: null,
        ...(pl.status === "on" ? { status: "waiting" } : {}) };
    }
    await ctx.update("plugin", pl.id, { manifest: JSON.stringify(m), manifest_sha256: d.sha, release: m.version, source: d.source, source_url: d.source_url, base_url: base,
      settings: JSON.stringify(d.settings), updated_at: ctx.now, ...registration });
    const missing = await askForKeys(ctx, pl.id, m.name, m);
    return { plugin_id: pl.id, name: m.name, version: m.version, keys_needed: missing };
  },
  async after(db, _i, result) {
    const r = result as { plugin_id: string };
    await deliverRegistrations(db, new Date(), r.plugin_id);
    return result;
  },
});

export const pluginPause = defineAction({
  name: "plugin.pause", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ plugin: PLUGIN_NAME }),
  async plan(ctx, i) {
    const { row, read, m } = await livePlugin(ctx.db, i.plugin);
    if (row.status === "paused") throw new KumiError("error.nothing_changed");
    return { title: both("action.plugin.pause"), summary: both("plan.plugin.pause", { name: m.name }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const pl = await ctx.trx.selectFrom("plugin").select(["id", "subscription_id"]).where("name", "=", i.plugin).where("status", "!=", "removed").executeTakeFirstOrThrow();
    await ctx.update("plugin", pl.id, { status: "paused", updated_at: ctx.now });
    if (pl.subscription_id) {
      await ctx.update("webhook_subscription", pl.subscription_id, { paused_at: ctx.now, paused_why: "plugin paused" });
      await ctx.trx.updateTable("webhook_delivery").set({ status: "dropped" }).where("subscription_id", "=", pl.subscription_id).where("status", "=", "waiting").execute();
    }
    return null;
  },
});

export const pluginResume = defineAction({
  name: "plugin.resume", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ plugin: PLUGIN_NAME }),
  async plan(ctx, i) {
    const { row, read, m } = await livePlugin(ctx.db, i.plugin);
    if (row.status !== "paused") throw new KumiError("error.nothing_changed");
    return { title: both("action.plugin.resume"), summary: both("plan.plugin.resume", { name: m.name }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const pl = await ctx.trx.selectFrom("plugin").select(["id", "subscription_id", "registered_at", "registration_sealed"]).where("name", "=", i.plugin).where("status", "!=", "removed").executeTakeFirstOrThrow();
    await ctx.update("plugin", pl.id, { status: pl.registered_at && !pl.registration_sealed ? "on" : "waiting", updated_at: ctx.now });
    if (pl.subscription_id) await ctx.update("webhook_subscription", pl.subscription_id, { paused_at: null, paused_why: null, failures: 0, failing_since: null });
    return null;
  },
});

export const pluginRemove = defineAction({
  name: "plugin.remove", version: 1, wholeClub: "reason.whole_club_agents",
  input: z.object({ plugin: PLUGIN_NAME, delete_keys: z.optional(z.boolean().check(z.describe("Also delete its keys from the vault; left out, they stay there"))) }),
  async plan(ctx, i) {
    const { row, read, m } = await livePlugin(ctx.db, i.plugin);
    // Every key kept under its name in the vault (pluginVaultName), declared now or by an older version.
    const keys = (await ctx.db.selectFrom("vault_item").select("name").where("active", "=", true).where((eb) => eb(eb.fn("lower", ["name"]), "like", `${m.name}/%`)).orderBy("name").execute())
      .map((v) => ({ vault_name: v.name }));
    const names = { en: keys.map((k) => k.vault_name).join(", "), es: keys.map((k) => k.vault_name).join(", ") };
    const lines: Text[] = [both("plan.plugin.remove", { name: m.name })];
    if (keys.length) lines.push(i.delete_keys ? both("plan.plugin.remove_keys", { keys: names }) : both("plan.plugin.keep_keys", { keys: names }));
    if (row.mode === "local") lines.push(both("plan.plugin.remove_local", { name: m.name }));
    return { title: both("action.plugin.remove"), summary: { en: lines.map((l) => l.en).join(" "), es: lines.map((l) => l.es).join(" ") }, reads: [read],
      undo: { kind: "none", note: both("reason.plugin_install_again") }, details: { keys: i.delete_keys ? keys.map((k) => k.vault_name) : [] } };
  },
  async apply(ctx, i, p) {
    const pl = await ctx.trx.selectFrom("plugin").select(["id", "agent_id", "role_id"]).where("name", "=", i.plugin).where("status", "!=", "removed").executeTakeFirstOrThrow();
    if (pl.agent_id) await revokeAgentRows(ctx, pl.agent_id);
    if (pl.role_id) await ctx.update("role", pl.role_id, { active: false });
    await ctx.update("plugin", pl.id, { status: "removed", removed_at: ctx.now, updated_at: ctx.now, registration_sealed: null, registration_next_at: null });
    for (const name of (p.details as { keys: string[] }).keys) {
      const v = await ctx.trx.selectFrom("vault_item").select("id").where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase())).where("active", "=", true).executeTakeFirst();
      if (v) await ctx.update("vault_item", v.id, { active: false, updated_at: ctx.now });
    }
    await ctx.emit("plugin.removed", { plugin_id: pl.id, by: ctx.actor.personId });
    return null;
  },
});

// ---- Registration ----
/** The registration a plugin is sent: the door and its token, the secrets that sign what it's sent, and its settings. */
async function registrationBody(db: Db, pluginId: string, token: string, now: Date): Promise<string> {
  const p = await db.selectFrom("plugin").leftJoin("webhook_subscription", "webhook_subscription.id", "plugin.subscription_id")
    .select(["plugin.id", "plugin.name", "plugin.release", "plugin.settings", "plugin.secret_sealed", "webhook_subscription.secret_sealed as whsec"]).where("plugin.id", "=", pluginId).executeTakeFirstOrThrow();
  const club = await db.selectFrom("club").select(["name", "default_language", "time_zone"]).executeTakeFirst();
  const base = io.publicUrl.replace(/\/+$/, "");
  return JSON.stringify({ type: REGISTER_TOPIC, id: p.id, sent_at: now.toISOString(),
    club: { name: club?.name ?? "", url: base, language: club?.default_language ?? "en", time_zone: club?.time_zone ?? "UTC", key_url: `${base}/.well-known/openpadel-plugin-key` },
    plugin: { name: p.name, version: p.release },
    door: { mcp: `${base}/mcp`, token },
    webhooks: { secret: p.whsec ? openText(p.whsec) : null, signature_header: "openpadel-signature" },
    hooks: { url: `${base}/plugins/${p.name}/hook`, secret: openText(p.secret_sealed), signature_header: "openpadel-signature" },
    settings: p.settings ?? {} });
}
/** Sends remote plugins their registrations that are due (or one plugin's now), each signed with the club's key; one
 *  that arrives (2xx) is cleared, so the token is kept nowhere but as a hash. Tried again with waits that double. */
export async function deliverRegistrations(db: Db, now = new Date(), only?: string): Promise<{ sent: number; failed: number }> {
  const due = await db.selectFrom("plugin").select(["id", "base_url", "registration_sealed", "registration_attempts", "status"]).where("registration_sealed", "is not", null).where("mode", "=", "remote")
    .where("status", "in", ["waiting", "on"]).$if(Boolean(only), (q) => q.where("id", "=", only!)).$if(!only, (q) => q.where("registration_next_at", "<=", now)).limit(20).execute();
  let sent = 0, failed = 0;
  for (const p of due) {
    let token: string;
    try { token = (JSON.parse(openText(p.registration_sealed!)) as { token: string }).token; } catch { continue; }
    const body = await registrationBody(db, p.id, token, now), t = Math.floor(now.getTime() / 1000);
    const headers = { "content-type": "application/json", "user-agent": "openPadel-Plugins/1", "openpadel-event": REGISTER_TOPIC, "openpadel-signature-ed25519": await signForPlugin(db, body, t) };
    let error: string | null = null;
    try { const r = await io.post(`${p.base_url}/register`, body, headers); if (r.status < 200 || r.status > 299) error = `HTTP ${r.status}`; }
    catch (e) { error = rawError(e); }
    if (!error) {
      sent++;
      await db.updateTable("plugin").set({ registration_sealed: null, registration_next_at: null, registration_error: null, registered_at: now }).where("id", "=", p.id).execute();
      await db.updateTable("plugin").set({ status: "on" }).where("id", "=", p.id).where("status", "=", "waiting").execute();
    } else {
      failed++;
      const n = p.registration_attempts + 1;
      await db.updateTable("plugin").set({ registration_attempts: n, registration_error: error, registration_next_at: new Date(now.getTime() + Math.min(backoffMs(n), 3600_000)) }).where("id", "=", p.id).execute();
    }
  }
  return { sent, failed };
}
/** A local plugin's environment, for its service on the server (`openpadel plugin service`): its token is handed over
 *  once, then cleared; asked again, it's a new token (the old one stops). */
export async function localPluginEnv(db: Db, name: string, now = new Date()): Promise<Record<string, string>> {
  const p = await db.selectFrom("plugin").selectAll().where("name", "=", name).where("status", "!=", "removed").executeTakeFirst();
  if (!p) throw new KumiError("error.plugin_not_installed", { name }, 404);
  if (p.mode !== "local") throw new KumiError("error.plugin_not_local", { name });
  let token: string;
  if (p.registration_sealed) token = (JSON.parse(openText(p.registration_sealed)) as { token: string }).token;
  else {
    const a = await db.selectFrom("agent").select("grant_id").where("id", "=", p.agent_id!).executeTakeFirstOrThrow();
    const t = newToken();
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("oauth_token").set({ revoked_at: now }).where("grant_id", "=", a.grant_id!).where("revoked_at", "is", null).execute();
      await keepToken(trx, a.grant_id!, t.hash, now);
      await trx.updateTable("agent").set({ token_last4: t.last4 }).where("id", "=", p.agent_id!).execute();
    });
    token = t.token;
  }
  const body = JSON.parse(await registrationBody(db, p.id, token, now)) as { door: { mcp: string }; webhooks: { secret: string }; hooks: { secret: string }; club: { url: string } };
  await db.updateTable("plugin").set({ registration_sealed: null, registration_next_at: null, registration_error: null, registered_at: now }).where("id", "=", p.id).execute();
  await db.updateTable("plugin").set({ status: "on" }).where("id", "=", p.id).where("status", "=", "waiting").execute();
  return { PORT: String(p.local_port), OPENPADEL_URL: body.club.url, OPENPADEL_MCP: body.door.mcp, OPENPADEL_TOKEN: token, OPENPADEL_WEBHOOK_SECRET: body.webhooks.secret ?? "",
    OPENPADEL_HOOK_SECRET: body.hooks.secret, OPENPADEL_PLUGIN: p.name };
}

// ---- Errors in words ----
/** What went wrong reaching a plugin, as kept for the logs and `doctor --json`: the cause's code when there is one
 *  (fetch's "fetch failed" hides it there). */
export function rawError(e: unknown): string {
  const c = (e as { cause?: { code?: string; message?: string } })?.cause;
  return String(c?.code ? `${c.code}: ${c.message ?? ""}`.trim() : (e as Error)?.message ?? e).slice(0, 200);
}
/** The same in plain words for staff, in both languages: can't find the address, refused, too slow, its certificate,
 *  an error status, an answer that made no sense, an address the club won't call; anything else, a plain sentence. */
export function problemText(raw: string | null | undefined, host: string): Text {
  const r = raw ?? "", status = /\bHTTP (\d{3})\b/.exec(r)?.[1];
  if (status) return both("plugin.problem_http", { host, status });
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo/i.test(r)) return both("plugin.problem_dns", { host });
  if (/ECONNREFUSED/.test(r)) return both("plugin.problem_refused", { host });
  if (/took longer|timed? ?out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|aborted/i.test(r)) return both("plugin.problem_timeout", { host });
  if (/CERT|certificate|TLS|SSL|self[- ]signed|ERR_TLS/i.test(r)) return both("plugin.problem_tls", { host });
  if (/isn't a public address|https only|ENOTPUBLIC/.test(r)) return both("plugin.problem_not_public", { host });
  if (/ECONNRESET|socket hang up|UND_ERR_SOCKET|EPIPE/i.test(r)) return both("plugin.problem_hung_up", { host });
  if (/too large|JSON|Unexpected token|not an address/i.test(r)) return both("plugin.problem_bad_answer", { host });
  return both("plugin.problem_other", { host });
}

// ---- Inbound hooks ----
/** Where a message that arrived at /plugins/<name>/hook goes, signed with the plugin's own secret; null when the plugin
 *  isn't installed and on, or declares no hook. */
export async function hookTarget(db: Db, name: string): Promise<{ url: string; sign: (body: Buffer, t: number) => string; local: boolean } | null> {
  const p = await db.selectFrom("plugin").select(["base_url", "manifest", "secret_sealed", "mode"]).where("name", "=", name).where("status", "=", "on").executeTakeFirst();
  if (!p || !p.base_url || !manifestOf(p).hook) return null;
  const secret = openText(p.secret_sealed);
  // The webhooks' signature (webhooks.ts) over the bytes exactly as they came: "<t>." then the body.
  return { url: `${p.base_url}/hook`, sign: (body, t) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.`, "utf8").update(body).digest("hex")}`, local: p.mode === "local" };
}

// ---- Reads ----
/** A plugin in words, for plugin info and the staff list: what it does, asks, sends, needs and costs, and its settings. */
export function pluginCard(m: Manifest, lang: Lang) {
  const rows = manifestRows(m);
  return { name: m.name, publisher: m.publisher, version: m.version, homepage: m.homepage, licence: m.licence, description: m.description[lang], mode: m.run.mode,
    can: m.grants.length ? grantsText(m.grants)[lang] : both("plan.plugin.no_actions")[lang], reads: areasText(readsOf(m))[lang], events: m.events,
    sends: m.data_out[lang], cost: { charges: m.cost.charges, note: m.cost.note[lang] }, runs: runText(m)[lang], cards: m.cards.map((c) => ({ slot: c.slot, title: c.title[lang] })),
    keys: m.secrets.map((s) => ({ name: s.name, label: s.label[lang], where: s.where[lang] })), hook: m.hook ? m.hook.from[lang] : null,
    settings: m.settings.map((f) => ({ key: f.key, type: f.type, label: f.label[lang], help: f.help?.[lang] ?? null, required: "required" in f ? Boolean(f.required) : false,
      default: "default" in f ? f.default ?? null : null, choices: f.type === "choice" ? f.choices.map((c) => ({ value: c.value, label: c.label[lang] })) : undefined })),
    words: rows.map((r) => ({ label: r.label[lang], text: r.text[lang] })) };
}
/** Every plugin the club has (removed ones last, for a while), for the staff list and `openpadel plugin list`. */
export async function clubPlugins(db: Db | Trx, lang: Lang) {
  const rows = await db.selectFrom("plugin").leftJoin("person", "person.id", "plugin.installed_by").leftJoin("webhook_subscription as s", "s.id", "plugin.subscription_id")
    .leftJoin("agent", "agent.id", "plugin.agent_id")
    .select(["plugin.id", "plugin.name", "plugin.release", "plugin.status", "plugin.mode", "plugin.source", "plugin.source_url", "plugin.base_url", "plugin.manifest", "plugin.settings",
      "plugin.installed_at", "plugin.removed_at", "plugin.registered_at", "plugin.registration_error", "plugin.registration_attempts", "person.display_name as installed_by",
      "s.last_ok_at as last_event_at", "s.last_error as event_error", "s.paused_at as events_paused_at", "agent.last_used_at", "agent.token_last4"])
    .where((w) => w.or([w("plugin.status", "!=", "removed"), w("plugin.removed_at", ">", new Date(Date.now() - 30 * 864e5))]))
    .orderBy("plugin.removed_at", "desc").orderBy("plugin.name").execute();
  const out = [];
  for (const r of rows) {
    const m = manifestOf(r);
    out.push({ ...pluginCard(m, lang), id: r.id, name: r.name, version: r.release, status: r.status, mode: r.mode, source: r.source,
      source_host: r.source_url ? (() => { try { return new URL(r.source_url!).host; } catch { return r.source_url; } })() : null,
      address: r.mode === "remote" && r.base_url ? new URL(r.base_url).host : r.base_url, installed_at: r.installed_at, installed_by: r.installed_by, removed_at: r.removed_at,
      registered_at: r.registered_at, registration_error: r.registration_error,
      registration_problem: r.registration_error ? problemText(r.registration_error, hostOf(r.base_url))[lang] : null,
      last_event_at: r.last_event_at, event_error: r.event_error, event_problem: r.event_error ? problemText(r.event_error, hostOf(r.base_url))[lang] : null, last_used_at: r.last_used_at, token_last4: r.token_last4,
      settings_values: r.settings, keys: (await pluginSecrets(db, r.name, m)).map((k) => ({ name: k.name, vault_name: k.vault_name, label: k.label[lang], where: k.where[lang], added: k.added, last4: k.last4 })) });
  }
  return out;
}
/** What the owner's vault page shows as requests: each installed plugin's keys that aren't there yet ("asked for by"). */
export async function pluginKeyRequests(db: Db | Trx, lang: Lang) {
  const rows = await db.selectFrom("plugin").leftJoin("person", "person.id", "plugin.installed_by").select(["plugin.name", "plugin.manifest", "plugin.installed_at", "person.display_name as by"])
    .where("plugin.status", "!=", "removed").orderBy("plugin.installed_at").execute();
  const out = [];
  for (const r of rows) {
    const m = manifestOf(r);
    const missing = (await pluginSecrets(db, r.name, m)).filter((s) => !s.added);
    if (missing.length) out.push({ plugin: r.name, by: r.by, asked_at: r.installed_at, why: m.description[lang], can: m.grants.length ? grantsText(m.grants)[lang] : null,
      keys: missing.map((s) => ({ name: s.name, vault_name: s.vault_name, label: s.label[lang], where: s.where[lang] })) });
  }
  return out;
}

/** The outside services that see member data (docs/processors.md), with each installed plugin's data out added as it's
 *  installed: for the privacy policy's list, in the reader's language and as Markdown rows. */
export async function processors(db: Db | Trx, lang: Lang) {
  const builtIn = (["stripe", "resend", "twilio", "push", "typesafe", "anthropic", "assistants", "offsite"] as const).map((k) => ({
    service: both(`processor.${k}.service` as Key)[lang], when: both(`processor.${k}.when` as Key)[lang], gets: both(`processor.${k}.gets` as Key)[lang], plugin: null as string | null }));
  const plugins = await db.selectFrom("plugin").select(["name", "manifest", "base_url", "mode"]).where("status", "!=", "removed").orderBy("name").execute();
  const fromPlugins = plugins.map((p) => {
    const m = manifestOf(p);
    return { service: both("processor.plugin_service", { publisher: m.publisher, name: m.name })[lang], when: m.description[lang], gets: m.data_out[lang], plugin: m.name };
  });
  const rows = [...builtIn, ...fromPlugins];
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = both("processor.table_head")[lang];
  const markdown = [head, "|---|---|---|", ...rows.map((r) => `| ${cell(r.service)} | ${cell(r.when)} | ${cell(r.gets)} |`)].join("\n");
  return { rows, markdown };
}
