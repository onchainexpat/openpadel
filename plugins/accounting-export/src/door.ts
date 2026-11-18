// The club's door: its MCP endpoint, called with the plugin's token (Authorization: Bearer). Each call is one stateless
// JSON-RPC tools/call; the answer's text is JSON. A plugin acts only through here, with the role its manifest gave it.

export type Fetch = typeof fetch;
export const DOOR_TIMEOUT_MS = 15_000;

/** Why a door call failed: `no_tool` (the club doesn't offer it, or not to us), `signed_out` (the token was revoked or
 *  the plugin paused), `unreachable`, or the club's own error key (error.plugin_secret_missing). */
export class DoorError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface Door { call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T> }

export function door(mcpUrl: string, token: string, fetchImpl: Fetch = fetch, timeoutMs = DOOR_TIMEOUT_MS): Door {
  let id = 0;
  return {
    async call(tool, args = {}) {
      let r: Response;
      try {
        r = await fetchImpl(mcpUrl, { method: "POST", signal: AbortSignal.timeout(timeoutMs), redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "openPadel-AccountingExport/0.1" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } }) });
      } catch (e) { throw new DoorError("unreachable", `the club's door didn't answer: ${(e as Error).message}`); }
      if (r.status === 401 || r.status === 403) throw new DoorError("signed_out", `the club refused the plugin's token (HTTP ${r.status})`);
      const text = await r.text();
      let b: any;
      try { b = JSON.parse(sseData(text)); } catch { throw new DoorError("unreachable", `the club's door answered HTTP ${r.status}, not JSON`); }
      if (b?.error) {
        const msg = String(b.error.message ?? "error");
        throw new DoorError(/tool .*not found|not found.*tool|unknown tool/i.test(msg) ? "no_tool" : "door_error", msg);
      }
      const res = b?.result;
      if (res?.isError) {
        const msg = String(res.content?.[0]?.text ?? "error");
        throw new DoorError(res._meta?.["kumi/error"] ?? (/tool .*not found|unknown tool/i.test(msg) ? "no_tool" : "door_error"), msg);
      }
      const out = res?.content?.[0]?.text;
      if (typeof out !== "string") throw new DoorError("door_error", "the club's door answered without content");
      try { return JSON.parse(out); } catch { return out as any; }
    },
  };
}

/** An answer sent as server-sent events: its last data line. */
function sseData(text: string): string {
  if (!/^(event|data):/m.test(text) || text.trimStart().startsWith("{")) return text;
  const data = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  return data.at(-1) ?? text;
}
