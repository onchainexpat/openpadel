// What the staff screens read. Reads aren't actions; they're for anyone with a staff role, and
// they answer in the reader's language.
import { Hono, type Context } from "hono";

import { sql } from "kysely";
import { dateTime, t, type Key, type Lang } from "@kumi/i18n";
import { assistantsOf, coachEarnings, coachSchedule, coachItem, coachStudents, rosterOf, ATTENDANCE_HOURS, STUDENT_DAYS, coveredBy, currentPolicy, currentWaiver, householdOf, waiverStatus, endDay, levelQueue, MOVE_DAYS, MOVE_LIMIT, sessionPlayers, freeCourts, gameView, KumiError, localDate, occupied, courtOpenings, spanOf, PLAYTOMIC, paidFor, planCounts, quote, shownOdds, standings, type Db , kidOf, monthSpent, rulesText, questionList, questionThread, searchFacts, memberPlan, levelOf, managersOf, segmentMembers, type Filters, membersFrom, publishCheck, customAreas, roleCatalogue, roleGrantsView, activeFactor, recoveryLeft, staffAlerts, currentAnswerer, factIn, textingOn, textingRegistration } from "@kumi/core";
import { textingStatusText } from "./texting.ts";
import { readPeopleCsv } from "./csv.ts";

type Me = { id: string; locale: string } | null;
/** Which area a staff page's data belongs to (roles.ts AREAS), for roles the club made. Lists every area uses
 *  (locations, courts) belong to none. */
