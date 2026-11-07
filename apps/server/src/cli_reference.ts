// The built-in roles' grants as the migrations make them, for the command line's reference (docs/cli/reference.md).
import type { Db } from "@kumi/core";
import type { GrantRow } from "./cli_commands.ts";

export async function builtInGrants(db: Db): Promise<GrantRow[]> {
  return db.selectFrom("role_grant").innerJoin("role", "role.id", "role_grant.role_id")
    .select(["role.key as role", "role_grant.pattern", "role_grant.mode", "role_grant.rows_scope", "role_grant.time_scope"])
    .where("role.system", "=", true).where("role.active", "=", true).where("role_grant.active", "=", true)
    .orderBy("role.key").orderBy("role_grant.pattern").execute() as Promise<GrantRow[]>;
}
