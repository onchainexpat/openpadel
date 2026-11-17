// Ask openPadel, the hosted assistant (the server's assistant.ts): each person's conversations with it, kept
// ASSISTANT_KEEP_DAYS after their last turn and then deleted, deletable by the person whenever they like (one, or
// all of theirs), and in their data export (privacy.ts). A turn is written as it happens, like a message in a game's
// chat (chat.ts): it changes nothing at the club. What the assistant changes at the club goes through the catalogue
// like any other change, previewed in the conversation and done only on the person's own Confirm in the app.
//
// The hosted assistant acts through a connection of its own for each person (an oauth_grant of the built-in client
// HOSTED_CLIENT_ID), so it is the same kind of thing as an assistant they connect themselves: listed under Profile,
// Assistants with what it spent this week, held to the weekly limit they set it ($0 until they choose more), never
// reaching further than they did when it was first turned on (assistant_reach.ts), and each change it previews
// carries that connection on its run (action_run.oauth_grant_id) and `via` "assistant:hosted:<app>".
import * as z from "zod/mini";
import { both } from "@kumi/i18n";
import { defineAction } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";

/** The built-in client the hosted assistant's connections belong to: never offered to OAuth (oauth.ts refuses it). */
export const HOSTED_CLIENT_ID = "openpadel-hosted";
export const HOSTED_NAME = "Ask openPadel";
/** A conversation is kept this many days after its last turn. */
export const ASSISTANT_KEEP_DAYS = 30;
/** What `via` a run the hosted assistant previewed carries. */
export const hostedVia = (surface: "staff" | "member") => `assistant:hosted:${surface}`;

/** A person's conversations, newest first. */
export async function assistantChatsOf(db: Db | Trx, personId: string, surface?: "staff" | "member") {
  return db.selectFrom("assistant_chat").select(["id", "surface", "title", "created_at", "updated_at"]).where("person_id", "=", personId)
    .$if(Boolean(surface), (q) => q.where("surface", "=", surface!)).orderBy("updated_at", "desc").limit(50).execute();
}

/** What the app shows of one conversation: each turn's words and the previews it made. Null when it isn't theirs. */
export async function assistantChat(db: Db | Trx, personId: string, chatId: string) {
  const chat = await db.selectFrom("assistant_chat").select(["id", "surface", "title", "created_at", "updated_at"]).where("id", "=", chatId).where("person_id", "=", personId).executeTakeFirst();
  if (!chat) return null;
  const rows = await db.selectFrom("assistant_message").select(["seq", "role", "shown", "created_at"]).where("chat_id", "=", chatId).where("shown", "is not", null).orderBy("seq").execute();
  return { ...chat, turns: rows.map((r) => ({ role: r.role, at: r.created_at, ...(r.shown as object) })) };
}

/** For the person's data export: every conversation, with what was said on each side (never the model's working). */
export async function assistantChatsExport(db: Db | Trx, personId: string) {
  const chats = await db.selectFrom("assistant_chat").select(["id", "surface", "title", "created_at", "updated_at"]).where("person_id", "=", personId).orderBy("created_at").execute();
  const out = [];
  for (const c of chats) {
    const rows = await db.selectFrom("assistant_message").select(["role", "shown", "created_at"]).where("chat_id", "=", c.id).where("shown", "is not", null).orderBy("seq").execute();
    out.push({ app: c.surface, title: c.title, started_at: c.created_at.toISOString(), last_at: c.updated_at.toISOString(),
      turns: rows.map((r) => { const s = r.shown as { text?: string; previews?: { summary: string }[] }; return { from: r.role === "user" ? "you" : HOSTED_NAME, at: r.created_at.toISOString(), text: s.text ?? "", ...(s.previews?.length ? { previews: s.previews.map((p) => p.summary) } : {}) }; }) });
  }
  return out;
}

/** Conversations past their keeping time, deleted (the hourly tidy, main.ts). */
export async function tidyAssistantChats(db: Db, now = new Date()): Promise<{ deleted: number }> {
  const r = await db.deleteFrom("assistant_chat").where("updated_at", "<", new Date(now.getTime() - ASSISTANT_KEEP_DAYS * 864e5)).executeTakeFirst();
  return { deleted: Number(r.numDeletedRows) };
}

/** Deleting one of your conversations with Ask openPadel, or all of them. Only ever your own: nobody else's (an owner's
 *  '*' grant included) is found. The words go for good, so there's no undo. */
export const assistantChatDelete = defineAction({
  name: "assistant.chat_delete", version: 1,
  input: z.object({ chat_id: z.optional(z.uuid().check(z.describe("One conversation; left out, all of yours."))) }),
  selfOnly: async (db, i: { chat_id?: string }) => i.chat_id ? (await db.selectFrom("assistant_chat").select("person_id").where("id", "=", i.chat_id).executeTakeFirst())?.person_id ?? null : null,
  async plan(ctx, i) {
    const me = ctx.actor.personId;
    if (!me) throw new KumiError("error.not_found", { thing: both("thing.assistant_chat") }, 404);
    if (i.chat_id) {
      const c = await ctx.db.selectFrom("assistant_chat").select(["title", "person_id"]).where("id", "=", i.chat_id).executeTakeFirst();
      if (!c || c.person_id !== me) throw new KumiError("error.not_found", { thing: both("thing.assistant_chat") }, 404);
      return { title: both("action.assistant.chat_delete"), summary: both("plan.assistant.chat_delete", { title: c.title }), reads: [], ownerIds: [me], undo: { kind: "none", note: both("reason.assistant_chat_gone") } };
    }
    const n = Number((await ctx.db.selectFrom("assistant_chat").select((e) => e.fn.countAll<string>().as("n")).where("person_id", "=", me).executeTakeFirstOrThrow()).n);
    if (!n) throw new KumiError("error.nothing_changed");
    return { title: both("action.assistant.chat_delete"), summary: both("plan.assistant.chat_delete_all", { count: n }), reads: [], ownerIds: [me], undo: { kind: "none", note: both("reason.assistant_chat_gone") } };
  },
  async apply(ctx, i) {
    const r = await ctx.trx.deleteFrom("assistant_chat").where("person_id", "=", ctx.actor.personId!).$if(Boolean(i.chat_id), (q) => q.where("id", "=", i.chat_id!)).executeTakeFirst();
    return { deleted: Number(r.numDeletedRows) };
  },
});
