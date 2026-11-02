// The owner's "Download everything" in the staff app: after confirming club.export (club_exit.ts), the app asks
// for the file to be made, gets the passphrase that opens it once, and downloads it. The file waits here, in
// memory, for CLUB_EXPORT_MINUTES; the passphrase is never kept, logged or shown again.
import { Hono, type Context } from "hono";
import { CLUB_EXPORT_MINUTES, exportClubRun, KumiError, type Db } from "@kumi/core";
import { RateLimiter } from "./limits.ts";
import { makeExport } from "./export.ts";

type Me = { id: string } | null;
interface Held { runId: string; personId: string; name: string; file: Buffer; until: number }

export function exportRoutes(db: Db, me: (c: Context<any>) => Me, o: { databaseUrl: string | null; now: () => Date }) {
  const app = new Hono();
  // One file at a time: a club's export can be tens of megabytes, held in memory until it's fetched.
  let held: Held | null = null, making = false;
  const made = new Set<string>(), tries = new RateLimiter(5, 60 * 60_000);
  const signedIn = (c: Context<any>) => { const m = me(c); if (!m) throw new KumiError("error.signed_out", {}, 401); return m; };

  app.post("/staff/export/:run", async (c) => {
    const m = signedIn(c), runId = c.req.param("run"), now = o.now();
    await exportClubRun(db, runId, m.id, now);
    if (made.has(runId)) throw new KumiError("error.club_export_made", {}, 409);
    if (making) throw new KumiError("error.club_export_busy", {}, 409);
    if (!tries.take(m.id, now.getTime())) throw new KumiError("error.too_many_requests", {}, 429);
    if (!o.databaseUrl) throw new KumiError("error.club_export_failed", { error: "DATABASE_URL isn't set" }, 500);
    making = true;
    try {
      const r = await makeExport(db, { url: o.databaseUrl, now });
      made.add(runId);
      held = { runId, personId: m.id, name: r.name, file: r.file, until: now.getTime() + CLUB_EXPORT_MINUTES * 60_000 };
      c.header("cache-control", "no-store");
      return c.json({ passphrase: r.passphrase, name: r.name, bytes: r.file.length, download: `/staff/export/${runId}/file`, minutes: CLUB_EXPORT_MINUTES });
    } catch (e) {
      if (e instanceof KumiError) throw e;
      console.error("club export:", (e as Error).message);
      throw new KumiError("error.club_export_failed", { error: (e as Error).message.split("\n")[0]! }, 500);
    } finally { making = false; }
  });

  app.get("/staff/export/:run/file", async (c) => {
    const m = signedIn(c), runId = c.req.param("run"), now = o.now();
    if (held && held.until < now.getTime()) held = null;
    if (!held || held.runId !== runId || held.personId !== m.id) throw new KumiError("error.club_export_gone", {}, 404);
    c.header("content-type", "application/octet-stream");
    c.header("content-disposition", `attachment; filename="${held.name}"`);
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "no-store");
    return c.body(new Uint8Array(held.file));
  });
  return app;
}
