// The staff app's Today page, its Approvals page and the counts on its menu: what needs a person now, today's takings so
// far and what happened since the reader last looked; and every ask waiting for a yes. Views only: answering an ask is
// /runs/:id/approve and /decline as before (actions.ts), and each row links to the page where it's handled.
//
// Each part only for those whose roles read it, judged as the page it links to judges it (reads.ts): money for the
// club's money people, levels and scores for those reading levels, members' questions for the front desk and up, and so
// on. Names (who asked, who owes, whose card failed) only for those who read people: a role the club made covering
// bookings but not members sees counts and times, never a name (12 Nov 2026), and an ask's own title in place of its
// summary, which names people.
import { Hono, type Context } from "hono";
import { sql } from "kysely";
import { productName, t, type Key, type Lang } from "@kumi/i18n";
import { ASK_ENDED, decide, levelQueue, localDate, mayAnswer, onDate, promoOff, staffAlerts, type Db, type Owners } from "@kumi/core";
import { seesChats } from "./chats.ts";
import { seesMoney } from "./receipts.ts";

type Me = { id: string; locale: string } | null;
/** What reads.ts knows of a reader, handed over so both judge them the same way. */
export interface Reader {
  reach(id: string): Promise<{ all: boolean; coach: boolean; custom: string[]; areas: string[] }>;
  roles(id: string): Promise<string[]>;
  mayAnyOf(id: string, actions: string[], o: Owners): Promise<boolean>;
}
const DESK_UP = ["owner", "manager", "front_desk"];
/** Who may take a booking's payment or give it back (reads.ts GRID_MONEY): they read what's owed on the Schedule. */
const GRID_MONEY = ["booking.record_payment", "booking.refund"];
/** Alerts another row of Today already counts (a question waiting, money owed on a booking): not twice. */
const ALERTS_COUNTED = new Set(["question_unanswered_staff", "booking_balance_due_staff", "booking_parts_owed_staff"]);
/** The kinds of money the ledger keeps apart (money.ts), each worded on Today; anything else is "other". */
const REVENUE = ["courts", "lessons", "programs", "memberships", "passes", "gift_cards", "after_restore"];
/** How far back "since you last looked" reaches, how far ahead a coach's time off is checked against their work, how
 *  far back a failed card charge is shown, and how many rows each part lists. */
const SINCE_MAX_HOURS = 72, COVER_DAYS = 7, FAILED_DAYS = 7, LIST = 3, SINCE_LIST = 8;

export type NeedKind = "approvals" | "owed" | "disputes" | "levels" | "questions" | "cover" | "failed" | "alerts";
export interface Need { kind: NeedKind; count: number; href: string; items: { text: string | null; sub?: string | null; at?: string | null; cents?: number | null; href?: string | null }[] }

