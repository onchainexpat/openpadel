// Who is signed in, the club, and the language: the three things every screen reads.
import { signal, computed, effect } from "@preact/signals";
import { h, type ComponentType } from "preact";
import { lazy } from "preact-iso";
import { useState } from "preact/hooks";
import { format, LANGS, pickLang, type Catalog, type Key, type Lang, type Params } from "@kumi/i18n/format";
import { brandColours } from "./brand.ts";
export { brandColours, contrastOf } from "./brand.ts";

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
  terms_url?: string | null; privacy_policy_url?: string | null;
  /** The club's own clock (IANA zone): every time the apps show is on it, wherever the reader's phone is set. */
  time_zone?: string };

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
/** A page loaded when it's first opened (preact-iso's lazy), which also waits for the rest of the wording. Each is
 *  tried twice. Still missing, the page never draws without its words: if the server now runs another release
 *  (this page's files have gone with the old one), the app reloads once for it; otherwise (offline, a network
 *  blip) it says the page didn't load, with a button that tries again, no reload. */
export const lazyPage = <T extends ComponentType<any>>(load: () => Promise<T>) =>
  lazy(() => loadPage(load).catch(async () => (await newRelease() && reloadOnce() ? new Promise<never>(() => {}) : unloaded(load)) as Promise<T> | T));
const twice = <R>(f: () => Promise<R>) => f().catch(() => f());
const loadPage = <T,>(load: () => Promise<T>) => Promise.all([twice(load), twice(() => loadWording(lang.peek()))]).then(([c]) => c);
/** Whether the server runs another release than this page came from: its page answers and names another entry
 *  file. False when it can't be reached, answers with an error or with no app page, or names this one. */
async function newRelease(): Promise<boolean> {
  const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src");
  if (!mine || !navigator.onLine) return false;
  try {
    const res = await fetch("/", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return false;
    const entry = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(await res.text())?.[1];
    return Boolean(entry) && entry !== mine;
  } catch { return false; }
}
const RELOADED = "kumi:reloaded";
function reloadOnce(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOADED) ?? 0) < 60_000) return false;
    sessionStorage.setItem(RELOADED, String(Date.now()));
  } catch { return false; }   // no storage: no way to tell a second reload from the first, so none
  location.reload();
  return true;
}
/** In place of a page that wouldn't load, with the first screen's words (always here): try again, and draw the
 *  page once it comes; or, for a release since replaced that a reload a minute ago didn't fix, reload. */
function unloaded<T extends ComponentType<any>>(load: () => Promise<T>) {
  return function Unloaded(props: Record<string, unknown>) {
    const [page, setPage] = useState<{ c: T } | null>(null), [state, setState] = useState<"failed" | "trying" | "updated">("failed");
    if (page) return h(page.c, props);
    if (state === "updated") return h("p", { class: "notice" }, t("ui.app_updated"), " ", h("button", { class: "small", onClick: () => location.reload() }, t("ui.reload")));
    const again = () => { setState("trying"); loadPage(load).then((c) => setPage({ c }), async () => setState(await newRelease() ? "updated" : "failed")); };
    return h("p", { class: "notice" }, t("ui.page_not_loaded"), " ", h("button", { class: "small", disabled: state === "trying", onClick: again }, t("ui.try_again")));
  };
}
export const t = (key: Key, params?: Params) => {
  const all = catalogs.value, l = all[lang.value] ? lang.value : lang.value === "en" ? "es" : "en";
  // A key the language's first part doesn't have yet (a page opened before the rest arrived) comes from the other.
  const has = (x: Lang) => all[x]?.[key] !== undefined, from = has(l) ? l : LANGS.find(has) ?? l;
  return format(all[from] ?? {}, from, key, params);
};
// ---- Passkeys, in plain words ----
/** The browser's name for a passkey failure (its own message is for developers), or null when it isn't one:
 *  each screen says it in plain words (sign-in: "didn't work"; the profile: why it wasn't saved). */
export function passkeyFailure(e: unknown): string | null {
  const name = (e as { name?: string } | null)?.name ?? "";
  return ["NotAllowedError", "AbortError", "InvalidStateError", "NotSupportedError", "SecurityError"].includes(name) ? name : null;
}

// ---- The club's colour, readable on both themes (brand.ts) ----
/** The club's colour as the apps paint it (styles.css): as it is for fills, with white or near-black text on them,
 *  whichever reads; and a tint of it for links, outlines and notes that reads at 4.5:1 on the light theme's
 *  background and cards and on the dark theme's (a club's dark green, as it is, is unreadable on the dark theme). */
export function applyBrand(colour: string) {
  const st = document.documentElement.style, b = brandColours(colour);
  st.setProperty("--brand", colour);
  if (!b) return;
  st.setProperty("--brand-ink-light", b.inkLight); st.setProperty("--brand-ink-dark", b.inkDark); st.setProperty("--on-brand", b.onBrand);
}

/** The server's clock, as its last answer gave it (its Date header): a phone's own can be hours out. */
let skew = 0;
export const serverNow = () => Date.now() + skew;
/** A moment on the club's clock, in the reader's language: a member away from home, or a phone set to the wrong
 *  zone, still sees the club's times. `zone` is for a location of its own; without one it's the club's. Every date
 *  and time the apps show goes through here (club_time.test.ts holds them to it). */
export function clubTime(at: string | number | Date, opts: Intl.DateTimeFormatOptions, zone?: string | null): string {
  return new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { ...opts, timeZone: zone || club.value?.time_zone || undefined }).format(new Date(at));
}
/** A moment: the time when it's today, the day and time when it isn't (a place offered at night is held into the next day). */
export function shortTime(iso: string): string {
  const day = (x: string | number) => clubTime(x, { year: "numeric", month: "numeric", day: "numeric" });
  return clubTime(iso, { ...(day(iso) === day(serverNow()) ? {} : { weekday: "short" as const }), hour: "numeric", minute: "2-digit" });
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
  // The server's clock, for what the screens compare with now: only a real difference counts (the header is to the second).
  const said = Date.parse(res.headers.get("date") ?? "");
  if (!isNaN(said) && Math.abs(said - Date.now() - skew) > 5_000) skew = said - Date.now();
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
