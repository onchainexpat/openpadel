// The bar at the bottom of every page: Home, Book, Play, Learn and Me, each an icon over its name, a thumb's 44 px
// and more, clear of the phone's own home bar (safe area). The tab the page is under is lit; on the tab's own
// page it's also said to be the current page.
import { useLocation } from "preact-iso";
import { club, t } from "@kumi/ui";
import { tabOf, tabsFor, type TabKey } from "./tabs.ts";

const icons: Record<TabKey, preact.JSX.Element> = {
  home: <path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  book: <><rect x="3" y="4.5" width="18" height="16.5" rx="2" /><path d="M8 2.5v4M16 2.5v4M3 10h18" /></>,
  play: <><circle cx="12" cy="12" r="9" /><path d="M5.7 5.6c3.2 3.6 3.2 9.2 0 12.8M18.3 5.6c-3.2 3.6-3.2 9.2 0 12.8" /></>,
  learn: <><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v16H5.5A1.5 1.5 0 0 0 4 20.5z" /><path d="M4 20.5A1.5 1.5 0 0 0 5.5 22H20" /></>,
  me: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
};
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
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{icons[x.key]}</svg>
          <span>{t(names[x.key])}</span>
        </a>
      ))}
    </nav>
  );
}
