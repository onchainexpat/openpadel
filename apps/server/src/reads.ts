// What the staff screens read. Reads aren't actions; they're for anyone with a staff role, and
// they answer in the reader's language.
import { Hono, type Context } from "hono";

import { sql } from "kysely";
import { both, dateTime, plainAmount, t, type Key, type Lang } from "@kumi/i18n";
import { decide, getAction, isUuid, onDate, weekdayOf, coachOwners, itsTimeNow, inLang, moveInStatus, archiveOf, comparison, takeOverCandidates, typeKey, creditBalance, competitionView, seriesOf, membershipDue, toGiveBack, assistantsOf, personEmailProblem, blockSeriesAt, coachEarnings, coachSchedule, coachItem, coachStudents, rosterOf, ATTENDANCE_HOURS, STUDENT_DAYS, coveredBy, currentPolicy, currentWaiver, householdOf, waiverStatus, endDay, levelQueue, importOptions, MOVE_DAYS, MOVE_LIMIT, sessionPlayers, freeCourts, gameView, KumiError, localDate, occupied, courtOpenings, courtOpeningsOn, atLocal, spanOf, PLAYTOMIC, paidFor, coveredFor, planCounts, quote, shownOdds, standings, type Db , type Owners, kidOf, monthSpent, rulesText, questionList, questionThread, searchFacts, memberPlan, levelOf, managersOf, segmentMembers, type Filters, membersFrom, publishCheck, COACH_AREAS, staffReach, roleCatalogue, roleGrantsView, activeFactor, recoveryLeft, staffAlerts, currentAnswerer, factIn, textingOn, textingRegistration, textUsage, usageView, supportRoleKeys, promoOff } from "@kumi/core";
import { textingStatusText } from "./texting.ts";
import { shortContact } from "./mcp.ts";
import { csvCell, readPeopleCsv } from "./csv.ts";
import { seesMoney } from "./receipts.ts";
import { translatorOn } from "./translate.ts";
import { clubFileStem } from "./file_names.ts";

type Me = { id: string; locale: string } | null;
/** Which area a staff page's data belongs to (roles.ts AREAS), for roles the club made. Lists every area uses
 *  (locations, courts) belong to none. */
/** The read areas the coach role gives (roles.ts COACH_AREAS; the staff app shows a coach the same). */
export const COACH_READS = COACH_AREAS;
/** And, outside those, the pages that answer a coach about themselves: their own earnings, and a question count of 0. */
const COACH_ALSO = /^\/staff\/(coach-earnings(\.csv)?|questions\/count)$/;
/** Who reads a date's night (its draw, players and scores): whoever runs its draw or scores, or sets its levels after it. */
const NIGHT_READ = ["draw.generate", "game.score", "level.set_session"];
const READ_AREAS: [RegExp, string][] = [
  [/^\/staff\/(people\/[^/]+\/level|levels|sessions\/[^/]+\/levels|scores)/, "levels"],
  [/^\/staff\/(people|tags|chats|customers)/, "members"], [/^\/staff\/(programs|sessions|roster)/, "programs"], [/^\/staff\/memberships/, "memberships"],
  [/^\/staff\/(reports|coach-earnings|payments|receipts|desk|move-in)/, "money"], [/^\/staff\/(settings|roles|vault|usage)/, "settings"],
  [/^\/staff\/(questions|facts|broadcast|broadcasts|segments|templates)/, "messages"], [/^\/staff\/(grid|quote|mirror|alerts|block-series|bookings|weekly-courts)/, "bookings"],
  [/^\/staff\/(coaches|my-schedule|students|calendar-link)/, "coaches"],
];
export const readArea = (path: string) => READ_AREAS.find(([re]) => re.test(path))?.[1] ?? null;
/** `assistant`: read through the assistant door (mcp.ts) for someone's own connection, where support access never
 *  reaches (support.ts): only the person's own staff roles count. */
