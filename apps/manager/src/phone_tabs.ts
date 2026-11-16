// The staff app's tabs at the bottom of a phone (PhoneTabs in App.tsx): four of the pages a person's roles open most,
// in the order the staff phone boards show them, with + (what they may add) in the middle. Only pages their menu
// already has (the same role rules as StaffNav); the Menu button at the top still opens everything. No Preact here:
// the tests read it.

export type TabKey = "today" | "day" | "schedule" | "approvals" | "people" | "levels" | "programs" | "bookings" | "reports" | "profile";
/** href: where the tab goes; roots: the addresses it stays lit on (its own and those under it). */
export type PhoneTab = { key: TabKey; href: string; roots: string[] };

/** What a person's roles open (access() in App.tsx). */
export type TabAccess = { coachOnly: boolean; coach: boolean; desk: boolean; coachSide: boolean; show: (area: string) => boolean };

const ALL: Record<TabKey, PhoneTab> = {
  today: { key: "today", href: "/today", roots: ["/today"] },
  day: { key: "day", href: "/courts", roots: ["/courts"] },
  schedule: { key: "schedule", href: "/schedule", roots: ["/schedule", "/roster", "/students"] },
  approvals: { key: "approvals", href: "/approvals", roots: ["/approvals"] },
  people: { key: "people", href: "/people", roots: ["/people"] },
  levels: { key: "levels", href: "/levels", roots: ["/levels", "/scores"] },
  programs: { key: "programs", href: "/programs", roots: ["/programs", "/sessions"] },
  bookings: { key: "bookings", href: "/bookings", roots: ["/bookings"] },
  reports: { key: "reports", href: "/reports", roots: ["/reports", "/payments"] },
  profile: { key: "profile", href: "/profile", roots: ["/profile"] },
};

/** The tabs, at most four, in order. A manager's (ManagerToday): Today, the Schedule, Approvals, Members. A coach on
 *  their own (CoachToday, CoachLevels): their schedule, the courts' day, Levels, Programs. Anyone else gets the first
 *  four of those their roles open, so an accountant gets Today, Approvals and Reports. */
export function phoneTabs(a: TabAccess): PhoneTab[] {
  const wanted: [TabKey, boolean][] = a.coachOnly
    ? [["schedule", true], ["day", a.show("bookings")], ["levels", a.show("levels")], ["programs", a.show("programs")], ["reports", a.coachSide], ["profile", true]]
    : [["today", true], ["day", a.show("bookings")], ["schedule", a.coach && !a.desk], ["approvals", true], ["people", a.show("members")],
      ["reports", a.show("money")], ["programs", a.show("programs")], ["levels", a.show("levels")], ["profile", true]];
  return wanted.filter(([, yes]) => yes).slice(0, 4).map(([k]) => ALL[k]);
}

/** Whether a tab is the page open now: its own address or one under it, or "/" when it's the person's home page. */
export function tabIsOn(tab: PhoneTab, path: string, homeHref: string | null): boolean {
  const p = path.split(/[?#]/)[0] || "/";
  if (p === "/") return tab.href === homeHref;
  return tab.roots.some((r) => p === r || p.startsWith(`${r}/`));
}

/** Where + goes in the row: after the first two tabs (the middle of four), or at the end of a shorter row. */
export const plusAt = (tabs: number) => Math.min(2, tabs);
