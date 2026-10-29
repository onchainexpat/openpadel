import { serve } from "@hono/node-server";
import { connect, migrate, PlaytomicClient, syncMirror } from "@kumi/core";
import { makeApp } from "./app.ts";
import { MemoryMailer } from "./mailer.ts";

const db = connect();
const applied = await migrate(db);
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
const port = Number(process.env.PORT ?? 8790);
const publicUrl = process.env.KUMI_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
serve({ fetch: makeApp({ db, mailer: new MemoryMailer(true), publicUrl, secureCookies: process.env.NODE_ENV === "production", production: process.env.NODE_ENV === "production" }).fetch, port });
console.log(`kumi server on http://127.0.0.1:${port}`);

// The read-only Playtomic mirror, when the club has given Kumi its Third Party API keys (through the
// environment, never the database or the code). One sync at a time, then a rest; pages are a minute apart.
const pt = { clientId: process.env.KUMI_PLAYTOMIC_CLIENT_ID, secret: process.env.KUMI_PLAYTOMIC_SECRET, tenantId: process.env.KUMI_PLAYTOMIC_TENANT_ID };
if (pt.clientId && pt.secret && pt.tenantId) {
  const client = new PlaytomicClient({ clientId: pt.clientId, secret: pt.secret, tenantId: pt.tenantId });
  const every = Number(process.env.KUMI_MIRROR_EVERY_MINUTES ?? 10) * 60_000, daysAhead = Number(process.env.KUMI_MIRROR_DAYS_AHEAD ?? 30);
  const loop = async () => {
    try {
      const r = await syncMirror(db, client, { daysAhead });
      console.log(r.ok ? `playtomic mirror: ${r.fetched} read, ${r.changes} changed, ${r.unmapped.length} courts to link` : `playtomic mirror failed: ${r.error}`);
    } catch (e) { console.error("playtomic mirror:", (e as Error).message); }
    finally { setTimeout(loop, every); }
  };
  void loop();
  console.log("playtomic mirror on");
}
