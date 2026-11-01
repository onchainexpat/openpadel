// Two-step sign-in. A passkey is both steps by itself; otherwise the emailed code is followed by a code from
// an authenticator app, or a recovery code. Who must: owners, managers and anyone holding a role the club
// made (the default), or every staff role; and anyone who chose to set an authenticator up.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction, readRow } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { matchStep, newRecoveryCode, RECOVERY_CODES } from "./totp.ts";

export type TwoFactorRule = "owner_manager" | "all_staff" | "off";
export const SETUP_MINUTES = 15;

/** The roles a person holds, by key, with whether each is one the club made. */
async function rolesOf(db: Db | Trx, personId: string) {
  return db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(["role.key", "role.system"])
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).where("role.active", "=", true).execute();
}

export async function activeFactor(db: Db | Trx, personId: string) {
  return (await db.selectFrom("staff_factor").selectAll().where("person_id", "=", personId).where("removed_at", "is", null).executeTakeFirst()) ?? null;
}

/** Whether this person has to give a second step at sign-in. */
export async function needsTwoFactor(db: Db | Trx, personId: string): Promise<boolean> {
  if (await activeFactor(db, personId)) return true;   // they chose it: an authenticator always counts
  const club = await db.selectFrom("club").select("two_factor").executeTakeFirst();
  const rule = (club?.two_factor ?? "owner_manager") as TwoFactorRule;
  if (rule === "off") return false;
  const roles = await rolesOf(db, personId);
  if (rule === "all_staff") return roles.some((r) => r.key !== "member");
  return roles.some((r) => r.key === "owner" || r.key === "manager" || !r.system);
}

/** Whether they have something to give as the second step: a passkey or an authenticator. */
export async function hasSecondFactor(db: Db | Trx, personId: string): Promise<boolean> {
  if (await activeFactor(db, personId)) return true;
  return Boolean(await db.selectFrom("passkey").select("credential_id").where("person_id", "=", personId).where("revoked_at", "is", null).executeTakeFirst());
}

/** The authenticator code given at sign-in: checked, and its time step kept so it can't be used again. */
export async function useAuthenticatorCode(db: Db, personId: string, code: string, now: Date): Promise<boolean> {
  const f = await activeFactor(db, personId);
  if (!f) return false;
  const step = matchStep(f.secret, code, now, Number(f.last_step));
  if (step === null) return false;
  // Only one request can move the step forward: a second use of the same code finds it already there.
  const moved = await db.updateTable("staff_factor").set({ last_step: String(step) }).where("person_id", "=", personId).where("last_step", "<", String(step)).executeTakeFirst();
  return Number(moved.numUpdatedRows) === 1;
}

// ---- Recovery codes: slow hashes (scrypt, salted), since there are only so many codes ----
const hashCode = (code: string, salt: Buffer) => scryptSync(code.trim().toLowerCase().replace(/[^a-z0-9]/g, ""), salt, 32, { N: 1 << 14 });
function packCode(code: string): string { const salt = randomBytes(16); return `${salt.toString("base64url")}.${hashCode(code, salt).toString("base64url")}`; }
function codeMatches(code: string, packed: string): boolean {
  const [salt, hash] = packed.split(".");
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, "base64url"), got = hashCode(code, Buffer.from(salt, "base64url"));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Ten new recovery codes, replacing any left. Shown once: only the hashes are kept, and never in the change log. */
export async function makeRecoveryCodes(db: Db | Trx, personId: string, now: Date): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  await db.updateTable("recovery_code").set({ used_at: now }).where("person_id", "=", personId).where("used_at", "is", null).execute();
  await db.insertInto("recovery_code").values(codes.map((c) => ({ id: uuidv7(now.getTime()), person_id: personId, code_hash: packCode(c) }))).execute();
  return codes;
}
export async function recoveryLeft(db: Db | Trx, personId: string): Promise<number> {
  return Number((await db.selectFrom("recovery_code").select((eb) => eb.fn.countAll<string>().as("n")).where("person_id", "=", personId).where("used_at", "is", null).executeTakeFirstOrThrow()).n);
}
/** A recovery code given at sign-in: used once. */
export async function useRecoveryCode(db: Db, personId: string, code: string, now: Date): Promise<boolean> {
  const left = await db.selectFrom("recovery_code").select(["id", "code_hash"]).where("person_id", "=", personId).where("used_at", "is", null).execute();
  const hit = left.find((r) => codeMatches(code, r.code_hash));
  if (!hit) return false;
  const used = await db.updateTable("recovery_code").set({ used_at: now }).where("id", "=", hit.id).where("used_at", "is", null).executeTakeFirst();
  return Number(used.numUpdatedRows) === 1;
}

