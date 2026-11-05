// Players' chats (packages/core/src/chat.ts): the member's routes, run inside the member routes (so an assistant
// reads a chat the way its person does, and only reads: the posting routes are POSTs it never makes), and the
// staff's view of every chat.
import { Hono, type Context } from "hono";
import type { Lang } from "@kumi/i18n";
import { chatId, chatKind, chatMute, chatSeen, chatThread, chatUnread, customAreas, editChat, KumiError, myChats, postChat, removeChat, staffChat, staffChats, type Db } from "@kumi/core";

/** A member's chats. `who` throws when signed out. */
export function chatRoutes(db: Db, who: (c: Context<any>) => string, lang: (c: Context<any>) => Lang, now: () => Date) {
  const app = new Hono();
  const json = async (c: Context<any>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  app.get("/my/chats", async (c) => c.json(await myChats(db, who(c), now())));
  app.get("/my/chats/unread", async (c) => c.json({ unread: await chatUnread(db, who(c), now()) }));
  // A message of one's own: changed within a few minutes, or taken back any time.
  app.post("/my/chats/messages/:mid/edit", async (c) => { await editChat(db, who(c), c.req.param("mid"), (await json(c)).body, now()); return c.json({ ok: true }); });
  app.post("/my/chats/messages/:mid/remove", async (c) => { await removeChat(db, who(c), c.req.param("mid"), now()); return c.json({ ok: true }); });
  app.get("/my/chats/:kind/:id", async (c) => c.json(await chatThread(db, who(c), chatKind(c.req.param("kind")), chatId(c.req.param("id")), lang(c), now())));
  app.post("/my/chats/:kind/:id", async (c) => c.json(await postChat(db, who(c), chatKind(c.req.param("kind")), chatId(c.req.param("id")), (await json(c)).body, now())));
  app.post("/my/chats/:kind/:id/seen", async (c) => { await chatSeen(db, who(c), chatKind(c.req.param("kind")), chatId(c.req.param("id")), now()); return c.json({ ok: true }); });
  app.post("/my/chats/:kind/:id/mute", async (c) => {
    await chatMute(db, who(c), chatKind(c.req.param("kind")), chatId(c.req.param("id")), (await json(c)).muted === true, now());
    return c.json({ ok: true });
  });
  return app;
}

const CHAT_ROLES = ["owner", "manager", "front_desk"];
/** Who reads every chat: front desk and up, or a role the club made that covers members. Never support access on
 *  its own (players' conversations are theirs and the club's), and never a coach on their own. */
export async function seesChats(db: Db, personId: string): Promise<boolean> {
  const areas = await customAreas(db, personId);
  if (areas) return areas.includes("members");
  const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
    .where("person_role.person_id", "=", personId).where("person_role.active", "=", true).where("role.active", "=", true).execute();
  return roles.some((r) => CHAT_ROLES.includes(r.key));
}

export function staffChatRoutes(db: Db, me: (c: Context<any>) => { id: string } | null, now: () => Date) {
  const app = new Hono();
  const staff = async (c: Context<any>) => {
    const m = me(c);
    if (!m) throw new KumiError("error.signed_out", {}, 401);
    if (!(await seesChats(db, m.id))) throw new KumiError("error.staff_only", {}, 403);
  };
  app.get("/staff/chats", async (c) => { await staff(c); return c.json(await staffChats(db, now())); });
  app.get("/staff/chats/:id", async (c) => { await staff(c); return c.json(await staffChat(db, c.req.param("id"), now())); });
  return app;
}
