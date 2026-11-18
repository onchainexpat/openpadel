// One address on the club's own network a local plugin may reach (decided 17 Nov 2026). A local plugin's service is
// kept off private networks (plugin_service.ts), so a Home Assistant at 192.168.1.20 is out of reach. A manifest may
// mark one string setting `club_network`; when that setting names a private or link-local address (or a name that
// resolves to exactly one), its service is let through to that one IP and nothing else there. The plan says so in
// words, and the owner says yes to it like the rest of the install or settings (a manager asks).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { both, type Key, type Text } from "@kumi/i18n";
import { KumiError } from "./errors.ts";
import type { Manifest, SettingField } from "./plugin_manifest.ts";

export interface NetworkIo {
  /** Every address a name answers at. */
  resolve(host: string): Promise<string[]>;
  /** This server's own addresses. */
  own(): string[];
}
const realIo: NetworkIo = {
  async resolve(host) { return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address); },
  own() { return Object.values(networkInterfaces()).flat().filter((a) => a).map((a) => a!.address.replace(/%.*$/, "")); },
};
let io: NetworkIo = realIo;
/** For tests: what names resolve to, and the server's own addresses. */
export function setNetworkIo(next: Partial<NetworkIo> | null): void { io = next ? { ...realIo, ...next } : realIo; }

const v4 = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
const in4 = (ip: string, base: string, bits: number) => bits === 0 || Math.floor(v4(ip) / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits));
/** An IPv6 address as eight numbers (with :: filled, and a trailing dotted IPv4 taken as two). */
function groups6(ip: string): number[] {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) { const n = v4(dotted[1]!); s = s.slice(0, -dotted[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const [head, tail] = s.includes("::") ? s.split("::") as [string, string] : [s, null];
  const h = head ? head.split(":").filter((x) => x !== "") : [], t = tail ? tail.split(":").filter((x) => x !== "") : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}

export type IpKind = "private" | "public" | "loopback" | "unspecified" | "multicast";
/** What kind of address an IP is, for this rule. Private covers the ranges the plugin's service is kept off. */
export function ipKind(ip: string): IpKind {
  if (isIP(ip) === 4) {
    if (in4(ip, "0.0.0.0", 8)) return "unspecified";
    if (in4(ip, "127.0.0.0", 8)) return "loopback";
    if (in4(ip, "224.0.0.0", 4) || in4(ip, "240.0.0.0", 4)) return "multicast";   // and the reserved block up to the broadcast address
    if (in4(ip, "10.0.0.0", 8) || in4(ip, "172.16.0.0", 12) || in4(ip, "192.168.0.0", 16) || in4(ip, "169.254.0.0", 16) || in4(ip, "100.64.0.0", 10)) return "private";
    return "public";
  }
  const g = groups6(ip);
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  // An IPv4 address written as IPv6 (::ffff:192.168.1.20) is that IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return ipKind(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
  if (g[0]! >> 8 === 0xff) return "multicast";
  if ((g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80) return "private";
  return "public";
}
const same = (a: string, b: string) => isIP(a) === 4 && isIP(b) === 4 ? a === b : isIP(a) === 6 && isIP(b) === 6 && groups6(a).join(":") === groups6(b).join(":");

/** The manifest's one setting on the club's network, if it has one. */
export const clubNetworkField = (m: Manifest): Extract<SettingField, { type: "string" }> | null =>
  (m.settings.find((f) => f.type === "string" && f.club_network) as Extract<SettingField, { type: "string" }> | undefined) ?? null;

/** The host a setting names: an address's host ("https://ha.club.lan:8123"), or the value itself ("192.168.1.20"). */
export function hostOfSetting(v: string): string {
  const s = v.trim();
  try { const u = new URL(s); if (u.hostname) return u.hostname.replace(/^\[|\]$/g, ""); } catch { /* not an address */ }
  return s.replace(/^\[|\]$/g, "").replace(/:\d+$/, (m) => isIP(s) === 6 ? m : "");
}

/** The one IP a local plugin's service is let through to, from its club-network setting: null when the setting is
 *  empty, the plugin isn't local, or the address is public (nothing to let through). Refused, with words, when it's this
 *  server, not one device's address, or a name that answers at several addresses. */
export async function clubNetworkIp(m: Manifest, values: Record<string, unknown>): Promise<{ ip: string; label: Text } | null> {
  const f = clubNetworkField(m);
  if (!f || m.run.mode !== "local") return null;
  const v = values[f.key];
  if (typeof v !== "string" || !v.trim()) return null;
  const host = hostOfSetting(v);
  const refuse = (why: string) => { throw new KumiError("error.plugin_club_network", { label: f.label, host, why: both(`error.plugin_club_network_${why}` as Key) }, 400); };
  let ips: string[];
  if (isIP(host)) ips = [host];
  else {
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return refuse("not_found");
    try { ips = [...new Set(await io.resolve(host))]; } catch { return refuse("not_found"); }
    if (!ips.length) return refuse("not_found");
  }
  if (ips.length > 1) return refuse("several");
  const ip = ips[0]!.replace(/%.*$/, ""), kind = ipKind(ip);
  if (kind === "loopback" || io.own().some((o) => same(o, ip))) return refuse("this_server");
  if (kind === "unspecified" || kind === "multicast") return refuse("not_one");
  return kind === "private" ? { ip, label: f.label } : null;
}