export function todayRoutes(db: Db, me: (c: Context<any>) => Me, lang: (c: Context<any>) => Lang, r: Reader) {
  const app = new Hono();
  const clubTz = async () => (await db.selectFrom("club").select("time_zone").executeTakeFirstOrThrow()).time_zone;

  /** What one reader reads, worked out once per request. */
  async function lens(id: string) {
    const reach = await r.reach(id), roles = await r.roles(id), reads = (area: string) => reach.all || reach.areas.includes(area);
    const wide = (area: string) => reach.all || reach.custom.includes(area);
    const money = await seesMoney(db, id);
    return { reach, reads, money, people: wide("members"), desk: roles.some((k) => DESK_UP.includes(k)),
      owedSeen: money || (wide("bookings") && await r.mayAnyOf(id, GRID_MONEY, { ownerIds: [] })),
      // A coach with no other staff role has their own schedule, not Today (the staff app gives them no link to it).
      coachOnly: !reach.all && !reach.custom.length };
  }
  type Lens = Awaited<ReturnType<typeof lens>>;

  /** The asks waiting that this person may say yes or no to, oldest first. */
  async function waitingFor(id: string, now: Date) {
    const rows = await db.selectFrom("action_run").leftJoin("person", "person.id", "action_run.actor_person_id").leftJoin("support_grant", "support_grant.id", "action_run.support_grant_id")
      .select(["action_run.id", "action_run.action", "action_run.input", "action_run.plan", "action_run.location_id", "action_run.actor_person_id", "action_run.via", "action_run.created_at",
        "action_run.plan_expires_at", "action_run.money_cents", "person.display_name", "support_grant.name as support_name"])
      .where("action_run.status", "=", "awaiting_approval").where("action_run.plan_expires_at", ">", now).orderBy("action_run.created_at").limit(200).execute();
    const out: typeof rows = [];
    for (const x of rows) if (await mayAnswer(db, x, id, now)) out.push(x);
    return out;
  }
  type Ask = Awaited<ReturnType<typeof waitingFor>>[number];
  /** An ask as the screens show it: who asked and its summary only for those who read people (its title otherwise). */
  const askView = (x: Pick<Ask, "id" | "action" | "plan" | "via" | "created_at" | "plan_expires_at" | "money_cents" | "display_name" | "support_name">, l: Lang, o: Lens) => {
    const p = x.plan as { title?: Record<Lang, string>; summary?: Record<Lang, string>; undo?: { kind?: string }; secondPerson?: boolean };
    const by = x.support_name ? t(l, "ui.support_by", { name: x.support_name }) : x.display_name ?? productName();
    return { id: x.id, action: x.action, title: p.title?.[l] ?? x.action, summary: o.people ? p.summary?.[l] ?? null : null, by: o.people ? by : null, via: x.via,
      asked_at: x.created_at, expires_at: x.plan_expires_at, undo: p.undo?.kind ?? null, ...(o.money ? { money_cents: Number(x.money_cents) || 0 } : {}) };
  };

  /** Everything on Today that needs a person, each part only where the reader's roles read it. `full`: the page itself,
   *  with a few of each to show; the menu's count needs only how many. */
  async function needs(id: string, o: Lens, l: Lang, now: Date, full: boolean): Promise<Need[]> {
    const tz = await clubTz(), today = localDate(now, tz), from = onDate(today, "00:00", tz), to = onDate(today, "24:00", tz);
    const out: Need[] = [];
    const hm = (d: Date) => new Intl.DateTimeFormat(l === "es" ? "es-US" : "en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
    const day = (d: Date) => new Intl.DateTimeFormat(l === "es" ? "es-US" : "en-US", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);

    // Asks waiting for this person's yes.
    const asks = await waitingFor(id, now);
    if (asks.length) out.push({ kind: "approvals", count: asks.length, href: "/approvals",
      items: full ? asks.slice(0, LIST).map((x) => { const v = askView(x, l, o); return { text: v.summary ?? v.title, sub: v.by, at: v.asked_at.toISOString() }; }) : [] });

    // Money owed at the desk on today's courts and today's program dates (what the Schedule and Bookings mark unpaid).
    if (o.owedSeen) {
      const owed = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").innerJoin("court", "court.id", "court_time.court_id").leftJoin("person", "person.id", "booking.organiser_id")
        .select(["booking.id", "booking.code", "booking.price_cents", "court.name as court", "person.display_name", sql<Date>`lower(court_time.during)`.as("s")])
        .select((eb) => eb.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(sql<string>`coalesce(sum(payment.amount_cents), 0)`.as("c"))
          .whereRef("booking_player.booking_id", "=", "booking.id").where("payment.status", "=", "succeeded").as("paid"))
        .select((eb) => eb.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id")
          .select(sql<string>`coalesce(sum(refund.amount_cents), 0)`.as("c")).whereRef("booking_player.booking_id", "=", "booking.id").where("refund.status", "!=", "failed").as("back"))
        .select((eb) => eb.selectFrom("payment").innerJoin("booking_player", "booking_player.id", "payment.booking_player_id").select(sql<string>`coalesce(sum(${promoOff()}), 0)`.as("c"))
          .whereRef("booking_player.booking_id", "=", "booking.id").where("payment.status", "=", "succeeded").as("off"))
        .where("booking.status", "in", ["confirmed", "completed"]).where("court_time.active", "=", true)
        .where(sql<boolean>`lower(court_time.during) >= ${from} AND lower(court_time.during) < ${to}`).orderBy(sql`lower(court_time.during)`).execute();
      const seen = new Set<string>(), rows: { at: Date; text: string | null; sub: string; cents: number; href?: string }[] = [];
      for (const b of owed) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        const due = b.price_cents - (Number(b.paid ?? 0) - Number(b.back ?? 0)) - Number(b.off ?? 0);
        if (due > 0) rows.push({ at: new Date(b.s), text: o.people ? b.display_name : null, sub: `${hm(new Date(b.s))} · ${b.court} · ${b.code}`, cents: due });
      }
      // A place on one of today's dates with nothing paid for it yet (a price, and no payment of any kind).
      const places = await db.selectFrom("enrolment").innerJoin("session", (j) => j.on((eb) => eb.or([eb("session.id", "=", eb.ref("enrolment.session_id")),
        eb.and([eb("enrolment.session_id", "is", null), eb("session.program_id", "=", eb.ref("enrolment.program_id"))])])))
        .innerJoin("program", "program.id", "session.program_id").innerJoin("person", "person.id", "enrolment.person_id")
        .select(["enrolment.id", "enrolment.price_cents", "program.name", "person.display_name", "session.id as session_id", "session.starts_at"])
        .where("enrolment.status", "=", "booked").where("enrolment.paid_by", "=", "none").where("enrolment.price_cents", ">", 0).where("session.status", "!=", "cancelled")
        .where("session.starts_at", ">=", from).where("session.starts_at", "<", to).orderBy("session.starts_at").execute();
      for (const p of places) rows.push({ at: new Date(p.starts_at), text: o.people ? p.display_name : null, sub: `${hm(new Date(p.starts_at))} · ${p.name}`, cents: p.price_cents,
        ...(o.reads("programs") ? { href: `/sessions/${p.session_id}` } : {}) });
      rows.sort((a, b) => a.at.getTime() - b.at.getTime());
      if (rows.length) out.push({ kind: "owed", count: rows.length, href: "/bookings?status=unpaid",
        items: full ? rows.slice(0, LIST).map((x) => ({ text: x.text, sub: x.sub, cents: x.cents, at: x.at.toISOString(), href: x.href ?? null })) : [] });
    }

    // Scores the players disagree on, and level reviews (asked for, or a level that moved a lot).
    if (o.reads("levels")) {
      const d = await db.selectFrom("game").select((eb) => eb.fn.countAll<string>().as("n")).where("status", "=", "disputed").where("booking_id", "is not", null).executeTakeFirstOrThrow();
      if (Number(d.n)) out.push({ kind: "disputes", count: Number(d.n), href: "/scores", items: [] });
      const q = await levelQueue(db, now), n = q.requests.length + q.moves.length;
      if (n) out.push({ kind: "levels", count: n, href: "/levels",
        items: full && o.people ? [...q.requests.map((x) => ({ text: x.name, sub: null })), ...q.moves.map((x) => ({ text: x.name, sub: `${x.from.toFixed(2)} → ${x.level.toFixed(2)}` }))].slice(0, LIST) : [] });
    }

    // Members' questions the club's answers handed over to a person (front desk and up, as the Questions page).
    if (o.desk) {
      const q = await db.selectFrom("question").select((eb) => eb.fn.countAll<string>().as("n")).where("status", "=", "open").executeTakeFirstOrThrow();
      if (Number(q.n)) out.push({ kind: "questions", count: Number(q.n), href: "/questions", items: [] });
    }

    // A coach off when they're down to run a program date or a lesson in the next week: someone else has to cover it.
    if (o.reach.all || o.reach.custom.includes("coaches") || o.reach.custom.includes("programs")) {
      const until = new Date(now.getTime() + COVER_DAYS * 86400_000);
      const dates = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id").leftJoin("person", "person.id", "session.coach_id")
        .select(["session.id", "session.program_id", "session.starts_at", "program.name", "person.display_name"])
        .where("session.coach_id", "is not", null).where("session.status", "!=", "cancelled").where("session.starts_at", ">=", now).where("session.starts_at", "<", until)
        .where(sql<boolean>`EXISTS (SELECT 1 FROM coach_time_off o WHERE o.active AND o.coach_id = session.coach_id AND o.during && tstzrange(session.starts_at, session.ends_at))`).orderBy("session.starts_at").execute();
      const lessons = await db.selectFrom("booking").innerJoin("court_time", "court_time.booking_id", "booking.id").leftJoin("person", "person.id", "booking.coach_id")
        .select(["booking.id", "booking.code", "person.display_name", sql<Date>`lower(court_time.during)`.as("s")])
        .where("booking.kind", "=", "lesson").where("booking.status", "=", "confirmed").where("court_time.active", "=", true)
        .where(sql<boolean>`lower(court_time.during) >= ${now} AND lower(court_time.during) < ${until}`)
        .where(sql<boolean>`EXISTS (SELECT 1 FROM coach_time_off o WHERE o.active AND o.coach_id = booking.coach_id AND o.during && court_time.during)`).execute();
      const rows = [...dates.map((x) => ({ at: new Date(x.starts_at), text: x.name, sub: o.people ? x.display_name : null, href: `/sessions/${x.id}` })),
        ...lessons.map((x) => ({ at: new Date(x.s), text: t(l, "ui.today_lesson", { code: x.code }), sub: o.people ? x.display_name : null, href: o.reads("bookings") ? "/bookings" : null }))]
        .sort((a, b) => a.at.getTime() - b.at.getTime());
      if (rows.length) out.push({ kind: "cover", count: rows.length, href: "/coaches",
        items: full ? rows.slice(0, LIST).map((x) => ({ text: x.text, sub: [`${day(x.at)} ${hm(x.at)}`, x.sub].filter(Boolean).join(" · "), href: x.href, at: x.at.toISOString() })) : [] });
    }

    // Card charges that failed in the last week and haven't been paid since, for the club's money people.
    if (o.money) {
      const since = new Date(now.getTime() - FAILED_DAYS * 86400_000);
      const failed = await db.selectFrom("payment as f").innerJoin("person", "person.id", "f.person_id")
        .select(["f.id", "f.person_id", "f.amount_cents", "f.created_at", "person.display_name"])
        .where("f.status", "=", "failed").where("f.created_at", ">=", since)
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom("payment as p").select("p.id").where("p.status", "=", "succeeded").whereRef("p.created_at", ">", "f.created_at")
          .where((eb) => eb.or([
            eb.and([eb("f.booking_player_id", "is not", null), eb("p.booking_player_id", "=", eb.ref("f.booking_player_id"))]),
            eb.and([eb("f.enrolment_id", "is not", null), eb("p.enrolment_id", "=", eb.ref("f.enrolment_id"))]),
            eb.and([eb("f.membership_id", "is not", null), eb("p.membership_id", "=", eb.ref("f.membership_id"))]),
            eb.and([eb("f.booking_player_id", "is", null), eb("f.enrolment_id", "is", null), eb("f.membership_id", "is", null), eb("p.person_id", "=", eb.ref("f.person_id"))]),
          ])))))
        .orderBy("f.created_at", "desc").execute();
      if (failed.length) out.push({ kind: "failed", count: failed.length, href: "/payments",
        items: full ? failed.slice(0, LIST).map((x) => ({ text: o.people ? x.display_name : null, sub: `${day(new Date(x.created_at))} ${hm(new Date(x.created_at))}`, cents: x.amount_cents,
          href: o.people ? `/people/${x.person_id}` : null, at: new Date(x.created_at).toISOString() })) : [] });
    }

    // The staff alerts this person was sent that nobody has handled (they're handled on the Schedule), less the ones
    // counted above. They were sent to the desk and up, whose messages name people already.
    if (o.reads("bookings")) {
      const a = (await staffAlerts(db, id, now)).open.filter((x) => !ALERTS_COUNTED.has(x.kind));
      if (a.length) out.push({ kind: "alerts", count: a.length, href: "/courts", items: full && o.people ? a.slice(0, LIST).map((x) => ({ text: x.subject, at: new Date(x.at).toISOString() })) : [] });
    }
    return out;
  }

  /** Paid today so far, by kind, refunds taken off (tax included: money taken, not the Reports' revenue before tax), and
   *  the same weekday a week ago up to the same time. The ledger is the whole club's. */
  async function takings(now: Date) {
    const tz = await clubTz(), today = localDate(now, tz), from = onDate(today, "00:00", tz);
    const sum = (a: Date, b: Date) => db.selectFrom("ledger_entry").innerJoin("ledger_txn", "ledger_txn.id", "ledger_entry.txn_id").innerJoin("ledger_account", "ledger_account.id", "ledger_entry.account_id")
      .select(["ledger_account.revenue_type", sql<string>`sum(-ledger_entry.amount_cents)`.as("cents")])
      .where("ledger_account.kind", "=", "revenue").where("ledger_txn.at", ">=", a).where("ledger_txn.at", "<", b).groupBy("ledger_account.revenue_type").execute();
    const week = 7 * 86400_000, rows = await sum(from, now), before = await sum(new Date(from.getTime() - week), new Date(now.getTime() - week));
    const total = (xs: { cents: string }[]) => xs.reduce((n, x) => n + Number(x.cents), 0);
    return { total_cents: total(rows), last_week_cents: total(before),
      rows: [...rows.reduce((m, x) => { const k = REVENUE.includes(x.revenue_type ?? "") ? x.revenue_type! : "other"; return m.set(k, (m.get(k) ?? 0) + Number(x.cents)); }, new Map<string, number>())]
        .map(([type, cents]) => ({ type, cents })).filter((x) => x.cents !== 0).sort((a, b) => b.cents - a.cents) };
  }

  /** What happened since the reader last looked (their app says when; at most three days back): how many courts were
   *  booked and cancelled, places taken and questions the club answered, each where their roles read it; and for those
   *  who read Changes, the changes themselves. */
  async function since(id: string, o: Lens, l: Lang, at: Date, now: Date) {
    const counts: Record<string, number> = {};
    const n = async (q: { executeTakeFirstOrThrow(): Promise<{ n: string | number | bigint }> }) => Number((await q.executeTakeFirstOrThrow()).n);
    if (o.reads("bookings")) {
      counts.booked = await n(db.selectFrom("booking").select((eb) => eb.fn.countAll<string>().as("n")).where("created_at", ">=", at).where("status", "in", ["confirmed", "completed", "cancelled"]).where("source", "!=", "import"));
      counts.cancelled = await n(db.selectFrom("booking").select((eb) => eb.fn.countAll<string>().as("n")).where("cancelled_at", ">=", at));
    }
    if (o.reads("programs")) counts.places = await n(db.selectFrom("enrolment").select((eb) => eb.fn.countAll<string>().as("n")).where("created_at", ">=", at).where("status", "in", ["booked", "attended"]));
    if (o.desk) counts.answered = await n(db.selectFrom("question_message").select((eb) => eb.fn.countAll<string>().as("n")).where("side", "=", "club").where("created_at", ">=", at));
    let changes: { id: string; summary: string; by: string; at: Date }[] | null = null, more = 0;
    if ((await decide(db, "changes.view", { personId: id, at: now })).mode === "allow") {
      const chats = await seesChats(db, id);
      const rows = await db.selectFrom("action_run").leftJoin("person", "person.id", "action_run.actor_person_id").leftJoin("support_grant", "support_grant.id", "action_run.support_grant_id")
        .select(["action_run.id", "action_run.action", "action_run.plan", "action_run.applied_at", "person.display_name", "support_grant.name as support_name"])
        .where("action_run.status", "=", "applied").where("action_run.applied_at", ">=", at).$if(!chats, (q) => q.where("action_run.action", "not like", "chat.%"))
        .orderBy("action_run.applied_at", "desc").limit(SINCE_LIST).execute();
      const all = await n(db.selectFrom("action_run").select((eb) => eb.fn.countAll<string>().as("n")).where("status", "=", "applied").where("applied_at", ">=", at)
        .$if(!chats, (q) => q.where("action", "not like", "chat.%")));
      more = Math.max(0, all - rows.length);
      changes = rows.map((x) => ({ id: x.id, summary: (x.plan as { summary?: Record<Lang, string> })?.summary?.[l] ?? x.action, at: x.applied_at!,
        by: x.support_name ? t(l, "ui.support_by", { name: x.support_name }) : x.display_name ?? productName() }));
    }
    return { from: at, counts, changes, more };
  }

  // ---- The menu's counts: how many asks wait for this person, questions wait, things on Today need someone, and
  // scores are disputed. One small read the menu repeats every minute and on each page change.
  app.get("/staff/counts", async (c) => {
    const id = me(c)!.id, o = await lens(id), now = new Date();
    if (o.coachOnly) return c.json({ approvals: 0, questions: 0, today: 0, disputes: 0 });
    const ns = await needs(id, o, lang(c), now, false), of = (k: NeedKind) => ns.find((x) => x.kind === k)?.count ?? 0;
    return c.json({ approvals: of("approvals"), questions: of("questions"), today: ns.reduce((s, x) => s + x.count, 0), disputes: of("disputes") });
  });

  app.get("/staff/today", async (c) => {
    const id = me(c)!.id, o = await lens(id), now = new Date(), l = lang(c);
    // Since the last look the app remembers, kept to the last three days; the start of yesterday evening when there's none.
    const asked = new Date(c.req.query("since") ?? ""), floor = new Date(now.getTime() - SINCE_MAX_HOURS * 3600_000);
    const at = isNaN(asked.getTime()) ? new Date(now.getTime() - 12 * 3600_000) : asked < floor ? floor : asked > now ? now : asked;
    return c.json({ now, time_zone: await clubTz(), people: o.people, needs: o.coachOnly ? [] : await needs(id, o, l, now, true),
      takings: o.money ? await takings(now) : null, since: await since(id, o, l, at, now) });
  });

  // ---- Approvals: every ask waiting for this person's yes (who asked, what it changes, when the ask runs out); the asks
  // they made themselves still waiting for someone else's; and the asks of theirs or answered by them in the last week.
  app.get("/staff/approvals", async (c) => {
    const id = me(c)!.id, o = await lens(id), now = new Date(), l = lang(c);
    const waiting = (await waitingFor(id, now)).map((x) => askView(x, l, o));
    const base = () => db.selectFrom("action_run").leftJoin("person", "person.id", "action_run.actor_person_id").leftJoin("support_grant", "support_grant.id", "action_run.support_grant_id")
      .select(["action_run.id", "action_run.action", "action_run.plan", "action_run.via", "action_run.created_at", "action_run.plan_expires_at", "action_run.money_cents", "action_run.status",
        "action_run.error", "action_run.approved_by", "action_run.applied_at", "person.display_name", "support_grant.name as support_name"]);
    const mine = (await base().where("action_run.actor_person_id", "=", id).where("action_run.status", "=", "awaiting_approval").where("action_run.plan_expires_at", ">", now)
      .orderBy("action_run.created_at").limit(50).execute()).map((x) => askView(x, l, o));
    const week = new Date(now.getTime() - 7 * 86400_000);
    const ended = await base().where("action_run.created_at", ">=", week)
      .where((eb) => eb.or([eb("action_run.approved_by", "is not", null), eb.and([eb("action_run.status", "=", "failed"), eb(sql<string>`action_run.error->>'code'`, "in", [...ASK_ENDED])])]))
      .where((eb) => eb.or([eb("action_run.actor_person_id", "=", id), eb("action_run.approved_by", "=", id), eb(sql<string>`action_run.error->'params'->>'by'`, "=", id)]))
      .orderBy("action_run.created_at", "desc").limit(30).execute();
    const names = new Map<string, string>();
    const nameOf = async (pid: string | null | undefined) => {
      if (!pid || !o.people) return null;
      if (!names.has(pid)) names.set(pid, (await db.selectFrom("person").select("display_name").where("id", "=", pid).executeTakeFirst())?.display_name ?? "");
      return names.get(pid)!;
    };
    const done = [];
    for (const x of ended) {
      const e = x.error as { code?: string; params?: { by?: string; reason?: string | null } } | null;
      const outcome = x.approved_by ? "approved" : e?.code === "error.declined" ? "declined" : "ended";
      done.push({ ...askView(x, l, o), outcome, answered_by: await nameOf(x.approved_by ?? e?.params?.by), answered_at: x.applied_at,
        reason: outcome === "declined" && o.people ? e?.params?.reason ?? null : null, ended: outcome === "ended" ? t(l, e!.code as Key, {}) : null });
    }
    return c.json({ people: o.people, waiting, mine, done });
  });

  return app;
}
