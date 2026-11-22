// A local plugin's own service on the club's server (`openpadel plugin service <name>`): its pinned release fetched
// and checked against the SHA-256 its manifest gives, unpacked, and run as a systemd unit with no access but the
// club's door and the internet: its own throwaway user (DynamicUser), the system read-only, no home, no devices, the
// club's settings, backups and database socket out of sight, and the private networks (and the cloud's metadata
// address) refused. Its token, its webhook secret and its hook secret go into its environment file, readable by root
// alone (systemd hands them to the service); nobody is shown them.
//
// Without --apply it only says what it would do (the unit, where it unpacks, the environment's names, never its
// values). On a Docker install it writes nothing yet: it prints the compose service it would add.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { clubNetworkField, ipKind, type Manifest } from "@kumi/core";
import { isIP } from "node:net";
import { pluginRequest } from "./plugins.ts";
import { setting } from "@kumi/core";

export const RELEASE_MAX_BYTES = 200_000_000;
export interface ServicePaths { root: string; envDir: string; unitDir: string }
export const servicePaths = (env: Record<string, string | undefined> = process.env): ServicePaths => ({
  root: setting("PLUGIN_ROOT", env) ?? "/opt/openpadel-plugins", envDir: setting("PLUGIN_ENV_DIR", env) ?? "/etc/kumi/plugins", unitDir: setting("PLUGIN_UNIT_DIR", env) ?? "/etc/systemd/system" });
export const unitName = (name: string) => `openpadel-plugin-${name}.service`;

/** The release, fetched and checked against its fingerprint: refused, and nothing kept, if it differs. */
export async function fetchRelease(m: Manifest, production: boolean): Promise<Buffer> {
  if (m.run.mode !== "local") throw new Error(`${m.name} isn't a local plugin`);
  const r = await pluginRequest(m.run.release_url, { method: "GET", headers: { "user-agent": "openPadel-Plugins/1" }, max: RELEASE_MAX_BYTES, timeoutMs: 120_000, publicOnly: production });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${new URL(m.run.release_url).host}`);
  const got = createHash("sha256").update(r.body).digest("hex");
  if (got !== m.run.sha256) throw new Error(`the release's SHA-256 is ${got}, not the ${m.run.sha256} its manifest pins: not installed`);
  return r.body;
}

/** Only what's safe in a unit file or a compose file: letters, digits and . _ - / @ : (a name, a version, a path, an
 *  image). The manifest's checks already hold every field to one line; this is the second lock on the same door. */
export const unitSafe = (s: string) => s.replace(/[^A-Za-z0-9._\-/@:]/g, "");

/** The systemd unit for a local plugin. Nothing the manifest says in words goes into it: only its name, version and
 *  entry, which the manifest's checks hold to safe characters, and they're kept to those again here. */
