// The club vault: the owner's keys and small documents, sealed with the server's key (sealed.ts). A value or
// file reaches the server first (stageVaultUpload, from the owner's app), sealed into vault_blob; the actions
// name that upload, so neither an action's input nor the change log ever carries what's inside. Secrets are
// never shown again in full, only their last four characters; documents can be downloaded by the owner, and
// each download is kept. Kumi itself can read a secret by name (vaultSecret) for a connection that needs one.
import * as z from "zod/mini";
import { both, type Text } from "@kumi/i18n";
import { defineAction, readRow, type PlanCtx } from "./actions.ts";
import type { Db, Trx } from "./db.ts";
import { KumiError } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { photoType } from "./lessons.ts";
import { openBytes, sealBytes } from "./sealed.ts";

/** The longest secret kept, and the largest document (the apps send it as base64 under the server's 3 MB limit). */
export const VAULT_SECRET_MAX = 4000;
export const VAULT_DOC_MAX_BYTES = 2_000_000;
/** An upload not put in the vault within this long is dropped. */
export const VAULT_UPLOAD_MINUTES = 60;
export type VaultDocType = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

/** What a document's first bytes say it is: a PDF or a picture (never the file's name, never anything that runs). */
export function vaultDocType(b: Buffer): VaultDocType | null {
  if (b.length >= 5 && b.toString("latin1", 0, 5) === "%PDF-") return "application/pdf";
  return photoType(b);
}
const cleanName = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
/** A file name safe to hand back in a download header: letters, digits, dots, dashes, brackets and spaces. */
export const safeFilename = (s: string) => cleanName(s).replace(/[^\w.\-() ]/g, "_").slice(0, 120) || "document";

/** Seal a value or file into the vault's waiting room. Returns the upload's id, to name in vault.add or vault.replace. */
export async function stageVaultUpload(db: Db, personId: string, up: { kind: "secret"; value: string } | { kind: "document"; bytes: Buffer; filename: string }, now = new Date()) {
  if (up.kind === "secret") {
    const value = up.value.replace(/^\s+|\s+$/g, "");
    if (!value) throw new KumiError("error.vault_empty", {}, 400);
    if (value.length > VAULT_SECRET_MAX) throw new KumiError("error.vault_secret_long", { count: VAULT_SECRET_MAX }, 400);
    const id = uuidv7(now.getTime());
    await db.insertInto("vault_blob").values({ id, kind: "secret", bytes: sealBytes(Buffer.from(value, "utf8")), size_bytes: Buffer.byteLength(value), content_type: null, filename: null,
      last4: value.length > 8 ? value.slice(-4) : null, created_by: personId, created_at: now, attached_at: null }).execute();
    return { upload_id: id, last4: value.length > 8 ? value.slice(-4) : null };
  }
  if (!up.bytes.length || up.bytes.length > VAULT_DOC_MAX_BYTES) throw new KumiError("error.vault_doc_big", { mb: VAULT_DOC_MAX_BYTES / 1_000_000 }, 413);
  const type = vaultDocType(up.bytes);
  if (!type) throw new KumiError("error.vault_doc_type", {}, 400);
  const id = uuidv7(now.getTime()), filename = safeFilename(up.filename);
  await db.insertInto("vault_blob").values({ id, kind: "document", bytes: sealBytes(up.bytes), size_bytes: up.bytes.length, content_type: type, filename, last4: null, created_by: personId, created_at: now, attached_at: null }).execute();
  return { upload_id: id, size_bytes: up.bytes.length, content_type: type };
}

/** An upload waiting to be put in the vault, by the person who sent it. */
async function waitingUpload(ctx: PlanCtx, uploadId: string, kind?: "secret" | "document") {
  const b = await ctx.db.selectFrom("vault_blob").select(["id", "kind", "size_bytes", "content_type", "filename", "last4", "created_by", "created_at", "attached_at"]).where("id", "=", uploadId).executeTakeFirst();
  if (!b || b.attached_at || b.created_by !== ctx.actor.personId || ctx.now.getTime() - new Date(b.created_at).getTime() > VAULT_UPLOAD_MINUTES * 60_000) throw new KumiError("error.vault_upload_gone");
  if (kind && b.kind !== kind) throw new KumiError("error.vault_upload_gone");
  return b;
}
/** Only the owner, in the staff app: never through an agent. */
function ownerHere(ctx: PlanCtx) { if (ctx.actor.agentId) throw new KumiError("error.vault_not_for_agents", {}, 403); }
const vaultName = z.string().check(z.minLength(1), z.maxLength(80));
const kb = (n: number) => Math.max(1, Math.round(n / 1000));
const describeItem = (b: { kind: string; last4: string | null; size_bytes: number; filename: string | null }): Text =>
  b.kind === "secret" ? (b.last4 ? both("plan.vault.secret_ending", { last4: b.last4 }) : both("plan.vault.secret_short"))
    : both("plan.vault.document", { file: b.filename ?? "", kb: kb(b.size_bytes) });

export const vaultAdd = defineAction({
  name: "vault.add", version: 1, strongAuth: true,
  input: z.object({ name: vaultName, upload_id: z.uuid(), note: z.optional(z.string().check(z.maxLength(300))) }),
  async plan(ctx, i) {
    ownerHere(ctx);
    const b = await waitingUpload(ctx, i.upload_id), name = cleanName(i.name);
    if (!name) throw new KumiError("error.invalid_input");
    const taken = await ctx.db.selectFrom("vault_item").select("id").where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase())).where("active", "=", true).executeTakeFirst();
    if (taken) throw new KumiError("error.vault_name_taken", { name });
    return { title: both("action.vault.add"), summary: both("plan.vault.add", { name, what: describeItem(b) }), reads: [], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const b = await ctx.trx.updateTable("vault_blob").set({ attached_at: ctx.now }).where("id", "=", i.upload_id).where("attached_at", "is", null).returning(["kind", "size_bytes", "content_type", "filename", "last4"]).executeTakeFirst();
    if (!b) throw new KumiError("error.vault_upload_gone");
    const id = uuidv7();
    await ctx.insert("vault_item", { id, kind: b.kind, name: cleanName(i.name), note: i.note?.trim() || null, blob_id: i.upload_id, last4: b.last4, filename: b.filename, content_type: b.content_type,
      size_bytes: b.size_bytes, created_by: ctx.actor.personId, created_at: ctx.now, updated_at: ctx.now });
    return { item_id: id };
  },
});

