// The session cookie. Over HTTPS it's `__Host-kumi_session`: Secure, Path=/ and no Domain, so the browser keeps it to
// this exact host, and no other site under the same domain can set or replace it. Clubs on a host's shared domain
// (several clubs at <slug>.kumi.club, a domain not on the Public Suffix List) need that: under the plain name, one
// club's server could set a `kumi_session` for the whole domain, and sign another club's visitors in as someone of
// its choosing (cookie tossing, found in the 3 Nov 2026 security review). Over plain http (Kumi on one's own
// computer, `secureCookies` off) browsers refuse the prefix, so the plain name stays there.
//
// For one release the plain name is still read over HTTPS, so nobody is signed out by the update: a request that
// brings only it is moved to the new name, and the old one cleared. A host whose clubs never had the old name turns
// that off (KUMI_LEGACY_SESSION_COOKIE=0), since the old name is the one another club could set.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_DAYS } from "./auth.ts";

export const PLAIN = "kumi_session", HOST = "__Host-kumi_session";
export interface CookieMode { secure: boolean; legacy: boolean }
export const sessionCookieName = (m: CookieMode) => (m.secure ? HOST : PLAIN);

/** The session token the request brings, and whether it came under the old name. */
export function readSession(c: Context<any>, m: CookieMode): { token: string | undefined; legacy: boolean } {
  if (!m.secure) return { token: getCookie(c, PLAIN), legacy: false };
  const t = getCookie(c, HOST);
  if (t) return { token: t, legacy: false };
  if (!m.legacy) return { token: undefined, legacy: false };
  const old = getCookie(c, PLAIN);
  return { token: old, legacy: Boolean(old) };
}

/** The session cookie set (a sign-in, or a session moved from the old name); the old name cleared over HTTPS. */
export function setSession(c: Context<any>, token: string, m: CookieMode) {
  setCookie(c, sessionCookieName(m), token, { httpOnly: true, secure: m.secure, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
  if (m.secure && getCookie(c, PLAIN) !== undefined) deleteCookie(c, PLAIN, { path: "/", secure: true });
}

/** Signed out: the cookie gone, under both names. */
export function clearSession(c: Context<any>, m: CookieMode) {
  deleteCookie(c, sessionCookieName(m), { path: "/", secure: m.secure });
  if (m.secure) deleteCookie(c, PLAIN, { path: "/", secure: true });
}
