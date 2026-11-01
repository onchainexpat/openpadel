// What the staff app reads to write to members (front desk and up): the club's tags, saved groups and
// templates, a live count of who a group means, and the messages already sent with what came of them.
// And the page behind a club news email's unsubscribe link, which needs no sign-in (the key in the
// address stops club news by email for its person, and nothing else).
import { Hono, type Context } from "hono";
import * as z from "zod/mini";
import { t, type Lang } from "@kumi/i18n";
import { audience, broadcastCounts, customAreas, describeFilters, filtersInput, KumiError, segmentMembers, unsubscribe, unsubscribeTarget, type Db, type Filters } from "@kumi/core";
import { readArea } from "./reads.ts";

type Me = { id: string } | null;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function broadcastRoutes(db: Db, me: (c: Context<any>) => Me, lang: (c: Context<any>) => Lang) {
  const app = new Hono();
  const desk = async (c: Context<any>) => {
    const m = me(c);
    if (!m) throw new KumiError("error.signed_out", {}, 401);
    const ok = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id")
      .where("person_role.person_id", "=", m.id).where("person_role.active", "=", true).where("role.key", "in", ["owner", "manager", "front_desk"]).executeTakeFirst();
    // Or a role the club made that covers this page's area (the tags people are given, the messages sent).
    const area = readArea(c.req.path);
    if (!ok && !(area && (await customAreas(db, m.id))?.includes(area))) throw new KumiError("error.staff_only", {}, 403);
    return m.id;
  };
  const tagCounts = async () => {
    const tags = await db.selectFrom("tag").select(["tag.id", "tag.name"]).select((eb) => eb.selectFrom("person_tag").innerJoin("person", "person.id", "person_tag.person_id")
      .select((x) => x.fn.countAll<string>().as("n")).whereRef("person_tag.tag_id", "=", "tag.id").where("person_tag.removed_at", "is", null).where("person.status", "!=", "archived").as("people"))
      .where("tag.active", "=", true).orderBy("tag.name").execute();
    return tags.map((x) => ({ id: x.id, name: x.name, people: Number(x.people ?? 0) }));
  };

  // Everything the group builder and the message form choose from.
  app.get("/staff/broadcast-options", async (c) => {
    await desk(c);
    const club = await db.selectFrom("club").select(["languages", "broadcast_daily_cap"]).executeTakeFirstOrThrow();
    const plans = await db.selectFrom("membership_plan").select(["id", "name"]).where("active", "=", true).orderBy("sort").orderBy("name").execute();
    const programs = await db.selectFrom("program").select(["program.id", "program.name"])
      .select((eb) => eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").where("session.status", "!=", "cancelled").as("first_start"))
      .where("program.status", "!=", "cancelled").orderBy("program.id", "desc").limit(100).execute();
    const templates = await db.selectFrom("message_template").selectAll().where("active", "=", true).orderBy("name").execute();
    const segments = await db.selectFrom("segment").select(["id", "name", "filters"]).where("active", "=", true).orderBy("name").execute();
    return c.json({ languages: club.languages, daily_cap: club.broadcast_daily_cap, plans, programs, tags: await tagCounts(), templates, segments });
  });

  app.get("/staff/tags", async (c) => { await desk(c); return c.json(await tagCounts()); });

  // The saved groups, each with what it means and how many it matches now.
  app.get("/staff/segments", async (c) => {
    await desk(c);
    const l = lang(c), now = new Date();
    const rows = await db.selectFrom("segment").selectAll().where("active", "=", true).orderBy("name").execute();
    return c.json(await Promise.all(rows.map(async (s) => ({ id: s.id, name: s.name, filters: s.filters, what: (await describeFilters(db, s.filters as Filters))[l],
      people: (await segmentMembers(db, s.filters as Filters, now)).length }))));
  });

  // Who a group means right now: how many, a few names, and, for a purpose, who it would reach.
  const CountBody = z.object({ filters: filtersInput, purpose: z.optional(z.enum(["club_news", "service"])) });
  app.post("/staff/segments/count", async (c) => {
    await desk(c);
    const b = z.safeParse(CountBody, await c.req.json().catch(() => ({})));
    if (!b.success) throw new KumiError("error.invalid_input", { details: z.prettifyError(b.error) }, 400);
    const a = await audience(db, b.data.filters, b.data.purpose ?? "club_news", new Date());
    return c.json({ matched: a.matched, recipients: a.recipients.length, left_out: a.leftOut, via_parents: a.viaParents, sample: a.sample, what: (await describeFilters(db, b.data.filters))[lang(c)] });
  });

  app.get("/staff/templates", async (c) => { await desk(c); return c.json(await db.selectFrom("message_template").selectAll().where("active", "=", true).orderBy("name").execute()); });

  // The messages sent to members, newest first, with what came of each, by channel.
  app.get("/staff/broadcasts", async (c) => {
    await desk(c);
    const l = lang(c);
    const rows = await db.selectFrom("broadcast").leftJoin("person", "person.id", "broadcast.created_by").selectAll("broadcast").select("person.display_name as sender")
      .orderBy("broadcast.created_at", "desc").limit(100).execute();
    const counts = await broadcastCounts(db, rows.map((r) => r.id));
    // When the next email still waiting goes (later today under the cap, or after quiet hours): what "stop the rest" would stop.
    const next = rows.length ? new Map((await db.selectFrom("outbound_message").select((eb) => ["broadcast_id", eb.fn.min("send_after").as("at")]).where("broadcast_id", "in", rows.map((r) => r.id))
      .where("kind", "=", "broadcast").where("channel", "=", "email").where("status", "=", "waiting").groupBy("broadcast_id").execute()).map((r) => [r.broadcast_id, r.at as Date])) : new Map();
    return c.json(await Promise.all(rows.map(async (b) => {
      const words = l === "es" ? (b.subject_es ? { subject: b.subject_es, body: b.body_es } : { subject: b.subject_en, body: b.body_en }) : (b.subject_en ? { subject: b.subject_en, body: b.body_en } : { subject: b.subject_es, body: b.body_es });
      return { id: b.id, purpose: b.purpose, status: b.status, subject: words.subject, body: words.body, group: b.segment_name, what: (await describeFilters(db, b.filters as Filters))[l],
        send_at: b.send_at, sent_at: b.sent_at, cancelled_at: b.cancelled_at, sender: b.sender, recipients: b.recipients, left_out: b.left_out_consent, email_days: b.email_days, counts: counts.get(b.id) ?? {}, next_email_at: next.get(b.id) ?? null };
    })));
  });

  // ---- The unsubscribe link ----
  const page = (l: Lang, club: string, body: string) => `<!doctype html><html lang="${l}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(t(l, "unsub.title", { club }))}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1d2321;background:#fff}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #1d2321;background:#1d2321;color:#fff;cursor:pointer}.meta{color:#555}</style></head>
<body><h1>${esc(t(l, "unsub.title", { club }))}</h1>${body}</body></html>`;
  app.get("/unsubscribe/:token", async (c) => {
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    const who = await unsubscribeTarget(db, c.req.param("token"));
    if (!who) return c.html(page(lang(c), "", `<p>${esc(t(lang(c), "unsub.bad"))}</p>`), 404);
    // A link opened (or checked by a mail scanner) changes nothing: the button does.
    if (who.answer === false) return c.html(page(who.lang, who.club, `<p>${esc(t(who.lang, "unsub.already", { club: who.club }))}</p><p class="meta">${esc(t(who.lang, "unsub.back"))}</p>`));
    return c.html(page(who.lang, who.club, `<p>${esc(t(who.lang, "unsub.ask", { club: who.club }))}</p><form method="post"><button type="submit">${esc(t(who.lang, "unsub.button"))}</button></form>`));
  });
  // The button, and mail apps' one-click (RFC 8058: a POST with "List-Unsubscribe=One-Click").
  app.post("/unsubscribe/:token", async (c) => {
    c.header("cache-control", "no-store");
    const token = c.req.param("token"), who = await unsubscribeTarget(db, token);
    if (!who) return c.html(page(lang(c), "", `<p>${esc(t(lang(c), "unsub.bad"))}</p>`), 404);
    const form = await c.req.text().catch(() => "");
    await unsubscribe(db, token, /List-Unsubscribe=One-Click/i.test(form) ? "one_click" : "page");
    return c.html(page(who.lang, who.club, `<p>${esc(t(who.lang, "unsub.done", { club: who.club }))}</p><p class="meta">${esc(t(who.lang, "unsub.back"))}</p>`));
  });
  return app;
}
