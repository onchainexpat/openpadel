import { LocationProvider, Router, Route } from "preact-iso";
import { useEffect } from "preact/hooks";
import { api, club, Inbox, InboxLink, lang, loadMe, loadUnread, me, t, type Club, SignIn, Profile } from "@kumi/ui";
import { Changes } from "./Changes.tsx";
import { Programs } from "./Programs.tsx";
import { Program } from "./Program.tsx";
import { Night } from "./Night.tsx";
import { Level } from "./Level.tsx";
import { Mirror } from "./Mirror.tsx";
import { Payments } from "./Payments.tsx";
import { People } from "./People.tsx";
import { Person } from "./Person.tsx";
import { Settings } from "./Settings.tsx";
import { Courts } from "./Courts.tsx";
import { Reports } from "./Reports.tsx";

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
  return (
    <LocationProvider>
      <header>
        <strong>{club.value?.name}</strong>
        <nav><a href="/programs">{t("ui.nav_programs")}</a><a href="/people">{t("ui.nav_people")}</a><a href="/courts">{t("ui.courts")}</a><a href="/playtomic">{t("ui.nav_playtomic")}</a><a href="/payments">{t("ui.nav_payments")}</a><a href="/reports">{t("ui.nav_reports")}</a><a href="/settings">{t("ui.nav_settings")}</a><InboxLink /><a href="/">{t("ui.nav_changes")}</a><a href="/profile">{t("ui.nav_profile")}</a><button class="link" onClick={signOut}>{t("ui.sign_out")}</button></nav>
      </header>
      <Router>
        <Route path="/" component={Changes} />
        <Route path="/profile" component={Profile} />
        <Route path="/programs" component={Programs} />
        <Route path="/programs/:id" component={Program} />
        <Route path="/sessions/:id" component={Night} />
        <Route path="/people" component={People} />
        <Route path="/people/:id" component={Person} />
        <Route path="/people/:id/level" component={Level} />
        <Route path="/playtomic" component={Mirror} />
        <Route path="/payments" component={Payments} />
        <Route path="/inbox" component={Inbox} />
        <Route path="/settings" component={Settings} />
        <Route path="/courts" component={Courts} />
        <Route path="/reports" component={Reports} />
      </Router>
    </LocationProvider>
  );
}
