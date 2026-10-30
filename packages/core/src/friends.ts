// Friends: a member adds someone they've played with (the same booking or game), or anyone whose friend
// link they've been given. Once each has added the other they're friends, and can save each other a place
// in a match. A name is only ever shown to friends, to people who have played together, and to whoever was
// given the link.
import { sql } from "kysely";
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction, readRow, type ApplyCtx, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { friendsAllowed, friendsAllowedSql } from "./kids.ts";

/** How far back "people you've played with" looks. */
export const PLAYED_WITH_DAYS = 90;

async function added(db: Db | Trx, from: string, to: string) {
  return (await db.selectFrom("friend").selectAll().where("person_id", "=", from).where("friend_id", "=", to).executeTakeFirst()) ?? null;
}

/** Whether each of the two has added the other (and neither is a kid whose parents have friends off). */
export async function areFriends(db: Db | Trx, a: string, b: string): Promise<boolean> {
  const r = await db.selectFrom("friend").select(sql<string>`count(*)`.as("n")).where("removed_at", "is", null)
    .where((eb) => eb.or([eb.and([eb("person_id", "=", a), eb("friend_id", "=", b)]), eb.and([eb("person_id", "=", b), eb("friend_id", "=", a)])])).executeTakeFirstOrThrow();
  return Number(r.n) === 2 && await friendsAllowed(db, a) && await friendsAllowed(db, b);
}

/** Everyone the person has shared a booking (both still in it) or a game with, since `since`. */
function coPlayerIds(db: Db | Trx, personId: string, since: Date | null) {
  const bookings = db.selectFrom("booking_player as me").innerJoin("booking_player as other", "other.booking_id", "me.booking_id").innerJoin("booking", "booking.id", "me.booking_id")
    .select("other.person_id as id").where("me.person_id", "=", personId).where("me.removed_at", "is", null).where("other.removed_at", "is", null)
    .where("other.person_id", "is not", null).where("other.person_id", "!=", personId).where("booking.status", "!=", "held")
    .$if(since !== null, (q) => q.where("booking.created_at", ">=", since!));
  const games = db.selectFrom("game_side as me").innerJoin("game_side as other", "other.game_id", "me.game_id").innerJoin("game", "game.id", "me.game_id")
    .select("other.person_id as id").where("me.person_id", "=", personId).where("other.person_id", "!=", personId).where("game.status", "!=", "void")
    .$if(since !== null, (q) => q.where(sql<Date>`coalesce(game.played_at, now())`, ">=", since!));
  return bookings.union(games);
}

/** Whether the two have played together (in the same booking, both still in it, or the same game). */
export async function playedTogether(db: Db | Trx, a: string, b: string): Promise<boolean> {
  return Boolean(await db.selectFrom(coPlayerIds(db, a, null).as("c")).select("c.id").where("c.id", "=", b).executeTakeFirst());
}

type Named = { id: string; display_name: string };
/** A member's friends page: friends, who added them (to add back), whom they added (waiting), and people
 *  they've played with lately whom they haven't added. */
export async function friendsOf(db: Db | Trx, personId: string, now = new Date()) {
  if (!(await friendsAllowed(db, personId))) return { friends: [], added_you: [], you_added: [], played_with: [] };
  const live = (q: any) => q.innerJoin("person", "person.id", "f.other").where("person.status", "=", "active").where("person.redacted_at", "is", null).where(friendsAllowedSql);
  const mine = await live(db.selectFrom(db.selectFrom("friend").select(["friend_id as other"]).where("person_id", "=", personId).where("removed_at", "is", null).as("f")))
    .select(["person.id", "person.display_name"]).execute() as Named[];
  const theirs = await live(db.selectFrom(db.selectFrom("friend").select(["person_id as other"]).where("friend_id", "=", personId).where("removed_at", "is", null).as("f")))
    .select(["person.id", "person.display_name"]).execute() as Named[];
  const mineIds = new Set(mine.map((p) => p.id)), theirIds = new Set(theirs.map((p) => p.id));
  const since = new Date(now.getTime() - PLAYED_WITH_DAYS * 86400_000);
  // Never a junior, unless their parents turned friends on: their names stay with their family and the club.
  const played = await db.selectFrom(coPlayerIds(db, personId, since).as("c")).innerJoin("person", "person.id", "c.id").select(["person.id", "person.display_name"]).distinct()
    .where("person.status", "=", "active").where("person.redacted_at", "is", null).where(friendsAllowedSql).execute();
  const byName = (a: Named, b: Named) => a.display_name.localeCompare(b.display_name);
  return {
    friends: mine.filter((p) => theirIds.has(p.id)).sort(byName),
    added_you: theirs.filter((p) => !mineIds.has(p.id)).sort(byName),
    you_added: mine.filter((p) => !theirIds.has(p.id)).sort(byName),
    played_with: played.filter((p) => !mineIds.has(p.id) && !theirIds.has(p.id)).sort(byName),
  };
}

