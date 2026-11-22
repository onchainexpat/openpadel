// Where the server listens. On a one-server install, 127.0.0.1 and PORT, with Caddy on the same machine in front.
// In Docker, every address (OPENPADEL_LISTEN_ADDRESS=0.0.0.0), since Caddy is another container. On a server several clubs
// share, a unix socket (OPENPADEL_SOCKET) in a folder only the club and its proxy can open: there's no port another club's
// process could reach, and whoever connects is the proxy, so its X-Forwarded-For is believed (limits.ts).
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { setting } from "@kumi/core";

type Env = Record<string, string | undefined>;
export type Listen = { socket: string } | { address: string; port: number };

export function listenFrom(env: Env = process.env): Listen {
  const socket = setting("SOCKET", env)?.trim();
  if (socket) {
    if (!socket.startsWith("/")) throw new Error(`OPENPADEL_SOCKET is the full path of a unix socket, such as /run/kumi/http.sock (not "${socket}")`);
    return { socket };
  }
  const port = Number(env.PORT?.trim() || 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT is a number from 0 to 65535 (not "${env.PORT}")`);
  return { address: setting("LISTEN_ADDRESS", env)?.trim() || "127.0.0.1", port };
}

/** Whether requests come only through the club's own unix socket (so the peer is always its proxy). */
export const onSocket = (env: Env = process.env) => Boolean(setting("SOCKET", env)?.trim());

export function describeListen(l: Listen, server?: Server): string {
  if ("socket" in l) return `unix socket ${l.socket}`;
  const a = server?.address(), port = a && typeof a === "object" ? a.port : l.port;
  return `http://${l.address.includes(":") ? `[${l.address}]` : l.address}:${port}`;
}

/** Starts the server. A socket is made readable and writable by its owner and group only (0660): put it in a folder
 *  whose group is the proxy's. One left by a server that stopped is replaced; anything else at that path is refused. */
export async function listen(fetch: (req: Request, env: any) => Response | Promise<Response>, l: Listen): Promise<Server> {
  const server = createAdaptorServer({ fetch }) as Server;
  const started = (...args: unknown[]) => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    (server.listen as (...a: unknown[]) => void)(...args, () => { server.off("error", reject); resolve(); });
  });
  if ("socket" in l) {
    try {
      if (!lstatSync(l.socket).isSocket()) throw new Error(`${l.socket} is already there and isn't a socket: not replacing it`);
      unlinkSync(l.socket);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await started(l.socket);
    chmodSync(l.socket, 0o660);
  } else {
    await started(l.port, l.address);
  }
  return server;
}
