import { LocationProvider, Router, Route } from "preact-iso";
import { useEffect } from "preact/hooks";
import { api, club, lang, loadMe, me, t, type Club, SignIn, Profile } from "@kumi/ui";
import { WhatsOn } from "./WhatsOn.tsx";
import { MyPlaces } from "./MyPlaces.tsx";
import { MyLevel } from "./MyLevel.tsx";

export function App() {
  useEffect(() => {
    api<Club>("/club").then((c) => { club.value = c; document.documentElement.style.setProperty("--brand", c.brand_colour); }).catch(() => {});
    loadMe();
  }, []);
  useEffect(() => { document.documentElement.lang = lang.value; }, [lang.value]);
  if (me.value === undefined) return <main class="card"><p>{t("ui.loading")}</p></main>;
  if (me.value === null) return <SignIn />;
  const signOut = async () => { await api("/auth/sign-out", {}); me.value = null; };
  return (
    <LocationProvider>
      <header>
        <strong>{club.value?.name}</strong>
        <nav><a href="/">{t("ui.nav_whats_on")}</a><a href="/places">{t("ui.nav_my")}</a><a href="/level">{t("ui.nav_level")}</a><a href="/profile">{t("ui.nav_profile")}</a><button class="link" onClick={signOut}>{t("ui.sign_out")}</button></nav>
      </header>
      <Router>
        <Route path="/" component={WhatsOn} />
        <Route path="/places" component={MyPlaces} />
        <Route path="/level" component={MyLevel} />
        <Route path="/profile" component={Profile} />
      </Router>
    </LocationProvider>
  );
}
