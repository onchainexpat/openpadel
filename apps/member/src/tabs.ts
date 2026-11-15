// The five tabs at the bottom of the members' app (TabBar.tsx), and which one each address belongs to, so the tab
// stays lit on the pages under it (a match is under Play, a receipt under Me). No Preact here: the tests read it.

export type TabKey = "home" | "book" | "play" | "learn" | "me";
export type Tab = { key: TabKey; href: string };
/** What the club has switched on that changes the tabs: no court bookings, no Book tab, and Play opens the events. */
export type TabClub = { court_bookings?: boolean };

/** The tabs, in order. Me's address is /account: /me is the server's (who's signed in). */
export function tabsFor(c: TabClub | null | undefined): Tab[] {
  const courts = Boolean(c?.court_bookings);
  return [
    { key: "home", href: "/" },
    ...(courts ? [{ key: "book" as const, href: "/book" }] : []),
    { key: "play", href: courts ? "/play" : "/events" },
    { key: "learn", href: "/learn" },
    { key: "me", href: "/account" },
  ];
}

// Each page's tab, by the start of its address. Anything not listed (an address the app doesn't have) is Home's.
const under: [TabKey, RegExp][] = [
  ["book", /^\/(book|join)(\/|$)/],
  ["play", /^\/(play|match|events|competitions|tournaments|leagues|take|chats|friends|friend)(\/|$)/],
  ["learn", /^\/(learn|lessons)(\/|$)/],
  ["me", /^\/(account|profile|membership|level|family|waiver|wallet|receipts|gift-cards|passes|places)(\/|$)/],
];

/** The tab an address belongs to. */
export function tabOf(path: string): TabKey {
  const p = path.split(/[?#]/)[0] || "/";
  for (const [key, re] of under) if (re.test(p)) return key;
  return "home";
}
