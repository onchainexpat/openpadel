import { ErrorBoundary, LocationProvider, Router, Route, useLocation } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { api, club, mayCreate, signOutHere, Inbox, InboxLink, lang, lazyPage, loadMe, loadUnread, Greeting, me, Notices, t, type Club, type Me, SignIn, ProfilePage as Profile, TwoFactor, clubTime, applyBrand, applyTitle, useBackCloses } from "@kumi/ui";
import { Schedule } from "./Schedule.tsx";
import { Courts, NewBooking, SessionPanel } from "./Courts.tsx";
import { NARROW, useDrawer, useMedia } from "./drawer.ts";
import { formatLocale } from "@kumi/i18n/format";
import { homeFor, type MenuItem } from "./presets.ts";
import { label, preset } from "./words.ts";
import { phoneTabs, plusAt, tabIsOn, type PhoneTab, type TabKey } from "./phone_tabs.ts";

// Pages loaded when first opened (Courts and a coach's schedule are in the first screen: they're where most staff start).
const Changes = lazyPage(() => import("./Changes.tsx").then((m) => m.Changes));
const Programs = lazyPage(() => import("./Programs.tsx").then((m) => m.Programs));
const Night = lazyPage(() => import("./Night.tsx").then((m) => m.Night));
const Competition = lazyPage(() => import("./Competition.tsx").then((m) => m.Competition));
const Level = lazyPage(() => import("./Level.tsx").then((m) => m.Level));
const People = lazyPage(() => import("./People.tsx").then((m) => m.People));
const Bookings = lazyPage(() => import("./Bookings.tsx").then((m) => m.Bookings));
const Person = lazyPage(() => import("./Person.tsx").then((m) => m.Person));
const Memberships = lazyPage(() => import("./Memberships.tsx").then((m) => m.Memberships));
const Scores = lazyPage(() => import("./Scores.tsx").then((m) => m.Scores));
const Levels = lazyPage(() => import("./Levels.tsx").then((m) => m.Levels));
const SessionLevels = lazyPage(() => import("./SessionLevels.tsx").then((m) => m.SessionLevels));
// What needs a person today, and every ask waiting for a yes (today.ts on the server).
const Today = lazyPage(() => import("./Today.tsx").then((m) => m.Today));
const Approvals = lazyPage(() => import("./Approvals.tsx").then((m) => m.Approvals));

// What a coach with no other staff role sees (the server's COACH_READS): their schedule, programs, courts and levels.
const COACH_SEES = ["bookings", "programs", "levels", "coaches"];
// Set-up pages, opened now and then, loaded when they are.
const Settings = lazyPage(() => import("./Settings.tsx").then((m) => m.Settings));
const Program = lazyPage(() => import("./Program.tsx").then((m) => m.Program));
const Coaches = lazyPage(() => import("./Coaches.tsx").then((m) => m.Coaches));
const Reports = lazyPage(() => import("./Reports.tsx").then((m) => m.Reports));
const Payments = lazyPage(() => import("./Payments.tsx").then((m) => m.Payments));
const Mirror = lazyPage(() => import("./Mirror.tsx").then((m) => m.Mirror));
const MoveIn = lazyPage(() => import("./MoveIn.tsx").then((m) => m.MoveIn));
// The club's own roles, and the owner's vault, from Settings.
const Roles = lazyPage(() => import("./Roles.tsx").then((m) => m.Roles));
const Vault = lazyPage(() => import("./Vault.tsx").then((m) => m.Vault));
const Usage = lazyPage(() => import("./Usage.tsx").then((m) => m.Usage));
const Support = lazyPage(() => import("./Support.tsx").then((m) => m.Support));
// A coach's lists, opened from the schedule.
const Roster = lazyPage(() => import("./Roster.tsx").then((m) => m.Roster));
const Students = lazyPage(() => import("./Students.tsx").then((m) => m.Students));
// Members' questions and the club's facts.
const Questions = lazyPage(() => import("./Questions.tsx").then((m) => m.Questions));
// Players' chats in their games (chat.ts).
const Chats = lazyPage(() => import("./Chats.tsx").then((m) => m.Chats));
const ChatPage = lazyPage(() => import("./Chats.tsx").then((m) => m.ChatPage));
const QuestionPage = lazyPage(() => import("./Questions.tsx").then((m) => m.QuestionPage));
const Facts = lazyPage(() => import("./Questions.tsx").then((m) => m.Facts));
// Writing to members: messages, groups and templates.
const Messages = lazyPage(() => import("./Messages.tsx").then((m) => m.Messages));
const Compose = lazyPage(() => import("./Messages.tsx").then((m) => m.Compose));
const Groups = lazyPage(() => import("./Messages.tsx").then((m) => m.Groups));
const Templates = lazyPage(() => import("./Messages.tsx").then((m) => m.Templates));