/** Friends whose name matches (for saving a place): friends only, by name only. */
export async function findFriends(db: Db | Trx, personId: string, q: string) {
  const { friends } = await friendsOf(db, personId);
  const needle = q.trim().toLocaleLowerCase();
  return friends.filter((f) => f.display_name.toLocaleLowerCase().includes(needle)).slice(0, 6);
}

/** The person behind a friend link, if it's someone who can be added. */
export async function personByFriendCode(db: Db | Trx, code: string) {
  return (await db.selectFrom("person").select(["id", "display_name"]).where("friend_code", "=", code).where("status", "=", "active").where("redacted_at", "is", null).where(friendsAllowedSql).executeTakeFirst()) ?? null;
}

async function planAdd(ctx: PlanCtx, personId: string, friendId: string, byLink: boolean) {
  if (personId === friendId) throw new KumiError("error.friend_self");
  if (!(await friendsAllowed(ctx.db, personId))) throw new KumiError("error.kid_friends_off");
  const { row } = await readRow(ctx.db, "person", friendId, "thing.person");
  if (row.status !== "active" || row.redacted_at || !(await friendsAllowed(ctx.db, friendId))) throw new KumiError("error.not_found", { thing: both("thing.person") }, 404);
  const name = row.display_name as string;
  if ((await added(ctx.db, personId, friendId))?.removed_at === null) throw new KumiError("error.friend_already", { name });
  const back = (await added(ctx.db, friendId, personId))?.removed_at === null;
  if (!back && !byLink && !(await playedTogether(ctx.db, personId, friendId))) throw new KumiError("error.friend_not_played", { name });
  return { title: both("action.friend.add"), summary: both(back ? "plan.friend.add_back" : "plan.friend.add", { name }), reads: [], ownerIds: [personId],
    undo: { kind: "reversible" as const }, details: { friend_id: friendId } };
}
async function applyAdd(ctx: ApplyCtx, personId: string, friendId: string) {
  const row = await ctx.trx.selectFrom("friend").selectAll().where("person_id", "=", personId).where("friend_id", "=", friendId).forUpdate().executeTakeFirst();
  if (row && !row.removed_at) throw new KumiError("error.changed");
  if (row) await ctx.update("friend", row.id, { removed_at: null });
  else {
    try { await ctx.insert("friend", { id: uuidv7(), person_id: personId, friend_id: friendId }); }
    catch (e: any) { if (e?.code === "23505") throw new KumiError("error.changed"); throw e; }
  }
  const mutual = (await added(ctx.trx, friendId, personId))?.removed_at === null;
  await ctx.emit("friend.added", { person_id: personId, friend_id: friendId, mutual });
  return { friends: mutual };
}

export const friendAdd = defineAction({
  name: "friend.add", version: 1,
  input: z.object({ person_id: z.uuid(), friend_id: z.uuid() }),
  plan: (ctx, i) => planAdd(ctx, i.person_id, i.friend_id, false),
  apply: (ctx, i) => applyAdd(ctx, i.person_id, i.friend_id),
});

export const friendAddByCode = defineAction({
  name: "friend.add_by_code", version: 1,
  // From someone's friend link: they gave it out, so it doesn't matter whether you've played together.
  input: z.object({ person_id: z.uuid(), code: z.string().check(z.minLength(6), z.maxLength(40)) }),
  async plan(ctx, i) {
    const p = await personByFriendCode(ctx.db, i.code);
    if (!p) throw new KumiError("error.friend_link_unknown", {}, 404);
    return planAdd(ctx, i.person_id, p.id, true);
  },
  apply: (ctx, i, plan) => applyAdd(ctx, i.person_id, (plan.details as { friend_id: string }).friend_id),
});

export const friendRemove = defineAction({
  name: "friend.remove", version: 1,
  input: z.object({ person_id: z.uuid(), friend_id: z.uuid() }),
  async plan(ctx, i) {
    const row = await added(ctx.db, i.person_id, i.friend_id);
    if (!row || row.removed_at) throw new KumiError("error.friend_not_added");
    const name = (await readRow(ctx.db, "person", i.friend_id, "thing.person")).row.display_name as string;
    const mutual = (await added(ctx.db, i.friend_id, i.person_id))?.removed_at === null;
    return { title: both("action.friend.remove"), summary: both(mutual ? "plan.friend.remove" : "plan.friend.take_back", { name }), reads: [{ entity: "friend" as const, id: row.id, version: row.version }],
      ownerIds: [i.person_id], undo: { kind: "reversible" as const }, details: { id: row.id } };
  },
  async apply(ctx, _i, plan) {
    await ctx.update("friend", (plan.details as { id: string }).id, { removed_at: ctx.now });
    return null;
  },
});
