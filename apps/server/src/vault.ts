// The club vault's routes (core/vault.ts): the owner's app sends a value or file here first, sealed into the
// waiting room, then previews and confirms vault.add or vault.replace naming the upload. The list never has a
// value in it; a document comes back only to the owner, as a download that's kept on record.
import { Hono, type Context } from "hono";
import { both, type Lang } from "@kumi/i18n";
import { hasSecondFactor, KumiError, pluginKeyRequests, safeFilename, secondStepForChanges, stageVaultUpload, vaultDocument, vaultList, VAULT_DOC_MAX_BYTES, VAULT_SECRET_MAX, type Db } from "@kumi/core";

type Me = { id: string; method?: string } | null;

/** The owner, signed in with a second step: its changes are sensitive (strongAuth), and so is reading what it keeps,
 *  whether or not the club asks a second step at sign-in. */
export async function ownerOnly(db: Db, me: Me) {
  if (!me) throw new KumiError("error.signed_out", {}, 401);
  const owner = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
    .where("person_role.person_id", "=", me.id).where("person_role.active", "=", true).where("role.key", "=", "owner").executeTakeFirst();
  if (!owner) throw new KumiError("error.vault_owner_only", {}, 403);
  if (me.method !== "passkey" && me.method !== "two_factor" && await secondStepForChanges(db, me.id))
    throw new KumiError((await hasSecondFactor(db, me.id)) ? "error.need_passkey" : "error.second_step_to_change", {}, 403);
  return me;
}

export function vaultRoutes(db: Db, me: (c: Context<any>) => Me, now: () => Date, lang: (c: Context<any>) => Lang = () => "en") {
  const app = new Hono();
  app.get("/staff/vault", async (c) => {
    await ownerOnly(db, me(c));
    // And the keys installed plugins still need (plugins.ts): each asked for by name, with where the owner gets it.
    return c.json({ items: await vaultList(db), limits: { secret_chars: VAULT_SECRET_MAX, document_bytes: VAULT_DOC_MAX_BYTES }, requests: await pluginKeyRequests(db, lang(c)) });
  });
  app.post("/staff/vault/upload", async (c) => {
    const m = await ownerOnly(db, me(c));
    const b = await c.req.json().catch(() => ({})) as { kind?: unknown; value?: unknown; filename?: unknown; data?: unknown };
    if (b.kind === "secret" && typeof b.value === "string") return c.json(await stageVaultUpload(db, m.id, { kind: "secret", value: b.value }, now()));
    if (b.kind === "document" && typeof b.data === "string" && typeof b.filename === "string") {
      if (b.data.length > Math.ceil(VAULT_DOC_MAX_BYTES / 3) * 4 + 4) throw new KumiError("error.vault_doc_big", { mb: VAULT_DOC_MAX_BYTES / 1_000_000 }, 413);
      return c.json(await stageVaultUpload(db, m.id, { kind: "document", bytes: Buffer.from(b.data, "base64"), filename: b.filename }, now()));
    }
    throw new KumiError("error.invalid_input", {}, 400);
  });
  app.get("/staff/vault/:id/file", async (c) => {
    const m = await ownerOnly(db, me(c)), id = c.req.param("id");
    const doc = /^[0-9a-f-]{36}$/i.test(id) ? await vaultDocument(db, id, m.id) : null;
    if (!doc) throw new KumiError("error.not_found", { thing: both("thing.vault_item") }, 404);
    // Always a download, never shown in the page: the type came from the file's own first bytes when it was kept.
    c.header("content-type", doc.content_type);
    c.header("content-disposition", `attachment; filename="${safeFilename(doc.filename)}"`);
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "no-store");
    return c.body(new Uint8Array(doc.bytes));
  });
  return app;
}