/** What someone's roles let them see, and the page they start on. */
function access(m: Me) {
  const roles = m.roles.map((r) => r.key), coach = roles.includes("coach"), desk = roles.some((r) => ["owner", "manager", "front_desk"].includes(r));
  // Everyone starts on the page their role uses most: the day on the courts for owners, managers and the desk (Changes,
  // the audit log, is a page of its own for owners and managers), a coach's schedule, the accountant's reports.
  const changes = roles.some((r) => r === "owner" || r === "manager");
  // Someone whose only staff roles are the club's own sees the areas those roles cover, and starts on the first.
  const areas = m.areas ?? null;
  // A coach with no other staff role sees their own work only: the server answers the rest with "staff only".
  const coachOnly = !areas && coach && roles.every((r) => r === "coach" || r === "member");
  const show = (area: string) => (areas ? areas.includes(area) : !coachOnly || COACH_SEES.includes(area));
  // A coach whose roles don't read every area (on their own, or with a role the club made): their own students' pages
  // and their own earnings stay theirs, whatever the other role covers (the server's areas include the coach's).
  const coachSide = coach && (coachOnly || Boolean(areas));
  const areaHome: Record<string, any> = { bookings: Courts, courts: Courts, programs: Programs, members: People, memberships: Memberships, levels: Levels, messages: Messages, money: Reports, coaches: Coaches, settings: Settings };
  // The Schedule (the courts' day) is home for anyone who reads bookings, as staff coming from other club software
  // expect; a coach keeps their own schedule, and the accountant the reports.
  const base = areas ? (coach ? Schedule : areas.includes("bookings") ? Courts : areaHome[areas[0] ?? ""] ?? Profile)
    : desk ? Courts : coach ? Schedule : roles.includes("accountant") ? Reports : show("bookings") ? Courts : Programs;
  // The club's "Coming from" preset may start those on the courts' day somewhere else, only on a page their roles open.
  const homePages = { day: { page: Courts, open: show("bookings") }, bookings: { page: Bookings, open: show("bookings") },
    people: { page: People, open: show("members") }, programs: { page: Programs, open: show("programs") }, today: { page: Today, open: !coachOnly } };
  const home = homeFor(preset(), base, Courts, homePages);
  const homeItem: MenuItem | null = home === Schedule ? "schedule" : (Object.keys(homePages) as (keyof typeof homePages)[]).find((k) => homePages[k].page === home) ?? null;
  // The pages in someone's menu, fetched while they look at their first one so opening them later doesn't wait.
  const later: { preload?: () => unknown }[] = [home, Profile];
  const add = (yes: boolean, ...pages: { preload?: () => unknown }[]) => { if (yes) later.push(...pages); };
  add(!coachOnly, Today, Approvals);
  add(show("bookings"), Bookings, NewBooking, SessionPanel);
  add(show("programs"), Programs, Program, Night);
  add(show("members") || coachSide, People, Person);
  add(show("memberships"), Memberships);
  add(show("levels"), Scores, Levels, Level, SessionLevels);
  add(desk || Boolean(areas?.includes("messages")), Questions, Messages);
  add(show("money") || coachSide, Reports, Payments);
  add(coach || desk || Boolean(areas?.includes("coaches")), Coaches);
  add(show("settings"), Settings);
  add(changes, Changes, Usage);
  return { coach, coachOnly, desk, changes, areas, coachSide, show, home, homeItem, later };
}

/** Support access under way: the person who has it, and the owner and managers, are told at the top of every page. */
function supportNotices(m: Me) {
  const until = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
  const level = (l: "view" | "manager") => (l === "view" ? t("msg.support_level_view") : t("msg.support_level_manager"));
  if (m.support) return [t("ui.support_banner_you", { level: level(m.support.level), until: until(m.support.ends_at) })];
  return (m.support_now ?? []).map((g) => <>{t("ui.support_banner_owner", { name: g.name, level: level(g.level), until: until(g.ends_at) })} <a href="/support">{t("ui.support_banner_see")}</a></>);
}