/** The read areas a coach with no other staff role sees (the staff app shows them the same). */
export const COACH_READS = ["bookings", "programs", "levels", "coaches"];
/** And, outside those, the pages that answer a coach about themselves: their own earnings, and a question count of 0. */
const COACH_ALSO = /^\/staff\/(coach-earnings(\.csv)?|questions\/count)$/;
const READ_AREAS: [RegExp, string][] = [
  [/^\/staff\/(people\/[^/]+\/level|levels|sessions\/[^/]+\/levels|scores)/, "levels"],
  [/^\/staff\/(people|tags)/, "members"], [/^\/staff\/(programs|sessions|roster)/, "programs"], [/^\/staff\/memberships/, "memberships"],
  [/^\/staff\/(reports|coach-earnings|payments|receipts)/, "money"], [/^\/staff\/(settings|roles|vault)/, "settings"],
  [/^\/staff\/(questions|facts|broadcast|broadcasts|segments|templates)/, "messages"], [/^\/staff\/(grid|quote|mirror|alerts)/, "bookings"],
  [/^\/staff\/(coaches|my-schedule|students|calendar-link)/, "coaches"],
];
export const readArea = (path: string) => READ_AREAS.find(([re]) => re.test(path))?.[1] ?? null;
export function readRoutes(db: Db, me: (c: Context<any>) => Me, lang: (c: Context<any>) => Lang) {
  const app = new Hono();
  app.use("/staff/*", async (c, next) => {
    const m = me(c);
    if (!m) throw new KumiError("error.signed_out", {}, 401);
    const staff = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", m.id).where("person_role.active", "=", true).where("role.active", "=", true).where("role.key", "!=", "member").executeTakeFirst();
    if (!staff) throw new KumiError("error.staff_only", {}, 403);
    // Someone whose only staff roles are ones the club made reads only the areas those roles cover.
    const areas = await customAreas(db, m.id), area = readArea(c.req.path);
    if (areas && area && !areas.includes(area)) throw new KumiError("error.staff_only", {}, 403);
    // A coach (and nothing else on staff) reads their own work: no club money, no member list or contact details,
    // no memberships, messages or settings (permissions.md). Their own students' pages stay open to them.
    if (!areas && area && !COACH_READS.includes(area) && !COACH_ALSO.test(c.req.path) && await coachOnly(m.id)) {
      const one = /^\/staff\/people\/([0-9a-f-]{36})$/.exec(c.req.path)?.[1];
      if (!(one && area === "members" && (await coachStudents(db, m.id, new Date())).some((s) => s.person_id === one))) throw new KumiError("error.staff_only", {}, 403);
    }
    await next();
  });
  const coachOnly = async (id: string) => { const k = (await rolesOf(id)).filter((r) => r !== "member"); return k.length > 0 && k.every((r) => r === "coach"); };

  const rolesOf = async (id: string) => (await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
    .where("person_role.person_id", "=", id).where("person_role.active", "=", true).execute()).map((r) => r.key);
  const deskUp = (roles: string[]) => roles.some((r) => ["owner", "manager", "front_desk"].includes(r));

  // ---- Coaches ----
  // Everyone with the coach role, with their profile (if they have one yet), lesson hours and time off coming
  // up. Front desk and up see them all; a coach sees their own.
  app.get("/staff/coaches", async (c) => {
    const m = me(c)!, roles = await rolesOf(m.id), all = deskUp(roles);
    if (!all && !roles.includes("coach")) throw new KumiError("error.staff_only", {}, 403);
    const people = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").innerJoin("person", "person.id", "person_role.person_id")
      .select(["person.id", "person.display_name"]).distinct().where("role.key", "=", "coach").where("person_role.active", "=", true).where("person.status", "!=", "archived")
      .$if(!all, (q) => q.where("person.id", "=", m.id)).orderBy("person.display_name").execute();
    const ids = people.length ? people.map((p) => p.id) : ["00000000-0000-0000-0000-000000000000"];
    const profiles = await db.selectFrom("coach").selectAll().where("person_id", "in", ids).execute();
    const hours = await db.selectFrom("coach_hours").select(["coach_id", "location_id", "weekday", "starts", "ends"]).where("coach_id", "in", ids).where("active", "=", true).orderBy("weekday").orderBy("starts").execute();
    const off = await db.selectFrom("coach_time_off").select(["id", "coach_id", "note", sql<Date>`lower(during)`.as("start"), sql<Date>`upper(during)`.as("end")])
      .where("coach_id", "in", ids).where("active", "=", true).where(sql<boolean>`upper(during) > now()`).orderBy(sql`lower(during)`).execute();
    const tz = await clubTz(), day = (d: Date) => localDate(new Date(d), tz), t5 = (x: string) => x.slice(0, 5);
    const policy = await currentPolicy(db), locations = await db.selectFrom("location").select(["id", "name"]).where("archived_at", "is", null).orderBy("name").execute();
    return c.json({ can_edit_all: all, lengths: policy.lengths, locations, coaches: people.map((p) => {
      const pr = profiles.find((x) => x.person_id === p.id);
      return { id: p.id, name: p.display_name, profile: pr ? { ...pr, photo: pr.photo_id ? `/public/photos/${pr.photo_id}` : null } : null,
        hours: hours.filter((h) => h.coach_id === p.id).map((h) => ({ location_id: h.location_id, weekday: h.weekday, starts: t5(h.starts), ends: t5(h.ends) })),
        time_off: off.filter((o) => o.coach_id === p.id).map((o) => ({ id: o.id, note: o.note, from: day(o.start), to: day(new Date(new Date(o.end).getTime() - 1)) })) };
    }) });
  });
  // The signed-in coach's lessons and sessions, for the next two weeks (and the last two days, while who came
  // can still be marked).
  app.get("/staff/my-schedule", async (c) => {
    const m = me(c)!, now = new Date();
    const rows = await coachSchedule(db, m.id, new Date(now.getTime() - ATTENDANCE_HOURS * 3600_000), new Date(now.getTime() + 14 * 864e5));
    return c.json({ time_zone: await clubTz(), items: rows });
  });
  // Who's coming to a lesson or a program date, and who came: the coach who runs it, or front desk and up.
  app.get("/staff/roster/:kind/:id", async (c) => {
    const m = me(c)!, roles = await rolesOf(m.id), kind = c.req.param("kind");
    if (kind !== "lesson" && kind !== "session") throw new KumiError("error.not_found", { thing: { en: "page", es: "la página" } }, 404);
    const item = await coachItem(db, kind, c.req.param("id"));
    if (!deskUp(roles) && !(roles.includes("coach") && item.coach_id === m.id)) throw new KumiError("error.staff_only", {}, 403);
    const r = await rosterOf(db, kind, item.id, new Date());
    return c.json({ ...r, time_zone: await clubTz(), hours: ATTENDANCE_HOURS });
  });
  // The people a coach worked with lately. A coach sees their own; front desk and up pick any coach.
  app.get("/staff/students", async (c) => {
    const m = me(c)!, roles = await rolesOf(m.id), desk = deskUp(roles), asked = c.req.query("coach");
    if (!desk && !roles.includes("coach")) throw new KumiError("error.staff_only", {}, 403);
    const coachId = desk ? (asked || (roles.includes("coach") ? m.id : null)) : m.id;
    const coaches = desk ? await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").innerJoin("person", "person.id", "person_role.person_id")
      .select(["person.id", "person.display_name as name"]).distinct().where("role.key", "=", "coach").where("person_role.active", "=", true).where("person.status", "!=", "archived").orderBy("person.display_name").execute() : [];
    if (!coachId) return c.json({ coach: null, coaches, days: STUDENT_DAYS, time_zone: await clubTz(), students: [] });
    const coach = await db.selectFrom("person").select(["id", "display_name as name"]).where("id", "=", coachId).executeTakeFirst();
    if (!coach) throw new KumiError("error.not_found", { thing: { en: "coach", es: "el entrenador" } }, 404);
    return c.json({ coach, coaches, days: STUDENT_DAYS, time_zone: await clubTz(), students: await coachStudents(db, coachId, new Date()) });
  });
  // For payroll: each coach's lessons (paid, less refunds) and the sessions they ran. Owners, managers and the
  // accountant see every coach; a coach sees their own.
  async function earnings(c: Context<any>) {
    const m = me(c)!, roles = await rolesOf(m.id), all = roles.some((r) => ["owner", "manager", "accountant"].includes(r));
    if (!all && !roles.includes("coach")) throw new KumiError("error.staff_only", {}, 403);
    const from = c.req.query("from") ?? "", to = c.req.query("to") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new KumiError("error.invalid_input", { details: "from and to (YYYY-MM-DD)" }, 400);
    const r = await coachEarnings(db, from, to, all ? undefined : [m.id]);
    return { ...r, lessons: r.lessons.filter((l) => l.status !== "cancelled" || l.paid_cents > 0) };
  }
  app.get("/staff/coach-earnings", async (c) => c.json(await earnings(c)));
  app.get("/staff/coach-earnings.csv", async (c) => {
    const r = await earnings(c), l = lang(c);
    const at = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: r.time_zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d)).replace(",", "");
    const q = (v: unknown) => { const x = String(v ?? ""); return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    const head = ["coach", "kind", "when", "minutes", "what", "status", "paid", "refunded", "net"].map((k) => t(l, `csv.${k}` as Key));
    const lines = [
      ...r.lessons.map((x) => [x.coach, t(l, "csv.lesson"), at(x.start), x.minutes, `${x.code} ${x.booked_by ?? ""} (${x.court})`, t(l, `csv.status_${x.status === "cancelled" ? "cancelled" : "held"}` as Key),
        (x.paid_cents / 100).toFixed(2), (x.refunded_cents / 100).toFixed(2), (x.net_cents / 100).toFixed(2)]),
      ...r.sessions.map((x) => [x.coach, t(l, "csv.session"), at(x.start), x.minutes, x.name, t(l, "csv.status_held"), "", "", ""]),
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2]))).map((row) => row.map(q).join(","));
    c.header("content-type", "text/csv; charset=utf-8"); c.header("content-disposition", `attachment; filename="kumi-coaches-${r.from}-to-${r.to}.csv"`);
    return c.body([head.join(","), ...lines].join("\r\n") + "\r\n");
  });

  // Scores the club has to decide (disputed), and the last few entered, with what each side said.
  app.get("/staff/scores", async (c) => {
    const rows = await db.selectFrom("game").innerJoin("booking", "booking.id", "game.booking_id").innerJoin("court", "court.id", "game.court_id").innerJoin("location", "location.id", "court.location_id")
      .select(["game.id", "game.status", "game.rated", "game.played_at", "court.name as court", "location.time_zone"])
      .where("game.booking_id", "is not", null).where((eb) => eb.or([eb("game.status", "=", "disputed"), eb("game.played_at", ">", sql<Date>`now() - interval '14 days'`)]))
      .orderBy(sql`game.status = 'disputed'`, "desc").orderBy("game.played_at", "desc").limit(100).execute();
    return c.json(await Promise.all(rows.map(async (r) => {
      const g = await gameView(db, r.id);
      const answers = await db.selectFrom("result_answer").leftJoin("person", "person.id", "result_answer.person_id").select(["result_answer.answer", "result_answer.note", "result_answer.at", "person.display_name"])
        .where("result_answer.game_id", "=", r.id).orderBy("result_answer.at").execute();
      return { ...r, sets: g.sets, a: g.a.map((x) => x.display_name), b: g.b.map((x) => x.display_name), answers };
    })));
  });
  const clubTz = async () => (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;
  // Membership plans and who holds one (with the last few that ended).
  app.get("/staff/memberships", async (c) => {
    const counts = await planCounts(db);
    const plans = await db.selectFrom("membership_plan").selectAll().where("active", "=", true).orderBy("sort").orderBy("name").execute();
    const members = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id").innerJoin("person", "person.id", "membership.person_id")
      .select(["membership.id", "membership.person_id", "person.display_name", "person.email", "membership_plan.name as plan", "membership.status", "membership.source", "membership.started_at",
        "membership.current_period_end", "membership.cancel_at_period_end", "membership.ended_at", "membership.end_reason", "membership.note", "membership.price_cents", "membership.paused_until",
        sql<boolean>`membership.saved_method IS NOT NULL`.as("card_saved")])
      .where((eb) => eb.or([eb("membership.status", "in", ["upcoming", "active", "past_due"]), eb("membership.ended_at", ">", sql<Date>`now() - interval '30 days'`)]))
      .orderBy("membership.status").orderBy("person.display_name").limit(500).execute();
    const tz = await clubTz(), now = new Date();
    // A family membership: the others it covers now.
    const others = members.length ? await db.selectFrom("membership_member").innerJoin("person", "person.id", "membership_member.person_id").select(["membership_member.membership_id", "person.display_name"])
      .where("membership_member.membership_id", "in", members.map((m) => m.id)).where((w) => w.or([w("membership_member.ends_at", "is", null), w("membership_member.ends_at", ">", now)]))
      .orderBy("membership_member.created_at").execute() : [];
    return c.json({ plans: plans.map((p) => ({ ...p, members: counts.get(p.id) ?? 0 })),
      members: members.map((m) => ({ ...m, also_covers: others.filter((o) => o.membership_id === m.id).map((o) => o.display_name),
        ends_on: m.current_period_end ? endDay({ current_period_end: m.current_period_end, source: m.source }, tz) : null })) });
  });

  // Everything the Settings page edits: the club, and each location with its courts (archived ones left out).
  app.get("/staff/settings", async (c) => {
    const club = await db.selectFrom("club").select(["name", "legal_name", "time_zone", "languages", "default_language", "brand_colour", "sign_up_open", "court_bookings", "tax_rate_bp", "public_page", "about", "two_factor", "question_alert_hours", "auto_answers", "broadcast_daily_cap", "broadcast_copy_managers", "program_decide_hours", "program_heads_up_hours"]).executeTakeFirstOrThrow();
    const rules = await db.selectFrom("price_rule").selectAll().where("active", "=", true).orderBy("priority", "desc").orderBy("name").execute();
    const policy = await currentPolicy(db), plans = await db.selectFrom("membership_plan").select(["id", "name"]).where("active", "=", true).orderBy("sort").orderBy("name").execute();
    const locations = await db.selectFrom("location").select(["id", "name", "address", "time_zone"]).where("archived_at", "is", null).orderBy("name").execute();
    const courts = await db.selectFrom("court").select(["id", "location_id", "name", "kind", "bookable", "sort"]).where("archived_at", "is", null).orderBy("sort").orderBy("name").execute();
    const hours = await db.selectFrom("opening_hours").select(["location_id", "weekday", "opens", "closes"]).execute();
    const own = await db.selectFrom("court_hours").select(["court_id", "weekday", "opens", "closes"]).where("active", "=", true).execute();
    const today = localDate(new Date(), club.time_zone);
    const special = await db.selectFrom("hours_exception").select(["id", "location_id", "court_id", "on_date", "opens", "closes", "note"]).where("active", "=", true)
      .where("on_date", ">=", today).orderBy("on_date").execute();
    const t5 = (x: string | null) => (x ? x.slice(0, 5) : null);
    const waiver = await currentWaiver(db);
    // Which decision model answers questions, if the server has one ("staff_only" if not): Settings says so.
    // Texts: whether they go, and where the carrier registration `kumi texting` runs stands (texting.ts).
    const reg = await textingRegistration(db);
    const texting = { on: textingOn(), status: reg?.status ?? null, number: reg?.phone_number ?? null, said: reg ? textingStatusText(reg, lang(c), club.time_zone) : [] };
    // Each court's own week: a weekday it has no hours of its own for is left out (it follows the location's).
    const courtWeek = (id: string) => own.filter((x) => x.court_id === id).sort((a, b) => a.weekday - b.weekday).map((x) => ({ weekday: x.weekday, opens: t5(x.opens), closes: t5(x.closes) }));
    return c.json({ club, answerer: currentAnswerer().name, texting, policy, plans, waiver: waiver ? { version_no: waiver.version_no, body: waiver.body } : null, locations: locations.map((l) => ({ ...l,
      courts: courts.filter((x) => x.location_id === l.id).map((x) => ({ ...x, hours: courtWeek(x.id) })),
      prices: rules.filter((r) => r.location_id === l.id).map((r) => ({ ...r, starts: t5(r.starts), ends: t5(r.ends) })),
      hours: [0, 1, 2, 3, 4, 5, 6].map((w) => { const h = hours.find((x) => x.location_id === l.id && x.weekday === w); return { weekday: w, opens: t5(h?.opens ?? null), closes: t5(h?.closes ?? null) }; }),
      special_days: special.filter((x) => x.location_id === l.id).map((x) => ({ ...x, opens: t5(x.opens), closes: t5(x.closes) })) })) });
  });

  // Occupancy and revenue by day: court hours open, what used them (bookings, programs, Playtomic) and what
  // was blocked, and the money from the ledger (court and program revenue, net of refunds; club-wide).
  async function report(locationId: string, from: string, to: string) {
    if (!/^[0-9a-f-]{36}$/i.test(locationId)) throw new KumiError("error.invalid_input", { details: "location_id, from and to (YYYY-MM-DD)" }, 400);
    const loc = await db.selectFrom("location").select(["id", "name", "time_zone"]).where("id", "=", locationId).executeTakeFirst();
    if (!loc || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new KumiError("error.invalid_input", { details: "location_id, from and to (YYYY-MM-DD)" }, 400);
    const courts = await db.selectFrom("court").select("id").where("location_id", "=", loc.id).where("archived_at", "is", null).where("bookable", "=", true).execute();
    const days: string[] = [];
    for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to && days.length < 92; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
    const money = await db.selectFrom("ledger_entry").innerJoin("ledger_txn", "ledger_txn.id", "ledger_entry.txn_id").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id")
      .select([sql<string>`to_char(ledger_txn.at AT TIME ZONE ${loc.time_zone}, 'YYYY-MM-DD')`.as("day"), "ledger_account.revenue_type", sql<string>`sum(-ledger_entry.amount_cents)`.as("cents")])
      .where("ledger_account.kind", "=", "revenue").where(sql<boolean>`(ledger_txn.at AT TIME ZONE ${loc.time_zone})::date BETWEEN ${from}::date AND ${to}::date`)
      .groupBy(["day", "ledger_account.revenue_type"]).execute();
    const rows = [];
    for (const day of days) {
      // Each court counts its own hours that day (a court's own week, or the location's).
      const hours = await courtOpenings(db, loc.id, courts.map((x) => x.id), day), open = spanOf([...hours.values()]);
      const openMin = open ? (open.closes.getTime() - open.opens.getTime()) / 60_000 : 0, by: Record<string, number> = {};
      let capacity = 0;
      for (const h of hours.values()) if (h) capacity += (h.closes.getTime() - h.opens.getTime()) / 60_000;
      if (open) for (const it of await occupied(db, courts.map((x) => x.id), open.opens, open.closes, new Date(0))) {
        const h = hours.get(it.court_id);
        if (!h) continue;
        const m = (Math.min(new Date(it.end).getTime(), h.closes.getTime()) - Math.max(new Date(it.start).getTime(), h.opens.getTime())) / 60_000;
        if (m > 0) by[it.kind] = (by[it.kind] ?? 0) + m;
      }
      const used = (by.booking ?? 0) + (by.session ?? 0) + (by.mirror ?? 0), blocked = by.block ?? 0;
      const cents = (type: string) => Number(money.find((r) => r.day === day && r.revenue_type === type)?.cents ?? 0);
      rows.push({ date: day, open_hours: openMin / 60, courts: courts.length, court_hours: capacity / 60, booked_hours: (by.booking ?? 0) / 60, program_hours: (by.session ?? 0) / 60,
        playtomic_hours: (by.mirror ?? 0) / 60, blocked_hours: blocked / 60, occupancy_percent: capacity - blocked > 0 ? Math.round(used / (capacity - blocked) * 1000) / 10 : 0,
        court_revenue_cents: cents("courts"), lesson_revenue_cents: cents("lessons"), program_revenue_cents: cents("programs") });
    }
    return { location: loc.name, from, to, rows };
  }
  app.get("/staff/reports", async (c) => c.json(await report(c.req.query("location_id") ?? "", c.req.query("from") ?? "", c.req.query("to") ?? "")));
  app.get("/staff/reports.csv", async (c) => {
    const r = await report(c.req.query("location_id") ?? "", c.req.query("from") ?? "", c.req.query("to") ?? "");
    const head = ["date", "open hours", "courts", "court hours", "booked hours", "program hours", "playtomic hours", "blocked hours", "occupancy %", "court revenue", "lesson revenue", "program revenue"];
    const lines = r.rows.map((x) => [x.date, x.open_hours, x.courts, x.court_hours, x.booked_hours, x.program_hours, x.playtomic_hours, x.blocked_hours, x.occupancy_percent,
      (x.court_revenue_cents / 100).toFixed(2), (x.lesson_revenue_cents / 100).toFixed(2), (x.program_revenue_cents / 100).toFixed(2)].join(","));
    c.header("content-type", "text/csv; charset=utf-8"); c.header("content-disposition", `attachment; filename="kumi-${r.from}-to-${r.to}.csv"`);
    return c.body([head.join(","), ...lines].join("\r\n") + "\r\n");
  });

  // What a court would cost: for the desk's booking form, with the member's price when it's for a member.
  app.get("/staff/quote", async (c) => {
    const start = new Date(c.req.query("starts_at") ?? ""), minutes = Number(c.req.query("minutes") ?? 0), personId = c.req.query("person_id");
    if (isNaN(start.getTime()) || !Number.isInteger(minutes) || minutes < 30 || minutes > 480) throw new KumiError("error.invalid_input", { details: "court_id, starts_at and minutes" }, 400);
    if (personId && !/^[0-9a-f-]{36}$/.test(personId)) throw new KumiError("error.invalid_input", { details: "person_id" }, 400);
    return c.json(await quote(db, { courtId: c.req.query("court_id") ?? "", start, minutes, personId: personId || null }));
  });

  // One location's courts on one day: what holds each court, in order, and when it's open.
  app.get("/staff/grid", async (c) => {
    const locationId = c.req.query("location_id") ?? "", now = new Date();
    const loc = await db.selectFrom("location").select(["id", "time_zone"]).where("id", "=", locationId).executeTakeFirst();
    if (!loc) throw new KumiError("error.not_found", { thing: { en: "location", es: "la sede" } }, 404);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("date") ?? "") ? c.req.query("date")! : localDate(now, loc.time_zone);
    const from = new Date(`${date}T00:00:00Z`), dayStart = new Date(from.getTime() - 14 * 3600_000), dayEnd = new Date(from.getTime() + 38 * 3600_000);
    const courts = await db.selectFrom("court").select(["id", "name", "kind"]).where("location_id", "=", loc.id).where("archived_at", "is", null).orderBy("sort").orderBy("name").execute();
    // Each court's own hours that day, and the day from the earliest opening to the latest closing.
    const hours = await courtOpenings(db, loc.id, courts.map((x) => x.id), date), open = spanOf([...hours.values()]);
    const items = (await occupied(db, courts.map((x) => x.id), dayStart, dayEnd, now)).filter((t) => localDate(new Date(t.start), loc.time_zone) === date || localDate(new Date(t.end), loc.time_zone) === date);
    const ids = (k: "booking_id" | "block_id" | "session_id") => [...new Set(items.map((t) => t[k]).filter((x): x is string => Boolean(x)))];
    const bookings = ids("booking_id").length ? await db.selectFrom("booking").leftJoin("person", "person.id", "booking.organiser_id").leftJoin("person as coach", "coach.id", "booking.coach_id")
      .select(["booking.id", "booking.code", "booking.status", "booking.kind", "booking.pay_mode", "booking.organiser_id", "booking.price_cents", "booking.balance_cents", "booking.invite_code", "person.display_name", "coach.display_name as coach"])
      .select((eb) => eb.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select((x) => x.fn.sum<string>("payment.amount_cents").as("c"))
        .whereRef("booking_player.booking_id", "=", "booking.id").where("payment.status", "=", "succeeded").as("paid_cents"))
      // What has gone back, so "paid" on the Today view is what the club still holds.
      .select((eb) => eb.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
        .select((x) => x.fn.sum<string>("refund.amount_cents").as("c")).whereRef("booking_player.booking_id", "=", "booking.id").where("refund.status", "!=", "failed").as("back_cents"))
      .select((eb) => eb.selectFrom("booking_player").select("guest_name").whereRef("booking_player.booking_id", "=", "booking.id").where("guest_name", "is not", null).limit(1).as("guest"))
      .where("booking.id", "in", ids("booking_id")).execute() : [];
    // Who's playing in each, and what players said about running late (today's word, newest first).
    const players = ids("booking_id").length ? await db.selectFrom("booking_player").leftJoin("person", "person.id", "booking_player.person_id")
      .select(["booking_player.id", "booking_player.booking_id", "booking_player.person_id", "person.display_name", "booking_player.guest_name"])
      .where("booking_player.booking_id", "in", ids("booking_id")).where("booking_player.removed_at", "is", null).where("booking_player.leaving_at", "is", null).orderBy("booking_player.id").execute() : [];
    const late = ids("booking_id").length ? await db.selectFrom("event_outbox").select(["payload", "created_at"]).where("topic", "=", "booking.running_late")
      .where("created_at", ">=", dayStart).where(sql<boolean>`payload->>'booking_id' = ANY(${ids("booking_id")})`).orderBy("id", "desc").execute() : [];
    const lateFor = (bookingId: string) => late.filter((e) => (e.payload as any).booking_id === bookingId).map((e) => ({ name: players.find((p) => p.person_id === (e.payload as any).person_id)?.display_name ?? "",
      minutes: Number((e.payload as any).minutes), at: e.created_at }));
    const blocks = ids("block_id").length ? await db.selectFrom("court_block").select(["id", "reason", "note", "series_id"]).where("id", "in", ids("block_id")).execute() : [];
    const sessions = ids("session_id").length ? await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").select(["session.id", "program.id as program_id", "program.name"]).where("session.id", "in", ids("session_id")).execute() : [];
    const mirror = await db.selectFrom("mirror_booking").select(["court_time_id", "booking_type"]).where("court_time_id", "in", items.filter((t) => t.kind === "mirror").map((t) => t.id).concat(["00000000-0000-0000-0000-000000000000"])).execute();
    // Places players gave up after the deadline, still empty: staff can open them in the app or give them away.
    const empty = ids("booking_id").length ? await db.selectFrom("booking_player").innerJoin("person", "person.id", "booking_player.person_id")
      .select(["booking_player.id", "booking_player.booking_id", "booking_player.fill_refund_percent", "person.display_name as name"])
      .where("booking_player.booking_id", "in", ids("booking_id")).where("booking_player.removed_at", "is", null).where("booking_player.leaving_at", "is not", null).orderBy("booking_player.leaving_at").execute() : [];
    const l = lang(c);
    return c.json({ date, time_zone: loc.time_zone, open, now: now.toISOString(), today: localDate(now, loc.time_zone), courts: courts.map((ct) => ({ ...ct, open: hours.get(ct.id) ?? null, items: items.filter((x) => x.court_id === ct.id).map((x) => {
      const base = { start: x.start, end: x.end, kind: x.kind };
      if (x.booking_id) { const b = bookings.find((y) => y.id === x.booking_id); return { ...base, booking_id: x.booking_id, code: b?.code, who: b?.display_name ?? b?.guest ?? "", price_cents: b?.price_cents ?? 0,
        paid_cents: Number(b?.paid_cents ?? 0) - Number(b?.back_cents ?? 0), balance_cents: b?.balance_cents ?? 0, booking_kind: b?.kind ?? "court", coach: b?.coach ?? null, status: b?.status,
        players: players.filter((p) => p.booking_id === x.booking_id).map((p) => p.display_name ?? p.guest_name ?? ""), late: lateFor(x.booking_id),
        // A member's court paid in full: the desk can name its players (booking_players.ts), and take them off.
        whole: b?.kind === "court" && b.pay_mode === "whole" && Boolean(b.organiser_id) && b.status === "confirmed",
        invite_code: b?.kind === "court" && b.pay_mode === "whole" && b.status === "confirmed" ? b.invite_code : null,
        seats: players.filter((p) => p.booking_id === x.booking_id && p.person_id).map((p) => ({ id: p.id, name: p.display_name ?? "", booker: p.person_id === b?.organiser_id })),
        empty_places: empty.filter((e) => e.booking_id === x.booking_id).map((e) => ({ id: e.id, name: e.name, open: e.fill_refund_percent !== null })) }; }
      if (x.block_id) { const k = blocks.find((y) => y.id === x.block_id); return { ...base, block_id: x.block_id, series: Boolean(k?.series_id), label: [t(l, `block.${k?.reason ?? "other"}` as Key), k?.note].filter(Boolean).join(": ") }; }
      if (x.session_id) { const s = sessions.find((y) => y.id === x.session_id); return { ...base, session_id: x.session_id, program_id: s?.program_id, label: s?.name ?? "" }; }
      return { ...base, label: `Playtomic: ${(mirror.find((m) => m.court_time_id === x.id)?.booking_type ?? "").toLowerCase().replace(/_/g, " ")}` };
    }) })) });
  });
  // The staff alerts this person was told about that nobody has handled yet, and the ones handled today.
  app.get("/staff/alerts", async (c) => c.json(await staffAlerts(db, me(c)!.id, new Date())));
  app.get("/staff/locations", async (c) => c.json(await db.selectFrom("location").select(["id", "name", "time_zone"]).where("archived_at", "is", null).orderBy("name").execute()));
  app.get("/staff/courts", async (c) => c.json(await db.selectFrom("court").select(["id", "name", "location_id", "kind"]).where("archived_at", "is", null)
    .$if(Boolean(c.req.query("location_id")), (q) => q.where("location_id", "=", c.req.query("location_id")!)).orderBy("sort").orderBy("name").execute()));
  // Search by name, email or phone; role=staff for everyone with a staff role, or one role's key; tag_id for
  // one of the club's tags, segment_id for whoever a saved group matches now. Each row has its tags.
  app.get("/staff/people", async (c) => {
    const raw = (c.req.query("q") ?? "").trim(), q = `%${raw}%`, role = c.req.query("role"), limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 200);
    const digits = raw.replace(/\D/g, ""), tagId = c.req.query("tag_id"), segmentId = c.req.query("segment_id");
    const uuid = (v: string | undefined) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
    let within: string[] | null = null;
    if (uuid(segmentId)) {
      const seg = await db.selectFrom("segment").select("filters").where("id", "=", segmentId!).where("active", "=", true).executeTakeFirst();
      within = seg ? (await segmentMembers(db, seg.filters as Filters, new Date())).map((p) => p.id) : [];
    }
    // Built-in roles by key (the screen words them); a role the club made by its name.
    const roles = (eb: any) => eb.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(sql<string[]>`array_agg(DISTINCT CASE WHEN role.system THEN role.key ELSE coalesce(role.name, role.key) END)`.as("r"))
      .whereRef("person_role.person_id", "=", "person.id").where("person_role.active", "=", true).where("role.active", "=", true);
    const tags = (eb: any) => eb.selectFrom("person_tag").innerJoin("tag", "tag.id", "person_tag.tag_id").select(sql<string[]>`array_agg(tag.name ORDER BY tag.name)`.as("t"))
      .whereRef("person_tag.person_id", "=", "person.id").where("person_tag.removed_at", "is", null).where("tag.active", "=", true);
    if (within && !within.length) return c.json([]);
    return c.json(await db.selectFrom("person").select(["id", "display_name", "email", "junior", "created_at"]).select((eb) => [roles(eb).as("roles"), tags(eb).as("tags")]).where("status", "!=", "archived")
      .where((eb) => eb.or([eb("display_name", "ilike", q), eb("email", "ilike", q), ...(digits.length >= 3 ? [eb(sql<string>`regexp_replace(coalesce(phone, ''), '\\D', '', 'g')`, "like", `%${digits}%`)] : [])]))
      .$if(Boolean(role), (qb) => qb.where((eb) => eb.exists(eb.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id")
        .whereRef("person_role.person_id", "=", "person.id").where("person_role.active", "=", true)
        .where("role.key", role === "staff" ? "!=" : "=", role === "staff" ? "member" : role!))))
      .$if(Boolean(uuid(tagId)), (qb) => qb.where((eb) => eb.exists(eb.selectFrom("person_tag").select("person_tag.id").whereRef("person_tag.person_id", "=", "person.id")
        .where("person_tag.tag_id", "=", tagId!).where("person_tag.removed_at", "is", null))))
      .$if(Boolean(within), (qb) => qb.where("id", "in", within!))
      .orderBy("display_name").limit(limit).execute());
  });
  app.get("/staff/people/:id", async (c) => {
    const id = c.req.param("id");
    const p = await db.selectFrom("person").select(["id", "display_name", "email", "locale", "status", "created_via", "created_at", "junior", "birth_year", "redacted_at"]).where("id", "=", id).executeTakeFirst();
    if (!p) throw new KumiError("error.not_found", { thing: { en: "person", es: "la persona" } }, 404);
    const roles = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").leftJoin("location", "location.id", "person_role.location_id")
      .select(["role.key", "role.name", "person_role.location_id", "location.name as location_name"]).where("person_role.person_id", "=", id).where("person_role.active", "=", true).where("role.active", "=", true).orderBy("role.key").execute();
    // What they sign in with, for the owner's reset (never the secrets themselves).
    const signIn = { authenticator: Boolean(await activeFactor(db, id)), recovery_left: await recoveryLeft(db, id),
      passkeys: (await db.selectFrom("passkey").select("credential_id").where("person_id", "=", id).where("revoked_at", "is", null).execute()).length };
    const places = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id")
      .select(["enrolment.id", "enrolment.status", "enrolment.program_id", "program.name"])
      .select((eb) => eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").as("first_start"))
      .where("enrolment.person_id", "=", id).orderBy("enrolment.id", "desc").limit(20).execute();
    // The latest answer for each kind of message: consent is append-only.
    const consent = await db.selectFrom("channel_consent").select(["channel", "purpose", "granted", "source", "at"]).distinctOn(["channel", "purpose"])
      .where("person_id", "=", id).orderBy("channel").orderBy("purpose").orderBy("at", "desc").execute();
    const membership = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
      .select(["membership.id", "membership.plan_id", "membership_plan.name", "membership.status", "membership.source", "membership.started_at", "membership.current_period_end",
        "membership.cancel_at_period_end", "membership.price_cents", "membership.note", "membership.paused_until", sql<boolean>`membership.saved_method IS NOT NULL`.as("card_saved")])
      .where("membership.person_id", "=", id).where("membership.status", "in", ["upcoming", "active", "past_due"]).executeTakeFirst();
    const plans = await db.selectFrom("membership_plan").select(["id", "name", "description", "price_cents", "period", "days_ahead", "join_in_app", "max_members", "starts_on", "sort"]).where("active", "=", true).orderBy("sort").orderBy("name").execute();
    const tz = await clubTz();
    // Their family (who manages a junior, and the juniors an adult manages), and the waiver.
    const hh = await householdOf(db, id);
    const family = hh ? await db.selectFrom("household_member").innerJoin("person", "person.id", "household_member.person_id")
      .select(["person.id", "person.display_name", "person.birth_year", "household_member.role"]).where("household_member.household_id", "=", hh.household_id)
      .where("household_member.removed_at", "is", null).where("person.status", "=", "active").where("person.id", "!=", id).orderBy("household_member.created_at").execute() : [];
    const waiver = await waiverStatus(db, id);
    const tags = await db.selectFrom("person_tag").innerJoin("tag", "tag.id", "person_tag.tag_id").select(["tag.id", "tag.name"]).where("person_tag.person_id", "=", id)
      .where("person_tag.removed_at", "is", null).where("tag.active", "=", true).orderBy("tag.name").execute();
    const cover = membership ? null : await db.selectFrom("membership_member").innerJoin("membership", "membership.id", "membership_member.membership_id")
      .innerJoin("membership_plan", "membership_plan.id", "membership.plan_id").innerJoin("person as payer", "payer.id", "membership.person_id")
      .select(["membership.id as membership_id", "membership.person_id as payer_id", "payer.display_name as payer", "membership_plan.name as plan"]).where("membership_member.person_id", "=", id)
      .where("membership.status", "in", ["upcoming", "active", "past_due"]).where((w) => w.or([w("membership_member.ends_at", "is", null), w("membership_member.ends_at", ">", new Date())])).executeTakeFirst();
    const alsoCovers = membership ? (await coveredBy(db, membership.id, new Date())).map((x) => x.display_name) : [];
    // A kid with a login of their own: the address they sign in with and the rules their parents set.
    const k = await kidOf(db, id);
    const kid = k ? { email: p.email, rules: rulesText(k)[lang(c)], spent_cents: await monthSpent(db, id, new Date()) } : null;
    return c.json({ ...p, kid, roles, sign_in: signIn, places, consent, plans, tags, family_role: hh?.role ?? null, family, covered_by: cover ?? null, also_covers: alsoCovers, waiver: waiver ? { ...waiver, accepted_on: waiver.accepted_at ? localDate(waiver.accepted_at, tz) : null } : null,
      membership: membership ? { ...membership, ends_on: membership.current_period_end ? endDay({ current_period_end: membership.current_period_end, source: membership.source }, tz) : null } : null });
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
    const sessions = await db.selectFrom("session").leftJoin("person", "person.id", "session.coach_id").selectAll("session").select("person.display_name as coach").where("program_id", "=", id).orderBy("starts_at").execute();
    // Who could run a date: everyone with the coach role.
    const coaches = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").innerJoin("person", "person.id", "person_role.person_id")
      .select(["person.id", "person.display_name as name"]).distinct().where("role.key", "=", "coach").where("person_role.active", "=", true).orderBy("person.display_name").execute();
    const courts = await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id").select(["court_time.session_id", "court.name"])
      .where("court_time.session_id", "in", sessions.length ? sessions.map((s) => s.id) : ["00000000-0000-0000-0000-000000000000"]).where("court_time.active", "=", true).execute();
    const draws = await db.selectFrom("draw").select("session_id").where("status", "!=", "void").execute();
    const roster = await db.selectFrom("enrolment").innerJoin("person", "person.id", "enrolment.person_id")
      .leftJoin("rating", (j) => j.onRef("rating.person_id", "=", "enrolment.person_id").on("rating.sport", "=", "padel"))
      .select(["enrolment.id", "enrolment.person_id", "person.display_name", "enrolment.status", "enrolment.waitlist_position", "enrolment.paid_by", "enrolment.price_cents", "enrolment.price_basis",
        "enrolment.left_how", "enrolment.left_reason", "enrolment.refund_outcome", "enrolment.refund_cents", "enrolment.comp_note", "rating.level"])
      .where("enrolment.program_id", "=", id).orderBy("enrolment.status").orderBy("enrolment.waitlist_position").orderBy("enrolment.created_at").execute();
    const offers = await db.selectFrom("waitlist_offer").select(["enrolment_id", "expires_at"]).where("outcome", "is", null).where("expires_at", ">", new Date())
      .where("enrolment_id", "in", roster.length ? roster.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"]).execute();
    const club = await db.selectFrom("club").select("program_decide_hours").executeTakeFirstOrThrow();
    return c.json({
      program, coaches, decide_hours: club.program_decide_hours,
      sessions: sessions.map((s) => ({ ...s, courts: courts.filter((x) => x.session_id === s.id).map((x) => x.name), has_draw: draws.some((d) => d.session_id === s.id) })),
      roster: await Promise.all(roster.map(async (r) => ({ ...r, paid_cents: await paidFor(db, r.id), offer_expires_at: offers.find((o) => o.enrolment_id === r.id)?.expires_at ?? null }))),
    });
  });

  // A program as members would see it on What's On (as someone without a membership: its price, and what members
  // pay), each date still to come with its courts and coach, and what's in the way of any. For a draft, before publishing.
  app.get("/staff/programs/:id/preview", async (c) => {
    const id = c.req.param("id"), l = lang(c), now = new Date();
    if (!(await db.selectFrom("program").select("id").where("id", "=", id).executeTakeFirst())) throw new KumiError("error.not_found", { thing: { en: "program", es: "el programa" } }, 404);
    const x = await publishCheck(db, id, now), p = x.program;
    const booked = Number((await db.selectFrom("enrolment").select((eb) => eb.fn.countAll<string>().as("n")).where("program_id", "=", id).where("status", "=", "booked").executeTakeFirstOrThrow()).n);
    const members = await membersFrom(db, [p]);
    return c.json({
      card: { id: p.id, name: p.name, kind: p.kind, capacity: p.capacity, booked, offered: 0, price_cents: p.price_cents, rated: p.rated, level_min: p.level_min, level_max: p.level_max,
        refund_window_hours: p.refund_window_hours, first_start: x.dates[0]?.starts_at ?? null, min_players: p.min_players, my_status: null, my_offer_until: null, my_watch: null,
        my_price_cents: p.price_cents, my_basis: "full", included: null, members_cents: members.get(p.id) ?? null },
      dates: x.dates.map((d) => ({ id: d.id, starts_at: d.starts_at, ends_at: d.ends_at, courts: d.courts, coach: d.coach })),
      blocks: x.blocks.map((b) => b.text[l]), warnings: x.warnings.map((w) => w.text[l]),
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

  // The level review queue: reviews players asked for, and levels that moved a lot.
  app.get("/staff/levels", async (c) => c.json({ ...await levelQueue(db, new Date()), limit: MOVE_LIMIT, days: MOVE_DAYS }));
  // Everyone who had a place in a session, with their levels, for setting levels after it.
  app.get("/staff/sessions/:id/levels", async (c) => {
    const { session, players, absent } = await sessionPlayers(db, c.req.param("id")), tz = await clubTz();
    return c.json({ session: { ...session, when: dateTime(new Date(session.starts_at), lang(c), tz), started: new Date(session.starts_at) <= new Date() }, players, absent });
  });

  // Someone's connected assistants, for the owner and managers: what each spent this week, to disconnect one.
  app.get("/staff/people/:id/assistants", async (c) => {
    const id = me(c)?.id;
    if (!id) throw new KumiError("error.signed_out", {}, 401);
    const keys = (await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", id).where("person_role.active", "=", true).where("role.active", "=", true).execute()).map((r) => r.key);
    if (!keys.some((k) => k === "owner" || k === "manager")) throw new KumiError("error.staff_only", {}, 403);
    return c.json(await assistantsOf(db, c.req.param("id"), new Date()));
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
  // ---- Members' questions and the club's facts (front desk and up) ----
  const deskOnly = async (c: Context<any>) => { if (!deskUp(await rolesOf(me(c)!.id))) throw new KumiError("error.staff_only", {}, 403); };
  // Waiting first (the longest wait at the top), or answered or closed, newest first.
  app.get("/staff/questions", async (c) => {
    await deskOnly(c);
    const view = c.req.query("view") ?? "waiting";
    const status = view === "answered" ? ["answered" as const] : view === "closed" ? ["closed" as const] : ["open" as const];
    const rows = await questionList(db, { status, limit: 100 });
    if (view === "waiting") rows.sort((a, b) => new Date(a.waiting_since ?? a.created_at).getTime() - new Date(b.waiting_since ?? b.created_at).getTime());
    return c.json({ view, questions: rows.map(({ asked_by: _a, person_id: _p, ...r }) => ({ ...r, about: r.about === r.asker ? null : r.about })) });
  });
  app.get("/staff/questions/count", async (c) => {
    if (!deskUp(await rolesOf(me(c)!.id))) return c.json({ waiting: 0 });
    const r = await db.selectFrom("question").select((eb) => eb.fn.countAll<string>().as("n")).where("status", "=", "open").executeTakeFirstOrThrow();
    return c.json({ waiting: Number(r.n) });
  });
  // One thread, with who's asking: their membership and level, and for a junior, who manages them.
  app.get("/staff/questions/:id", async (c) => {
    await deskOnly(c);
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new KumiError("error.not_found", { thing: { en: "question", es: "la pregunta" } }, 404);
    const q = await questionThread(db, id), now = new Date();
    const plan = await memberPlan(db, q.person_id, now), level = await levelOf(db, q.person_id);
    const parents = q.junior ? (await db.selectFrom("person").select("display_name").where("id", "in", [...await managersOf(db, q.person_id), "00000000-0000-0000-0000-000000000000"]).execute()).map((p) => p.display_name) : [];
    const desk = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").innerJoin("person", "person.id", "person_role.person_id")
      .select(["person.id", "person.display_name"]).distinct().where("role.key", "in", ["owner", "manager", "front_desk"]).where("person_role.active", "=", true).orderBy("person.display_name").execute();
    // A fact Kumi sent by itself: which fact, how sure the model was, and what the member said about it.
    const l = lang(c), picks = await db.selectFrom("answer_decision").innerJoin("club_fact", "club_fact.id", "answer_decision.fact_id")
      .select(["answer_decision.fact_id", "answer_decision.answerer", "answer_decision.confidence", "answer_decision.corrected", "answer_decision.created_at",
        "club_fact.id", "club_fact.topic", "club_fact.question_en", "club_fact.answer_en", "club_fact.question_es", "club_fact.answer_es", "club_fact.active", "club_fact.public"])
      .where("answer_decision.question_id", "=", id).where("answer_decision.outcome", "=", "fact").orderBy("answer_decision.created_at").execute();
    const kumi = (m: { fact_id: string | null; created_at: Date }) => {
      const p = picks.find((x) => x.fact_id === m.fact_id && new Date(x.created_at).getTime() === new Date(m.created_at).getTime());
      return p ? { fact: factIn(p, l).question, by: p.answerer, confidence: p.confidence === null ? null : Number(p.confidence), corrected: p.corrected } : null;
    };
    return c.json({ ...q, membership: plan?.name ?? null, level: level === null ? null : level.toFixed(2), parents, desk: desk.map((d) => ({ id: d.id, name: d.display_name })),
      messages: q.messages.map((m) => ({ id: m.id, side: m.side, body: m.body, at: m.created_at, author: m.author, fact_id: m.fact_id, kumi: m.side === "club" ? kumi(m) : null })) });
  });
  app.get("/staff/facts", async (c) => {
    await deskOnly(c);
    const rows = await searchFacts(db, "", { all: true });
    return c.json(rows.map((f) => ({ id: f.id, topic: f.topic, question_en: f.question_en, answer_en: f.answer_en, question_es: f.question_es, answer_es: f.answer_es, active: f.active, public: f.public })));
  });
  // ---- Roles: the built-in ones and the club's own, what each may do, and how many hold it ----
  app.get("/staff/roles", async (c) => {
    const roles = await db.selectFrom("role").select(["key", "name", "system", "based_on"]).select((eb) => eb.selectFrom("person_role").select((x) => x.fn.countAll<string>().as("n"))
      .whereRef("person_role.role_id", "=", "role.id").where("person_role.active", "=", true).as("holders")).where("active", "=", true).orderBy("system", "desc").orderBy("created_at").execute();
    const l = lang(c);
    return c.json(roles.map((r) => ({ key: r.key, name: r.system ? t(l, `role.${r.key}` as Key) : r.name, system: r.system, based_on: r.based_on, holders: Number(r.holders ?? 0) })));
  });
  app.get("/staff/roles/catalogue", async (c) => c.json(await roleCatalogue(db, lang(c))));
  app.get("/staff/roles/:key/grants", async (c) => c.json(await roleGrantsView(db, c.req.param("key"))));

  return app;
}
