// What the staff screens read. Reads aren't actions; they're for anyone with a staff role, and
// they answer in the reader's language.
import { Hono, type Context } from "hono";

import { sql } from "kysely";
import { t, type Lang } from "@kumi/i18n";
import { KumiError, PLAYTOMIC, paidFor, shownOdds, standings, type Db } from "@kumi/core";
import { readPeopleCsv } from "./csv.ts";

type Me = { id: string; locale: string } | null;
export function readRoutes(db: Db, me: (c: Context<any>) => Me, lang: (c: Context<any>) => Lang) {
  const app = new Hono();
  app.use("/staff/*", async (c, next) => {
    const m = me(c);
    if (!m) throw new KumiError("error.signed_out", {}, 401);
    const staff = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", m.id).where("person_role.active", "=", true).where("role.key", "!=", "member").executeTakeFirst();
    if (!staff) throw new KumiError("error.staff_only", {}, 403);
    await next();
  });

  // Everything the Settings page edits: the club, and each location with its courts (archived ones left out).
  app.get("/staff/settings", async (c) => {
    const club = await db.selectFrom("club").select(["name", "legal_name", "time_zone", "languages", "default_language", "brand_colour", "sign_up_open"]).executeTakeFirstOrThrow();
    const locations = await db.selectFrom("location").select(["id", "name", "address", "time_zone"]).where("archived_at", "is", null).orderBy("name").execute();
    const courts = await db.selectFrom("court").select(["id", "location_id", "name", "kind", "bookable", "sort"]).where("archived_at", "is", null).orderBy("sort").orderBy("name").execute();
    return c.json({ club, locations: locations.map((l) => ({ ...l, courts: courts.filter((x) => x.location_id === l.id) })) });
  });
  app.get("/staff/locations", async (c) => c.json(await db.selectFrom("location").select(["id", "name", "time_zone"]).where("archived_at", "is", null).orderBy("name").execute()));
  app.get("/staff/courts", async (c) => c.json(await db.selectFrom("court").select(["id", "name", "location_id", "kind"]).where("archived_at", "is", null)
    .$if(Boolean(c.req.query("location_id")), (q) => q.where("location_id", "=", c.req.query("location_id")!)).orderBy("sort").orderBy("name").execute()));
  // Search by name or email; role=staff for everyone with a staff role, or one role's key.
  app.get("/staff/people", async (c) => {
    const q = `%${(c.req.query("q") ?? "").trim()}%`, role = c.req.query("role"), limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 200);
    const roles = (eb: any) => eb.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(sql<string[]>`array_agg(DISTINCT role.key)`.as("r"))
      .whereRef("person_role.person_id", "=", "person.id").where("person_role.active", "=", true);
    return c.json(await db.selectFrom("person").select(["id", "display_name", "email", "created_at"]).select((eb) => roles(eb).as("roles")).where("status", "!=", "archived")
      .where((eb) => eb.or([eb("display_name", "ilike", q), eb("email", "ilike", q)]))
      .$if(Boolean(role), (qb) => qb.where((eb) => eb.exists(eb.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id")
        .whereRef("person_role.person_id", "=", "person.id").where("person_role.active", "=", true)
        .where("role.key", role === "staff" ? "!=" : "=", role === "staff" ? "member" : role!))))
      .orderBy("display_name").limit(limit).execute());
  });
  app.get("/staff/people/:id", async (c) => {
    const id = c.req.param("id");
    const p = await db.selectFrom("person").select(["id", "display_name", "email", "locale", "status", "created_via", "created_at"]).where("id", "=", id).executeTakeFirst();
    if (!p) throw new KumiError("error.not_found", { thing: { en: "person", es: "la persona" } }, 404);
    const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").leftJoin("location", "location.id", "person_role.location_id")
      .select(["role.key", "person_role.location_id", "location.name as location_name"]).where("person_role.person_id", "=", id).where("person_role.active", "=", true).orderBy("role.key").execute();
    const places = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id")
      .select(["enrolment.id", "enrolment.status", "enrolment.program_id", "program.name"])
      .select((eb) => eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").as("first_start"))
      .where("enrolment.person_id", "=", id).orderBy("enrolment.id", "desc").limit(20).execute();
    // The latest answer for each kind of message: consent is append-only.
    const consent = await db.selectFrom("channel_consent").select(["channel", "purpose", "granted", "source", "at"]).distinctOn(["channel", "purpose"])
      .where("person_id", "=", id).orderBy("channel").orderBy("purpose").orderBy("at", "desc").execute();
    return c.json({ ...p, roles, places, consent });
  });
  // Read a spreadsheet of members and say what's in it; nothing changes until person.import is confirmed.
  app.post("/staff/people/import-preview", async (c) => {
    const { csv } = await c.req.json().catch(() => ({ csv: "" })) as { csv?: string };
    const r = readPeopleCsv(String(csv ?? "").slice(0, 2_000_000));
    const l = lang(c);
    return c.json({ rows: r.rows, problems: r.problems.map((p) => ({ line: p.line, text: p.text[l] })), ...(r.fatal ? { fatal: r.fatal[l] } : {}) });
  });

  app.get("/staff/programs", async (c) => {
    const rows = await db.selectFrom("program").selectAll()
      .select((eb) => [
        eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.program_id", "=", "program.id").where("enrolment.status", "=", "booked").as("booked"),
        eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.program_id", "=", "program.id").where("enrolment.status", "=", "waitlisted").as("waitlisted"),
        eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").where("session.status", "!=", "cancelled").as("first_start"),
      ]).where("program.status", "!=", "cancelled").orderBy("program.id", "desc").limit(100).execute();
    return c.json(rows.map((r) => ({ ...r, booked: Number(r.booked ?? 0), waitlisted: Number(r.waitlisted ?? 0) })));
  });

  app.get("/staff/programs/:id", async (c) => {
    const id = c.req.param("id");
    const program = await db.selectFrom("program").selectAll().where("id", "=", id).executeTakeFirst();
    if (!program) throw new KumiError("error.not_found", { thing: { en: "program", es: "el programa" } }, 404);
    const sessions = await db.selectFrom("session").selectAll().where("program_id", "=", id).orderBy("starts_at").execute();
    const courts = await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").select(["court_time.session_id", "court.name"])
      .where("court_time.session_id", "in", sessions.length ? sessions.map((s) => s.id) : ["00000000-0000-0000-0000-000000000000"]).where("court_time.active", "=", true).execute();
    const draws = await db.selectFrom("draw").select("session_id").where("status", "!=", "void").execute();
    const roster = await db.selectFrom("enrolment").innerJoin("person", "person.id", "enrolment.person_id")
      .leftJoin("rating", (j) => j.onRef("rating.person_id", "=", "enrolment.person_id").on("rating.sport", "=", "padel"))
      .select(["enrolment.id", "enrolment.person_id", "person.display_name", "enrolment.status", "enrolment.waitlist_position", "enrolment.paid_by", "enrolment.price_cents",
        "enrolment.left_how", "enrolment.left_reason", "enrolment.refund_outcome", "enrolment.refund_cents", "enrolment.comp_note", "rating.level"])
      .where("enrolment.program_id", "=", id).orderBy("enrolment.status").orderBy("enrolment.waitlist_position").orderBy("enrolment.created_at").execute();
    const offers = await db.selectFrom("waitlist_offer").select(["enrolment_id", "expires_at"]).where("outcome", "is", null).where("expires_at", ">", new Date())
      .where("enrolment_id", "in", roster.length ? roster.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"]).execute();
    return c.json({
      program,
      sessions: sessions.map((s) => ({ ...s, courts: courts.filter((x) => x.session_id === s.id).map((x) => x.name), has_draw: draws.some((d) => d.session_id === s.id) })),
      roster: await Promise.all(roster.map(async (r) => ({ ...r, paid_cents: await paidFor(db, r.id), offer_expires_at: offers.find((o) => o.enrolment_id === r.id)?.expires_at ?? null }))),
    });
  });

  app.get("/staff/sessions/:id/night", async (c) => {
    const id = c.req.param("id");
    const draw = await db.selectFrom("draw").selectAll().where("session_id", "=", id).where("status", "!=", "void").executeTakeFirst();
    const games = await db.selectFrom("game").leftJoin("court", "court.id", "game.court_id").leftJoin("game_set", (j) => j.onRef("game_set.game_id", "=", "game.id").on("game_set.set_no", "=", 1))
      .select(["game.id", "game.round", "game.status", "game.predicted_a", "court.name as court", "game_set.a", "game_set.b"]).where("game.session_id", "=", id).where("game.status", "!=", "void").orderBy("game.round").orderBy("court.name").execute();
    const sides = await db.selectFrom("game_side").innerJoin("person", "person.id", "game_side.person_id").select(["game_side.game_id", "game_side.side", "person.display_name", "person.id"])
      .where("game_side.game_id", "in", games.length ? games.map((g) => g.id) : ["00000000-0000-0000-0000-000000000000"]).orderBy("person.display_name").execute();
    const names = new Map(sides.map((s) => [s.id, s.display_name]));
    const rounds = new Map<number, unknown[]>();
    for (const g of games) {
      const r = rounds.get(g.round!) ?? []; rounds.set(g.round!, r);
      const p = g.predicted_a === null ? 0.5 : shownOdds(Number(g.predicted_a));
      r.push({ id: g.id, court: g.court, status: g.status, odds_a: Math.round(p * 100), a: sides.filter((s) => s.game_id === g.id && s.side === "a").map((s) => s.display_name),
        b: sides.filter((s) => s.game_id === g.id && s.side === "b").map((s) => s.display_name), score: g.a === null ? null : { a: g.a, b: g.b } });
    }
    const table = (await standings(db, id)).map((s) => ({ name: names.get(s.person_id) ?? "", points: s.points, games: s.games }));
    return c.json({ draw: draw ?? null, rounds: [...rounds].map(([round, gs]) => ({ round, games: gs })), standings: table });
  });

  app.get("/staff/people/:id/level", async (c) => {
    const id = c.req.param("id"), l = lang(c);
    const person = await db.selectFrom("person").select(["id", "display_name"]).where("id", "=", id).executeTakeFirst();
    if (!person) throw new KumiError("error.not_found", { thing: { en: "person", es: "la persona" } }, 404);
    const rating = await db.selectFrom("rating").select(["level", "provisional", "floor", "rated_games", "floor_reason"]).where("person_id", "=", id).where("sport", "=", "padel").executeTakeFirst();
    const events = await db.selectFrom("rating_event").select(["at", "kind", "level_before", "level_after", "explanation"]).where("person_id", "=", id).orderBy("id", "desc").limit(50).execute();
    return c.json({ person, rating: rating ?? null, events: events.map((e) => ({ ...e, explanation: (e.explanation as Record<string, string>)[l] ?? "" })) });
  });

  // The Playtomic mirror: how the last copy went, courts still to link, and bookings that clash with Kumi.
  app.get("/staff/mirror", async (c) => {
    const l = lang(c);
    const status = await db.selectFrom("connector_status").selectAll().where("system", "=", PLAYTOMIC).executeTakeFirst();
    const refs = await db.selectFrom("external_ref").select(["external_id", "entity_id"]).where("system", "=", PLAYTOMIC).where("entity", "=", "court").execute();
    const courts = new Map((await db.selectFrom("court").select(["id", "name"]).execute()).map((r) => [r.id, r.name]));
    const ptNames = new Map(((status?.courts ?? []) as { courtRef: string; courtName: string }[]).map((x) => [x.courtRef, x.courtName]));
    const kind = (type: string) => t(l, ({ REGULAR_BOOKING: "pt.regular_booking", OPEN_MATCH: "pt.open_match", PRIVATE_CLASS: "pt.private_class", COURSE_CLASS: "pt.course_class" } as const)[type as "OPEN_MATCH"] ?? "pt.other");
    const conflicts = await db.selectFrom("mirror_booking").leftJoin("court_time", "court_time.id", "mirror_booking.clash_id").leftJoin("session", "session.id", "court_time.session_id").leftJoin("program", "program.id", "session.program_id")
      .select(["mirror_booking.ref", "mirror_booking.court_id", "mirror_booking.booking_type", "program.name as event", "session.id as session_id", sql<Date>`lower(mirror_booking.during)`.as("starts_at"), sql<Date>`upper(mirror_booking.during)`.as("ends_at")])
      .where("mirror_booking.system", "=", PLAYTOMIC).where("mirror_booking.status", "=", "conflict").where(sql<boolean>`upper(mirror_booking.during) > now()`).orderBy(sql`lower(mirror_booking.during)`).execute();
    return c.json({
      status: status ? { last_sync_at: status.last_sync_at, last_ok_at: status.last_ok_at, failed: Boolean(status.last_error), fetched: status.fetched } : null,
      // From the last sync, less any court linked since then.
      unmapped: ((status?.unmapped ?? []) as { courtRef: string }[]).filter((u) => !refs.some((r) => r.external_id === u.courtRef)),
      linked: refs.map((r) => ({ resource_id: r.external_id, name: ptNames.get(r.external_id) ?? r.external_id, court_id: r.entity_id, court: courts.get(r.entity_id) ?? "" })),
      conflicts: conflicts.map((r) => ({ ref: r.ref, court: courts.get(r.court_id) ?? "", kind: kind(r.booking_type), starts_at: r.starts_at, ends_at: r.ends_at, event: r.event, session_id: r.session_id })),
    });
  });
  return app;
}