/** For someone whose role (one the club made) doesn't cover a page. */
function NotForRole() { return <main class="card"><p>{t("ui.not_for_your_role")}</p></main>; }

/** The menu's counts (today.ts): asks waiting for this person's yes, questions waiting, what needs someone on Today, and
 *  disputed scores, each only as far as the person's roles read it. One small read, every minute and again on each page
 *  change, so answering one shows straight away. None for a coach on their own: their menu has none of these. */
type Counts = { approvals: number; questions: number; today: number; disputes: number };
function useCounts(on: boolean): Counts {
  const [n, setN] = useState<Counts>({ approvals: 0, questions: 0, today: 0, disputes: 0 }), { path } = useLocation();
  useEffect(() => {
    if (!on) return;
    const load = () => api<Counts>("/staff/counts").then(setN).catch(() => {});
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [path, on]);
  return n;
}
const badge = (n: number) => n > 0 && <span class="badge warn">{n}</span>;

/** The Questions link, with how many wait for an answer. */
function QuestionsLink({ n, current }: { n: number; current?: "page" }) {
  return <a href="/questions" aria-current={current}>{label("ui.nav_questions")}{badge(n)}</a>;
}

type Access = ReturnType<typeof access>;
/** The staff menu: the Schedule first, then the club's people and what they sign up for, levels, messages, the
 *  club's own pages, and the person's own, in the order and words of the club's "Coming from" preset (presets.ts).
 *  Each link only for those whose roles read that area (the server refuses the rest either way): the preset orders
 *  and names the links, never who gets one. */
function StaffNav({ a, n, signOut }: { a: Access; n: Counts; signOut: () => void }) {
  const { path } = useLocation();
  const { coach, coachOnly, desk, changes, areas, coachSide, show, homeItem } = a;
  // The page open now: its own address or one under it ("/" is whichever page is home).
  const on = (...roots: string[]) => (roots.some((r) => path === r || path.startsWith(`${r}/`)) ? "page" as const : undefined);
  const home = (item: MenuItem) => (path === "/" && homeItem === item ? "page" as const : undefined);
  const link = (yes: unknown, href: string, words: string, current = on(href), count = 0) => (yes ? <li><a href={href} aria-current={current}>{words}{badge(count)}</a></li> : null);
  const messages = desk || Boolean(areas?.includes("messages"));
  const items: Record<MenuItem, any> = {
    day: link(show("bookings"), "/courts", label("ui.nav_day_schedule"), on("/courts") ?? home("day")),
    today: link(!coachOnly, "/today", label("ui.nav_today"), on("/today") ?? home("today"), n.today),
    schedule: link(coach, "/schedule", label("ui.nav_schedule"), on("/schedule", "/roster", "/students") ?? home("schedule")),
    bookings: link(show("bookings"), "/bookings", label("ui.nav_bookings"), on("/bookings") ?? home("bookings")),
    people: link(show("members"), "/people", label("ui.nav_people"), on("/people") ?? home("people")),
    programs: link(show("programs"), "/programs", label("ui.nav_programs"), on("/programs", "/sessions") ?? home("programs")),
    payments: link(show("money"), "/payments", label("ui.nav_payments")),
    memberships: link(show("memberships"), "/memberships", label("ui.nav_memberships")),
    coaches: link(coach || desk || areas?.includes("coaches"), "/coaches", label("ui.nav_coaches")),
    levels: link(show("levels"), "/levels", label("ui.nav_levels")),
    scores: link(show("levels"), "/scores", label("ui.nav_scores"), on("/scores"), n.disputes),
    questions: messages && <li><QuestionsLink n={n.questions} current={on("/questions", "/facts")} /></li>,
    messages: link(messages, "/messages", label("ui.nav_messages"), on("/messages", "/groups", "/templates")),
    chats: link(show("members") && club.value?.players_chat, "/chats", label("ui.nav_chats")),
    playtomic: link(me.value?.playtomic, "/playtomic", label("ui.nav_playtomic")),
    reports: link(show("money") || coachSide, "/reports", label("ui.nav_reports")),
    // Approvals for everyone but a coach on their own (their own asks wait there too), and for anyone with one to answer.
    approvals: link(!coachOnly || n.approvals > 0, "/approvals", label("ui.nav_approvals"), on("/approvals"), n.approvals),
    usage: link(changes, "/usage", label("ui.nav_usage")),
    // Roles (WebPermissions' "Staff and permissions"): for those who may make a role (the owner; a manager asks), on
    // the Roles page Settings links to as well. Not under support access, which never changes roles.
    roles: link(show("settings") && mayCreate("role.create") && !me.value?.support, "/roles", label("ui.nav_roles")),
    changes: link(changes, "/changes", label("ui.nav_changes")),
    settings: link(show("settings"), "/settings", label("ui.nav_settings"), on("/settings", "/vault")),
    inbox: <li><InboxLink current={on("/inbox")} /></li>,
    profile: link(true, "/profile", label("ui.nav_profile")),
  };
  const groups = preset().menu;
  return (
    <nav class="staff-nav" aria-label={t("ui.nav_main")}>
      {groups.map((g, i) => (
        <ul>
          {g.map((item) => items[item])}
          {i === groups.length - 1 && <li><button type="button" class="link" onClick={signOut}>{t("ui.sign_out")}</button></li>}
        </ul>))}
    </nav>
  );
}

/** Whether + offers this person anything: the Schedule's + Create choices their roles allow (the Schedule decides
 *  each one again, for its location and day). */
const mayAddSomething = () => ["program.create", "booking.create", "booking.create_lesson", "court.block"].some((x) => mayCreate(x));
const TAB_WORDS: Record<TabKey, () => string> = {
  today: () => t("ui.nav_today"), day: () => label("ui.nav_day_schedule"), schedule: () => label("ui.nav_schedule"),
  approvals: () => t("ui.nav_approvals"), people: () => label("ui.nav_people"), levels: () => t("ui.nav_levels"), programs: () => t("ui.phone_tab_programs"),
  bookings: () => label("ui.nav_bookings"), reports: () => t("ui.nav_reports"), profile: () => t("ui.nav_profile"),
};
const TAB_ICONS: Record<TabKey, preact.JSX.Element> = {
  today: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  day: <><rect x="3" y="4.5" width="18" height="16.5" rx="2" /><path d="M8 2.5v4M16 2.5v4M3 10h18" /></>,
  schedule: <><rect x="3" y="4.5" width="18" height="16.5" rx="2" /><path d="M8 2.5v4M16 2.5v4M3 10h18M8 14h3M8 17h6" /></>,
  approvals: <><path d="M9 11l3 3 8-8" /><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" /></>,
  people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></>,
  levels: <path d="M4 20V14M10 20V9M16 20V4M2 20h20" />,
  programs: <><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v16H5.5A1.5 1.5 0 0 0 4 20.5z" /><path d="M4 20.5A1.5 1.5 0 0 0 5.5 22H20" /></>,
  bookings: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>,
  reports: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  profile: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
};

/** On a phone, the pages a person opens most as tabs at the bottom, with + in the middle opening the Schedule's
 *  + Create (the same choices, each previewed before anything changes). Approvals carries its count. Everything else
 *  stays in the Menu at the top. Not shown on a wide screen, where the menu is down the left. */
function PhoneTabs({ a, n }: { a: Access; n: Counts }) {
  const { path, route } = useLocation();
  const tabs = phoneTabs(a), homeHref = homeHrefOf(a);
  const plus = mayAddSomething() && a.show("bookings");
  // On the Schedule, + opens its Create panel where it is; anywhere else it goes to the Schedule with the panel open.
  const add = () => {
    const onSchedule = path.startsWith("/courts") || (path === "/" && a.home === Courts);
    if (onSchedule) dispatchEvent(new Event("kumi:create")); else route("/courts?create=1");
  };
  const cell = (x: PhoneTab) => {
    const on = tabIsOn(x, path, homeHref);
    return <a href={x.href} class={on ? "on" : undefined} aria-current={on ? "page" : undefined}>
      <span class="tab-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{TAB_ICONS[x.key]}</svg>
        {x.key === "approvals" && n.approvals > 0 && <span class="tab-count">{n.approvals}</span>}</span>
      <span class="tab-word">{TAB_WORDS[x.key]()}</span>
      {x.key === "approvals" && n.approvals > 0 && <span class="visually-hidden">: {t("count.approvals_waiting", { count: n.approvals })}</span>}
    </a>;
  };
  const at = plusAt(tabs.length);
  return (
    <nav class="phone-tabs" aria-label={t("ui.phone_tabs")}>
      {tabs.slice(0, at).map(cell)}
      {plus && <button type="button" class="tab-plus" aria-label={t("ui.create")} aria-haspopup="dialog" onClick={add}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>}
      {tabs.slice(at).map(cell)}
    </nav>
  );
}
/** The address of the page "/" shows, so its tab is lit there too. */
const homeHrefOf = (a: Access): string | null => a.home === Schedule ? "/schedule" : a.home === Courts ? "/courts" : a.homeItem === "today" ? "/today"
  : a.homeItem === "bookings" ? "/bookings" : a.homeItem === "people" ? "/people" : a.homeItem === "programs" ? "/programs" : null;

/** The page's frame: the menu down the left on a wide screen; on a phone a bar with a Menu button that opens it over
 *  the page (Escape, the back button or a link closes it), and tabs at the bottom (PhoneTabs). */
function Frame({ a, signOut, children }: { a: Access; signOut: () => void; children: any }) {
  const [open, setOpen] = useState(false), { path } = useLocation(), narrow = useMedia(NARROW);
  const n = useCounts(!a.coachOnly);
  const shown = open && narrow, close = () => setOpen(false);
  useEffect(close, [path, narrow]);
  useBackCloses(shown, close);
  const rail = useDrawer<HTMLDivElement>(shown, close, true);
  return (
    <div class="shell">
      <header class="topbar">
        <button type="button" class="menu-button" aria-expanded={shown} aria-controls="staff-menu" onClick={() => setOpen(!open)}>
          <span aria-hidden="true">☰</span> {t("ui.menu")}</button>
        <strong>{club.value?.logo && <img class="club-logo" src={club.value.logo} alt="" width={28} height={28} />}{club.value?.name}</strong>
      </header>
      {shown && <div class="scrim" onClick={close} />}
      <div id="staff-menu" ref={rail} class={`rail${shown ? " open" : ""}`} role={shown ? "dialog" : undefined} aria-modal={shown ? "true" : undefined}
        aria-label={shown ? t("ui.nav_main") : undefined}>
        <div class="rail-head"><strong>{club.value?.logo && <img class="club-logo" src={club.value.logo} alt="" width={28} height={28} />}{club.value?.name}</strong>
          {shown && <button type="button" class="small" onClick={close}>{t("ui.close")}</button>}</div>
        <StaffNav a={a} n={n} signOut={signOut} />
      </div>
      <div class="shell-main">{children}</div>
      {narrow && <PhoneTabs a={a} n={n} />}
    </div>
  );
}

/** The day the club's Kumi ends (leaving.ts), for the owner and managers: the owner's link goes to Download everything. */
function leavingNotice(on: string, owner: boolean) {
  const date = new Intl.DateTimeFormat(formatLocale(lang.value), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${on}T12:00:00Z`));
  return <>{t(owner ? "ui.leaving_banner_owner" : "ui.leaving_banner_staff", { date })}{owner && <> <a href="/settings#download-everything">{t("ui.leaving_download")}</a></>}</>;
}

export function App() {
  useEffect(() => {
    api<Club>("/club").then((c) => { club.value = c; applyBrand(c.brand_colour); applyTitle(c.name, "staff"); }).catch(() => {});
    loadMe();
  }, []);
  useEffect(() => { document.documentElement.lang = lang.value; }, [lang.value]);
  // Fully signed in: not while a session still owes its second step (nothing else answers until then).
  const inside = Boolean(me.value && !me.value.gate);
  useEffect(() => {
    if (!inside) return;
    void loadUnread();
    const id = setInterval(loadUnread, 60_000);
    return () => clearInterval(id);
  }, [inside]);
  useEffect(() => {
    if (!inside || !me.value) return;
    const pages = access(me.value).later;
    const idle = (f: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(f) : setTimeout(f, 1500));
    // One at a time, after the first screen is up, so they never compete with it.
    const next = () => { const p = pages.shift(); if (p) Promise.resolve(p.preload?.()).catch(() => {}).finally(() => idle(next)); };
    idle(next);
  }, [inside]);

  if (me.value === undefined) return <main class="card"><p>{t("ui.loading")}</p></main>;
  if (me.value === null) return <SignIn />;
  if (me.value.gate) return <ErrorBoundary><TwoFactor /></ErrorBoundary>;
  const signOut = () => signOutHere();
  // Signed in with no staff role (a member, or support access that has ended): say so, rather than pages that can't load.
  if (!me.value.support && !me.value.roles.some((r) => r.key !== "member")) return (
    <main class="card"><p>{t(me.value.support_ended ? "ui.support_ended_you" : "ui.no_staff_role")}</p><button onClick={signOut}>{t("ui.sign_out")}</button></main>
  );
  const a = access(me.value), { changes, coachSide, show, home } = a;
  // A page outside those areas says so, rather than failing to load.
  const only = (area: string, page: any) => (show(area) ? page : NotForRole);
  return (
    <LocationProvider>
      <Frame a={a} signOut={signOut}>
      <Notices items={[
        club.value?.moved ? <>{t("ui.moved_banner_staff")} {club.value.moved_to && <a href={club.value.moved_to}>{club.value.moved_to}</a>}</>
          : club.value?.read_only && t("ui.read_only_banner_staff"),
        me.value.leaving && leavingNotice(me.value.leaving, me.value.roles.some((r) => r.key === "owner")),
        ...supportNotices(me.value),
      ]} />
      <Greeting app="staff" />
      <Router>
        <Route path="/" component={home} />
        <Route path="/changes" component={changes ? Changes : NotForRole} />
        <Route path="/today" component={Today} />
        <Route path="/approvals" component={Approvals} />
        <Route path="/profile" component={() => <Profile app="staff" />} />
        <Route path="/programs" component={only("programs", Programs)} />
        <Route path="/programs/:id" component={only("programs", Program)} />
        <Route path="/sessions/:id" component={only("programs", Night)} />
        <Route path="/programs/:id/competition" component={only("programs", Competition)} />
        <Route path="/sessions/:id/levels" component={only("levels", SessionLevels)} />
        <Route path="/people" component={only("members", People)} />
        <Route path="/people/:id" component={coachSide ? Person : only("members", Person)} />
        <Route path="/people/:id/level" component={only("levels", Level)} />
        <Route path="/playtomic" component={only("bookings", Mirror)} />
        <Route path="/playtomic/move-in" component={only("money", MoveIn)} />
        <Route path="/payments" component={only("money", Payments)} />
        <Route path="/inbox" component={Inbox} />
        <Route path="/settings" component={only("settings", Settings)} />
        <Route path="/usage" component={changes ? Usage : NotForRole} />
        <Route path="/support" component={changes && !me.value.support ? Support : NotForRole} />
        <Route path="/roles" component={only("settings", Roles)} />
        <Route path="/vault" component={only("settings", Vault)} />
        <Route path="/courts" component={only("bookings", Courts)} />
        <Route path="/bookings" component={only("bookings", Bookings)} />
        <Route path="/reports" component={coachSide ? Reports : only("money", Reports)} />
        <Route path="/memberships" component={only("memberships", Memberships)} />
        <Route path="/scores" component={only("levels", Scores)} />
        <Route path="/levels" component={only("levels", Levels)} />
        <Route path="/coaches" component={only("coaches", Coaches)} />
        <Route path="/schedule" component={Schedule} />
        <Route path="/roster/:kind/:id" component={Roster} />
        <Route path="/students" component={only("coaches", Students)} />
        <Route path="/chats" component={only("members", Chats)} />
        <Route path="/chats/:id" component={only("members", ChatPage)} />
        <Route path="/questions" component={only("messages", Questions)} />
        <Route path="/questions/:id" component={only("messages", QuestionPage)} />
        <Route path="/facts" component={only("messages", Facts)} />
        <Route path="/messages" component={only("messages", Messages)} />
        <Route path="/messages/new" component={only("messages", Compose)} />
        <Route path="/groups" component={only("messages", Groups)} />
        <Route path="/templates" component={only("messages", Templates)} />
      </Router>
      </Frame>
    </LocationProvider>
  );
}
