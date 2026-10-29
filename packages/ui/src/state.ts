// Who is signed in, the club, and the language: the three things every screen reads.
import { signal, computed } from "@preact/signals";
import { pickLang, t as translate, type Key, type Lang, type Params } from "@kumi/i18n";

export type Me = { person: { id: string; display_name: string; locale: string }; signed_in_with: "email_code" | "passkey"; lang: Lang; roles: { key: string; location_id: string | null }[] };
export type Club = { name: string; brand_colour: string; languages: string[]; default_language: Lang };

export const me = signal<Me | null | undefined>(undefined);      // undefined: not loaded yet
export const club = signal<Club | null>(null);
export const lang = signal<Lang>(pickLang(navigator.language));
export const t = (key: Key, params?: Params) => translate(lang.value, key, params);
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
  try { const m = await api<Me>("/me"); me.value = m; lang.value = m.lang; }
  catch { me.value = null; }
}
