import { ErrorBoundary, LocationProvider, Router, Route, lazy, useLocation } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { api, club, Inbox, InboxLink, lang, loadMe, loadUnread, me, t, type Club, type Me, SignIn, ProfilePage as Profile, TwoFactor } from "@kumi/ui";
import { Schedule } from "./Schedule.tsx";
import { Courts } from "./Courts.tsx";

// Pages loaded when first opened (Courts and a coach's schedule are in the first screen: they're where most staff start).
const Changes = lazy(() => import("./Changes.tsx").then((m) => m.Changes));
const Programs = lazy(() => import("./Programs.tsx").then((m) => m.Programs));
const Night = lazy(() => import("./Night.tsx").then((m) => m.Night));
const Level = lazy(() => import("./Level.tsx").then((m) => m.Level));
const People = lazy(() => import("./People.tsx").then((m) => m.People));
const Person = lazy(() => import("./Person.tsx").then((m) => m.Person));
const Memberships = lazy(() => import("./Memberships.tsx").then((m) => m.Memberships));
const Scores = lazy(() => import("./Scores.tsx").then((m) => m.Scores));
const Levels = lazy(() => import("./Levels.tsx").then((m) => m.Levels));
const SessionLevels = lazy(() => import("./SessionLevels.tsx").then((m) => m.SessionLevels));

// What a coach with no other staff role sees (the server's COACH_READS): their schedule, programs, courts and levels.
const COACH_SEES = ["bookings", "programs", "levels", "coaches"];
// Set-up pages, opened now and then, loaded when they are.
const Settings = lazy(() => import("./Settings.tsx").then((m) => m.Settings));
const Program = lazy(() => import("./Program.tsx").then((m) => m.Program));
const Coaches = lazy(() => import("./Coaches.tsx").then((m) => m.Coaches));
const Reports = lazy(() => import("./Reports.tsx").then((m) => m.Reports));
const Payments = lazy(() => import("./Payments.tsx").then((m) => m.Payments));
const Mirror = lazy(() => import("./Mirror.tsx").then((m) => m.Mirror));
// The club's own roles, and the owner's vault, from Settings.
const Roles = lazy(() => import("./Roles.tsx").then((m) => m.Roles));
const Vault = lazy(() => import("./Vault.tsx").then((m) => m.Vault));
const Usage = lazy(() => import("./Usage.tsx").then((m) => m.Usage));
// A coach's lists, opened from the schedule.
const Roster = lazy(() => import("./Roster.tsx").then((m) => m.Roster));
const Students = lazy(() => import("./Students.tsx").then((m) => m.Students));
// Members' questions and the club's facts.
const Questions = lazy(() => import("./Questions.tsx").then((m) => m.Questions));
const QuestionPage = lazy(() => import("./Questions.tsx").then((m) => m.QuestionPage));
const Facts = lazy(() => import("./Questions.tsx").then((m) => m.Facts));
// Writing to members: messages, groups and templates.
const Messages = lazy(() => import("./Messages.tsx").then((m) => m.Messages));
const Compose = lazy(() => import("./Messages.tsx").then((m) => m.Compose));
const Groups = lazy(() => import("./Messages.tsx").then((m) => m.Groups));
const Templates = lazy(() => import("./Messages.tsx").then((m) => m.Templates));

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
  const areaHome: Record<string, any> = { bookings: Courts, courts: Courts, programs: Programs, members: People, memberships: Memberships, levels: Levels, messages: Messages, money: Reports, coaches: Coaches, settings: Settings };
  const home = areas ? (areaHome[areas[0] ?? ""] ?? Profile) : desk ? Courts : coach ? Schedule : roles.includes("accountant") ? Reports : Programs;
  // The pages in someone's menu, fetched while they look at their first one so opening them later doesn't wait.
  const later: { preload?: () => unknown }[] = [home, Profile];
  const add = (yes: boolean, ...pages: { preload?: () => unknown }[]) => { if (yes) later.push(...pages); };
  add(show("programs"), Programs, Program, Night);
  add(show("members") || coachOnly, People, Person);
  add(show("memberships"), Memberships);
  add(show("levels"), Scores, Levels, Level, SessionLevels);
  add(desk || Boolean(areas?.includes("messages")), Questions, Messages);
  add(show("money") || coachOnly, Reports, Payments);
  add(coach || desk || Boolean(areas?.includes("coaches")), Coaches);
  add(show("settings"), Settings);
  add(changes, Changes, Usage);
  return { coach, desk, changes, areas, coachOnly, show, home, later };
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

