import { LocationProvider, Router, Route, lazy } from "preact-iso";
import { useEffect } from "preact/hooks";
import { api, club, Inbox, InboxLink, lang, loadMe, loadUnread, me, t, type Club, SignIn, Profile } from "@kumi/ui";
import { Schedule } from "./Schedule.tsx";
import { Changes } from "./Changes.tsx";
import { Programs } from "./Programs.tsx";
import { Program } from "./Program.tsx";
import { Night } from "./Night.tsx";
import { Level } from "./Level.tsx";
import { People } from "./People.tsx";
import { Person } from "./Person.tsx";
import { Courts } from "./Courts.tsx";
import { Memberships } from "./Memberships.tsx";
import { Scores } from "./Scores.tsx";
import { Levels } from "./Levels.tsx";
import { SessionLevels } from "./SessionLevels.tsx";
// Set-up pages, opened now and then, loaded when they are.
const Settings = lazy(() => import("./Settings.tsx").then((m) => m.Settings));
const Coaches = lazy(() => import("./Coaches.tsx").then((m) => m.Coaches));
const Reports = lazy(() => import("./Reports.tsx").then((m) => m.Reports));
const Payments = lazy(() => import("./Payments.tsx").then((m) => m.Payments));
const Mirror = lazy(() => import("./Mirror.tsx").then((m) => m.Mirror));

export function App() {
  useEffect(() => {
    api<Club>("/club").then((c) => { club.value = c; document.documentElement.style.setProperty("--brand", c.brand_colour); }).catch(() => {});
    loadMe();
  }, []);
  useEffect(() => { document.documentElement.lang = lang.value; }, [lang.value]);
  useEffect(() => {
    if (!me.value) return;
    void loadUnread();
    const id = setInterval(loadUnread, 60_000);
    return () => clearInterval(id);
  }, [Boolean(me.value)]);

  if (me.value === undefined) return <main class="card"><p>{t("ui.loading")}</p></main>;
  if (me.value === null) return <SignIn />;
  const signOut = async () => { await api("/auth/sign-out", {}); me.value = null; };
  const roles = me.value.roles.map((r) => r.key), coach = roles.includes("coach"), desk = roles.some((r) => ["owner", "manager", "front_desk"].includes(r));
  return (
    <LocationProvider>
      <header>
        <strong>{club.value?.name}</strong>
        <nav>{coach && <a href="/schedule">{t("ui.nav_schedule")}</a>}<a href="/programs">{t("ui.nav_programs")}</a><a href="/people">{t("ui.nav_people")}</a><a href="/memberships">{t("ui.nav_memberships")}</a>{(coach || desk) && <a href="/coaches">{t("ui.nav_coaches")}</a>}<a href="/courts">{t("ui.courts")}</a><a href="/scores">{t("ui.nav_scores")}</a><a href="/levels">{t("ui.nav_levels")}</a><a href="/playtomic">{t("ui.nav_playtomic")}</a><a href="/payments">{t("ui.nav_payments")}</a><a href="/reports">{t("ui.nav_reports")}</a><a href="/settings">{t("ui.nav_settings")}</a><InboxLink />{(desk || !coach) && <a href="/">{t("ui.nav_changes")}</a>}<a href="/profile">{t("ui.nav_profile")}</a><button class="link" onClick={signOut}>{t("ui.sign_out")}</button></nav>
      </header>
      <Router>
        <Route path="/" component={coach && !desk ? Schedule : Changes} />
        <Route path="/profile" component={() => <Profile app="staff" />} />
        <Route path="/programs" component={Programs} />
        <Route path="/programs/:id" component={Program} />
        <Route path="/sessions/:id" component={Night} />
        <Route path="/sessions/:id/levels" component={SessionLevels} />
        <Route path="/people" component={People} />
        <Route path="/people/:id" component={Person} />
        <Route path="/people/:id/level" component={Level} />
        <Route path="/playtomic" component={Mirror} />
        <Route path="/payments" component={Payments} />
        <Route path="/inbox" component={Inbox} />
        <Route path="/settings" component={Settings} />
        <Route path="/courts" component={Courts} />
        <Route path="/reports" component={Reports} />
        <Route path="/memberships" component={Memberships} />
        <Route path="/scores" component={Scores} />
        <Route path="/levels" component={Levels} />
        <Route path="/coaches" component={Coaches} />
        <Route path="/schedule" component={Schedule} />
      </Router>
    </LocationProvider>
  );
}
