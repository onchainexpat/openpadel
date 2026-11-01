import { ErrorBoundary, LocationProvider, Router, Route, lazy } from "preact-iso";
import { useEffect } from "preact/hooks";
import { api, club, Inbox, InboxLink, lang, loadMe, loadUnread, me, t, type Club, SignIn, Profile, TwoFactor } from "@kumi/ui";
import { WhatsOn } from "./WhatsOn.tsx";
import { MyPlaces } from "./MyPlaces.tsx";
import { MyLevel } from "./MyLevel.tsx";
import { Book } from "./Book.tsx";
import { Join } from "./Join.tsx";
import { MatchPage, Play } from "./Play.tsx";
import { FriendLink, Friends } from "./Friends.tsx";
import { TakePlace } from "./Take.tsx";
import { loadFamily, waiverDue } from "./ForWhom.tsx";
// Pages few members open, loaded when they do.
const Membership = lazy(() => import("./Membership.tsx").then((m) => m.Membership));
const Lessons = lazy(() => import("./Lessons.tsx").then((m) => m.Lessons));
const Family = lazy(() => import("./Family.tsx").then((m) => m.Family));
const FamilyJoin = lazy(() => import("./Family.tsx").then((m) => m.FamilyJoin));
const Waiver = lazy(() => import("./Family.tsx").then((m) => m.Waiver));
const Ask = lazy(() => import("./Ask.tsx").then((m) => m.Ask));
const AskThread = lazy(() => import("./Ask.tsx").then((m) => m.AskThread));

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
    void loadFamily();
    const id = setInterval(loadUnread, 60_000);
    return () => clearInterval(id);
  }, [inside]);
  if (me.value === undefined) return <main class="card"><p>{t("ui.loading")}</p></main>;
  if (me.value === null) return <SignIn />;
  if (me.value.gate) return <ErrorBoundary><TwoFactor /></ErrorBoundary>;
  const signOut = async () => { await api("/auth/sign-out", {}); me.value = null; };
  return (
    <LocationProvider>
      <header>
        <strong>{club.value?.name}</strong>
        <nav><a href="/">{t("ui.nav_whats_on")}</a>{club.value?.court_bookings && <><a href="/play">{t("ui.nav_play")}</a><a href="/book">{t("ui.nav_book")}</a></>}{club.value?.lessons && <a href="/lessons">{t("ui.nav_lessons")}</a>}<a href="/places">{t("ui.nav_my")}</a>{club.value?.memberships && <a href="/membership">{t("ui.nav_membership")}</a>}<a href="/level">{t("ui.nav_level")}</a><a href="/family">{t("ui.nav_family")}</a><a href="/ask">{t("ui.nav_ask")}</a><InboxLink /><a href="/profile">{t("ui.nav_profile")}</a><button class="link" onClick={signOut}>{t("ui.sign_out")}</button></nav>
      </header>
      {waiverDue.value && <p class="note banner" role="status">{t("ui.waiver_banner")} <a href="/waiver">{t("ui.waiver_read")}</a></p>}
      <Router>
        <Route path="/" component={WhatsOn} />
        <Route path="/places" component={MyPlaces} />
        <Route path="/level" component={MyLevel} />
        <Route path="/inbox" component={Inbox} />
        <Route path="/book" component={Book} />
        <Route path="/join/:code" component={Join} />
        <Route path="/membership" component={Membership} />
        <Route path="/play" component={Play} />
        <Route path="/match/:id" component={MatchPage} />
        <Route path="/friends" component={Friends} />
        <Route path="/friend/:code" component={FriendLink} />
        <Route path="/take/:code" component={TakePlace} />
        <Route path="/lessons" component={Lessons} />
        <Route path="/family" component={Family} />
        <Route path="/family/join/:code" component={FamilyJoin} />
        <Route path="/waiver" component={Waiver} />
        <Route path="/ask" component={Ask} />
        <Route path="/ask/:id" component={AskThread} />
        <Route path="/profile" component={Profile} />
      </Router>
    </LocationProvider>
  );
}