export function unitFile(m: Manifest, dir: string, envFile: string, port: number, allowIp: string | null = null): string {
  if (m.run.mode !== "local") throw new Error("not local");
  // The one address on the club's network the owner said yes to (club_network.ts): only an IP, checked again here.
  if (allowIp !== null && (!/^[0-9A-Fa-f:.]{2,45}$/.test(allowIp) || !isIP(allowIp) || ipKind(allowIp) !== "private")) throw new Error("not a private IP address");
  const allow = allowIp === null ? "" : `\n# The owner let it reach this one address on the club's own network (its ${unitSafe(clubNetworkField(m)?.key ?? "club_network")} setting).\nIPAddressAllow=${allowIp}/${isIP(allowIp) === 4 ? 32 : 128}`;
  const name = unitSafe(m.name), version = unitSafe(m.version), p = Number.isInteger(port) ? port : 0;
  return `# openPadel plugin ${name} ${version}. Written by openpadel plugin service ${name}; it talks to the club only
# through its door (OPENPADEL_MCP) and listens on 127.0.0.1:${p} for the events and hooks the club passes on.
# It can't reach Caddy's admin (a socket under /var/lib/caddy, hidden here), the club's settings, backups or database
# socket. Postgres on 127.0.0.1:5432 answers on the loopback, but only with a password this service never has.
[Unit]
Description=openPadel plugin ${name}
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=${unitSafe(envFile)}
WorkingDirectory=${unitSafe(dir)}
# Its own place to keep what it needs across restarts (given to it as STATE_DIRECTORY), readable by it alone.
StateDirectory=openpadel-plugin-${name}
StateDirectoryMode=0700
ExecStart=${unitSafe(join(dir, m.run.entry))}
Restart=on-failure
RestartSec=5
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6
InaccessiblePaths=-/etc/kumi -/var/backups/kumi -/var/lib/postgresql -/run/postgresql -/var/lib/kumi -/etc/caddy -/var/lib/caddy -/run/caddy
IPAddressDeny=10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 fc00::/7 fe80::/10${allow}
MemoryMax=512M
CPUQuota=50%

[Install]
WantedBy=multi-user.target
`;
}
/** The compose service a Docker install would add (printed, not written, in this version). */
export function composeService(m: Manifest, port: number): string {
  if (m.run.mode !== "local") throw new Error("not local");
  const name = unitSafe(m.name), p = Number.isInteger(port) ? port : 0;
  const image = m.run.image ? unitSafe(m.run.image) : "# this plugin publishes no container image: it can't run on a Docker install yet";
  return `  plugin-${name}:
    image: ${image}
    restart: unless-stopped
    env_file: ./plugins/${name}.env
    environment: { PORT: "${p}" }
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    networks: [plugins]
    mem_limit: 512m
`;
}

/** Unpacks a checked release into its own directory (GNU tar leaves out absolute paths and ".."), and checks its entry
 *  is inside it. */
export function unpack(release: Buffer, dir: string, entry: string): void {
  const tmp = mkdtempSync(join(tmpdir(), "openpadel-plugin-"));
  try {
    const file = join(tmp, "release.tar.gz");
    writeFileSync(file, release, { mode: 0o600 });
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    execFileSync("tar", ["-xzf", file, "-C", dir, "--no-same-owner", "--no-same-permissions"], { stdio: "pipe" });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const at = join(dir, entry);
  if (!existsSync(at)) throw new Error(`the release has no ${entry}`);
  const real = realpathSync(at), base = realpathSync(dir);
  if (!real.startsWith(base + sep)) throw new Error(`${entry} points outside the release`);
}

/** The environment file: one line each, root's alone. */
export function envFileText(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v.replace(/[\r\n]/g, "")}`).join("\n") + "\n";
}

export interface ServicePlan { name: string; version: string; dir: string; envFile: string; unitFile: string; unit: string; compose: string | null; port: number; envNames: string[] }
export function servicePlan(m: Manifest, port: number, docker: boolean, paths = servicePaths(), allowIp: string | null = null): ServicePlan {
  const dir = resolve(paths.root, m.name, m.version), envFile = join(paths.envDir, `${m.name}.env`);
  return { name: m.name, version: m.version, dir, envFile, unitFile: join(paths.unitDir, unitName(m.name)), unit: unitFile(m, dir, envFile, port, allowIp), compose: docker ? composeService(m, port) : null, port,
    envNames: ["PORT", "OPENPADEL_URL", "OPENPADEL_MCP", "OPENPADEL_TOKEN", "OPENPADEL_WEBHOOK_SECRET", "OPENPADEL_HOOK_SECRET", "OPENPADEL_PLUGIN"] };
}
/** Writes what the plan says (systemd installs only): the release unpacked, its environment (root's alone) and its unit. */
export function writeService(p: ServicePlan, release: Buffer, entry: string, env: Record<string, string>): void {
  unpack(release, p.dir, entry);
  mkdirSync(resolve(p.envFile, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(p.envFile, envFileText(env), { mode: 0o600 });
  writeFileSync(p.unitFile, p.unit, { mode: 0o644 });
}
