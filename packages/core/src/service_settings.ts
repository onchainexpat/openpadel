// A club service's settings set in the app: the owner pastes a key on its card (Settings, Connectors) or their agent
// pipes it in (`openpadel connect <service> --set FIELD --from-stdin`), and it's kept in the vault (vault.ts), sealed
// with the server's key, the vault item naming the setting it is. One reader for every setting a service needs:
// the settings file (OPENPADEL_X, else KUMI_X: settings.ts) when it has a value, so a server set up before keeps
// working and the owner can pin one there; else the vault. Never a value back to a browser or an agent: the card,
// doctor and a preview say "set, ending 4f2a" and where it's from.
import * as z from "zod/mini";
import { both, type Key, type Text } from "@kumi/i18n";
import { defineAction, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { openBytes } from "./sealed.ts";
import { setting, settingName, shortName, type Env } from "./settings.ts";
import { stageVaultUpload, VAULT_UPLOAD_MINUTES } from "./vault.ts";

/** One thing a service needs. `secret`: shown only by its last four characters, ever; a plain one (an address, an
 *  account's id) is shown as it is. `check`: what a value must look like, so a wrong paste is caught before it's kept
 *  (the words say what was expected, never what was pasted). */
export interface ServiceField { field: string; setting: string; secret: boolean; needed: boolean; check?: RegExp; expect?: Key }
export interface Service { key: string; fields: ServiceField[] }

const f = (field: string, s: string, secret: boolean, needed: boolean, check?: RegExp, expect?: Key): ServiceField => ({ field, setting: s, secret, needed, ...(check ? { check, expect } : {}) });
/** The services an owner can set up in the app, in Connectors' order. The two keys the owner keeps in a password
 *  manager (OPENPADEL_SECRET_KEY, which seals the vault, and OPENPADEL_BACKUP_KEY, which opens the backups the vault
 *  is in) stay in the settings file alone: a vault that held the key to itself would lock with it. */
export const SERVICES: Service[] = [
  { key: "stripe", fields: [f("secret_key", "STRIPE_SECRET_KEY", true, true, /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/, "service.expect.stripe_secret"),
    f("publishable_key", "STRIPE_PUBLISHABLE_KEY", false, true, /^pk_(test|live)_[A-Za-z0-9]{10,}$/, "service.expect.stripe_publishable"),
    f("webhook_secret", "STRIPE_WEBHOOK_SECRET", true, false, /^whsec_[A-Za-z0-9+/=]{10,}$/, "service.expect.whsec")] },
  { key: "resend", fields: [f("api_key", "RESEND_API_KEY", true, true, /^re_[A-Za-z0-9_]{8,}$/, "service.expect.resend_key"),
    f("from", "MAIL_FROM", false, true, /^([^<>@\r\n]{1,80} <[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>|[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+)$/, "service.expect.mail_from"),
    f("webhook_secret", "RESEND_WEBHOOK_SECRET", true, false, /^whsec_[A-Za-z0-9+/=]{10,}$/, "service.expect.whsec")] },
  { key: "twilio", fields: [f("account_sid", "TWILIO_ACCOUNT_SID", false, true, /^AC[0-9a-f]{32}$/, "service.expect.twilio_sid"),
    f("auth_token", "TWILIO_AUTH_TOKEN", true, true, /^[0-9a-f]{32}$/, "service.expect.twilio_token"),
    f("sender", "TWILIO_MESSAGING_SERVICE_SID", false, false, /^MG[0-9a-f]{32}$/, "service.expect.twilio_sender")] },
  { key: "playtomic", fields: [f("client_id", "PLAYTOMIC_CLIENT_ID", false, true, /^[\w.-]{4,200}$/, "service.expect.plain_id"),
    f("secret", "PLAYTOMIC_SECRET", true, true, /^\S{8,}$/, "service.expect.no_spaces"),
    f("tenant_id", "PLAYTOMIC_TENANT_ID", false, true, /^[\w-]{4,100}$/, "service.expect.plain_id")] },
  { key: "offsite", fields: [f("endpoint", "OFFSITE_ENDPOINT", false, true, /^https:\/\/[^\s/]+(\/\S*)?$/, "service.expect.https"),
    f("bucket", "OFFSITE_BUCKET", false, true, /^[a-z0-9][a-z0-9.-]{1,62}$/, "service.expect.bucket"),
    f("key_id", "OFFSITE_ACCESS_KEY_ID", false, true, /^[\w-]{8,200}$/, "service.expect.plain_id"),
    f("secret", "OFFSITE_SECRET_ACCESS_KEY", true, true, /^\S{16,}$/, "service.expect.no_spaces")] },
  { key: "ai", fields: [f("typesafe_api_key", "TYPESAFE_API_KEY", true, false, /^\S{12,}$/, "service.expect.no_spaces"),
    f("anthropic_api_key", "ANTHROPIC_API_KEY", true, false, /^sk-ant-\S{8,}$/, "service.expect.anthropic_key")] },
];
export const SERVICE_KEYS = SERVICES.map((s) => s.key) as [string, ...string[]];
export const serviceOf = (key: string): Service => {
  const s = SERVICES.find((x) => x.key === key);
  if (!s) throw new KumiError("error.service_unknown", { service: key }, 404);
  return s;
};
export const fieldOf = (service: Service, field: string): ServiceField => {
  const x = service.fields.find((y) => y.field === field || settingName(y.setting) === field || y.setting === shortName(field));
  if (!x) throw new KumiError("error.service_field_unknown", { field, fields: service.fields.map((y) => y.field).join(", ") }, 400);
  return x;
};
/** Every setting the app can hold (short names): the reader looks only these up in the vault. */
const IN_APP = new Set(SERVICES.flatMap((s) => s.fields.map((x) => x.setting)));

// ---- The reader ----
// The vault's values, read at most every 30 seconds by each process: a change made in this process (the form, the
// command line on the server) is seen at once, since its apply forgets them; one made by another process (the
// server's `openpadel connect`) within the half minute.
const KEEP_MS = 30_000;
// Kept per database (a test or a restore check may open another).
let kept = new WeakMap<object, { at: number; values: Map<string, string> }>();
const listeners = new Set<() => void>();
/** Forget what was read, so the next read asks the vault again (after a set or a remove, and in tests). */
export function forgetServiceSettings(): void { kept = new WeakMap(); for (const l of listeners) l(); }
/** Told whenever the settings may have changed in this process: the server uses it to look again at once. */
export function onServiceSettingsChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

async function vaultValues(db: Db | Trx, now = Date.now()): Promise<Map<string, string>> {
  const k = kept.get(db);
  if (k && now - k.at < KEEP_MS) return k.values;
  const rows = await db.selectFrom("vault_item").innerJoin("vault_blob", "vault_blob.id", "vault_item.blob_id").select(["vault_item.setting", "vault_blob.bytes"])
    .where("vault_item.active", "=", true).where("vault_item.setting", "is not", null).execute();
  const values = new Map<string, string>();
  for (const r of rows) {
    try { values.set(shortName(r.setting!), openBytes(r.bytes).toString("utf8")); } catch { /* sealed under a key this server doesn't have: doctor says so */ }
  }
  kept.set(db, { at: now, values });
  return values;
}

export type SettingSource = "server" | "app" | null;
/** A service's setting and where it's from: the settings file ("server") when it has a value, else the app ("app"). */
export async function serviceSetting(db: Db | Trx, name: string, env: Env = process.env): Promise<{ value: string | undefined; source: SettingSource }> {
  const file = setting(name, env);
  if (file?.trim()) return { value: file, source: "server" };
  if (!IN_APP.has(shortName(name))) return { value: file, source: null };
  const v = (await vaultValues(db)).get(shortName(name));
  return v ? { value: v, source: "app" } : { value: file, source: null };
}
/** The settings as the services read them: the environment, with what the app holds filled in under the new names
 *  wherever the file has nothing. Everything that takes an `env` (doctor, Twilio, offsite, the answerer) reads this. */
export async function serviceEnv(db: Db | Trx, env: Env = process.env): Promise<Env> {
  const values = await vaultValues(db).catch(() => new Map<string, string>());
  const out: Env = { ...env };
  for (const [s, v] of values) if (!setting(s, env)?.trim()) out[settingName(s)] = v;
  return out;
}

/** What a setting is shown as: a secret by its last four (when it's long enough to keep them hidden), a plain one in full. */
export function shownAs(field: Pick<ServiceField, "secret">, value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (!field.secret) return v;
  return v.length >= 12 ? v.slice(-4) : null;
}
/** A service's settings, for its card, doctor and an agent: each one set or not, where from, and shown as above. */
export async function serviceStatus(db: Db | Trx, key: string, env: Env = process.env) {
  const s = serviceOf(key);
  return Promise.all(s.fields.map(async (x) => {
    const { value, source } = await serviceSetting(db, x.setting, env);
    const shown = shownAs(x, value);
    return { field: x.field, name: settingName(x.setting), secret: x.secret, needed: x.needed, set: Boolean(value?.trim()), source: value?.trim() ? source : null,
      last4: x.secret ? shown : null, value: x.secret ? null : shown };
  }));
}

// ---- Putting a value in: the form and the command line send it here first ----
/** Whether the club is still practising: outside production, or with OPENPADEL_PRACTICE=1. A live Stripe key waits
 *  for go-live, as on the server. */
export const practising = (env: Env = process.env) => env.NODE_ENV !== "production" || setting("PRACTICE", env) === "1";
/** A value for a service's setting, checked and sealed into the vault's waiting room (vault.ts): its upload is what
 *  vault.service_set names, so no value is ever in an action's input, a preview or the change log. */
export async function stageServiceValue(db: Db, personId: string, service: string, field: string, raw: string, o: { env?: Env; now?: Date } = {}) {
  const x = fieldOf(serviceOf(service), field), value = raw.replace(/^\s+|\s+$/g, "");
  if (!value) throw new KumiError("error.vault_empty", {}, 400);
  if (x.check && !x.check.test(value)) throw new KumiError("error.service_value_shape", { setting: settingName(x.setting), expect: both(x.expect!) }, 400);
  if (service === "stripe" && /_live_/.test(value) && practising(o.env)) throw new KumiError("error.service_live_in_practice", {}, 409);
  const up = await stageVaultUpload(db, personId, { kind: "secret", value }, o.now);
  return { upload_id: up.upload_id, field: x.field, name: settingName(x.setting), shown: shownAs(x, value) };
}

// ---- The actions ----
const owner = async (ctx: PlanCtx) => {
  // The vault's rule: the owner, never an agent; the server's own command line acts as the system, as root there.
  if (ctx.actor.agentId) throw new KumiError("error.vault_not_for_agents", {}, 403);
  if (ctx.actor.auth === "system") return;
  const o = ctx.actor.personId ? await ctx.db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
    .where("person_role.person_id", "=", ctx.actor.personId).where("person_role.active", "=", true).where("role.key", "=", "owner").executeTakeFirst() : null;
  if (!o) throw new KumiError("error.service_owner_only", {}, 403);
};
const serviceName = (key: string): Text => both(`connector.${key}.name` as Key);
const fieldName = (key: string, field: string): Text => both(`service.field.${key}.${field}` as Key);
const list = (xs: Text[]): Text => ({ en: xs.map((x) => x.en).join("; "), es: xs.map((x) => x.es).join("; ") });
/** A preview's words and, when there's more to say, that after them. */
const also = (a: Text, b: Text | null): Text => b ? { en: `${a.en} ${b.en}`, es: `${a.es} ${b.es}` } : a;
/** Whose the settings file still has a value for, which wins over the app's (said in the preview). */
const pinned = (fields: ServiceField[]) => fields.filter((x) => setting(x.setting)?.trim()).map((x) => settingName(x.setting));

/** Waiting uploads, by the person who sent them (or the system's, sent by the server's command line). */
async function uploadsFor(ctx: PlanCtx, ids: string[]) {
  const rows = await ctx.db.selectFrom("vault_blob").select(["id", "kind", "last4", "created_by", "created_at", "attached_at", "bytes"]).where("id", "in", ids).execute();
  for (const id of ids) {
    const b = rows.find((r) => r.id === id);
    if (!b || b.attached_at || b.kind !== "secret" || (b.created_by ?? null) !== (ctx.actor.personId ?? null) || ctx.now.getTime() - new Date(b.created_at).getTime() > VAULT_UPLOAD_MINUTES * 60_000)
      throw new KumiError("error.vault_upload_gone");
  }
  return rows;
}

export const serviceSet = defineAction({
  name: "vault.service_set", version: 1, strongAuth: true,
  input: z.object({ service: z.enum(SERVICE_KEYS), values: z.array(z.object({ field: z.string().check(z.minLength(1), z.maxLength(80)), upload_id: z.uuid() })).check(z.minLength(1), z.maxLength(8)) }),
  async plan(ctx, i) {
    await owner(ctx);
    const s = serviceOf(i.service), fields = i.values.map((v) => fieldOf(s, v.field));
    if (new Set(fields.map((x) => x.field)).size !== fields.length) throw new KumiError("error.invalid_input");
    const ups = await uploadsFor(ctx, i.values.map((v) => v.upload_id));
    const what = fields.map((x, n) => {
      const b = ups.find((u) => u.id === i.values[n]!.upload_id)!;
      // A plain setting is said as it is (an address isn't a secret); a secret by its last four only.
      const shown = x.secret ? (b.last4 ? both("plan.vault.secret_ending", { last4: b.last4 }) : both("plan.vault.secret_short")) : { en: openBytes(b.bytes).toString("utf8"), es: openBytes(b.bytes).toString("utf8") };
      return both("plan.service.one", { field: fieldName(s.key, x.field), what: shown });
    });
    const still = pinned(fields);
    return { title: both("action.vault.service_set"), summary: also(both("plan.service.set", { service: serviceName(s.key), what: list(what) }), still.length ? both("plan.service.file_wins", { names: still.join(", ") }) : null),
      reads: [], undo: { kind: "reversible" }, details: { service: s.key, fields: fields.map((x) => settingName(x.setting)) } };
  },
  async apply(ctx, i) {
    const s = serviceOf(i.service);
    for (const v of i.values) {
      const x = fieldOf(s, v.field), name = settingName(x.setting);
      const b = await ctx.trx.updateTable("vault_blob").set({ attached_at: ctx.now }).where("id", "=", v.upload_id).where("attached_at", "is", null).returning(["size_bytes", "last4"]).executeTakeFirst();
      if (!b) throw new KumiError("error.vault_upload_gone");
      const was = await ctx.trx.selectFrom("vault_item").select("id").where("setting", "=", name).where("active", "=", true).executeTakeFirst();
      if (was) await ctx.update("vault_item", was.id, { blob_id: v.upload_id, last4: x.secret ? b.last4 : null, size_bytes: b.size_bytes, updated_at: ctx.now });
      else {
        // The vault's names are the owner's too: one they kept by hand under this name is now this setting.
        const named = await ctx.trx.selectFrom("vault_item").select("id").where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase())).where("active", "=", true).executeTakeFirst();
        if (named) await ctx.update("vault_item", named.id, { setting: name, blob_id: v.upload_id, last4: x.secret ? b.last4 : null, size_bytes: b.size_bytes, updated_at: ctx.now });
        else await ctx.insert("vault_item", { id: uuidv7(), kind: "secret", name, note: null, setting: name, blob_id: v.upload_id, last4: x.secret ? b.last4 : null, filename: null, content_type: null,
          size_bytes: b.size_bytes, created_by: ctx.actor.personId, created_at: ctx.now, updated_at: ctx.now });
      }
    }
    forgetServiceSettings();
    return { service: s.key, set: i.values.map((v) => fieldOf(s, v.field).field) };
  },
  // And again once it's saved, so nothing read meanwhile keeps the value before.
  async after(_db, _i, result) { forgetServiceSettings(); return result; },
});

export const serviceRemove = defineAction({
  name: "vault.service_remove", version: 1, strongAuth: true,
  input: z.object({ service: z.enum(SERVICE_KEYS), fields: z.optional(z.array(z.string().check(z.minLength(1), z.maxLength(80))).check(z.maxLength(8))) }),
  async plan(ctx, i) {
    await owner(ctx);
    const s = serviceOf(i.service), fields = i.fields?.length ? i.fields.map((x) => fieldOf(s, x)) : s.fields;
    const held = await ctx.db.selectFrom("vault_item").select(["id", "setting"]).where("active", "=", true).where("setting", "in", fields.map((x) => settingName(x.setting))).execute();
    if (!held.length) throw new KumiError("error.service_nothing_in_app", { service: serviceName(s.key) }, 409);
    const named = fields.filter((x) => held.some((h) => h.setting === settingName(x.setting)));
    const still = pinned(named);
    return { title: both("action.vault.service_remove"), summary: also(both("plan.service.remove", { service: serviceName(s.key), what: list(named.map((x) => fieldName(s.key, x.field))) }), still.length ? both("plan.service.file_still", { names: still.join(", ") }) : null),
      reads: [], undo: { kind: "reversible" }, details: { service: s.key, fields: named.map((x) => settingName(x.setting)) } };
  },
  async apply(ctx, i) {
    const s = serviceOf(i.service), fields = i.fields?.length ? i.fields.map((x) => fieldOf(s, x)) : s.fields;
    const held = await ctx.trx.selectFrom("vault_item").select("id").where("active", "=", true).where("setting", "in", fields.map((x) => settingName(x.setting))).execute();
    for (const h of held) await ctx.update("vault_item", h.id, { active: false, updated_at: ctx.now });
    forgetServiceSettings();
    return { service: s.key, removed: held.length };
  },
  async after(_db, _i, result) { forgetServiceSettings(); return result; },
});

// ---- A link straight to a service's form, for the owner (`openpadel connect <service> --link`) ----
export const CONNECTOR_LINK_MINUTES = 15;
export async function makeConnectorLink(db: Db, personId: string | null, service: string, o: { now?: Date; hash: (token: string) => string; token: string }) {
  serviceOf(service);
  const now = o.now ?? new Date();
  // Made on the server as root, the link is for the club's owner (the first one, as setup's).
  const pid = personId ?? (await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.person_id")
    .where("role.key", "=", "owner").where("person_role.active", "=", true).orderBy("person_role.id").executeTakeFirst())?.person_id;
  if (!pid) throw new KumiError("error.service_owner_only", {}, 403);
  const expires = new Date(now.getTime() + CONNECTOR_LINK_MINUTES * 60_000);
  await db.insertInto("connector_link").values({ id: uuidv7(now.getTime()), service, person_id: pid, token_hash: o.hash(o.token), expires_at: expires }).execute();
  return { expires_at: expires };
}
/** The service a link opens, for an owner signed in, while it hasn't run out. */
export async function connectorLinkService(db: Db, tokenHash: string, now = new Date()): Promise<string | null> {
  const r = await db.selectFrom("connector_link").select(["service"]).where("token_hash", "=", tokenHash).where("expires_at", ">", now).executeTakeFirst();
  return r?.service ?? null;
}
