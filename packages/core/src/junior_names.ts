// Juniors' names stay with their family and the club (friends.ts): a junior is named to themselves, the partner
// they play with and their household; any other member reads "Junior player". Staff read every name (no reader).
// Every name a member reads about a tournament, a league or a rated game goes through this.
import { both, type Text } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";

const plain = (s: string): Text => ({ en: s, es: s });

/** The people in the reader's households (the reader too). */
export async function familyOf(db: Db | Trx, reader: string): Promise<Set<string>> {
  const hh = await db.selectFrom("household_member").select("household_id").where("person_id", "=", reader).where("removed_at", "is", null).execute();
  const ids = hh.length ? (await db.selectFrom("household_member").select("person_id").where("household_id", "in", hh.map((h) => h.household_id)).where("removed_at", "is", null).execute()).map((m) => m.person_id) : [];
  return new Set([reader, ...ids]);
}

/** How `reader` may see each person: `teams` are who plays together, so a junior's own partner sees their name.
 *  With no reader (staff), every name. */
export async function namesFor(db: Db | Trx, reader: string | null, people: string[], teams: string[][] = []): Promise<(id: string) => Text> {
  const ids = [...new Set(people.filter(Boolean))];
  const ps = new Map((ids.length ? await db.selectFrom("person").select(["id", "display_name", "junior"]).where("id", "in", ids).execute() : []).map((p) => [p.id, p]));
  const family = reader ? await familyOf(db, reader) : new Set<string>();
  const partners = new Set(reader ? teams.filter((t) => t.includes(reader)).flat() : []);
  return (id: string) => {
    const p = ps.get(id);
    if (!p) return plain("");
    if (!p.junior || !reader || family.has(id) || partners.has(id)) return plain(p.display_name);
    return both("pub.junior_player");
  };
}

/** "Ana + Ben", in each language. */
export const pairText = (x: Text, y: Text): Text => ({ en: `${x.en} + ${y.en}`, es: `${x.es} + ${y.es}` });
