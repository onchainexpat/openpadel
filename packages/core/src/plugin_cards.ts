// Plugin cards (docs/plugins/README.md, "Cards"): what a plugin shows in the core apps' slots. Plugins never ship
// code into the apps: the manifest declares a card's slot and title, and what the card says comes from the plugin at
// run time through the door, as two actions only a plugin's own token may plan:
//   plugin.card_put   { slot, subject, tone?, rows, link? }   puts (or replaces) its card for that slot and subject
//   plugin.card_clear { slot, subject }                        takes it down
// A card is data (rows of words in both languages, a tone, an https link), so the apps render it with their own
// components: themed, accessible and safe by construction. A paused or removed plugin's cards aren't shown, nor a card
// in a slot its manifest no longer declares.
import * as z from "zod/mini";
import { both, type Key, type Lang, type Text } from "@kumi/i18n";
import { defineAction } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { bothWords, CARD_SLOTS, type Manifest } from "./plugin_manifest.ts";

export type CardSlot = (typeof CARD_SLOTS)[number];
export const CARD_ROWS_MAX = 6;
/** Slots whose cards belong to one thing (a court, a game, a person); the others are the club's (Money, Connectors). */
export const SUBJECT_SLOTS: readonly CardSlot[] = ["court_tile", "game", "member_profile"];
export const CARD_TONES = ["ok", "warn", "off"] as const;

const httpsUrl = z.string().check(z.maxLength(500), z.refine((s) => {
  try { const u = new URL(s); return u.protocol === "https:" && !u.username && !u.password && !/[\u0000-\u001f\u007f-\u009f]/.test(s); } catch { return false; }
}, "an https address"));
const cardInput = {
  slot: z.enum(CARD_SLOTS).check(z.describe("Where: a slot the plugin's manifest declares (court_tile, game, member_profile, money, connectors)")),
  subject: z.optional(z.nullable(z.uuid().check(z.describe("What the card belongs to: a court's id for court_tile, a booking's (or game's) id for game, a person's id for member_profile; none for money and connectors")))),
};
const PutInput = z.object({
  ...cardInput,
  tone: z.optional(z.enum(CARD_TONES).check(z.describe("ok (the default), warn (something needs a look) or off"))),
  rows: z.array(z.strictObject({ label: bothWords(40), text: bothWords(200) })).check(z.maxLength(CARD_ROWS_MAX),
    z.describe("Up to 6 lines, each { label: {en, es}, text: {en, es} }: one line of words each, no em dashes")),
  link: z.optional(z.strictObject({ url: httpsUrl, label: bothWords(60) }).check(z.describe("An https link under the card, with its words in both languages"))),
});

/** The live plugin a person row stands for (its agent's), or null for anyone else: the only one who may put its cards. */
export async function pluginOfPerson(db: Db | Trx, personId: string | null | undefined) {
  if (!personId) return null;
  return (await db.selectFrom("plugin").innerJoin("agent", "agent.id", "plugin.agent_id").select(["plugin.id", "plugin.name", "plugin.manifest"])
    .where("agent.person_id", "=", personId).where("agent.revoked_at", "is", null).where("plugin.status", "in", ["waiting", "on"]).executeTakeFirst()) ?? null;
}
async function mine(db: Db | Trx, personId: string | null) {
  const p = await pluginOfPerson(db, personId);
  if (!p) throw new KumiError("error.plugin_cards_only", {}, 403);
  return { ...p, m: p.manifest as Manifest };
}
/** The slot is one the manifest declares, and the subject is there and fits it; the subject's name, for the preview. */
async function checkWhere(db: Db | Trx, m: Manifest, slot: CardSlot, subject: string | null | undefined): Promise<{ subject: string | null; title: Text; named: string | null }> {
  const decl = m.cards.find((c) => c.slot === slot);
  if (!decl) throw new KumiError("error.plugin_card_slot", { slot }, 403);
  const needs = SUBJECT_SLOTS.includes(slot);
  if (!needs) { if (subject) throw new KumiError("error.plugin_card_subject", { slot }, 400); return { subject: null, title: decl.title, named: null }; }
  if (!subject) throw new KumiError("error.plugin_card_subject", { slot }, 400);
  let named: string | null | undefined;
  if (slot === "court_tile") named = (await db.selectFrom("court").select("name").where("id", "=", subject).executeTakeFirst())?.name;
  // A person is never named in the preview: the plugin may not read members.
  else if (slot === "member_profile") named = (await db.selectFrom("person").select("id").where("id", "=", subject).where("status", "!=", "archived").executeTakeFirst()) ? "" : undefined;
  else {
    const b = await db.selectFrom("booking").leftJoin("court_time", (j) => j.onRef("court_time.booking_id", "=", "booking.id").on("court_time.active", "=", true))
      .leftJoin("court", "court.id", "court_time.court_id").select(["booking.id", "court.name"]).where("booking.id", "=", subject).executeTakeFirst();
    named = b ? b.name ?? "" : (await db.selectFrom("game").select("id").where("id", "=", subject).executeTakeFirst()) ? "" : undefined;
  }
  if (named === undefined) throw new KumiError("error.plugin_card_subject", { slot }, 404);
  return { subject, title: decl.title, named: named || null };
}
async function cardRow(db: Db | Trx, pluginId: string, slot: CardSlot, subject: string | null) {
  return db.selectFrom("plugin_card").selectAll().where("plugin_id", "=", pluginId).where("slot", "=", slot)
    .$if(subject === null, (q) => q.where("subject", "is", null)).$if(subject !== null, (q) => q.where("subject", "=", subject!)).executeTakeFirst();
}
const whereText = (slot: CardSlot, named: string | null): Text => {
  const w = both(`plan.plugin.slot_${slot}` as Key);
  return named ? { en: `${w.en} (${named})`, es: `${w.es} (${named})` } : w;
};

