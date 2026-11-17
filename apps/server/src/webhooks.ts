// Sending the club's signed webhooks (packages/core/src/webhooks.ts makes and signs them; this POSTs them). In
// production an address must be https and public: never this server's own network (loopback, private ranges,
// link-local, the cloud metadata address), checked on the address actually connected to, so a name can't answer one
// thing to a check and another to the connection (oauth.ts, publicOnlyLookup). Redirects aren't followed, an answer
// counts only by its status, and an address that takes longer than 10 seconds has failed that try.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { setWebhookRules, type WebhookPost } from "@kumi/core";
import { publicAddress, publicOnlyLookup } from "./oauth.ts";
import { shortenContacts } from "./mcp.ts";

export const WEBHOOK_TIMEOUT_MS = 10_000;

/** A name that is this machine or its private network whatever it resolves to. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;
/** Whether an address's host may take a webhook in production: a public IP, or a name that isn't a local one (its
 *  addresses are checked again when it's connected to). */
export function publicHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(h)) return publicAddress(h);
  return h.includes(".") && !LOCAL_NAME.test(h);
}

/** The server's rules for webhooks: https and public addresses only in production; event data shortened as the door
 *  shows it (emails and phone numbers). */
export function useWebhookRules(production: boolean): void {
  setWebhookRules({ httpsOnly: production, hostOk: production ? publicHost : () => true, scrub: (d) => shortenContacts(d) });
}

/** POST a webhook: public addresses only when `publicOnly` (production), no redirects, 10 seconds at most. `localOk`: an
 *  address on this server's loopback that is a local plugin's own (plugins.ts), the one exception. */
export function webhookPost(publicOnly: boolean, localOk: (u: URL) => Promise<boolean> = async () => false): WebhookPost {
  return (url, body, headers) => new Promise(async (resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { return reject(new Error("not an address")); }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const local = publicOnly && u.protocol === "http:" && (host === "127.0.0.1" || host === "::1") && await localOk(u).catch(() => false);
    if (publicOnly && !local && u.protocol !== "https:") return reject(new Error("https only"));
    if (publicOnly && !local && !publicHost(host)) return reject(new Error(`${host} isn't a public address`));
    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(u, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, ...(publicOnly && !local ? { lookup: publicOnlyLookup() as any } : {}) }, (res) => {
      res.resume();   // only the status counts; whatever it says is read and dropped
      res.on("end", () => { clearTimeout(timer); resolve(res.statusCode ?? 0); });
      res.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error("took longer than 10 seconds")), WEBHOOK_TIMEOUT_MS);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.end(body);
  });
}
