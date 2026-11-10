import { ErrorBoundary, LocationProvider, Router, Route, useLocation } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { api, club, signOutHere, Inbox, InboxLink, lang, lazyPage, loadMe, loadUnread, me, Notices, t, type Club, type Me, SignIn, ProfilePage as Profile, TwoFactor, clubTime, applyBrand, applyTitle } from "@kumi/ui";
import { Schedule } from "./Schedule.tsx";
import { Courts } from "./Courts.tsx";
import { formatLocale } from "@kumi/i18n/format";

// Pages loaded when first opened (Courts and a coach's schedule are in the first screen: they're where most staff start).
const Changes = lazyPage(() => import("./Changes.tsx").then((m) => m.Changes));
const Programs = lazyPage(() => import("./Programs.tsx").then((m) => m.Programs));
const Night = lazyPage(() => import("./Night.tsx").then((m) => m.Night));
const Competition = lazyPage(() => import("./Competition.tsx").then((m) => m.Competition));
const Level = lazyPage(() => import("./Level.tsx").then((m) => m.Level));
const People = lazyPage(() => import("./People.tsx").then((m) => m.People));
const Person = lazyPage(() => import("./Person.tsx").then((m) => m.Person));
const Memberships = lazyPage(() => import("./Memberships.tsx").then((m) => m.Memberships));
const Scores = lazyPage(() => import("./Scores.tsx").then((m) => m.Scores));
const Levels = lazyPage(() => import("./Levels.tsx").then((m) => m.Levels));
const SessionLevels = lazyPage(() => import("./SessionLevels.tsx").then((m) => m.SessionLevels));

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
  const home = areas ? (coach ? Schedule : areaHome[areas[0] ?? ""] ?? Profile) : desk ? Courts : coach ? Schedule : roles.includes("accountant") ? Reports : Programs;
  // The pages in someone's menu, fetched while they look at their first one so opening them later doesn't wait.
  const later: { preload?: () => unknown }[] = [home, Profile];
  const add = (yes: boolean, ...pages: { preload?: () => unknown }[]) => { if (yes) later.push(...pages); };
  add(show("programs"), Programs, Program, Night);
  add(show("members") || coachSide, People, Person);
  add(show("memberships"), Memberships);
  add(show("levels"), Scores, Levels, Level, SessionLevels);
  add(desk || Boolean(areas?.includes("messages")), Questions, Messages);
  add(show("money") || coachSide, Reports, Payments);
  add(coach || desk || Boolean(areas?.includes("coaches")), Coaches);
  add(show("settings"), Settings);
  add(changes, Changes, Usage);
  return { coach, desk, changes, areas, coachSide, show, home, later };
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

/** The Questions link, with how many wait for an answer. */
function QuestionsLink() {
  const [n, setN] = useState(0), { path } = useLocation();
  // Again on each page change, so answering one shows straight away.
  useEffect(() => {
    const load = () => api<{ waiting: number }>("/staff/questions/count").then((r) => setN(r.waiting)).catch(() => {});
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [path]);
  return <a href="/questions">{t("ui.nav_questions")}{n > 0 && <span class="badge warn">{n}</span>}</a>;
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
  const { coach, desk, changes, areas, coachSide, show, home } = access(me.value);
  // A page outside those areas says so, rather than failing to load.
  const only = (area: string, page: any) => (show(area) ? page : NotForRole);
  return (
    <LocationProvider>
      <header>
        <strong>{club.value?.name}</strong>
        <nav>{coach && <a href="/schedule">{t("ui.nav_schedule")}</a>}{show("programs") && <a href="/programs">{t("ui.nav_programs")}</a>}{show("members") && <a href="/people">{t("ui.nav_people")}</a>}{show("members") && club.value?.players_chat && <a href="/chats">{t("ui.nav_chats")}</a>}{show("memberships") && <a href="/memberships">{t("ui.nav_memberships")}</a>}{(coach || desk || areas?.includes("coaches")) && <a href="/coaches">{t("ui.nav_coaches")}</a>}{show("bookings") && <a href="/courts">{t("ui.courts")}</a>}{show("levels") && <a href="/scores">{t("ui.nav_scores")}</a>}{show("levels") && <a href="/levels">{t("ui.nav_levels")}</a>}{(desk || areas?.includes("messages")) && <QuestionsLink />}{(desk || areas?.includes("messages")) && <a href="/messages">{t("ui.nav_messages")}</a>}{me.value?.playtomic && <a href="/playtomic">{t("ui.nav_playtomic")}</a>}{show("money") && <a href="/payments">{t("ui.nav_payments")}</a>}{(show("money") || coachSide) && <a href="/reports">{t("ui.nav_reports")}</a>}{show("settings") && <a href="/settings">{t("ui.nav_settings")}</a>}{changes && <a href="/usage">{t("ui.nav_usage")}</a>}<InboxLink />{changes && <a href="/changes">{t("ui.nav_changes")}</a>}<a href="/profile">{t("ui.nav_profile")}</a><button class="link" onClick={signOut}>{t("ui.sign_out")}</button></nav>
      </header>
      <Notices items={[
        club.value?.moved ? <>{t("ui.moved_banner_staff")} {club.value.moved_to && <a href={club.value.moved_to}>{club.value.moved_to}</a>}</>
          : club.value?.read_only && t("ui.read_only_banner_staff"),
        me.value.leaving && leavingNotice(me.value.leaving, me.value.roles.some((r) => r.key === "owner")),
        ...supportNotices(me.value),
      ]} />
      <Router>
        <Route path="/" component={home} />
        <Route path="/changes" component={changes ? Changes : NotForRole} />
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
    </LocationProvider>
  );
}
