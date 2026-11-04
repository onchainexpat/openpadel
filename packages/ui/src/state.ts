// Who is signed in, the club, and the language: the three things every screen reads.
import { signal, computed, effect } from "@preact/signals";
import type { ComponentType } from "preact";
import { lazy } from "preact-iso";
import { format, LANGS, pickLang, type Catalog, type Key, type Lang, type Params } from "@kumi/i18n/format";

export type Me = { person: { id: string; display_name: string; locale: string }; signed_in_with: "email_code" | "phone_code" | "passkey" | "two_factor"; lang: Lang;
  /** False for an account that joined by phone and hasn't added an email: the members' app asks for one, never requires it. */
  has_email?: boolean;
  email?: string | null;
  /** The club's email can't reach their address (email_suppression.ts): a bounce, a spam complaint, or the email service's own list. */
  email_problem?: { reason: "bounce" | "complaint" | "provider"; since: string; detail: string | null } | null;
  /** A role the club made has its own name; the built-in ones are worded by key. */
  roles: { key: string; name?: string | null; location_id: string | null }[];
  /** This session still owes its second step ("verify"), or has none set up yet ("setup"): the apps show only that. */
  gate?: "setup" | "verify" | null;
  /** Someone whose only staff roles are the club's own: the areas those cover (null for everyone else). */
  areas?: string[] | null;
  /** For those people: which of the staff screens' changes their roles allow (null: everyone else, as their role always has). */
  can?: string[] | null;
  /** A junior with a login of their own: their parents' rules apply, and payments go on the family card. */
  kid?: { friends: boolean } | null;
  /** The day the club's Kumi ends (leaving.ts), for owners and managers: the staff app says so at the top. */
  leaving?: string | null;

  /** Signed in with support access the owner gave (it reads as a manager; what it may change is the server's call). */
  support?: { name: string; level: "view" | "manager"; ends_at: string } | null;
  /** For owners and managers: support access under way at the club, for the banner. */
  support_now?: { name: string; level: "view" | "manager"; ends_at: string }[];
  /** An account made for support access, whose access has ended. */
  support_ended?: boolean };
export type Club = { name: string; brand_colour: string; languages: string[]; default_language: Lang; drafts?: boolean; court_bookings?: boolean; memberships?: boolean; lessons?: boolean; public_page?: boolean; phone_sign_in?: boolean; member_url?: string;
  /** The club's host made it read-only (read_only.ts): both apps say so at the top. */
  read_only?: boolean;
  /** The club's Kumi moved to another server (club_exit.ts): this one says where, and sends nothing. */
  moved?: boolean; moved_to?: string | null;
  /** The club's own terms and privacy policy for members (Policies.tsx), when it has set them. */
  terms_url?: string | null; privacy_policy_url?: string | null };

export const me = signal<Me | null | undefined>(undefined);      // undefined: not loaded yet
/** Whether to offer a button for a change: a role the club made may not allow it (the server decides either way). */
export const mayDo = (action: string) => !me.value?.can || me.value.can.includes(action);
/** The account was just deleted: the sign-in page says so. */
export const farewell = signal(false);
export const club = signal<Club | null>(null);
export const lang = signal<Lang>(pickLang(navigator.language));

// The wording: only this app's keys, one language at a time, fetched when it's first needed (the build
// makes the modules: packages/i18n/src/vite.ts). Each language comes in two parts: what the first screen says,
// and the rest, which the pages loaded later wait for (lazyPage). Until a new language arrives whole, text stays
// in the old one.
type Part = () => Promise<{ default: Catalog }>;
const wordingIn: Record<Lang, { first: Part; rest: Part }> = {
  en: { first: () => import("virtual:kumi-wording/en"), rest: () => import("virtual:kumi-wording/en/rest") },
  es: { first: () => import("virtual:kumi-wording/es"), rest: () => import("virtual:kumi-wording/es/rest") },
};
const catalogs = signal<Partial<Record<Lang, Catalog>>>({});
const fetching = new Map<string, Promise<Catalog>>();
function part(l: Lang, p: "first" | "rest"): Promise<Catalog> {
  const k = `${l}/${p}`;
  if (!fetching.has(k)) fetching.set(k, wordingIn[l][p]().then((m) => m.default, (e) => { fetching.delete(k); throw e; }));
  return fetching.get(k)!;
}
const add = (l: Lang, c: Catalog) => { catalogs.value = { ...catalogs.peek(), [l]: { ...catalogs.peek()[l], ...c } }; };
/** Just what the first screen says, in this language. */
const firstWording = (l: Lang): Promise<void> => part(l, "first").then((c) => add(l, c));
/** All of a language's wording, put in at once. */
const loadWording = (l: Lang): Promise<void> => Promise.all([part(l, "first"), part(l, "rest")]).then(([a, b]) => add(l, { ...a, ...b }));
/** Settles once the first language's first-screen wording is in; the apps draw their first screen after it. */
export const wordingReady: Promise<void> = firstWording(lang.peek()).catch(() => undefined);
// The rest of the wording follows once the app knows who's here (loadMe), in their language, not the browser's.
let following = false;
const followLanguage = () => { if (!following) { following = true; effect(() => { loadWording(lang.value).catch(() => undefined); }); } };
/** A page loaded when it's first opened (preact-iso's lazy), which also waits for the rest of the wording. */
export const lazyPage = <T extends ComponentType<any>>(load: () => Promise<T>) =>
  lazy(() => Promise.all([load(), loadWording(lang.peek()).catch(() => undefined)]).then(([c]) => c));
export const t = (key: Key, params?: Params) => {
  const all = catalogs.value, l = all[lang.value] ? lang.value : lang.value === "en" ? "es" : "en";
  // A key the language's first part doesn't have yet (a page opened before the rest arrived) comes from the other.
  const has = (x: Lang) => all[x]?.[key] !== undefined, from = has(l) ? l : LANGS.find(has) ?? l;
  return format(all[from] ?? {}, from, key, params);
};
/** A moment: the time when it's today, the day and time when it isn't (a place offered at night is held into the next day). */
export function shortTime(iso: string): string {
  const d = new Date(iso), today = d.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { ...(today ? {} : { weekday: "short" as const }), hour: "numeric", minute: "2-digit" }).format(d);
}
/** How many inbox messages are unread, for the nav; checked when the app opens and every minute. */
export const unread = signal(0);
export async function loadUnread(): Promise<void> {
  try { unread.value = (await api<{ unread: number }>("/my/inbox")).unread; } catch { /* signed out or offline: keep the last count */ }
}
export const isStaff = computed(() => (me.value?.roles ?? []).some((r) => r.key !== "member"));

export class ApiError extends Error { code: string; status: number; constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; } }

export async function api<T = any>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", "accept-language": lang.value, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  // Support access that ended mid-session: who they are now is read again, so the app says it ended.
  if (res.status === 403 && json.error === "error.staff_only" && me.value?.support && path !== "/me") void loadMe();
  if (!res.ok) throw new ApiError(json.error ?? "error", json.message ?? res.statusText, res.status);
  return json as T;
}

export async function loadMe(): Promise<void> {
  try { const m = await api<Me>("/me"); await firstWording(m.lang).catch(() => undefined); me.value = m; lang.value = m.lang; }
  catch { me.value = null; }
  followLanguage();
}
