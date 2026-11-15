// "Coming from" (Settings): one staff app, made to feel familiar to staff moving from the software they used before.
// A preset is data, and may only set: the words of menu items and page titles (by key, so both languages follow), the
// menu's order, the first page for staff who read the courts' day, and the default column order of the Bookings and
// Customers tables. Never who may see or do what: every menu item, page and column keeps its own role check, and a
// preset only orders or renames what that check already lets through (presets.test.ts holds it to that).
//
// Adding one (say, a booking system whose screens we have seen) is data only: its name in packages/i18n/src/presets.ts,
// its object below, and any words of its own as `preset.*` keys in en.ts and es.ts.
import type { Key } from "@kumi/i18n/format";
import { comingFrom, type ComingFrom } from "@kumi/i18n/presets";

/** The words a preset may rename: menu items and the titles of their pages. */
export type LabelKey = "ui.nav_day_schedule" | "ui.nav_schedule" | "ui.nav_bookings" | "ui.nav_people" | "ui.people_title" | "ui.nav_programs"
  | "ui.nav_payments" | "ui.nav_memberships" | "ui.nav_coaches" | "ui.nav_levels" | "ui.nav_scores" | "ui.nav_questions" | "ui.nav_messages"
  | "ui.nav_chats" | "ui.nav_playtomic" | "ui.nav_reports" | "ui.nav_usage" | "ui.nav_changes" | "ui.nav_settings" | "ui.nav_profile"
  | "ui.nav_today" | "ui.nav_approvals" | "ui.nav_roles";
/** A preset's own words: the `preset.*` keys, named without their start. */
type WordOf<K> = K extends `preset.${infer W}` ? W : never;
export type PresetWord = WordOf<Key>;

/** Every item in the staff menu (sign out is always last, after them). */
export const MENU_ITEMS = ["day", "today", "schedule", "bookings", "people", "programs", "payments", "memberships", "coaches", "levels", "scores",
  "questions", "messages", "chats", "playtomic", "reports", "approvals", "usage", "roles", "changes", "settings", "inbox", "profile"] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];
/** Pages a preset may start staff on, in place of the courts' day (each only for those whose roles open it). */
export const HOME_PAGES = ["day", "today", "bookings", "people", "programs"] as const;
export type HomePage = (typeof HOME_PAGES)[number];
export const BOOKING_COLUMNS = ["when", "length", "players", "court", "type", "made_in", "status"] as const;
export type BookingColumn = (typeof BOOKING_COLUMNS)[number];
export const CUSTOMER_COLUMNS = ["name", "phone", "email", "membership", "membership_ends", "club_news", "level"] as const;
export type CustomerColumn = (typeof CUSTOMER_COLUMNS)[number];

export interface Preset {
  /** A key shown in place of another, in both languages. */
  labels: Partial<Record<LabelKey, PresetWord>>;
  /** The menu in groups, top to bottom: every item once. */
  menu: MenuItem[][];
  home: HomePage;
  bookingColumns: BookingColumn[];
  customerColumns: CustomerColumn[];
}

/** Playtomic's club manager: Schedule first and home, Bookings, Customers, "Clinics, courses and events". These are the
 *  app's own keys since 11 Nov 2026, so this preset renames nothing. */
const playtomic: Preset = {
  labels: {},
  menu: [["day", "today", "schedule", "bookings"], ["people", "programs", "payments", "memberships", "coaches"], ["levels", "scores"],
    ["questions", "messages", "chats"], ["playtomic", "reports", "approvals", "usage", "roles", "changes", "settings"], ["inbox", "profile"]],
  home: "day",
  bookingColumns: ["when", "length", "players", "court", "type", "made_in", "status"],
  customerColumns: ["name", "phone", "email", "membership", "membership_ends", "club_news", "level"],
};

/** openPadel's own plain words, as the staff app said them before 11 Nov 2026: Courts, People, Programs; programs
 *  before people, as the old row of links had them. Today is home (14 Nov 2026): what needs a person, the takings and
 *  what happened overnight, with the courts' day a link away. */
const none: Preset = {
  labels: { "ui.nav_day_schedule": "plain_schedule", "ui.nav_people": "plain_people", "ui.people_title": "plain_people", "ui.nav_programs": "plain_programs" },
  menu: [["today", "day", "schedule", "bookings"], ["programs", "people", "memberships", "coaches", "payments"], ["levels", "scores"],
    ["questions", "messages", "chats"], ["approvals", "playtomic", "reports", "usage", "roles", "changes", "settings"], ["inbox", "profile"]],
  home: "today",
  bookingColumns: ["when", "court", "type", "players", "length", "status", "made_in"],
  customerColumns: ["name", "membership", "membership_ends", "level", "phone", "email", "club_news"],
};

export const PRESETS: Record<ComingFrom, Preset> = { none, playtomic };

/** The preset for a club's setting (an unknown or missing one reads as the default). */
export const presetFor = (setting: unknown): Preset => PRESETS[comingFrom(setting)];

/** The key to show for one of the renameable words (words.ts says it). */
export function labelKey(p: Preset, k: LabelKey): LabelKey | `preset.${PresetWord}` {
  const own = p.labels[k];
  return own ? `preset.${own}` : k;
}

/** Where someone starts: the preset's page, if it's one their roles open, in place of the courts' day; anyone whose
 *  first page is something else (a coach's own schedule, the accountant's reports) keeps theirs. */
export function homeFor<P>(p: Preset, fallback: P, day: P, pages: Record<HomePage, { page: P; open: boolean }>): P {
  if (fallback !== day) return fallback;
  const pick = pages[p.home];
  return pick.open ? pick.page : fallback;
}

/** Columns in the preset's order, of those shown (a column a role doesn't get is left out before this). */
export const ordered = <C extends string>(order: readonly C[], shown: readonly C[]): C[] => order.filter((c) => shown.includes(c));