export function readRoutes(db: Db, me: (c: Context<any>) => Me, lang: (c: Context<any>) => Lang, opts: { assistant?: boolean } = {}) {
  const app = new Hono();
  const supportKeys = (id: string) => opts.assistant ? Promise.resolve([] as string[]) : supportRoleKeys(db, id);
  app.use("/staff/*", async (c, next) => {
    const m = me(c);
    if (!m) throw new KumiError("error.signed_out", {}, 401);
    const staff = await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
      .where("person_role.person_id", "=", m.id).where("person_role.active", "=", true).where("role.active", "=", true).where("role.key", "!=", "member").executeTakeFirst();
    // Support access the owner gave (support.ts) reads as a manager would, while it lasts.
    if (!staff && !(await supportKeys(m.id)).length) throw new KumiError("error.staff_only", {}, 403);
    // What someone reads is what all their roles give together (roles.ts readAreas): front desk and up, the accountant
    // and support access every area; a coach their own work (COACH_READS: no club money, no member list or contact
    // details, no memberships, messages or settings, permissions.md); a role the club made the areas it covers.
    const reach = await reachOf(m.id), area = readArea(c.req.path);
    if (!reach.all && area && !reach.areas.includes(area)) {
      // A coach's pages about themselves, and their own students' pages, stay open to them; and a role covering
      // memberships opens the page of anyone it acts on there: someone with a membership, or covered by one (their
      // money only as the page's own money rule gives it).
      const one = /^\/staff\/people\/([0-9a-f-]{36})$/.exec(c.req.path)?.[1];
      const coachs = reach.coach && (COACH_ALSO.test(c.req.path) || (one && area === "members" && (await coachStudents(db, m.id, new Date())).some((s) => s.person_id === one)));
      if (!coachs && !(one && area === "members" && reach.areas.includes("memberships") && await hasMembership(one)))
        throw new KumiError("error.staff_only", {}, 403);
    }
    await next();
  });
  /** Every area (`all`), or the ones the person's roles give together; `coach` when one of them is the coach role, and
   *  `custom` the areas the roles the club made give (the wider view a coach's role alone doesn't). */
  const reachOf = async (id: string) => {
    const r = await staffReach(db, id, await supportKeys(id));
    return { all: r.all, coach: r.coach, custom: r.custom ?? [], areas: [...new Set([...(r.coach ? COACH_READS : []), ...(r.custom ?? [])])] };
  };
  /** Whether someone has (or had) a membership, theirs or one covering them: the people a memberships role acts on. */
  const hasMembership = async (personId: string) => Boolean(await db.selectFrom("membership").select("id").where("person_id", "=", personId).executeTakeFirst()
    || await db.selectFrom("membership_member").select("id").where("person_id", "=", personId).executeTakeFirst());
  /** Whether the person reads an area through a role wider than coaching: one reading every area, or a role the club
   *  made covering it. A coach's role alone reads their own lessons there, not everyone's. */
  const widerIn = async (id: string, area: string) => { const r = await reachOf(id); return r.all || r.custom.includes(area); };

  const rolesOf = async (id: string) => [...(await db.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("role.key")
    .where("person_role.person_id", "=", id).where("person_role.active", "=", true).execute()).map((r) => r.key), ...await supportKeys(id)];
  const deskUp = (roles: string[]) => roles.some((r) => ["owner", "manager", "front_desk"].includes(r));
  // A lesson's or a date's players are read by whoever may do its work there (`actions`: marking who came, setting its
  // levels, running its night), judged as the action itself is (permissions.ts, with coachOwners for whose it is): a
  // role reaching every row, built-in or one the club made, reads every one; a coach's own-rows grant reads only the
  // ones they run. Anyone else hears one and the same no ("not yours", reason.own_only), whatever the reason inside
  // (another location's, someone else's, one that isn't there, an id that isn't one), so a refusal never tells whether
  // or where it exists. Front desk and up (and support access) read them all; a missing one is a 404.
  const coachRuns = async (c: Context<any>, kind: "lesson" | "session", id: string, actions: string[]) => {
    const m = me(c)!, valid = isUuid(id);
    const gone = () => new KumiError("error.not_found", { thing: both(kind === "lesson" ? "thing.booking" : "thing.session") }, 404);
    if (deskUp(await rolesOf(m.id)) || await mayAnyOf(m.id, actions, await coachOwners(db, kind, valid ? id : undefined))) { if (!valid) throw gone(); return; }
    throw new KumiError("error.forbidden_reason", { reason: both("reason.own_only") }, 403);
  };
  /** Which of a program's dates' pages (coachRuns) the reader may open, so the staff app links only those: its players
   *  (`students`), setting its levels (`levels`) and its night (`night`). Front desk and up open them all. */
  const datesOpen = async (personId: string, locationId: string | null, sessions: { id: string; coach_id: string | null }[]) => {
    const all = deskUp(await rolesOf(personId)), out = new Map<string, { students: boolean; levels: boolean; night: boolean }>();
    for (const s of sessions) {
      const o: Owners = { ownerIds: s.coach_id ? [s.coach_id] : [], locationId };
      out.set(s.id, all ? { students: true, levels: true, night: true }
        : { students: await mayAnyOf(personId, ["attendance.mark"], o), levels: await mayAnyOf(personId, ["level.set_session"], o), night: await mayAnyOf(personId, NIGHT_READ, o) });
    }
    return out;
  };
  /** Whether any of `actions` is the person's to do on these rows, asked as each action's own check asks it (permissions.ts,
   *  every role they hold, built-in or the club's own). */
  const mayAnyOf = async (personId: string, actions: string[], o: Owners): Promise<boolean> => {
    for (const name of actions) {
      const def = getAction(name);
      const d = await decide(db, name, { personId, locationId: o.locationId ?? null, ownerIds: o.ownerIds, at: new Date(), assistant: Boolean(opts.assistant),
        clubWide: Boolean(def.clubWide) || o.locationId === undefined, wholeClub: def.wholeClub });
      if (d.mode !== "no") return true;
    }
    return false;
  };
  // What members paid for a program place, its refunds and a free place's note: the club's money people (seesMoney:
  // front desk and up, the accountant, a club-made role covering money) or whoever may take a place's payment, give a
  // free place or give money back there through any role. A coach reads the roster and levels without them.
  const PROGRAM_MONEY = ["enrolment.record_payment", "enrolment.comp", "enrolment.unpaid", "refund.give_back", "refund.settle"];
  const PLACE_MONEY = ["price_cents", "price_basis", "paid_by", "paid_cents", "refund_outcome", "refund_cents", "comp_note"] as const;
  // The courts day's money: the club's money people, or whoever may take a booking's payment or give it back there.
  const GRID_MONEY = ["booking.record_payment", "booking.refund"];
  // A person's page's money: the club's money people, or whoever may do one of the money changes the page offers
  // (a booking's refund, a membership's payment or sale, a refund given back or sent again, credit paid out, a pass refunded).
  const PERSON_MONEY = ["booking.refund", "membership.record_payment", "membership.sell", "refund.give_back", "refund.resend", "credit.pay_out", "pass.refund"];
  const seesProgramMoney = async (c: Context<any>, locationId: string | null) => {
    const m = me(c)!;
    return await seesMoney(db, m.id, { assistant: opts.assistant }) || await mayAnyOf(m.id, PROGRAM_MONEY, { ownerIds: [], locationId });
  };

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
    const kind = c.req.param("kind");
    if (kind !== "lesson" && kind !== "session") throw new KumiError("error.not_found", { thing: { en: "page", es: "la página" } }, 404);
    await coachRuns(c, kind, c.req.param("id"), ["attendance.mark"]);
    const item = await coachItem(db, kind, c.req.param("id"));
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
    // Column names (and the kind and status words) are English for every reader, as in every download, so a
    // spreadsheet or an accounting tool reads the same file from any member of staff; amounts and times keep the club's.
    const r = await earnings(c), l = "en" as const;
    const at = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: r.time_zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d)).replace(",", "");
    const head = ["coach", "kind", "when", "minutes", "what", "status", "paid", "refunded", "net"].map((k) => t(l, `csv.${k}` as Key));
    const lines = [
      ...r.lessons.map((x) => [x.coach, t(l, "csv.lesson"), at(x.start), x.minutes, `${x.code} ${x.booked_by ?? ""} (${x.court})`, t(l, `csv.status_${x.status === "cancelled" ? "cancelled" : "held"}` as Key),
        plainAmount(x.paid_cents), plainAmount(x.refunded_cents), plainAmount(x.net_cents)]),
      ...r.sessions.map((x) => [x.coach, t(l, "csv.session"), at(x.start), x.minutes, x.name, t(l, "csv.status_held"), "", "", ""]),
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2]))).map((row) => row.map(csvCell).join(","));
    c.header("content-type", "text/csv; charset=utf-8"); c.header("content-disposition", `attachment; filename="${await clubFileStem(db)}-coaches-${r.from}-to-${r.to}.csv"`);
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
        "membership.current_period_end", "membership.cancel_at_period_end", "membership.ended_at", "membership.end_reason", "membership.note", "membership.price_cents", "membership.paused_until", "membership.balance_cents",
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
    const club = await db.selectFrom("club").select(["name", "legal_name", "time_zone", "languages", "default_language", "brand_colour", "coming_from", "sign_up_open", "court_bookings", "players_chat", "weekly_bookings", "weekly_max_weeks", "gift_cards", "gift_card_min_cents", "gift_card_max_cents", "tax_rate_bp", "currency", "format_locale", "country", "prices_include_tax", "tax_label", "public_page", "about", "terms_url", "privacy_policy_url", "translations", "two_factor", "second_step_sign_in", "question_alert_hours", "auto_answers", "broadcast_daily_cap", "broadcast_copy_managers", "level_import_line", "logo_id", "logo_for", "program_decide_hours", "program_heads_up_hours"]).executeTakeFirstOrThrow();
    const rules = await db.selectFrom("price_rule").selectAll().where("active", "=", true).orderBy("priority", "desc").orderBy("name").execute();
    const policy = await currentPolicy(db), plans = await db.selectFrom("membership_plan").select(["id", "name"]).where("active", "=", true).orderBy("sort").orderBy("name").execute();
    const locations = await db.selectFrom("location").select(["id", "name", "address", "postal_code", "region", "country", "time_zone"]).where("archived_at", "is", null).orderBy("name").execute();
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
    const texting = { on: textingOn(), status: reg?.status ?? null, number: reg?.phone_number ?? null, said: reg ? textingStatusText(reg, lang(c), club.time_zone) : [], usage: await textUsage(db) };
    // Each court's own week: a weekday it has no hours of its own for is left out (it follows the location's).
    const courtWeek = (id: string) => own.filter((x) => x.court_id === id).sort((a, b) => a.weekday - b.weekday).map((x) => ({ weekday: x.weekday, opens: t5(x.opens), closes: t5(x.closes) }));
    return c.json({ club, answerer: currentAnswerer().name, texting, policy, plans, waiver: waiver ? { version_no: waiver.version_no, body: waiver.body, translations: waiver.translations } : null, drafts: translatorOn(), locations: locations.map((l) => ({ ...l,
      courts: courts.filter((x) => x.location_id === l.id).map((x) => ({ ...x, hours: courtWeek(x.id) })),
      prices: rules.filter((r) => r.location_id === l.id).map((r) => ({ ...r, starts: t5(r.starts), ends: t5(r.ends) })),
      hours: [0, 1, 2, 3, 4, 5, 6].map((w) => { const h = hours.find((x) => x.location_id === l.id && x.weekday === w); return { weekday: w, opens: t5(h?.opens ?? null), closes: t5(h?.closes ?? null) }; }),
      special_days: special.filter((x) => x.location_id === l.id).map((x) => ({ ...x, opens: t5(x.opens), closes: t5(x.closes) })) })) });
  });

  // Occupancy and revenue by day: court hours open, what used them (bookings, programs, Playtomic) and what
  // was blocked, and the money from the ledger (courts, lessons, programs and memberships, net of refunds;
  // club-wide). Memberships are their own lines: starts, renewals and a family's extra people, less refunds.
  async function report(locationId: string, from: string, to: string) {
    if (!/^[0-9a-f-]{36}$/i.test(locationId)) throw new KumiError("error.invalid_input", { details: "location_id, from and to (YYYY-MM-DD)" }, 400);
    const loc = await db.selectFrom("location").select(["id", "name", "time_zone"]).where("id", "=", locationId).executeTakeFirst();
    if (!loc || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new KumiError("error.invalid_input", { details: "location_id, from and to (YYYY-MM-DD)" }, 400);
    const courts = await db.selectFrom("court").select("id").where("location_id", "=", loc.id).where("archived_at", "is", null).where("bookable", "=", true).execute();
    const days: string[] = [];
    for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to && days.length < 92; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
    // The days' own bounds on the club's clock, a day wider each side, let the books be read by time (ledger_txn_at);
    // the club date of each still decides which day it counts on.
    // A report shows at most 92 days, so the books past the last of them aren't read.
    const last = days.at(-1) ?? to;
    const ymd = (d: string) => d.split("-").map(Number) as [number, number, number];
    const [fy, fm, fd] = ymd(from), [ty, tm, td] = ymd(last);
    const readFrom = atLocal(fy, fm, fd - 1, 0, loc.time_zone), readTo = atLocal(ty, tm, td + 2, 0, loc.time_zone);
    const money = await db.selectFrom("ledger_entry").innerJoin("ledger_txn", "ledger_txn.id", "ledger_entry.txn_id").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id")
      .select([sql<string>`to_char(ledger_txn.at AT TIME ZONE ${loc.time_zone}, 'YYYY-MM-DD')`.as("day"), "ledger_account.revenue_type", sql<string>`sum(-ledger_entry.amount_cents)`.as("cents")])
      .where("ledger_account.kind", "=", "revenue").where("ledger_txn.at", ">=", readFrom).where("ledger_txn.at", "<", readTo)
      .where(sql<boolean>`(ledger_txn.at AT TIME ZONE ${loc.time_zone})::date BETWEEN ${from}::date AND ${last}::date`)
      .groupBy(["day", "ledger_account.revenue_type"]).execute();
    // Revenue is shown before tax: the books post what was paid, tax included, so the tax on each day's receipts for
    // courts and lessons (the only taxed things) comes off, refunds giving theirs back. The receipt's day is when it
    // was issued, a minute or so after the payment, so a payment at midnight can count its tax on the next day.
    const taxRows = await db.selectFrom("receipt").innerJoin("payment", "payment.id", "receipt.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
      .innerJoin("booking", "booking.id", "booking_player.booking_id")
      .select([sql<string>`to_char(receipt.paid_at AT TIME ZONE ${loc.time_zone}, 'YYYY-MM-DD')`.as("day"), sql<string>`CASE WHEN booking.kind = 'lesson' THEN 'lessons' ELSE 'courts' END`.as("revenue_type"),
        sql<string>`sum(CASE WHEN receipt.kind = 'refund' THEN -receipt.tax_cents ELSE receipt.tax_cents END)`.as("cents")])
      .where("booking.location_id", "=", loc.id).where("receipt.tax_cents", ">", 0)
      .where("receipt.paid_at", ">=", readFrom).where("receipt.paid_at", "<", readTo)
      .where(sql<boolean>`(receipt.paid_at AT TIME ZONE ${loc.time_zone})::date BETWEEN ${from}::date AND ${last}::date`).groupBy(["day", "revenue_type"]).execute();
    // Each court's hours and what held it, read once for all the days, not once a day.
    const openings = await courtOpeningsOn(db, loc.id, courts.map((x) => x.id), days);
    const bounds = (day: string) => { const [y, mo, dd] = ymd(day); return [atLocal(y, mo, dd, 0, loc.time_zone).getTime(), atLocal(y, mo, dd + 1, 0, loc.time_zone).getTime()] as const; };
    const held = days.length ? await occupied(db, courts.map((x) => x.id), new Date(bounds(days[0]!)[0]), new Date(bounds(days.at(-1)!)[1]), new Date(0)) : [];
    const rows = [];
    for (const day of days) {
      // Each court counts its own hours that day (a court's own week, or the location's).
      const hours = openings.get(day)!, open = spanOf([...hours.values()]);
      const openMin = open ? (open.closes.getTime() - open.opens.getTime()) / 60_000 : 0;
      // What was booked counts whatever the hours say (a match kept after its court's hours changed is still
      // booked and paid for); the hours only shape the capacity, so occupancy counts the time inside them.
      const all: Record<string, number> = {}, inside: Record<string, number> = {};
      let capacity = 0;
      for (const h of hours.values()) if (h) capacity += (h.closes.getTime() - h.opens.getTime()) / 60_000;
      const [dayStart, dayEnd] = bounds(day);
      // What overlapped the day, as the query for that day alone would have found it.
      for (const it of held.filter((t) => new Date(t.start).getTime() < dayEnd && new Date(t.end).getTime() > dayStart)) {
        const s = Math.max(new Date(it.start).getTime(), dayStart), e = Math.min(new Date(it.end).getTime(), dayEnd);
        if (e <= s) continue;
        all[it.kind] = (all[it.kind] ?? 0) + (e - s) / 60_000;
        const h = hours.get(it.court_id);
        const m = h ? (Math.min(e, h.closes.getTime()) - Math.max(s, h.opens.getTime())) / 60_000 : 0;
        if (m > 0) inside[it.kind] = (inside[it.kind] ?? 0) + m;
      }
      const used = (inside.booking ?? 0) + (inside.session ?? 0) + (inside.mirror ?? 0), blocked = inside.block ?? 0;
      const taxOf = (type: string) => Number(taxRows.find((r) => r.day === day && r.revenue_type === type)?.cents ?? 0);
      const cents = (type: string) => Number(money.find((r) => r.day === day && r.revenue_type === type)?.cents ?? 0) - taxOf(type);
      rows.push({ date: day, open_hours: openMin / 60, courts: courts.length, court_hours: capacity / 60, booked_hours: (all.booking ?? 0) / 60, program_hours: (all.session ?? 0) / 60,
        playtomic_hours: (all.mirror ?? 0) / 60, blocked_hours: blocked / 60, occupancy_percent: capacity - blocked > 0 ? Math.round(used / (capacity - blocked) * 1000) / 10 : 0,
        court_revenue_cents: cents("courts"), lesson_revenue_cents: cents("lessons"), program_revenue_cents: cents("programs"), membership_revenue_cents: cents("memberships"), tax_cents: taxOf("courts") + taxOf("lessons"),
        // Card payments found after a restore that the staff kept as paid elsewhere (payments_after_restore.ts): other
        // income, apart, on the day each was paid, less refunds the provider has made of them since.
        found_revenue_cents: cents("after_restore") });
    }
    return { location: loc.name, from, to, rows };
  }
  app.get("/staff/reports", async (c) => c.json(await report(c.req.query("location_id") ?? "", c.req.query("from") ?? "", c.req.query("to") ?? "")));
  app.get("/staff/reports.csv", async (c) => {
    const r = await report(c.req.query("location_id") ?? "", c.req.query("from") ?? "", c.req.query("to") ?? "");
    // Revenue before tax, as on the page, and the tax collected on courts and lessons beside it (refunds giving theirs back).
    const head = ["date", "open hours", "courts", "court hours", "booked hours", "program hours", "playtomic hours", "blocked hours", "occupancy %", "court revenue", "lesson revenue", "program revenue", "membership revenue", "tax collected", "card payments recorded after a restore"];
    const lines = r.rows.map((x) => [x.date, x.open_hours, x.courts, x.court_hours, x.booked_hours, x.program_hours, x.playtomic_hours, x.blocked_hours, x.occupancy_percent,
      plainAmount(x.court_revenue_cents), plainAmount(x.lesson_revenue_cents), plainAmount(x.program_revenue_cents), plainAmount(x.membership_revenue_cents), plainAmount(x.tax_cents), plainAmount(x.found_revenue_cents)].map(csvCell).join(","));
    c.header("content-type", "text/csv; charset=utf-8"); c.header("content-disposition", `attachment; filename="${await clubFileStem(db)}-report-${r.from}-to-${r.to}.csv"`);
    return c.body([head.join(","), ...lines].join("\r\n") + "\r\n");
  });

  // What a court would cost: for the desk's booking form, with the member's price when it's for a member.
  app.get("/staff/quote", async (c) => {
    const start = new Date(c.req.query("starts_at") ?? ""), minutes = Number(c.req.query("minutes") ?? 0), personId = c.req.query("person_id");
    if (isNaN(start.getTime()) || !Number.isInteger(minutes) || minutes < 30 || minutes > 480) throw new KumiError("error.invalid_input", { details: "court_id, starts_at and minutes" }, 400);
    if (personId && !/^[0-9a-f-]{36}$/.test(personId)) throw new KumiError("error.invalid_input", { details: "person_id" }, 400);
    // With the club's "pay my part" deadline, so the desk's form offers each their part only while there's time.
    return c.json({ ...await quote(db, { courtId: c.req.query("court_id") ?? "", start, minutes, personId: personId || null }), split_deadline_hours: (await currentPolicy(db)).split_deadline_hours });
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
      .select(["booking.id", "booking.code", "booking.status", "booking.kind", "booking.pay_mode", "booking.organiser_id", "booking.coach_id", "booking.price_cents", "booking.balance_cents", "booking.invite_code", "booking.note", "booking.player_note", "person.display_name", "coach.display_name as coach"])
      .select((eb) => eb.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select((x) => x.fn.sum<string>("payment.amount_cents").as("c"))
        .whereRef("booking_player.booking_id", "=", "booking.id").where("payment.status", "=", "succeeded").as("paid_cents"))
      // What promo codes took off: covered, not owed, so the desk isn't shown a discount to take as money.
      .select((eb) => eb.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(sql<string>`coalesce(sum(${promoOff()}), 0)`.as("c"))
        .whereRef("booking_player.booking_id", "=", "booking.id").where("payment.status", "=", "succeeded").as("off_cents"))
      // What was paid in Playtomic (a booking taken over): said as such, so the desk doesn't look for that money here.
      .select((eb) => eb.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(sql<string>`coalesce(sum(payment.amount_cents), 0)`.as("c"))
        .whereRef("booking_player.booking_id", "=", "booking.id").where("payment.status", "=", "succeeded").where("payment.method", "=", "playtomic").as("pt_cents"))
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
    // A program date's kind (a clinic, a league...), so the grid colours it; and which bookings are open matches.
    const sessions = ids("session_id").length ? await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").select(["session.id", "program.id as program_id", "program.name", "program.kind"]).where("session.id", "in", ids("session_id")).execute() : [];
    const matches = new Set(ids("booking_id").length ? (await db.selectFrom("open_match").select("booking_id").where("booking_id", "in", ids("booking_id")).execute()).map((m) => m.booking_id) : []);
    const mirror = await db.selectFrom("mirror_booking").select(["court_time_id", "booking_type"]).where("court_time_id", "in", items.filter((t) => t.kind === "mirror").map((t) => t.id).concat(["00000000-0000-0000-0000-000000000000"])).execute();
    // Places players gave up after the deadline, still empty: staff can open them in the app or give them away.
    const empty = ids("booking_id").length ? await db.selectFrom("booking_player").innerJoin("person", "person.id", "booking_player.person_id")
      .select(["booking_player.id", "booking_player.booking_id", "booking_player.fill_refund_percent", "person.display_name as name"])
      .where("booking_player.booking_id", "in", ids("booking_id")).where("booking_player.removed_at", "is", null).where("booking_player.leaving_at", "is not", null).orderBy("booking_player.leaving_at").execute() : [];
    const l = lang(c);
    // Someone who reads bookings only as a coach (no role reading every area, nor one the club made covering bookings,
    // whatever else they hold) sees their own lessons in full; anyone else's booking is only "booked": bookings and
    // court time are "own lessons" for a coach (permissions.md), so no names, codes or money.
    const viewer = me(c)!.id, coachView = !(await widerIn(viewer, "bookings"));
    // What members paid on each booking (price, paid, promo, Playtomic, balance): for the club's money people or whoever
    // may take a booking's payment or give it back here (as the person page and a program's page decide); everyone
    // else (a coach on their own lesson, a role the club made covering bookings only) runs the court without it.
    const money = await seesMoney(db, viewer, { assistant: opts.assistant }) || await mayAnyOf(viewer, GRID_MONEY, { ownerIds: [], locationId: loc.id });
    // Names (who booked, who plays, who's late, whose place is empty) only for those who read people (seesPeople, as the
    // Bookings list decides), and a coach on their own lesson: a role the club made covering bookings and not members
    // runs the court without them. Who booked and plays in each Playtomic copy, the same.
    const people = await seesPeople(viewer);
    const names = people ? await playtomicNames(items.filter((x) => x.kind === "mirror").map((x) => x.id)) : new Map<string, { who: string | null; players: string[] }>();
    const paidPart = (b: (typeof bookings)[number] | undefined) => money ? { price_cents: b?.price_cents ?? 0, paid_cents: Number(b?.paid_cents ?? 0) - Number(b?.back_cents ?? 0),
      off_cents: Number(b?.off_cents ?? 0), pt_cents: Number(b?.pt_cents ?? 0), balance_cents: b?.balance_cents ?? 0 } : {};
    return c.json({ date, time_zone: loc.time_zone, open, now: now.toISOString(), today: localDate(now, loc.time_zone), money, people, courts: courts.map((ct) => ({ ...ct, open: hours.get(ct.id) ?? null, items: items.filter((x) => x.court_id === ct.id).map((x) => {
      const base = { start: x.start, end: x.end, kind: x.kind };
      if (x.booking_id && coachView && bookings.find((y) => y.id === x.booking_id)?.coach_id !== viewer) return { ...base, label: t(l, "grid.booked") };
      if (x.booking_id) { const b = bookings.find((y) => y.id === x.booking_id), named = people || (Boolean(b) && b!.coach_id === viewer), nm = (n: string) => named ? n : "";
        return { ...base, booking_id: x.booking_id, code: b?.code, who: nm(b?.display_name ?? b?.guest ?? ""), ...paidPart(b),
        booking_kind: b?.kind ?? "court", open_match: matches.has(x.booking_id), coach: b?.coach ?? null, status: b?.status,
        // The staff's own note and the one players see, with the names (a role that runs courts without people sees neither).
        ...(named && b?.note ? { note: b.note } : {}), ...(named && b?.player_note ? { player_note: b.player_note } : {}), split: b?.pay_mode === "split",
        players: named ? players.filter((p) => p.booking_id === x.booking_id).map((p) => p.display_name ?? p.guest_name ?? "") : [], late: lateFor(x.booking_id).map((w) => ({ ...w, name: nm(w.name) })),
        // A member's court paid in full: the desk can name its players (booking_players.ts), and take them off.
        whole: b?.kind === "court" && b.pay_mode === "whole" && Boolean(b.organiser_id) && b.status === "confirmed",
        invite_code: b?.kind === "court" && b.pay_mode === "whole" && b.status === "confirmed" ? b.invite_code : null,
        seats: players.filter((p) => p.booking_id === x.booking_id && p.person_id).map((p) => ({ id: p.id, name: nm(p.display_name ?? ""), booker: p.person_id === b?.organiser_id })),
        empty_places: empty.filter((e) => e.booking_id === x.booking_id).map((e) => ({ id: e.id, name: nm(e.name), open: e.fill_refund_percent !== null })) }; }
      if (x.block_id) { const k = blocks.find((y) => y.id === x.block_id); return { ...base, block_id: x.block_id, series: Boolean(k?.series_id), label: [t(l, `block.${k?.reason ?? "other"}` as Key), k?.note].filter(Boolean).join(": ") }; }
      if (x.session_id) { const s = sessions.find((y) => y.id === x.session_id); return { ...base, session_id: x.session_id, program_id: s?.program_id, program_kind: s?.kind ?? null, label: s?.name ?? "" }; }
      // A Playtomic copy: its kind, and who booked it and plays in it (from the club's archive) for those who read people.
      const pt = names.get(x.id);
      return { ...base, label: `Playtomic: ${t(l, typeKey(mirror.find((m) => m.court_time_id === x.id)?.booking_type))}`, ...(pt ? { who: pt.who ?? "", players: pt.players } : {}) };
    }) })) });
  });

  /** Who booked each Playtomic copy and who plays in it, from the club's archive (playtomic_archive.ts), by the copy's court
   *  time. Only for those who read people (see `seesPeople`). A member whose account was deleted here never shows: their
   *  rows have no name (erased_at, playtomic_erased.ts), and a row matched to a deleted account is left out as well. */
  const playtomicNames = async (courtTimeIds: string[]) => {
    const out = new Map<string, { who: string | null; players: string[] }>();
    if (!courtTimeIds.length) return out;
    const rows = await db.selectFrom("mirror_booking")
      .innerJoin("playtomic_booking", (j) => j.on(sql<boolean>`mirror_booking.ref = playtomic_booking.booking_id || ':' || playtomic_booking.resource_id`))
      .innerJoin("playtomic_booking_player", "playtomic_booking_player.booking_id", "playtomic_booking.booking_id")
      .leftJoin("person", "person.id", "playtomic_booking_player.person_id")
      .select(["mirror_booking.court_time_id", "playtomic_booking_player.name", "playtomic_booking_player.is_owner", "playtomic_booking_player.participant_id",
        "playtomic_booking_player.family_member_id", "playtomic_booking.owner_id"])
      .where("mirror_booking.court_time_id", "in", courtTimeIds).where("playtomic_booking_player.erased_at", "is", null)
      .where("playtomic_booking_player.name", "is not", null).where("person.redacted_at", "is", null)
      .orderBy("playtomic_booking_player.is_owner", "desc").orderBy("playtomic_booking_player.id").execute();
    for (const r of rows) {
      const e = out.get(r.court_time_id!) ?? { who: null, players: [] };
      const owner = r.is_owner || (r.owner_id && r.participant_id === r.owner_id && !r.family_member_id);
      if (owner && !e.who) e.who = r.name!;
      e.players.push(r.name!);
      out.set(r.court_time_id!, e);
    }
    return out;
  };
  /** Who reads people's names on the club's bookings lists: someone whose roles read the people area wider than a coach's
   *  own students (front desk and up, the accountant, support access, a role the club made covering members). */
  const seesPeople = (id: string) => widerIn(id, "members");

  // ---- Bookings, as a list (the staff app's Bookings page) ----
  // One location's bookings over some days: court bookings and lessons (open matches among them), program dates and
  // Playtomic copies, each with its time, length, court, kind, where it was made and how it stands. Read as the day's
  // grid is: someone who reads bookings only as a coach sees their own lessons (and the program dates and Playtomic
  // copies the grid shows them, unnamed), never anyone else's booking; names only for those who read people (a coach's
  // own lesson keeps its player's name, as on the grid); what was paid and owed only for the grid's money readers.
  const BOOKING_TYPES = ["court", "lesson", "open_match", "program", "playtomic"] as const;
  const BOOKING_STATES = ["upcoming", "in_progress", "done", "cancelled", "unpaid"] as const;
  const MADE_IN = ["app", "desk", "playtomic"] as const;
  const PER_PAGE = 25;
  /** Every booking the list's filters find (not a page of them), and what this reader may see of them. */
  const bookingsFound = async (c: Context<any>, l: Lang = lang(c)) => {
    const q = (k: string) => c.req.query(k) ?? "", now = new Date();
    const loc = isUuid(q("location_id")) ? await db.selectFrom("location").select(["id", "time_zone"]).where("id", "=", q("location_id")).executeTakeFirst() : undefined;
    if (!loc) throw new KumiError("error.not_found", { thing: { en: "location", es: "la sede" } }, 404);
    const ymd = /^\d{4}-\d{2}-\d{2}$/, today = localDate(now, loc.time_zone);
    const fromDay = ymd.test(q("from")) ? q("from") : today, toDay = ymd.test(q("to")) ? q("to") : fromDay;
    const span = (Date.parse(`${toDay}T12:00:00Z`) - Date.parse(`${fromDay}T12:00:00Z`)) / 86400_000;
    if (!(span >= 0 && span <= 62)) throw new KumiError("error.invalid_input", { details: "from and to: up to 62 days, from first" }, 400);
    const pick = <T extends string>(k: string, ok: readonly T[]) => (ok as readonly string[]).includes(q(k)) ? q(k) as T : null;
    const type = pick("type", BOOKING_TYPES), madeIn = pick("made_in", MADE_IN);
    const from = onDate(fromDay, "00:00", loc.time_zone), to = onDate(toDay, "24:00", loc.time_zone);
    const viewer = me(c)!.id, coachView = !(await widerIn(viewer, "bookings")), people = await seesPeople(viewer);
    const money = await seesMoney(db, viewer, { assistant: opts.assistant }) || await mayAnyOf(viewer, GRID_MONEY, { ownerIds: [], locationId: loc.id });
    // "Unpaid" is a state only money readers are offered; for anyone else it narrows nothing.
    const status = pick("status", BOOKING_STATES.filter((s) => s !== "unpaid" || money));
    const page = Math.max(1, Math.floor(Number(q("page")) || 1));
    const courts = new Map((await db.selectFrom("court").select(["id", "name"]).where("location_id", "=", loc.id).execute()).map((x) => [x.id, x.name]));
    const courtIds = [...courts.keys()].concat(["00000000-0000-0000-0000-000000000000"]);
    const inRange = sql<boolean>`lower(court_time.during) >= ${from} AND lower(court_time.during) < ${to}`;
    type Row = { key: string; starts_at: Date; ends_at: Date; court_id: string; court: string; type: (typeof BOOKING_TYPES)[number]; program_kind?: string | null; made_in: (typeof MADE_IN)[number] | "club";
      status: "upcoming" | "in_progress" | "done" | "cancelled"; owed_cents?: number; who: string | null; person_id?: string | null; more: number; label?: string; code?: string; booking_id?: string; program_id?: string };
    const state = (s: Date, e: Date, cancelled: boolean): Row["status"] => cancelled ? "cancelled" : now < s ? "upcoming" : now < e ? "in_progress" : "done";
    const rows: Row[] = [];

    // Court bookings and lessons: where each is now (or was, when it was cancelled).
    const booked = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").leftJoin("person", "person.id", "booking.organiser_id")
      .select(["booking.id", "booking.code", "booking.kind", "booking.status", "booking.source", "booking.organiser_id", "booking.coach_id", "booking.price_cents", "court_time.id as ct",
        "court_time.court_id", "person.display_name", sql<Date>`lower(court_time.during)`.as("s"), sql<Date>`upper(court_time.during)`.as("e")])
      .select((eb) => eb.selectFrom("booking_player").select("guest_name").whereRef("booking_player.booking_id", "=", "booking.id").where("guest_name", "is not", null).limit(1).as("guest"))
      .select((eb) => eb.selectFrom("booking_player").select((x) => x.fn.countAll<string>().as("n")).whereRef("booking_player.booking_id", "=", "booking.id").where("booking_player.removed_at", "is", null).as("players"))
      .select((eb) => eb.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select((x) => x.fn.sum<string>("payment.amount_cents").as("c"))
        .whereRef("booking_player.booking_id", "=", "booking.id").where("payment.status", "=", "succeeded").as("paid"))
      .select((eb) => eb.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(sql<string>`coalesce(sum(${promoOff()}), 0)`.as("c"))
        .whereRef("booking_player.booking_id", "=", "booking.id").where("payment.status", "=", "succeeded").as("off"))
      .select((eb) => eb.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
        .select((x) => x.fn.sum<string>("refund.amount_cents").as("c")).whereRef("booking_player.booking_id", "=", "booking.id").where("refund.status", "!=", "failed").as("back"))
      .where("booking.location_id", "=", loc.id).where("court_time.court_id", "in", courtIds).where(inRange)
      .where("booking.status", "in", ["confirmed", "completed", "cancelled"]).where((w) => w.or([w("court_time.active", "=", true), w("booking.status", "=", "cancelled")]))
      .$if(coachView, (x) => x.where("booking.coach_id", "=", viewer)).orderBy("court_time.id", "desc").execute();
    const matches = new Set(booked.length ? (await db.selectFrom("open_match").select("booking_id").where("booking_id", "in", booked.map((b) => b.id)).execute()).map((m) => m.booking_id) : []);
    // A cancelled booking is where it last was: a time it was moved away from before it was cancelled isn't listed.
    const gone = booked.filter((b) => b.status === "cancelled").map((b) => b.id);
    const last = new Map(gone.length ? (await db.selectFrom("court_time").select(["booking_id", sql<string>`max(id::text)`.as("ct")]).where("booking_id", "in", gone).groupBy("booking_id").execute())
      .map((x) => [x.booking_id!, x.ct]) : []);
    const seen = new Set<string>();
    for (const b of booked) {
      if (seen.has(b.id) || (b.status === "cancelled" && last.get(b.id) !== b.ct)) continue;
      seen.add(b.id);
      const s = new Date(b.s), e = new Date(b.e), named = people || b.coach_id === viewer;
      const owed = b.price_cents - (Number(b.paid ?? 0) - Number(b.back ?? 0)) - Number(b.off ?? 0);
      rows.push({ key: b.id, booking_id: b.id, code: b.code, starts_at: s, ends_at: e, court_id: b.court_id, court: courts.get(b.court_id) ?? "",
        type: b.kind === "lesson" ? "lesson" : matches.has(b.id) ? "open_match" : "court", made_in: b.source === "desk" ? "desk" : b.source === "import" ? "playtomic" : "app",
        status: state(s, e, b.status === "cancelled"), ...(money && b.status !== "cancelled" && owed > 0 ? { owed_cents: owed } : {}),
        who: named ? b.display_name ?? b.guest ?? "" : null, person_id: named ? b.organiser_id : null, more: Math.max(0, Number(b.players ?? 0) - 1) });
    }
    // Program dates: once each, with every court they're on, and how many have a place.
    const dates = await db.selectFrom("court_time").innerJoin("session", "session.id", "court_time.session_id").innerJoin("program", "program.id", "session.program_id")
      .select(["session.id", "session.program_id", "program.name", "program.kind", "court_time.court_id", sql<Date>`lower(court_time.during)`.as("s"), sql<Date>`upper(court_time.during)`.as("e")])
      .select((eb) => eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).where("enrolment.status", "=", "booked")
        .where((w) => w.or([w("enrolment.session_id", "=", w.ref("session.id")), w.and([w("enrolment.session_id", "is", null), w("enrolment.program_id", "=", w.ref("session.program_id"))])])).as("places"))
      .where("court_time.kind", "=", "session").where("court_time.active", "=", true).where("court_time.court_id", "in", courtIds).where(inRange).orderBy("court_time.court_id").execute();
    for (const d of dates) {
      const had = rows.find((r) => r.key === d.id);
      if (had) { had.court = [had.court, courts.get(d.court_id) ?? ""].join(", "); continue; }
      const s = new Date(d.s), e = new Date(d.e);
      rows.push({ key: d.id, program_id: d.program_id, starts_at: s, ends_at: e, court_id: d.court_id, court: courts.get(d.court_id) ?? "", type: "program", program_kind: d.kind, made_in: "club",
        status: state(s, e, false), who: null, label: d.name, more: Number(d.places ?? 0) });
    }
    // Playtomic copies: bookings still made in Playtomic while the club moves, held here so courts never double up.
    const copies = await db.selectFrom("court_time").innerJoin("mirror_booking", "mirror_booking.court_time_id", "court_time.id")
      .select(["court_time.id", "court_time.court_id", "mirror_booking.booking_type", sql<Date>`lower(court_time.during)`.as("s"), sql<Date>`upper(court_time.during)`.as("e")])
      .where("court_time.kind", "=", "mirror").where("court_time.active", "=", true).where("court_time.court_id", "in", courtIds).where(inRange).execute();
    const names = people ? await playtomicNames(copies.map((x) => x.id)) : new Map<string, { who: string | null; players: string[] }>();
    for (const m of copies) {
      const s = new Date(m.s), e = new Date(m.e), n = names.get(m.id);
      rows.push({ key: `${m.court_id}|${s.toISOString()}`, starts_at: s, ends_at: e, court_id: m.court_id, court: courts.get(m.court_id) ?? "", type: "playtomic", made_in: "playtomic",
        status: state(s, e, false), who: n?.who ?? null, more: n ? Math.max(0, n.players.length - (n.who ? 1 : 0)) : 0, label: t(l, typeKey(m.booking_type)) });
    }
    const shown = rows.filter((r) => (!type || r.type === type) && (!madeIn || r.made_in === madeIn) && (!status || (status === "unpaid" ? (r.owed_cents ?? 0) > 0 : r.status === status)))
      .sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime() || a.court.localeCompare(b.court));
    return { fromDay, toDay, today, loc, money, people, page, shown: shown.map((r) => ({ ...r, date: localDate(r.starts_at, loc.time_zone),
      minutes: Math.round((r.ends_at.getTime() - r.starts_at.getTime()) / 60_000) })) };
  };
  app.get("/staff/bookings", async (c) => {
    const { fromDay, toDay, today, loc, money, people, page, shown } = await bookingsFound(c);
    const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
    return c.json({ from: fromDay, to: toDay, today, time_zone: loc.time_zone, money, people, total: shown.length, page: Math.min(page, pages), pages, per_page: PER_PAGE,
      rows: shown.slice((Math.min(page, pages) - 1) * PER_PAGE, Math.min(page, pages) * PER_PAGE) });
  });
  // The same list as a spreadsheet: every booking the filters find, with what the reader sees on screen and nothing
  // more (an organiser's name only for those who read people, what's owed only for money readers). Column names and
  // kind and status words are English for every reader, as in every download; times are the location's.
  app.get("/staff/bookings.csv", async (c) => {
    const l = "en" as const, { fromDay, toDay, loc, money, people, shown } = await bookingsFound(c, l);
    const at = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: loc.time_zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    const head = ["date", "starts", "ends", "minutes", "court", "kind", "what", "made_in", "status", ...(people ? ["organiser"] : []), "players", "code", ...(money ? ["owed"] : [])].map((k) => t(l, `csv.${k}` as Key));
    const lines = shown.map((r) => [r.date, at(r.starts_at), at(r.ends_at), r.minutes, r.court,
      r.type === "program" && r.program_kind ? t(l, `kind.${r.program_kind}` as Key) : t(l, `ui.list_type_${r.type}` as Key), r.label ?? "", t(l, `ui.made_in_${r.made_in}` as Key), t(l, `ui.booking_state_${r.status}` as Key),
      ...(people ? [r.type === "program" ? "" : r.who ?? ""] : []), r.type === "program" ? r.more : r.more + 1, r.code ?? "", ...(money ? [r.owed_cents ? plainAmount(r.owed_cents) : ""] : [])].map(csvCell).join(","));
    c.header("content-type", "text/csv; charset=utf-8"); c.header("content-disposition", `attachment; filename="${await clubFileStem(db)}-bookings-${fromDay}-to-${toDay}.csv"`);
    return c.body([head.join(","), ...lines].join("\r\n") + "\r\n");
  });

  // A location's weekly courts (booking_series.ts): each member's court every week, with who, when it started and runs
  // until, and how it stands. Members' own courts, not a coach's lessons: someone who reads bookings only as a coach hears
  // the same no as for the Playtomic mirror. Names for those who read people, the price and what's owed for money readers.
  app.get("/staff/weekly-courts", async (c) => {
    const viewer = me(c)!.id;
    if (!(await widerIn(viewer, "bookings"))) throw new KumiError("error.staff_only", {}, 403);
    const id = c.req.query("location_id") ?? "";
    const loc = isUuid(id) ? await db.selectFrom("location").select(["id", "time_zone"]).where("id", "=", id).executeTakeFirst() : undefined;
    if (!loc) throw new KumiError("error.not_found", { thing: { en: "location", es: "la sede" } }, 404);
    const now = new Date(), today = localDate(now, loc.time_zone), people = await seesPeople(viewer);
    const money = await seesMoney(db, viewer, { assistant: opts.assistant }) || await mayAnyOf(viewer, GRID_MONEY, { ownerIds: [], locationId: loc.id });
    const series = await db.selectFrom("booking_series").innerJoin("court", "court.id", "booking_series.court_id").innerJoin("person", "person.id", "booking_series.organiser_id")
      .select(["booking_series.id", "booking_series.starts", "booking_series.minutes", "booking_series.first_date", "booking_series.last_date", "booking_series.source", "booking_series.paused_at",
        "booking_series.organiser_id", "court.name as court", "person.display_name", "person.redacted_at"])
      .where("booking_series.location_id", "=", loc.id).where("booking_series.last_date", ">=", today)
      .orderBy("booking_series.first_date").orderBy("booking_series.starts").execute();
    const weeks = series.length ? await db.selectFrom("booking_series_week").leftJoin("booking", "booking.id", "booking_series_week.booking_id")
      .select(["booking_series_week.series_id", "booking_series_week.on_date", "booking_series_week.price_cents", "booking_series_week.booking_id", "booking_series_week.missed", "booking.status", "booking.balance_cents"])
      .where("booking_series_week.series_id", "in", series.map((s) => s.id)).orderBy("booking_series_week.on_date").execute() : [];
    // A series shows while it has a week still booked (or still to be booked) to come, as on the person's page (seriesOf).
    const live = series.filter((s) => weeks.some((w) => w.series_id === s.id && w.on_date >= today && w.on_date <= s.last_date && ((w.booking_id && w.status !== "cancelled") || (!w.booking_id && !w.missed))));
    return c.json({ money, people, total: live.length, rows: live.map((s) => {
      const mine = weeks.filter((w) => w.series_id === s.id), next = mine.find((w) => w.on_date >= today && w.on_date <= s.last_date && w.status !== "cancelled");
      const owed = mine.filter((w) => w.on_date <= today && w.status && w.status !== "cancelled" && (w.balance_cents ?? 0) > 0).reduce((n, w) => n + (w.balance_cents ?? 0), 0);
      const named = people && !s.redacted_at;
      return { id: s.id, weekday: weekdayOf(s.first_date), starts: s.starts.slice(0, 5), minutes: s.minutes, court: s.court, first_date: s.first_date, last_date: s.last_date,
        made_in: s.source === "desk" ? "desk" : "app", status: s.paused_at ? "paused" : "active", who: named ? s.display_name : null, person_id: named ? s.organiser_id : null,
        ...(money ? { price_cents: next?.price_cents ?? null, owed_cents: owed } : {}) };
    }) });
  });
  // A location's repeating blocks still to come: the pattern, and the next dates a change or an end starts from.
  app.get("/staff/block-series", async (c) => {
    const id = c.req.query("location_id") ?? "";
    const loc = /^[0-9a-f-]{36}$/.test(id) ? await db.selectFrom("location").select("id").where("id", "=", id).executeTakeFirst() : undefined;
    if (!loc) throw new KumiError("error.not_found", { thing: { en: "location", es: "la sede" } }, 404);
    return c.json(await blockSeriesAt(db, loc.id, new Date()));
  });
  // The staff alerts this person was told about that nobody has handled yet, and the ones handled today.
  app.get("/staff/alerts", async (c) => c.json(await staffAlerts(db, me(c)!.id, new Date())));
  app.get("/staff/locations", async (c) => c.json(await db.selectFrom("location").select(["id", "name", "time_zone"]).where("archived_at", "is", null).orderBy("name").execute()));
  app.get("/staff/courts", async (c) => c.json(await db.selectFrom("court").select(["id", "name", "location_id", "kind"]).where("archived_at", "is", null)
    .$if(Boolean(c.req.query("location_id")), (q) => q.where("location_id", "=", c.req.query("location_id")!)).orderBy("sort").orderBy("name").execute()));
  // Search by name, email or phone; role=staff for everyone with a staff role, or one role's key; tag_id for
  // one of the club's tags, segment_id for whoever a saved group matches now. Each row has its tags.
  /** The people a search finds, as /staff/people and the Customers list read them: by name, email or phone; role=staff
   *  for everyone with a staff role, or one role's key; tag_id for one of the club's tags, segment_id for whoever a saved
   *  group matches now. null when a saved group matches nobody. */
  const peopleFound = async (c: Context<any>) => {
    const raw = (c.req.query("q") ?? "").trim(), q = `%${raw}%`, role = c.req.query("role");
    const digits = raw.replace(/\D/g, ""), tagId = c.req.query("tag_id"), segmentId = c.req.query("segment_id");
    const uuid = (v: string | undefined) => v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
    let within: string[] | null = null;
    if (uuid(segmentId)) {
      const seg = await db.selectFrom("segment").select("filters").where("id", "=", segmentId!).where("active", "=", true).executeTakeFirst();
      within = seg ? (await segmentMembers(db, seg.filters as Filters, new Date())).map((p) => p.id) : [];
    }
    if (within && !within.length) return null;
    // An account made for support access (support.ts) isn't one of the club's people.
    return db.selectFrom("person").where("status", "!=", "archived").where("created_via", "!=", "support")
      // Through the assistant door, names only: an email or phone it can match is a yes or no on the whole of one, and
      // the door shows them shortened (mcp.ts), so matching them would let the shortening be undone one letter at a time.
      .where((eb) => eb.or([eb("display_name", "ilike", q), ...(opts.assistant ? [] : [eb("email", "ilike", q), ...(digits.length >= 3 ? [eb(sql<string>`regexp_replace(coalesce(phone, ''), '\\D', '', 'g')`, "like", `%${digits}%`)] : [])])]))
      .$if(Boolean(role), (qb) => qb.where((eb) => eb.exists(eb.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select("person_role.id")
        .whereRef("person_role.person_id", "=", "person.id").where("person_role.active", "=", true)
        .where("role.key", role === "staff" ? "!=" : "=", role === "staff" ? "member" : role!))))
      .$if(Boolean(uuid(tagId)), (qb) => qb.where((eb) => eb.exists(eb.selectFrom("person_tag").select("person_tag.id").whereRef("person_tag.person_id", "=", "person.id")
        .where("person_tag.tag_id", "=", tagId!).where("person_tag.removed_at", "is", null))))
      .$if(Boolean(within), (qb) => qb.where("id", "in", within!));
  };
  // Built-in roles by key (the screen words them); a role the club made by its name.
  const rolesOfRow = (eb: any) => eb.selectFrom("person_role").innerJoin("role", "role.id", "person_role.role_id").select(sql<string[]>`array_agg(DISTINCT CASE WHEN role.system THEN role.key ELSE coalesce(role.name, role.key) END)`.as("r"))
    .whereRef("person_role.person_id", "=", "person.id").where("person_role.active", "=", true).where("role.active", "=", true);
  const tagsOfRow = (eb: any) => eb.selectFrom("person_tag").innerJoin("tag", "tag.id", "person_tag.tag_id").select(sql<string[]>`array_agg(tag.name ORDER BY tag.name)`.as("t"))
    .whereRef("person_tag.person_id", "=", "person.id").where("person_tag.removed_at", "is", null).where("tag.active", "=", true);
  // Search by name, email or phone (peopleFound). Each row has its tags.
  app.get("/staff/people", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 200), found = await peopleFound(c);
    if (!found) return c.json([]);
    return c.json(await found.select(["id", "display_name", "email", "junior", "created_at"]).select((eb) => [rolesOfRow(eb).as("roles"), tagsOfRow(eb).as("tags")])
      .orderBy("display_name").limit(limit).execute());
  });
  // The Customers list: the same search, a page at a time, with how many there are; each person's email and phone (the
  // contact details whoever reads people sees on their page), their membership (their own, or one covering them) and the
  // day it ends, their answer about club news by email, and their level for those who read levels.
  const CUSTOMERS_PAGE = 50;
  app.get("/staff/customers", async (c) => {
    const found = await peopleFound(c), page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));
    if (!found) return c.json({ total: 0, page: 1, pages: 1, per_page: CUSTOMERS_PAGE, levels: false, rows: [] });
    const total = Number((await found.select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n), pages = Math.max(1, Math.ceil(total / CUSTOMERS_PAGE)), at = Math.min(page, pages);
    const reach = await reachOf(me(c)!.id), levels = reach.all || reach.areas.includes("levels");
    // Phone numbers in full for the front desk and up (owner, manager, front desk; support access reads as a manager),
    // who ring members back; everyone else reading the list (the accountant, a coach, a role the club made covering
    // members) sees the last two digits, as the assistant door shortens them (mcp.ts), enough to tell two people apart.
    // No role the club makes reads more contact detail than a member's page gives it, and that page shows no phone.
    const fullPhone = !opts.assistant && deskUp(await rolesOf(me(c)!.id));
    const rows = await found.select(["id", "display_name", "email", "phone", "junior"]).select((eb) => [rolesOfRow(eb).as("roles"), tagsOfRow(eb).as("tags")])
      .orderBy("display_name").orderBy("id").limit(CUSTOMERS_PAGE).offset((at - 1) * CUSTOMERS_PAGE).execute();
    const ids = rows.map((r) => r.id).concat(["00000000-0000-0000-0000-000000000000"]), now = new Date(), tz = await clubTz();
    const LIVE = ["upcoming", "active", "past_due"] as const;
    const own = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
      .select(["membership.person_id", "membership_plan.name", "membership.current_period_end", "membership.source"]).where("membership.person_id", "in", ids).where("membership.status", "in", [...LIVE]).execute();
    const covered = await db.selectFrom("membership_member").innerJoin("membership", "membership.id", "membership_member.membership_id").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
      .select(["membership_member.person_id", "membership_plan.name", "membership.current_period_end", "membership.source"]).where("membership_member.person_id", "in", ids).where("membership.status", "in", [...LIVE])
      .where((w) => w.or([w("membership_member.ends_at", "is", null), w("membership_member.ends_at", ">", now)])).execute();
    const news = await db.selectFrom("channel_consent").select(["person_id", "granted"]).distinctOn(["person_id"]).where("person_id", "in", ids)
      .where("channel", "=", "email").where("purpose", "=", "club_news").orderBy("person_id").orderBy("at", "desc").execute();
    const level = levels ? await db.selectFrom("rating").select(["person_id", "level"]).where("person_id", "in", ids).where("sport", "=", "padel").execute() : [];
    return c.json({ total, page: at, pages, per_page: CUSTOMERS_PAGE, levels, rows: rows.map((r) => {
      const m = own.find((x) => x.person_id === r.id) ?? covered.find((x) => x.person_id === r.id), n = news.find((x) => x.person_id === r.id);
      // The phone in full or to its last two digits (fullPhone); a search by phone finds them either way.
      return { ...r, phone: fullPhone ? r.phone : shortContact("phone", r.phone) as string | null, membership: m ? { name: m.name, ends_on: m.current_period_end ? endDay({ current_period_end: m.current_period_end, source: m.source }, tz) : null } : null,
        // A junior isn't asked about club news (their family is).
        club_news: r.junior || !n ? null : n.granted, ...(levels ? { level: level.find((x) => x.person_id === r.id)?.level ?? null } : {}) };
    }) });
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
    // Money (what they paid or owe, prices, refunds, their balance, a kid's spending) is for the club's money people
    // (seesMoney) and whoever may do a money change the page offers (PERSON_MONEY: a membership desk, a refunds role),
    // never for someone reading the page without it: a coach looking at their own student, or a role the club made
    // covering members and not money. They read the rest, and the page says which (`money`).
    const money = await seesMoney(db, me(c)!.id, { assistant: opts.assistant }) || await mayAnyOf(me(c)!.id, PERSON_MONEY, { ownerIds: [] });
    const places = await db.selectFrom("enrolment").innerJoin("program", "program.id", "enrolment.program_id")
      .select(["enrolment.id", "enrolment.status", "enrolment.program_id", "program.name"])
      .select((eb) => eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").as("first_start"))
      .where("enrolment.person_id", "=", id).orderBy("enrolment.id", "desc").limit(20).execute();
    // Their court bookings and lessons from the last 30 days on, as organiser or player: what each cost, what they
    // paid on it by card that can still go back, so the desk can cancel it or refund it from here.
    const since = new Date(Date.now() - 30 * 86400_000);
    const booked = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id")
      .select(["booking.id", "booking.code", "booking.kind", "booking.status", "booking.price_cents", "booking.organiser_id", "booking.location_id", "court.name as court", sql<string>`lower(court_time.during)`.as("starts_at")])
      .where((w) => w.or([w("booking.organiser_id", "=", id), w.exists(w.selectFrom("booking_player").select("booking_player.id").whereRef("booking_player.booking_id", "=", "booking.id")
        .where("booking_player.person_id", "=", id).where("booking_player.removed_at", "is", null))]))
      .where(sql<boolean>`upper(court_time.during) >= ${since}`).where("booking.status", "in", ["held", "confirmed", "completed", "cancelled"])
      .where((w) => w.or([w("court_time.active", "=", true), w("booking.status", "=", "cancelled")])).where(itsTimeNow)
      .orderBy("booking.id").execute();
    const pays = booked.length ? await db.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
      .select(["payment.id", "booking_player.booking_id", "payment.amount_cents", "payment.provider", "payment.person_id", "payment.method"]).select(promoOff().as("off"))
      .select(sql<string>`coalesce((select sum(r.amount_cents) from refund r where r.payment_id = payment.id and r.status in ('pending', 'sent')), 0)`.as("back"))
      .where("booking_player.booking_id", "in", booked.map((b) => b.id)).where("payment.status", "=", "succeeded").where("payment.person_id", "=", id).execute() : [];
    const bookings = booked.sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at))).slice(0, 20).map((b) => {
      const mine = pays.filter((x) => x.booking_id === b.id);
      return { id: b.id, code: b.code, kind: b.kind, status: b.status, court: b.court, location_id: b.location_id, starts_at: new Date(b.starts_at).toISOString(), price_cents: b.price_cents, organiser: b.organiser_id === id,
        paid_cents: mine.reduce((n, x) => n + x.amount_cents - Number(x.back), 0),
        // What a promo code took off their part, so a share paid in full with a code doesn't read as short.
        off_cents: mine.reduce((n, x) => n + Number(x.off), 0),
        // Paid in Playtomic (a booking taken over), said as such.
        pt_cents: mine.filter((x) => x.method === "playtomic").reduce((n, x) => n + x.amount_cents - Number(x.back), 0),
        refundable: mine.filter((x) => x.provider !== "none" && x.amount_cents - Number(x.back) > 0).map((x) => ({ payment_id: x.id, left_cents: x.amount_cents - Number(x.back) })) };
    });
    // Refunds to them that didn't go through: the staff can send each again.
    const failedRefunds = await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").select(["refund.id", "refund.amount_cents", "refund.failure", "refund.created_at"])
      .where("payment.person_id", "=", id).where("refund.status", "=", "failed").orderBy("refund.created_at", "desc").limit(20).execute();
    // The latest answer for each kind of message: consent is append-only.
    const consent = await db.selectFrom("channel_consent").select(["channel", "purpose", "granted", "source", "at"]).distinctOn(["channel", "purpose"])
      .where("person_id", "=", id).orderBy("channel").orderBy("purpose").orderBy("at", "desc").execute();
    const membership = await db.selectFrom("membership").innerJoin("membership_plan", "membership_plan.id", "membership.plan_id")
      .select(["membership.id", "membership.plan_id", "membership_plan.name", "membership.status", "membership.source", "membership.started_at", "membership.current_period_end",
        "membership.cancel_at_period_end", "membership.price_cents", "membership.note", "membership.paused_until", "membership.balance_cents", sql<boolean>`membership.saved_method IS NOT NULL`.as("card_saved")])
      .where("membership.person_id", "=", id).where("membership.status", "in", ["upcoming", "active", "past_due"]).executeTakeFirst();
    // What the desk would take for it now (what's owed, or the next period), and what waits there to give back to
    // them: for the club's money people, not a coach looking at their own student.
    const due = membership && money ? await membershipDue(db, membership.id) : null, giveBack = money ? await toGiveBack(db, id) : [];
    const plans = await db.selectFrom("membership_plan").select(["id", "name", "description", "translations", "price_cents", "period", "days_ahead", "join_in_app", "max_members", "starts_on", "sort"]).where("active", "=", true).orderBy("sort").orderBy("name").execute();
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
    const kid = k ? { email: p.email, rules: rulesText(k)[lang(c)], ...(money ? { spent_cents: await monthSpent(db, id, new Date()) } : {}) } : null;
    // The club's email can't reach them (email_suppression.ts): the desk sees why, and can clear it once it's fixed.
    const emailProblem = p.email ? await personEmailProblem(db, p.id) : null;
    // Their weekly courts still running (booking_series.ts), each with its weeks from today.
    // Without money: each week's price, whether it's owed (as booked) and whether it was charged are left out.
    const series = (await seriesOf(db, p.id, new Date())).map((x) => money ? x : { ...x, weeks: x.weeks.map(({ price_cents: _p, charged: _c, ...w }) => ({ ...w, state: w.state === "owed" ? "booked" : w.state })) });
    // Their club credit (credit.ts), for staff who see money: what the club owes them, to pay out at the desk.
    const credit = money ? await creditBalance(db, p.id) : null;
    // A membership's payment state too: behind on payment reads as running, and whether a card is saved isn't said.
    const BOOKING_MONEY = ["price_cents", "paid_cents", "off_cents", "pt_cents", "refundable"], MEMBERSHIP_MONEY = ["price_cents", "balance_cents", "card_saved"];
    const unpaid = <T extends object>(row: T, keys: string[]) => money ? row : Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k))) as Partial<T>;
    return c.json({ ...p, money, email_problem: emailProblem, kid, roles, sign_in: signIn, places, bookings: bookings.map((b) => unpaid(b, BOOKING_MONEY)), series, credit_cents: credit, failed_refunds: money ? failedRefunds : [], to_give_back: giveBack.map(({ id, amount_cents, method, created_at }) => ({ id, amount_cents, method, created_at })), consent, plans, tags, family_role: hh?.role ?? null, family, covered_by: cover ?? null, also_covers: alsoCovers, waiver: waiver ? { ...waiver, accepted_on: waiver.accepted_at ? localDate(waiver.accepted_at, tz) : null } : null,
      membership: membership ? { ...unpaid(membership, MEMBERSHIP_MONEY), ...(money || membership.status !== "past_due" ? {} : { status: "active" }), ends_on: membership.current_period_end ? endDay({ current_period_end: membership.current_period_end, source: membership.source }, tz) : null, ...(money ? { due } : {}) } : null,
      // Their bookings in the club's copy of Playtomic, newest first, read only (playtomic_archive.ts).
      // A coach sees who a student played with in Playtomic no more than in Kumi's own list above: front desk and up do.
      playtomic: await (async () => { const desk = deskUp(await rolesOf(me(c)!.id));
        return (await archiveOf(db, id, { limit: 30 })).map(({ price, payment_status, ...b }) => ({ ...b, ...(money ? { price, payment_status } : {}), others: desk ? b.others : [], kind: t(lang(c), typeKey(b.type)) })); })() });
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
        "enrolment.left_how", "enrolment.left_reason", "enrolment.refund_outcome", "enrolment.refund_cents", "enrolment.comp_note", "enrolment.session_id", "rating.level"])
      .where("enrolment.program_id", "=", id).orderBy("enrolment.status").orderBy("enrolment.waitlist_position").orderBy("enrolment.created_at").execute();
    const offers = await db.selectFrom("waitlist_offer").select(["enrolment_id", "expires_at"]).where("outcome", "is", null).where("expires_at", ">", new Date())
      .where("enrolment_id", "in", roster.length ? roster.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"]).execute();
    const club = await db.selectFrom("club").select("program_decide_hours").executeTakeFirstOrThrow();
    const money = await seesProgramMoney(c, program.location_id), opens = await datesOpen(me(c)!.id, program.location_id, sessions);
    return c.json({
      program, coaches, money, decide_hours: club.program_decide_hours,
      // Signed up per date: each date's own places and how many have one.
      sessions: sessions.map((s) => ({ ...s, courts: courts.filter((x) => x.session_id === s.id).map((x) => x.name), has_draw: draws.some((d) => d.session_id === s.id),
        places: s.capacity_override ?? program.capacity, booked: roster.filter((r) => r.session_id === s.id && r.status === "booked").length, opens: opens.get(s.id)! })),
      roster: money ? await Promise.all(roster.map(async (r) => ({ ...r, paid_cents: await coveredFor(db, r.id), offer_expires_at: offers.find((o) => o.enrolment_id === r.id)?.expires_at ?? null })))
        : roster.map((r) => ({ ...Object.fromEntries(Object.entries(r).filter(([k]) => !(PLACE_MONEY as readonly string[]).includes(k))), offer_expires_at: offers.find((o) => o.enrolment_id === r.id)?.expires_at ?? null })),
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

  // A tournament or league: its pairs, who has a place without a partner, the draw, matches and tables.
  app.get("/staff/programs/:id/competition", async (c) => {
    const id = c.req.param("id");
    const v = await competitionView(db, id);
    const paired = new Set(v.entries.filter((e) => e.status === "invited" || e.status === "entered").flatMap((e) => [e.person_a, e.person_b]));
    const single = await db.selectFrom("enrolment").innerJoin("person", "person.id", "enrolment.person_id").select(["person.id", "person.display_name"])
      .where("enrolment.program_id", "=", id).where("enrolment.status", "=", "booked").orderBy("person.display_name").execute();
    const courts = await db.selectFrom("court_time").innerJoin("session", "session.id", "court_time.session_id").innerJoin("court", "court.id", "court_time.court_id")
      .select(["court.id", "court.name"]).distinct().where("session.program_id", "=", id).where("court_time.active", "=", true).execute();
    const prog = await db.selectFrom("program").select(["kind", "name", "public_names", "visibility"]).where("id", "=", id).executeTakeFirstOrThrow();
    return c.json({ ...v, kind: prog.kind, name: prog.name, public_names: prog.public_names, public: prog.visibility === "public", without_partner: single.filter((p) => !paired.has(p.id)).map((p) => ({ id: p.id, name: p.display_name })), courts });
  });

  // A night's draw, players and scores: whoever runs its draw or scores, or sets the session's levels after it (a coach,
  // their own sessions): NIGHT_READ.
  app.get("/staff/sessions/:id/night", async (c) => {
    const id = c.req.param("id");
    await coachRuns(c, "session", id, NIGHT_READ);
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
    const sat = (draw?.sat_out ?? {}) as Record<string, string[]>, satIds = [...new Set(Object.values(sat).flat())];
    const satNames = new Map((satIds.length ? await db.selectFrom("person").select(["id", "display_name"]).where("id", "in", satIds).execute() : []).map((p) => [p.id, p.display_name]));
    for (const id of satIds) names.set(id, satNames.get(id) ?? "");
    const table = (await standings(db, id)).map((s) => ({ name: names.get(s.person_id) ?? "", points: s.points, games: s.games, top: s.top }));
    const list = [...rounds].map(([round, gs]) => ({ round, games: gs as { status: string }[], sat_out: (sat[String(round)] ?? []).map((p) => names.get(p) ?? "") }));
    const last = list[list.length - 1];
    // Mexicano and King of the Court: the next round can be made once the last one has all its scores.
    const next = draw && draw.format !== "americano" && last && last.round < draw.rounds && last.games.every((g) => g.status === "confirmed") ? last.round + 1 : null;
    const prog = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").select("program.format").where("session.id", "=", id).executeTakeFirst();
    return c.json({ draw: draw ?? null, format: prog?.format ?? null, rounds: list, standings: table, next_round: next });
  });

  // A program date as the Schedule's side panel shows it: its places, level and price, the dates of its series, and who's
  // on it with how each place stands (paid, a pass, club credit, a membership, a free place, not paid, or waiting).
  // Names for those who read people, and a coach on their own date (as its roster); a role the club made covering
  // bookings and not programs never gets here (the programs area). How each place was paid only for the program's
  // money readers; a coach sees who's coming and who's waiting, not what they paid.
  app.get("/staff/sessions/:id/panel", async (c) => {
    const id = c.req.param("id"), viewer = me(c)!.id, now = new Date();
    if (!isUuid(id)) throw new KumiError("error.not_found", { thing: both("thing.session") }, 404);
    if (!(await seesPeople(viewer))) await coachRuns(c, "session", id, ["attendance.mark"]);
    const item = await coachItem(db, "session", id), r = await rosterOf(db, "session", id, now);
    const p = await db.selectFrom("program").select(["id", "kind", "capacity", "level_min", "level_max", "price_cents", "member_price_cents", "location_id"]).where("id", "=", item.program_id!).executeTakeFirstOrThrow();
    const s = await db.selectFrom("session").select("capacity_override").where("id", "=", id).executeTakeFirstOrThrow();
    const dates = await db.selectFrom("session").select([(eb) => eb.fn.min("starts_at").as("first"), (eb) => eb.fn.max("starts_at").as("last"), (eb) => eb.fn.countAll<string>().as("n")])
      .where("program_id", "=", p.id).where("status", "!=", "cancelled").executeTakeFirstOrThrow();
    const places = await db.selectFrom("enrolment").innerJoin("person", "person.id", "enrolment.person_id")
      .select(["enrolment.id", "enrolment.person_id", "enrolment.status", "enrolment.waitlist_position", "enrolment.paid_by", "enrolment.price_cents", "enrolment.price_basis", "person.display_name"])
      .where("enrolment.program_id", "=", p.id).where("enrolment.status", "in", ["booked", "attended", "waitlisted"])
      .where((w) => w.or([w("enrolment.session_id", "=", id), w("enrolment.session_id", "is", null)])).orderBy("enrolment.waitlist_position").orderBy("enrolment.created_at").execute();
    const money = await seesProgramMoney(c, p.location_id);
    const how = async (e: (typeof places)[number]) => {
      if (e.paid_by === "comp") return "free";
      if (e.price_basis === "included") return "membership";
      const ways = (await db.selectFrom("payment").select("method").where("enrolment_id", "=", e.id).where("status", "=", "succeeded").execute()).map((x) => x.method);
      if (ways.includes("pass")) return "pass";
      if (await coveredFor(db, e.id) >= e.price_cents) return ways.length && ways.every((m) => m === "credit") ? "credit" : "paid";
      return "unpaid";
    };
    const players = [];
    for (const x of r.players) {
      const e = places.find((y) => y.person_id === x.person_id && y.status !== "waitlisted");
      players.push({ person_id: x.person_id, name: x.name, came: x.came, ...(money && e ? { pay: await how(e) } : {}) });
    }
    const waiting = places.filter((y) => y.status === "waitlisted");
    return c.json({ time_zone: await clubTz(), money, session: { id, program_id: p.id, kind: p.kind, name: item.name, start: item.start, end: item.end, courts: item.courts, coach: item.coach,
      cancelled: item.cancelled }, places: s.capacity_override ?? p.capacity, booked: r.players.length, waiting: waiting.length,
      level_min: p.level_min, level_max: p.level_max, ...(money ? { price_cents: p.price_cents, member_price_cents: p.member_price_cents } : {}),
      series: { first: dates.first, last: dates.last, dates: Number(dates.n) }, marking: r.marking,
      players: [...players, ...waiting.map((w, n) => ({ person_id: w.person_id, name: w.display_name, came: null, waitlist: w.waitlist_position ?? n + 1 }))] });
  });

  // The level review queue: reviews players asked for, and levels that moved a lot.
  app.get("/staff/levels", async (c) => c.json({ ...await levelQueue(db, new Date()), limit: MOVE_LIMIT, days: MOVE_DAYS }));
  // Everyone who had a place in a session, with their levels, for setting levels after it.
  app.get("/staff/sessions/:id/levels", async (c) => {
    await coachRuns(c, "session", c.req.param("id"), ["level.set_session"]);
    const { session, players, absent } = await sessionPlayers(db, c.req.param("id")), tz = await clubTz();
    return c.json({ session: { ...session, when: dateTime(new Date(session.starts_at), lang(c), tz), started: new Date(session.starts_at) <= new Date() }, players, absent });
  });

  // The club's monthly meter (usage.ts), for the owner and managers: this month by kind against the cap, and the
  // months before it. Only the owner changes the cap (club.usage_cap_set; a manager can ask).
  app.get("/staff/usage", async (c) => {
    const keys = await rolesOf(me(c)!.id);
    if (!keys.some((k) => k === "owner" || k === "manager")) throw new KumiError("error.staff_only", {}, 403);
    return c.json({ usage: await usageView(db, new Date()), texts: await textUsage(db, new Date()) });
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
    const imports = await importOptions(db, id);
    return c.json({ person, rating: rating ?? null, events: events.map((e) => ({ ...e, explanation: (e.explanation as Record<string, string>)[l] ?? "" })),
      ...imports, import: imports.import ? { ...imports.import, explanation: imports.import.explanation[l] } : null });
  });

  // The Playtomic mirror: how the last copy went, courts still to link, and bookings that clash with Kumi.
  // Moving in from Playtomic (brought_in.ts): what's been brought over, Playtomic's players as last read and the
  // memberships among them, for the owner and managers. Club credit and members' details: money and members both.
  const ownerOrManager = async (c: Context<any>) => {
    if (!(await rolesOf(me(c)!.id)).some((r) => r === "owner" || r === "manager")) throw new KumiError("error.staff_only", {}, 403);
  };
  const benefitCounts = (players: { benefits?: { name: string; until: string | null }[] }[]) => {
    const n = new Map<string, { name: string; people: number }>();
    for (const p of players) for (const b of p.benefits ?? []) { const k = b.name.trim().toLowerCase(); const e = n.get(k) ?? { name: b.name.trim(), people: 0 }; e.people++; n.set(k, e); }
    return [...n.values()].sort((a, b) => b.people - a.people);
  };
  app.get("/staff/move-in", async (c) => {
    await ownerOrManager(c);
    const { upload, ...st } = await moveInStatus(db);
    const kept = await db.selectFrom("playtomic_player").select("benefits").execute();
    const plans = await db.selectFrom("membership_plan").select(["id", "name", "translations", "price_cents", "period", "join_in_app"]).where("active", "=", true).orderBy("sort").execute();
    const l = lang(c);
    // The latest upload of the club's export, as the server read it: what staff choose from (never sent back as rows).
    const up = upload ? { id: upload.id, sha256: upload.sha256, file_name: upload.file_name, at: upload.at, rows: upload.rows, wallet_columns: upload.wallet_columns,
      uploaded_by: upload.uploaded_by, erased: upload.erased,
      problems: upload.problems.slice(0, 50).map((p) => ({ line: p.line, text: p.text[l] })), benefits: benefitCounts(upload.players) } : null;
    return c.json({ ...st, upload: up, has_keys: Boolean(process.env.KUMI_PLAYTOMIC_CLIENT_ID && process.env.KUMI_PLAYTOMIC_SECRET && process.env.KUMI_PLAYTOMIC_TENANT_ID),
      benefits: benefitCounts(kept.map((k) => ({ benefits: k.benefits as { name: string; until: string | null }[] }))),
      plans: plans.map((p) => ({ id: p.id, name: inLang(p.name, p.translations, "name", l), join_in_app: p.join_in_app })) });
  });

  app.get("/staff/mirror", async (c) => {
    // The Playtomic mirror is the club's moving in and its bookings side by side, not a coach's own work: someone who
    // reads bookings only as a coach hears the same no as for any page outside their areas.
    const viewer = me(c)!.id;
    if (!(await widerIn(viewer, "bookings"))) throw new KumiError("error.staff_only", {}, 403);
    // A role the club made covering bookings but not money: no price, payment, or Playtomic's owner of a booking.
    const money = await seesMoney(db, viewer, { assistant: opts.assistant }), people = await seesPeople(viewer);
    const l = lang(c);
    const status = await db.selectFrom("connector_status").selectAll().where("system", "=", PLAYTOMIC).executeTakeFirst();
    const refs = await db.selectFrom("external_ref").select(["external_id", "entity_id"]).where("system", "=", PLAYTOMIC).where("entity", "=", "court").execute();
    const courts = new Map((await db.selectFrom("court").select(["id", "name"]).execute()).map((r) => [r.id, r.name]));
    const ptNames = new Map(((status?.courts ?? []) as { courtRef: string; courtName: string }[]).map((x) => [x.courtRef, x.courtName]));
    const kind = (type: string) => t(l, typeKey(type));
    const conflicts = await db.selectFrom("mirror_booking").leftJoin("court_time", "court_time.id", "mirror_booking.clash_id").leftJoin("session", "session.id", "court_time.session_id").leftJoin("program", "program.id", "session.program_id")
      .select(["mirror_booking.ref", "mirror_booking.court_id", "mirror_booking.booking_type", "program.name as event", "session.id as session_id", sql<Date>`lower(mirror_booking.during)`.as("starts_at"), sql<Date>`upper(mirror_booking.during)`.as("ends_at")])
      .where("mirror_booking.system", "=", PLAYTOMIC).where("mirror_booking.status", "=", "conflict").where(sql<boolean>`upper(mirror_booking.during) > now()`).orderBy(sql`lower(mirror_booking.during)`).execute();
    return c.json({
      status: status ? { last_sync_at: status.last_sync_at, last_ok_at: status.last_ok_at, failed: Boolean(status.last_error), fetched: status.fetched } : null,
      // From the last sync, less any court linked since then.
      unmapped: ((status?.unmapped ?? []) as { courtRef: string }[]).filter((u) => !refs.some((r) => r.external_id === u.courtRef)),
      linked: refs.map((r) => ({ resource_id: r.external_id, name: ptNames.get(r.external_id) ?? r.external_id, court_id: r.entity_id, court: courts.get(r.entity_id) ?? "" })),
      conflicts: conflicts.map((r) => ({ ref: r.ref, court: courts.get(r.court_id) ?? "", kind: kind(r.booking_type), starts_at: r.starts_at, ends_at: r.ends_at, event: r.event, session_id: r.session_id })),
      // Moving from Playtomic (playtomic_archive.ts): the two side by side, a week ahead; and upcoming player
      // bookings that can be taken over.
      compare: status ? await comparison(db, new Date(), 7).then((x) => ({ days: x.days, diffs: x.diffs.filter((d) => money || d.kind !== "paid").map((d) => ({ ...d, kind_label: kind(d.type) })) })) : null,
      // Playtomic's owner of each by name only for those who read people (seesPeople), as on the Schedule.
      take_over: status ? (await takeOverCandidates(db, new Date())).map(({ price, payment_status, owner, ...x }) => ({ ...x, ...(money ? { price, payment_status, ...(people ? { owner } : {}) } : {}), kind: kind(x.type) })) : [],
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
