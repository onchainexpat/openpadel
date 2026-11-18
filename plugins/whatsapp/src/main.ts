// Starts the WhatsApp plugin (README.md). Two ways to run:
//   - local, on the club's own server (`openpadel plugin service`): the club writes OPENPADEL_URL, OPENPADEL_MCP,
//     OPENPADEL_TOKEN, OPENPADEL_WEBHOOK_SECRET, OPENPADEL_HOOK_SECRET and PORT into its environment, and it listens on
//     127.0.0.1;
//   - remote, on any host: the club sends a signed registration to <its address>/register when it's installed.
import { jsonLog } from "./log.ts";
import { plugin } from "./server.ts";
import { blankRecord, openStore } from "./store.ts";

const env = process.env;
const local = Boolean(env.OPENPADEL_TOKEN);
const port = Number(env.PORT ?? 8080);
const host = env.HOST ?? (local ? "127.0.0.1" : "0.0.0.0");
// systemd's StateDirectory when it gives one, else STATE_DIR, else ./state for a remote plugin. Without anywhere to
// write it keeps what waits to go in memory, and loses it on a restart (the club's change log still says what was handed).
const store = openStore(env.STATE_DIRECTORY ?? env.STATE_DIR ?? (local ? null : "state"));
const p = plugin({ store, log: jsonLog, registrations: !local, allowHttp: env.OPENPADEL_DEV === "1",
  clubs: env.OPENPADEL_CLUBS ? env.OPENPADEL_CLUBS.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean) : null });

if (local) {
  const url = (env.OPENPADEL_URL ?? "").replace(/\/+$/, "");
  const kept = p.runners.get(url)?.rec;
  p.add({ ...(kept ?? blankRecord({} as any)),
    club: { name: kept?.club.name ?? "", url, time_zone: kept?.club.time_zone ?? "UTC", language: kept?.club.language ?? "en" },
    door: { mcp: env.OPENPADEL_MCP ?? `${url}/mcp`, token: env.OPENPADEL_TOKEN! },
    webhookSecret: env.OPENPADEL_WEBHOOK_SECRET ?? "", hookSecret: env.OPENPADEL_HOOK_SECRET ?? "", settings: kept?.settings ?? {} });
}

const server = await p.listen(port, host);
p.start();
jsonLog("info", "WhatsApp plugin started", { mode: local ? "local" : "remote", port, host, clubs: p.runners.size, kept_on_disk: store.durable });
const stop = () => { p.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
