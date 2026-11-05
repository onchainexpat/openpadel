import { ErrorBoundary, LocationProvider, Router, Route } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { api, club, Inbox, InboxLink, lang, lazyPage, loadMe, loadUnread, me, Notices, t, type Club, SignIn, ProfilePage as Profile, TwoFactor, applyBrand } from "@kumi/ui";
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
const Membership = lazyPage(() => import("./Membership.tsx").then((m) => m.Membership));
const Lessons = lazyPage(() => import("./Lessons.tsx").then((m) => m.Lessons));
const Family = lazyPage(() => import("./Family.tsx").then((m) => m.Family));
const FamilyJoin = lazyPage(() => import("./Family.tsx").then((m) => m.FamilyJoin));
const Waiver = lazyPage(() => import("./Family.tsx").then((m) => m.Waiver));
const Ask = lazyPage(() => import("./Ask.tsx").then((m) => m.Ask));
const AskThread = lazyPage(() => import("./Ask.tsx").then((m) => m.AskThread));
const Receipts = lazyPage(() => import("./Receipts.tsx").then((m) => m.Receipts));
const ReceiptPage = lazyPage(() => import("./Receipts.tsx").then((m) => m.ReceiptPage));

/** Someone who joined by phone is asked to add an email, until they add one or say "not now" on this device. */
function useEmailNotice() {
  const [later, setLater] = useState(() => { try { return localStorage.getItem("kumi.email_later") === "1"; } catch { return false; } });
  // The club's email can't reach their address (email_suppression.ts): said until they change it or the desk clears it.
  const problem = me.value?.email_problem;
  if (problem) return <>{t(problem.reason === "complaint" ? "ui.email_problem_complaint" : "ui.email_problem_bounce", { email: me.value?.email ?? "" })} <a href="/profile#email">{t("ui.email_problem_change")}</a></>;
  if (me.value?.has_email !== false || later) return null;
  const notNow = () => { try { localStorage.setItem("kumi.email_later", "1"); } catch { /* private window: it asks again next time */ } setLater(true); };
  return <>{t("ui.email_banner")} <a href="/profile#email">{t("ui.email_banner_add")}</a> <button class="link" onClick={notNow}>{t("ui.email_banner_later")}</button></>;
}

export function App() {
  useEffect(() => {
    api<Club>("/club").then((c) => { club.value = c; applyBrand(c.brand_colour); }).catch(() => {});
    loadMe();
  }, []);
  useEffect(() => { document.documentElement.lang = lang.value; }, [lang.value]);
  const emailNotice = useEmailNotice();
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
      <Notices items={[
        club.value?.moved ? <>{t("ui.moved_banner")} {club.value.moved_to && <a href={club.value.moved_to}>{club.value.moved_to}</a>}</>
          : club.value?.read_only && t("ui.read_only_banner"),
        waiverDue.value && <>{t("ui.waiver_banner")} <a href="/waiver">{t("ui.waiver_read")}</a></>,
        emailNotice,
      ]} />
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
        <Route path="/receipts" component={Receipts} />
        <Route path="/receipts/:id" component={ReceiptPage} />
        <Route path="/profile" component={Profile} />
      </Router>
    </LocationProvider>
  );
}
