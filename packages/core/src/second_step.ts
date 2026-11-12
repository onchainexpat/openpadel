// Who gives a second step, and when: read by the sign-in gate (two_factor.ts), sensitive changes (actions.ts) and
// assistant connections (assistant_reach.ts). Kept apart from the actions so actions.ts can read it.
import type { Db, Trx } from "./db.ts";

export type TwoFactorRule = "owner_manager" | "all_staff" | "off";

/** The roles a person holds, by key, with whether each is one the club made. */
async function rolesOf(db: Db | Trx, personId: string) {
  return db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(["role.key", "role.system"])
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).where("role.active", "=", true).execute();
}

export async function activeFactor(db: Db | Trx, personId: string) {
  return (await db.selectFrom("staff_factor").selectAll().where("person_id", "=", personId).where("removed_at", "is", null).executeTakeFirst()) ?? null;
}

/** Whether they have something to give as the second step: a passkey or an authenticator. */
export async function hasSecondFactor(db: Db | Trx, personId: string): Promise<boolean> {
  if (await activeFactor(db, personId)) return true;
  return Boolean(await db.selectFrom("passkey").select("credential_id").where("person_id", "=", personId).where("revoked_at", "is", null).executeTakeFirst());
}

/** Whether the club's rule (club.two_factor) names this person's roles: owners, managers and anyone holding a role the
 *  club made (the default), or every staff role. They give a second step for the club's most sensitive changes
 *  (strongAuth), and an assistant they connect without one works as a member's (assistant_reach.ts); at sign-in too
 *  when the club asks it there (club.second_step_sign_in). 'off' (practice and test databases) names nobody. */
export async function secondStepByRole(db: Db | Trx, personId: string): Promise<boolean> {
  const club = await db.selectFrom("club").select("two_factor").executeTakeFirst();
  const rule = (club?.two_factor ?? "owner_manager") as TwoFactorRule;
  if (rule === "off") return false;
  const roles = await rolesOf(db, personId);
  return rule === "all_staff" ? roles.some((r) => r.key !== "member") : roles.some((r) => r.key === "owner" || r.key === "manager" || !r.system);
}

/** Whether the club asks the roles its rule names for a second step at every sign-in (Settings; off by default). */
export async function secondStepAtSignIn(db: Db | Trx): Promise<boolean> {
  return Boolean((await db.selectFrom("club").select("second_step_sign_in").executeTakeFirst())?.second_step_sign_in);
}

/** Whether an assistant this person connects reaches all they may only when the connecting sign-in gave a second
 *  step: the roles the club's rule names, and anyone with an authenticator. The same whether or not the club asks a
 *  second step at sign-in, so turning that off never widens what an assistant reaches. */
export async function secondStepForReach(db: Db | Trx, personId: string): Promise<boolean> {
  return Boolean(await activeFactor(db, personId)) || await secondStepByRole(db, personId);
}

/** Whether a sensitive change (strongAuth) needs this person signed in with a second step: anyone with a passkey or an
 *  authenticator, and the roles the club's rule names. Whoever has none yet sets one up there (the apps offer it). */
export async function secondStepForChanges(db: Db | Trx, personId: string): Promise<boolean> {
  return (await hasSecondFactor(db, personId)) || await secondStepByRole(db, personId);
}
