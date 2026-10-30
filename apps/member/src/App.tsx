import { LocationProvider, Router, Route } from "preact-iso";
import { useEffect } from "preact/hooks";
import { api, club, Inbox, InboxLink, lang, loadMe, loadUnread, me, t, type Club, SignIn, Profile } from "@kumi/ui";
import { WhatsOn } from "./WhatsOn.tsx";
import { MyPlaces } from "./MyPlaces.tsx";
import { MyLevel } from "./MyLevel.tsx";
import { Book } from "./Book.tsx";
import { Join } from "./Join.tsx";
import { Membership } from "./Membership.tsx";
import { MatchPage, Play } from "./Play.tsx";

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
        <nav><a href="/">{t("ui.nav_whats_on")}</a>{club.value?.court_bookings && <><a href="/play">{t("ui.nav_play")}</a><a href="/book">{t("ui.nav_book")}</a></>}<a href="/places">{t("ui.nav_my")}</a>{club.value?.memberships && <a href="/membership">{t("ui.nav_membership")}</a>}<a href="/level">{t("ui.nav_level")}</a><InboxLink /><a href="/profile">{t("ui.nav_profile")}</a><button class="link" onClick={signOut}>{t("ui.sign_out")}</button></nav>
      </header>
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
        <Route path="/profile" component={Profile} />
      </Router>
    </LocationProvider>
  );
}