// ---- The actions ----

/** Setting up an authenticator: the first code proves the app has the secret. The secret comes from the
 *  set-up waiting in auth_challenge, so it's never in the action's input; the change log leaves it out. */
export const factorAdd = defineAction({
  name: "person.factor_add", version: 1, internal: true,
  input: z.object({ person_id: z.uuid(), challenge_id: z.uuid(), code: z.string().check(z.regex(/^\s*\d{6}\s*$/)) }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    if (await activeFactor(ctx.db, i.person_id)) throw new KumiError("error.factor_exists");
    const ch = await ctx.db.selectFrom("auth_challenge").selectAll().where("id", "=", i.challenge_id).where("kind", "=", "totp_setup").where("person_id", "=", i.person_id)
      .where("consumed_at", "is", null).where("expires_at", ">", ctx.now).executeTakeFirst();
    if (!ch) throw new KumiError("error.factor_setup_expired");
    if (matchStep(ch.code_hash, i.code, ctx.now) === null) throw new KumiError("error.bad_factor_code", {}, 401);
    return { title: both("action.person.factor_add"), summary: both("plan.person.factor_add"), reads: [read], ownerIds: [i.person_id], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    const ch = await ctx.trx.updateTable("auth_challenge").set({ consumed_at: ctx.now }).where("id", "=", i.challenge_id).where("consumed_at", "is", null).returningAll().executeTakeFirst();
    if (!ch) throw new KumiError("error.factor_setup_expired");
    const step = matchStep(ch.code_hash, i.code, ctx.now)!;
    // One row per person: setting up again after removing reuses it.
    const old = await ctx.trx.selectFrom("staff_factor").select("person_id").where("person_id", "=", i.person_id).executeTakeFirst();
    if (old) await ctx.update("staff_factor", i.person_id, { secret: ch.code_hash, confirmed_at: ctx.now, last_step: String(step), removed_at: null });
    else await ctx.insert("staff_factor", { person_id: i.person_id, secret: ch.code_hash, confirmed_at: ctx.now, last_step: String(step) });
    await ctx.emit("person.factor_added", { person_id: i.person_id });
    return null;
  },
});

/** New recovery codes (the old ones stop working). The codes themselves are made outside the action. */
export const factorCodes = defineAction({
  name: "person.factor_codes", version: 1, internal: true, strongAuth: true,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const { read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    return { title: both("action.person.factor_codes"), summary: both("plan.person.factor_codes", { count: RECOVERY_CODES }), reads: [read], ownerIds: [i.person_id], undo: { kind: "none" } };
  },
  async apply(ctx, i) { await ctx.emit("person.factor_codes", { person_id: i.person_id }); return null; },
});

/** Taking your own authenticator off. Someone who has to use two steps keeps a passkey first. */
export const factorRemove = defineAction({
  name: "person.factor_remove", version: 1, strongAuth: true,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const f = await activeFactor(ctx.db, i.person_id);
    if (!f) throw new KumiError("error.not_found", { thing: both("thing.authenticator") }, 404);
    // Without it, would they still have to use two steps, and have nothing to give?
    const passkey = await ctx.db.selectFrom("passkey").select("credential_id").where("person_id", "=", i.person_id).where("revoked_at", "is", null).executeTakeFirst();
    if (!passkey && await mustByRole(ctx.db, i.person_id)) throw new KumiError("error.factor_needed");
    return { title: both("action.person.factor_remove"), summary: both("plan.person.factor_remove"), reads: [{ entity: "staff_factor", id: i.person_id, version: f.version }], ownerIds: [i.person_id], undo: { kind: "none" } };
  },
  async apply(ctx, i) {
    await ctx.update("staff_factor", i.person_id, { removed_at: ctx.now });
    await ctx.trx.updateTable("recovery_code").set({ used_at: ctx.now }).where("person_id", "=", i.person_id).where("used_at", "is", null).execute();
    return null;
  },
});
async function mustByRole(db: Db | Trx, personId: string): Promise<boolean> {
  const club = await db.selectFrom("club").select("two_factor").executeTakeFirst();
  const rule = (club?.two_factor ?? "owner_manager") as TwoFactorRule;
  if (rule === "off") return false;
  const roles = await rolesOf(db, personId);
  return rule === "all_staff" ? roles.some((r) => r.key !== "member") : roles.some((r) => r.key === "owner" || r.key === "manager" || !r.system);
}