export const pluginCardPut = defineAction({
  name: "plugin.card_put", version: 1,
  input: PutInput,
  async plan(ctx, i) {
    const p = await mine(ctx.db, ctx.actor.personId);
    const w = await checkWhere(ctx.db, p.m, i.slot, i.subject);
    const have = await cardRow(ctx.db, p.id, i.slot, w.subject);
    return { title: both("action.plugin.card_put"), summary: both(have && !have.cleared_at ? "plan.plugin.card_replace" : "plan.plugin.card_put", { name: p.name, title: w.title, where: whereText(i.slot, w.named) }),
      rows: i.rows, reads: have ? [{ entity: "plugin_card", id: have.id, version: have.version }] : [], ownerIds: [ctx.actor.personId!], undo: { kind: "reversible" },
      details: { plugin_id: p.id, subject: w.subject, card_id: have?.id ?? null } };
  },
  async apply(ctx, i, p) {
    const d = p.details as { plugin_id: string; subject: string | null; card_id: string | null };
    const row = { tone: i.tone ?? "ok", rows: JSON.stringify(i.rows), link: i.link ? JSON.stringify(i.link) : null, put_at: ctx.now, cleared_at: null };
    const have = d.card_id ? { id: d.card_id } : await cardRow(ctx.trx, d.plugin_id, i.slot, d.subject);
    if (have) { await ctx.update("plugin_card", have.id, row); return { card_id: have.id }; }
    const id = uuidv7();
    await ctx.insert("plugin_card", { id, plugin_id: d.plugin_id, slot: i.slot, subject: d.subject, ...row });
    return { card_id: id };
  },
});

export const pluginCardClear = defineAction({
  name: "plugin.card_clear", version: 1,
  input: z.object(cardInput),
  async plan(ctx, i) {
    const p = await mine(ctx.db, ctx.actor.personId);
    const w = await checkWhere(ctx.db, p.m, i.slot, i.subject);
    const have = await cardRow(ctx.db, p.id, i.slot, w.subject);
    if (!have || have.cleared_at) throw new KumiError("error.nothing_changed");
    return { title: both("action.plugin.card_clear"), summary: both("plan.plugin.card_clear", { name: p.name, title: w.title, where: whereText(i.slot, w.named) }),
      reads: [{ entity: "plugin_card", id: have.id, version: have.version }], ownerIds: [ctx.actor.personId!], undo: { kind: "reversible" }, details: { card_id: have.id } };
  },
  async apply(ctx, _i, p) {
    await ctx.update("plugin_card", (p.details as { card_id: string }).card_id, { cleared_at: ctx.now });
    return null;
  },
});

// ---- Reads ----
export interface ShownCard { plugin: string; slot: CardSlot; subject: string | null; title: string; tone: "ok" | "warn" | "off";
  rows: { label: string; text: string }[]; link: { url: string; label: string } | null; put_at: Date }
/** The cards shown in a slot, for these subjects (or the club's, for money and connectors), in the reader's language:
 *  only live plugins' (not paused or removed), only in slots their manifest still declares. Who may read which is the
 *  route's to judge (reads.ts, member.ts). */
export async function cardsFor(db: Db | Trx, slot: CardSlot, subjects: string[] | null, lang: Lang): Promise<ShownCard[]> {
  if (subjects && !subjects.length) return [];
  const rows = await db.selectFrom("plugin_card").innerJoin("plugin", "plugin.id", "plugin_card.plugin_id")
    .select(["plugin.name", "plugin.manifest", "plugin_card.slot", "plugin_card.subject", "plugin_card.tone", "plugin_card.rows", "plugin_card.link", "plugin_card.put_at"])
    .where("plugin_card.slot", "=", slot).where("plugin_card.cleared_at", "is", null).where("plugin.status", "in", ["waiting", "on"])
    .$if(subjects !== null, (q) => q.where("plugin_card.subject", "in", subjects!)).$if(subjects === null, (q) => q.where("plugin_card.subject", "is", null))
    .orderBy("plugin.name").limit(200).execute();
  const out: ShownCard[] = [];
  for (const r of rows) {
    const decl = (r.manifest as Manifest).cards.find((c) => c.slot === r.slot);
    if (!decl) continue;
    const link = r.link as { url: string; label: Text } | null;
    out.push({ plugin: r.name, slot: r.slot, subject: r.subject, title: decl.title[lang], tone: r.tone,
      rows: (r.rows as { label: Text; text: Text }[]).map((x) => ({ label: x.label[lang], text: x.text[lang] })), link: link ? { url: link.url, label: link.label[lang] } : null, put_at: r.put_at });
  }
  return out;
}
