// The two addresses a club's Kumi answers on: the staff app's (KUMI_PUBLIC_URL: passkeys, agent sign-in, Stripe's
// return pages) and the members' app's. Links a member gets from the server (a club news email's unsubscribe link,
// the public page's own address) use the members' one; links built in the apps use the address they're open on.
type Env = Record<string, string | undefined>;

/** The members' app's address: KUMI_MEMBER_URL; or else the staff address without the "staff." in front, which is
 *  how both installs (server-setup.sh and Docker) name the two; or else the staff address itself, when one address
 *  serves both (a laptop, or a server set up by hand). */
export function memberUrl(staff: string, env: Env = process.env): string {
  const set = env.KUMI_MEMBER_URL?.trim();
  if (set) return set.replace(/\/$/, "");
  const u = new URL(staff);
  if (u.hostname.startsWith("staff.")) u.hostname = u.hostname.slice("staff.".length);
  return u.toString().replace(/\/$/, "");
}

/** The web domain to register with Stripe so the members' card form can offer Apple Pay and Google Pay: the members'
 *  address's host, when it's a public HTTPS name (Stripe can't register a laptop, an IP address or a test name). */
export function walletDomainOf(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname;
  if (u.protocol !== "https:" || !h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":")) return null;
  if (/(^|\.)(localhost|test|example|invalid|local|internal)$/.test(h)) return null;
  return h;
}