/** The owner starts someone's second step over (a lost phone): their authenticator, recovery codes and
 *  passkeys go, they're signed out everywhere, and they set it up again at their next sign-in. Kumi's own
 *  command line can do it too, for an owner who is locked out. */
export const resetSignIn = defineAction({
  name: "person.reset_sign_in", version: 1, system: true, strongAuth: true,
  input: z.object({ person_id: z.uuid() }),
  async plan(ctx, i) {
    const { row, read } = await readRow(ctx.db, "person", i.person_id, "thing.person");
    if (ctx.actor.personId && ctx.actor.personId === i.person_id) throw new KumiError("error.reset_own_sign_in");
    const f = await activeFactor(ctx.db, i.person_id);
    const passkeys = (await ctx.db.selectFrom("passkey").select("credential_id").where("person_id", "=", i.person_id).where("revoked_at", "is", null).execute()).length;
    const codes = await recoveryLeft(ctx.db, i.person_id);
    if (!f && !passkeys && !codes) throw new KumiError("error.nothing_to_reset");
    return { title: both("action.person.reset_sign_in"), reads: [read], ownerIds: [i.person_id], undo: { kind: "none", note: both("reason.undo_final") },
      summary: both("plan.person.reset_sign_in", { person: row.display_name, authenticator: both(f ? "reset.authenticator_yes" : "reset.authenticator_no"), passkeys: both("count.passkeys", { count: passkeys }), codes: both("count.recovery_codes", { count: codes }) }),
      details: { name: row.display_name } };
  },
  async apply(ctx, i) {
    if (await activeFactor(ctx.trx, i.person_id)) await ctx.update("staff_factor", i.person_id, { removed_at: ctx.now });
    await ctx.trx.updateTable("recovery_code").set({ used_at: ctx.now }).where("person_id", "=", i.person_id).where("used_at", "is", null).execute();
    for (const p of await ctx.trx.selectFrom("passkey").select("credential_id").where("person_id", "=", i.person_id).where("revoked_at", "is", null).execute())
      await ctx.update("passkey", p.credential_id, { revoked_at: ctx.now });
    await ctx.trx.updateTable("web_session").set({ revoked_at: ctx.now }).where("person_id", "=", i.person_id).where("revoked_at", "is", null).execute();
    const by = ctx.actor.personId ? (await ctx.trx.selectFrom("person").select("display_name").where("id", "=", ctx.actor.personId).executeTakeFirst())?.display_name ?? null : null;
    await ctx.emit("person.sign_in_reset", { person_id: i.person_id, by });
    return null;
  },
});
