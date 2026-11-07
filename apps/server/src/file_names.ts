// Files people download are named for their club ("kestrel-padel-receipts-2026-11-01-to-2026-11-30.csv"), never for
// the software: members read only their club's name, and staff files read the same in anyone's Downloads folder.
import type { Db } from "@kumi/core";

/** The club's name as a file name's start: plain letters and digits, dashes between, at most 40. "club" if none. */
export function fileStem(name: string | null | undefined): string {
  const s = (name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "club";
}

export async function clubFileStem(db: Db): Promise<string> {
  return fileStem((await db.selectFrom("club").select("name").executeTakeFirst())?.name);
}
