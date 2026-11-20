// The bar at the bottom of every page: Home, Book, Play, Learn and Me, each an icon over its name, a thumb's 44 px
// and more, clear of the phone's own home bar (safe area). The tab the page is under is lit; on the tab's own
// page it's also said to be the current page.
import { useLocation } from "preact-iso";
import { club, Icon, t, type IconName } from "@kumi/ui";
import { tabOf, tabsFor, type TabKey } from "./tabs.ts";

const icons: Record<TabKey, IconName> = { home: "house", book: "calendar-days", play: "volleyball", learn: "graduation-cap", me: "circle-user-round" };
const names = { home: "ui.tab_home", book: "ui.tab_book", play: "ui.tab_play", learn: "ui.tab_learn", me: "ui.tab_me" } as const;

/** Under Play: open matches or events, two pages side by side (when the club takes court bookings, so has matches). */
export function PlaySwitch({ here }: { here: "matches" | "events" }) {
  if (!club.value?.court_bookings) return null;
  return (
    <nav class="seg" aria-label={t("ui.tab_play")}>
      <a href="/play" aria-current={here === "matches" ? "page" : undefined}>{t("ui.play_matches")}</a>
      <a href="/events" aria-current={here === "events" ? "page" : undefined}>{t("ui.home_events")}</a>
    </nav>
  );
}

/** Under Learn: clinics, courses, and private lessons when the club gives them in the app. Links, so each has its address. */
export function LearnSwitch({ here }: { here: "clinics" | "courses" | "lessons" }) {
  return (
    <nav class="seg" aria-label={t("ui.tab_learn")}>
      <a href="/learn" aria-current={here === "clinics" ? "page" : undefined}>{t("ui.learn_clinics")}</a>
      <a href="/learn?show=courses" aria-current={here === "courses" ? "page" : undefined}>{t("ui.learn_courses")}</a>
      {club.value?.lessons && <a href="/lessons" aria-current={here === "lessons" ? "page" : undefined}>{t("ui.lessons_title")}</a>}
    </nav>
  );
}

export function TabBar() {
  const { path } = useLocation();
  const here = tabOf(path);
  return (
    <nav class="tabbar" aria-label={t("ui.tabs_label")}>
      {tabsFor(club.value).map((x) => (
        <a href={x.href} class={x.key === here ? "on" : undefined} aria-current={x.key !== here ? undefined : path === x.href ? "page" : "true"}>
          <Icon name={icons[x.key]} />
          <span>{t(names[x.key])}</span>
        </a>
      ))}
    </nav>
  );
}
