import { ErrorBoundary, LocationProvider, Router, Route, useLocation } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { Skeleton, NotFound, api, chatsUnread, club, Inbox, InboxLink, lang, lazyPage, loadChatsUnread, loadMe, loadUnread, Greeting, me, Notices, t, type Club, SignIn, ProfilePage as Profile, TwoFactor, applyBrand, applyTitle } from "@kumi/ui";
import { Home } from "./Home.tsx";
import { TabBar } from "./TabBar.tsx";
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
// Events (under Play) and Learn: the club's programs, each with its own page; and the private lessons, under Learn.
const Events = lazyPage(() => import("./Programs.tsx").then((m) => m.Events));
const Learn = lazyPage(() => import("./Programs.tsx").then((m) => m.Learn));
const ProgramPage = lazyPage(() => import("./Programs.tsx").then((m) => m.ProgramPage));
const Lessons = lazyPage(() => import("./Programs.tsx").then((m) => m.LessonsPage));
const Competitions = lazyPage(() => import("./Competitions.tsx").then((m) => m.Competitions));
const GiftCards = lazyPage(() => import("./GiftCards.tsx").then((m) => m.GiftCards));
const Passes = lazyPage(() => import("./Passes.tsx").then((m) => m.Passes));
const Family = lazyPage(() => import("./Family.tsx").then((m) => m.Family));
const FamilyJoin = lazyPage(() => import("./Family.tsx").then((m) => m.FamilyJoin));
const Waiver = lazyPage(() => import("./Family.tsx").then((m) => m.Waiver));
const Ask = lazyPage(() => import("./Ask.tsx").then((m) => m.Ask));
const AskThread = lazyPage(() => import("./Ask.tsx").then((m) => m.AskThread));
const Receipts = lazyPage(() => import("./Receipts.tsx").then((m) => m.Receipts));
const ReceiptPage = lazyPage(() => import("./Receipts.tsx").then((m) => m.ReceiptPage));
// Wallet: club credit and what came and went, passes held, and links to the rest of their money.
const Wallet = lazyPage(() => import("./Wallet.tsx").then((m) => m.Wallet));
// Me: the member's own pages. At /account, since /me is the server's (who is signed in).
const Me = lazyPage(() => import("./Me.tsx").then((m) => m.Me));
const Chats = lazyPage(() => import("./Chats.tsx").then((m) => m.Chats));
// Once, for a member who moved in from Playtomic (Welcome.tsx).
const Welcome = lazyPage(() => import("./Welcome.tsx").then((m) => m.Welcome));
const ChatThread = lazyPage(() => import("./Chats.tsx").then((m) => m.ChatThread));

/** The Chats link, with how many messages wait unread in the member's games (none when the club turned chat off). */
function ChatsLink() {
  if (!club.value?.players_chat) return null;
  const n = chatsUnread.value;
  return <a href="/chats" aria-label={n ? `${t("ui.nav_chats")}, ${t("count.unread", { count: n })}` : undefined}>{t("ui.nav_chats")}{n > 0 && <span class="badge">{n}</span>}</a>;
}

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
    api<Club>("/club").then((c) => { club.value = c; applyBrand(c.brand_colour); applyTitle(c.name, "member"); }).catch(() => {});
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
    const id = setInterval(() => { void loadUnread(); void loadChatsUnread(); }, 60_000);
    return () => clearInterval(id);
  }, [inside]);
  // The chats' badge once the club says whether it has chats.
  useEffect(() => { if (inside && club.value?.players_chat) void loadChatsUnread(); }, [inside, club.value?.players_chat]);
  if (me.value === undefined) return <Skeleton />;
  if (me.value === null) return <SignIn />;
  if (me.value.gate) return <ErrorBoundary><TwoFactor /></ErrorBoundary>;
  return (
    <LocationProvider>
      <header>
        <a class="club-name" href="/">{club.value?.logo && <img class="club-logo" src={club.value.logo} alt="" width={28} height={28} />}{club.value?.name}</a>
        <nav aria-label={t("ui.header_label")}><ChatsLink /><InboxLink /></nav>
      </header>
      <Notices items={[
        club.value?.moved ? <>{t("ui.moved_banner")} {club.value.moved_to && <a href={club.value.moved_to}>{club.value.moved_to}</a>}</>
          : club.value?.read_only && t("ui.read_only_banner"),
        waiverDue.value && <>{t("ui.waiver_banner")} <a href="/waiver">{t("ui.waiver_read")}</a></>,
        emailNotice,
      ]} />
      {me.value.welcome && <ToWelcome />}
      <Greeting app="member" />
      <Router>
        <Route path="/" component={Home} />
        <Route path="/welcome" component={Welcome} />
        <Route path="/events" component={Events} />
        <Route path="/events/:id" component={ProgramPage} />
        <Route path="/learn" component={Learn} />
        <Route path="/learn/:id" component={ProgramPage} />
        <Route path="/account" component={Me} />
        <Route path="/places" component={MyPlaces} />
        <Route path="/competitions" component={Competitions} />
        <Route path="/gift-cards" component={GiftCards} />
        <Route path="/passes" component={Passes} />
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
        <Route path="/wallet" component={Wallet} />
        <Route path="/receipts" component={Receipts} />
        <Route path="/receipts/:id" component={ReceiptPage} />
        <Route path="/chats" component={Chats} />
        <Route path="/chats/:kind/:id" component={ChatThread} />
        <Route path="/profile" component={Profile} />
        {/* What people type for tournaments and leagues go there; any other address the app doesn't have says so, with the way
            back to the start, never a blank page. */}
        <Route path="/tournaments" component={ToCompetitions} />
        <Route path="/leagues" component={ToCompetitions} />
        <Route default component={NotFound} />
      </Router>
      <TabBar />
    </LocationProvider>
  );
}

/** Another address for a page: replaced by the page's own, so back doesn't return here. */
function Go({ to }: { to: string }) {
  const { route } = useLocation();
  useEffect(() => { route(to, true); }, [to]);
  return null;
}
const ToCompetitions = () => <Go to="/competitions" />;
/** A member who moved in from Playtomic, at their first sign-in: Home opens on the welcome instead, once (the page
 *  notes it seen). A link they followed in (a match, a place) opens as it is; the welcome waits for Home. */
function ToWelcome() {
  const { path } = useLocation();
  return path === "/" ? <Go to="/welcome" /> : null;
}
