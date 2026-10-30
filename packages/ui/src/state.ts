// Who is signed in, the club, and the language: the three things every screen reads.
import { signal, computed, effect } from "@preact/signals";
import { format, pickLang, type Catalog, type Key, type Lang, type Params } from "@kumi/i18n/format";

export type Me = { person: { id: string; display_name: string; locale: string }; signed_in_with: "email_code" | "passkey"; lang: Lang; roles: { key: string; location_id: string | null }[];
  /** A junior with a login of their own: their parents' rules apply, and payments go on the family card. */
  kid?: { friends: boolean } | null };
export type Club = { name: string; brand_colour: string; languages: string[]; default_language: Lang; court_bookings?: boolean; memberships?: boolean; lessons?: boolean; public_page?: boolean };

export const me = signal<Me | null | undefined>(undefined);      // undefined: not loaded yet
/** The account was just deleted: the sign-in page says so. */
export const farewell = signal(false);
export const club = signal<Club | null>(null);
export const lang = signal<Lang>(pickLang(navigator.language));

// The wording: only this app's keys, one language at a time, fetched when it's first needed (the build
// makes the modules: packages/i18n/src/vite.ts). Until a new language arrives, text stays in the old one.
const wordingIn: Record<Lang, () => Promise<{ default: Catalog }>> = { en: () => import("virtual:kumi-wording/en"), es: () => import("virtual:kumi-wording/es") };
const catalogs = signal<Partial<Record<Lang, Catalog>>>({});
const fetching = new Map<Lang, Promise<void>>();
function loadWording(l: Lang): Promise<void> {
  if (!fetching.has(l)) fetching.set(l, wordingIn[l]().then((m) => { catalogs.value = { ...catalogs.peek(), [l]: m.default }; }, (e) => { fetching.delete(l); throw e; }));
  return fetching.get(l)!;
}
/** Settles once the first language's wording is in; the apps draw their first screen after it. */
export const wordingReady: Promise<void> = loadWording(lang.peek()).catch(() => undefined);
effect(() => { loadWording(lang.value).catch(() => undefined); });
export const t = (key: Key, params?: Params) => {
  const all = catalogs.value, l = all[lang.value] ? lang.value : lang.value === "en" ? "es" : "en";
  return format(all[l] ?? {}, l, key, params);
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
  if (!res.ok) throw new ApiError(json.error ?? "error", json.message ?? res.statusText, res.status);
  return json as T;
}

export async function loadMe(): Promise<void> {
  try { const m = await api<Me>("/me"); await loadWording(m.lang).catch(() => undefined); me.value = m; lang.value = m.lang; }
  catch { me.value = null; }
}
