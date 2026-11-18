// Home Assistant's REST API: POST /api/services/<domain>/turn_on|turn_off with the entities, under a long-lived access
// token. Each call has a timeout; the caller retries with waits that grow (club.ts).
import type { Fetch } from "./door.ts";

export const HA_TIMEOUT_MS = 8_000;

export class HomeAssistantError extends Error {
  /** HTTP status, or 0 when it didn't answer. 401 means the token is wrong or gone. */
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Turns entities on or off: lights through the light service, switches through the switch service. */
export async function setLights(baseUrl: string, token: string, service: "turn_on" | "turn_off", entities: string[], fetchImpl: Fetch = fetch, timeoutMs = HA_TIMEOUT_MS): Promise<void> {
  const byDomain = new Map<string, string[]>();
  for (const e of entities) { const d = e.split(".")[0]!; byDomain.set(d, [...(byDomain.get(d) ?? []), e]); }
  for (const [domain, ids] of byDomain) {
    let r: Response;
    try {
      r = await fetchImpl(`${baseUrl}/api/services/${domain}/${service}`, { method: "POST", signal: AbortSignal.timeout(timeoutMs), redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ entity_id: ids }) });
    } catch (e) { throw new HomeAssistantError(0, `Home Assistant didn't answer: ${(e as Error).message}`); }
    await r.arrayBuffer().catch(() => null);
    if (r.status < 200 || r.status > 299) throw new HomeAssistantError(r.status, `Home Assistant answered HTTP ${r.status} to ${domain}.${service}`);
  }
}

/** Whether Home Assistant answers its API with this token (GET /api/). */
export async function ping(baseUrl: string, token: string, fetchImpl: Fetch = fetch, timeoutMs = HA_TIMEOUT_MS): Promise<void> {
  let r: Response;
  try { r = await fetchImpl(`${baseUrl}/api/`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error", headers: { authorization: `Bearer ${token}` } }); }
  catch (e) { throw new HomeAssistantError(0, `Home Assistant didn't answer: ${(e as Error).message}`); }
  await r.arrayBuffer().catch(() => null);
  if (r.status < 200 || r.status > 299) throw new HomeAssistantError(r.status, `Home Assistant answered HTTP ${r.status}`);
}
