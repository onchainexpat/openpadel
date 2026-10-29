import { LocationProvider, Router, Route } from "preact-iso";
import { useEffect } from "preact/hooks";
import { api, club, lang, loadMe, me, t, type Club } from "./state.ts";
import { SignIn } from "./SignIn.tsx";
import { Changes } from "./Changes.tsx";
import { Profile } from "./Profile.tsx";

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
        <nav><a href="/">{t("ui.nav_changes")}</a><a href="/profile">{t("ui.nav_profile")}</a><button class="link" onClick={signOut}>{t("ui.sign_out")}</button></nav>
      </header>
      <Router>
        <Route path="/" component={Changes} />
        <Route path="/profile" component={Profile} />
      </Router>
    </LocationProvider>
  );
}