export function App() {
  useEffect(() => {
    api<Club>("/club").then((c) => { club.value = c; document.documentElement.style.setProperty("--brand", c.brand_colour); }).catch(() => {});
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
  const signOut = async () => { await api("/auth/sign-out", {}); me.value = null; };
  const { coach, desk, changes, areas, coachOnly, show, home } = access(me.value);
  // A page outside those areas says so, rather than failing to load.
  const only = (area: string, page: any) => (show(area) ? page : NotForRole);
  return (
    <LocationProvider>
      <header>
        <strong>{club.value?.name}</strong>
        <nav>{coach && <a href="/schedule">{t("ui.nav_schedule")}</a>}{show("programs") && <a href="/programs">{t("ui.nav_programs")}</a>}{show("members") && <a href="/people">{t("ui.nav_people")}</a>}{show("memberships") && <a href="/memberships">{t("ui.nav_memberships")}</a>}{(coach || desk || areas?.includes("coaches")) && <a href="/coaches">{t("ui.nav_coaches")}</a>}{show("bookings") && <a href="/courts">{t("ui.courts")}</a>}{show("levels") && <a href="/scores">{t("ui.nav_scores")}</a>}{show("levels") && <a href="/levels">{t("ui.nav_levels")}</a>}{(desk || areas?.includes("messages")) && <QuestionsLink />}{(desk || areas?.includes("messages")) && <a href="/messages">{t("ui.nav_messages")}</a>}{show("bookings") && <a href="/playtomic">{t("ui.nav_playtomic")}</a>}{show("money") && <a href="/payments">{t("ui.nav_payments")}</a>}{(show("money") || coachOnly) && <a href="/reports">{t("ui.nav_reports")}</a>}{show("settings") && <a href="/settings">{t("ui.nav_settings")}</a>}{changes && <a href="/usage">{t("ui.nav_usage")}</a>}<InboxLink />{changes && <a href="/changes">{t("ui.nav_changes")}</a>}<a href="/profile">{t("ui.nav_profile")}</a><button class="link" onClick={signOut}>{t("ui.sign_out")}</button></nav>
      </header>
      {club.value?.read_only && <p class="note banner" role="status">{t("ui.read_only_banner_staff")}</p>}
      <Router>
        <Route path="/" component={home} />
        <Route path="/changes" component={changes ? Changes : NotForRole} />
        <Route path="/profile" component={() => <Profile app="staff" />} />
        <Route path="/programs" component={only("programs", Programs)} />
        <Route path="/programs/:id" component={only("programs", Program)} />
        <Route path="/sessions/:id" component={only("programs", Night)} />
        <Route path="/sessions/:id/levels" component={only("levels", SessionLevels)} />
        <Route path="/people" component={only("members", People)} />
        <Route path="/people/:id" component={coachOnly ? Person : only("members", Person)} />
        <Route path="/people/:id/level" component={only("levels", Level)} />
        <Route path="/playtomic" component={only("bookings", Mirror)} />
        <Route path="/payments" component={only("money", Payments)} />
        <Route path="/inbox" component={Inbox} />
        <Route path="/settings" component={only("settings", Settings)} />
        <Route path="/usage" component={changes ? Usage : NotForRole} />
        <Route path="/roles" component={only("settings", Roles)} />
        <Route path="/vault" component={only("settings", Vault)} />
        <Route path="/courts" component={only("bookings", Courts)} />
        <Route path="/reports" component={coachOnly ? Reports : only("money", Reports)} />
        <Route path="/memberships" component={only("memberships", Memberships)} />
        <Route path="/scores" component={only("levels", Scores)} />
        <Route path="/levels" component={only("levels", Levels)} />
        <Route path="/coaches" component={only("coaches", Coaches)} />
        <Route path="/schedule" component={Schedule} />
        <Route path="/roster/:kind/:id" component={Roster} />
        <Route path="/students" component={only("coaches", Students)} />
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