/** A new value for a secret (a key was changed at the supplier), or a newer copy of a document. */
export const vaultReplace = defineAction({
  name: "vault.replace", version: 1, strongAuth: true,
  input: z.object({ item_id: z.uuid(), upload_id: z.uuid() }),
  async plan(ctx, i) {
    ownerHere(ctx);
    const { row, read } = await readRow(ctx.db, "vault_item", i.item_id, "thing.vault_item");
    if (!row.active) throw new KumiError("error.not_found", { thing: both("thing.vault_item") }, 404);
    const b = await waitingUpload(ctx, i.upload_id, row.kind);
    return { title: both("action.vault.replace"), summary: both("plan.vault.replace", { name: row.name, what: describeItem(b) }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) {
    const b = await ctx.trx.updateTable("vault_blob").set({ attached_at: ctx.now }).where("id", "=", i.upload_id).where("attached_at", "is", null).returning(["size_bytes", "content_type", "filename", "last4"]).executeTakeFirst();
    if (!b) throw new KumiError("error.vault_upload_gone");
    await ctx.update("vault_item", i.item_id, { blob_id: i.upload_id, last4: b.last4, filename: b.filename, content_type: b.content_type, size_bytes: b.size_bytes, updated_at: ctx.now });
    return null;
  },
});

export const vaultRemove = defineAction({
  name: "vault.remove", version: 1, strongAuth: true,
  input: z.object({ item_id: z.uuid() }),
  async plan(ctx, i) {
    ownerHere(ctx);
    const { row, read } = await readRow(ctx.db, "vault_item", i.item_id, "thing.vault_item");
    if (!row.active) throw new KumiError("error.not_found", { thing: both("thing.vault_item") }, 404);
    return { title: both("action.vault.remove"), summary: both("plan.vault.remove", { name: row.name }), reads: [read], undo: { kind: "reversible" } };
  },
  async apply(ctx, i) { await ctx.update("vault_item", i.item_id, { active: false, updated_at: ctx.now }); return null; },
});

/** The vault's list for the owner: names, last four characters, file details, and recent downloads. No values. */
export async function vaultList(db: Db | Trx) {
  const items = await db.selectFrom("vault_item").leftJoin("person", "person.id", "vault_item.created_by")
    .select(["vault_item.id", "vault_item.kind", "vault_item.name", "vault_item.note", "vault_item.last4", "vault_item.filename", "vault_item.content_type", "vault_item.size_bytes",
      "vault_item.created_at", "vault_item.updated_at", "person.display_name as by"]).where("vault_item.active", "=", true).orderBy("vault_item.kind").orderBy("vault_item.name").execute();
  const ids = items.length ? items.map((x) => x.id) : ["00000000-0000-0000-0000-000000000000"];
  const access = await db.selectFrom("vault_access").leftJoin("person", "person.id", "vault_access.person_id").select(["vault_access.item_id", "vault_access.at", "person.display_name as by"])
    .where("vault_access.item_id", "in", ids).orderBy("vault_access.at", "desc").limit(50).execute();
  return items.map((x) => ({ ...x, downloads: access.filter((a) => a.item_id === x.id).slice(0, 5).map((a) => ({ at: a.at, by: a.by })) }));
}

/** A document's file for the owner's download, kept as a download. */
export async function vaultDocument(db: Db, itemId: string, personId: string) {
  const r = await db.selectFrom("vault_item").innerJoin("vault_blob", "vault_blob.id", "vault_item.blob_id")
    .select(["vault_item.id", "vault_item.filename", "vault_item.content_type", "vault_blob.bytes"]).where("vault_item.id", "=", itemId).where("vault_item.kind", "=", "document").where("vault_item.active", "=", true).executeTakeFirst();
  if (!r) return null;
  await db.insertInto("vault_access").values({ id: uuidv7(), item_id: r.id, person_id: personId }).execute();
  return { filename: r.filename ?? "document", content_type: r.content_type ?? "application/octet-stream", bytes: openBytes(r.bytes) };
}

/** A secret's value by name, for Kumi's own use on the server (a connection that needs a key). Never sent to
 *  a browser or an agent. */
export async function vaultSecret(db: Db | Trx, name: string): Promise<string | null> {
  const r = await db.selectFrom("vault_item").innerJoin("vault_blob", "vault_blob.id", "vault_item.blob_id").select("vault_blob.bytes")
    .where((eb) => eb(eb.fn("lower", ["vault_item.name"]), "=", name.trim().toLowerCase())).where("vault_item.kind", "=", "secret").where("vault_item.active", "=", true).executeTakeFirst();
  return r ? openBytes(r.bytes).toString("utf8") : null;
}

/** Uploads nobody put in the vault in time are dropped (they were sealed, but there's no need to keep them). */
export async function tidyVaultUploads(db: Db, now = new Date()) {
  const r = await db.deleteFrom("vault_blob").where("attached_at", "is", null).where("created_at", "<", new Date(now.getTime() - VAULT_UPLOAD_MINUTES * 60_000)).executeTakeFirst();
  return { dropped: Number(r.numDeletedRows) };
}
