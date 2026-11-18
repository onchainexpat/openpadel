// A marketing sync telling the club that a member unsubscribed on its side (Klaviyo's unsubscribe link, a suppression
// after a complaint): their answer to club news by email turns to no here too, so openPadel and the outside service
// agree and nobody is put back on a list they left. Only a live plugin whose manifest reads the club news list may, for
// one member it was given (someone on the list now), and it's a change like any other: previewed, in the change log as
// the plugin's, and not undone (a yes is the member's own, in the app).
import * as z from "zod/mini";
import { sql } from "kysely";
import { both } from "@kumi/i18n";
import { defineAction } from "./actions.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { pluginOfPerson } from "./plugin_cards.ts";
import type { Manifest } from "./plugin_manifest.ts";

export const clubNewsUnsubscribedElsewhere = defineAction({
  name: "club_news.unsubscribed_elsewhere", version: 1,
  input: z.object({ person_id: z.uuid().check(z.describe("A member's id, as club_news_list gave it")),
    service: z.optional(z.string().check(z.maxLength(40), z.regex(/^[A-Za-z0-9 .-]*$/), z.describe("Where they unsubscribed (Klaviyo)"))) }),
  async plan(ctx, i) {
    const p = await pluginOfPerson(ctx.db, ctx.actor.personId);
    if (!p || !((p.manifest as Manifest).reads ?? []).includes("club_news")) throw new KumiError("error.forbidden_reason", { reason: both("reason.plugin_own") }, 403);
    // Only someone on the list now: the plugin was given them, and their answer is yes.
    const on = await ctx.db.selectFrom("person").select(["id", "display_name"]).where("id", "=", i.person_id).where("status", "!=", "archived").where("redacted_at", "is", null)
      .where(sql<boolean>`(SELECT c.granted FROM channel_consent c WHERE c.person_id = person.id AND c.channel = 'email' AND c.purpose = 'club_news' ORDER BY c.at DESC, c.id DESC LIMIT 1) IS TRUE`)
      .executeTakeFirst();
    if (!on) throw new KumiError("error.nothing_changed");
    const service = i.service?.trim() || p.name;
    return { title: both("action.club_news.unsubscribed_elsewhere"), summary: both("plan.club_news.unsubscribed_elsewhere", { plugin: p.name, name: on.display_name, service }),
      reads: [], ownerIds: [ctx.actor.personId!], undo: { kind: "none", note: both("reason.news_yes_is_theirs") }, details: { plugin: p.name, service } };
  },
  async apply(ctx, i, plan) {
    const d = plan.details as { plugin: string; service: string };
    await ctx.trx.insertInto("channel_consent").values({ id: uuidv7(), person_id: i.person_id, channel: "email", purpose: "club_news", granted: false, source: "plugin", form_version: null,
      evidence: JSON.stringify({ plugin: d.plugin, service: d.service }), at: ctx.now }).execute();
    await ctx.emit("club_news.left", { person_id: i.person_id, why: "unsubscribed_elsewhere" });
    return { person_id: i.person_id };
  },
});
