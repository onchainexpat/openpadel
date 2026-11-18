// Starts the plugin. Two ways to run (docs/plugins/writing.md):
//   - local, on the club's own server (`openpadel plugin service`): the club writes OPENPADEL_URL, OPENPADEL_MCP,
//     OPENPADEL_TOKEN, OPENPADEL_WEBHOOK_SECRET and PORT into its environment, and it listens on 127.0.0.1;
//   - remote, on any host: the club sends a signed registration to <its address>/register when it's installed.
import { plugin, type Log } from "./plugin.ts";

// One JSON line per thing worth knowing, on stderr. Never a token or a key: anything shaped like one is blotted out.
const log: Log = (level, msg, fields = {}) => {
  process.stderr.write(JSON.stringify({ at: new Date().toISOString(), level, msg, ...fields }).replace(/\b(opa_|whsec_|opps_)[A-Za-z0-9_-]+|Bearer\s+[^\s"]+/g, "[hidden]") + "\n");
};
const env = process.env, url = (env.OPENPADEL_URL ?? "").replace(/\/+$/, "");
const local = env.OPENPADEL_TOKEN ? { url, timeZone: "UTC", mcp: env.OPENPADEL_MCP ?? `${url}/mcp`, token: env.OPENPADEL_TOKEN, webhookSecret: env.OPENPADEL_WEBHOOK_SECRET ?? "", settings: {} } : null;
const p = plugin({ log, local, stateDir: local ? null : env.STATE_DIRECTORY ?? env.STATE_DIR ?? "state", allowHttp: env.OPENPADEL_DEV === "1" });
const server = await p.listen(Number(env.PORT ?? 8080), env.HOST ?? (local ? "127.0.0.1" : "0.0.0.0"));
p.start();
log("info", "started", { mode: local ? "local" : "remote", clubs: p.runners.size });
const stop = () => { p.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
