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
import type { Manifest } from "@kumi/core";
import { pluginRequest } from "./plugins.ts";

export const RELEASE_MAX_BYTES = 200_000_000;
export interface ServicePaths { root: string; envDir: string; unitDir: string }
export const servicePaths = (env: Record<string, string | undefined> = process.env): ServicePaths => ({
  root: env.KUMI_PLUGIN_ROOT ?? "/opt/openpadel-plugins", envDir: env.KUMI_PLUGIN_ENV_DIR ?? "/etc/kumi/plugins", unitDir: env.KUMI_PLUGIN_UNIT_DIR ?? "/etc/systemd/system" });
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

/** The systemd unit for a local plugin. */
export function unitFile(m: Manifest, dir: string, envFile: string, port: number): string {
  if (m.run.mode !== "local") throw new Error("not local");
  return `# openPadel plugin ${m.name} ${m.version} (${m.publisher}). Written by \`openpadel plugin service ${m.name}\`; it talks to the club
# only through its door (OPENPADEL_MCP) and listens on 127.0.0.1:${port} for the events and hooks the club passes on.
[Unit]
Description=openPadel plugin ${m.name}
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=${envFile}
WorkingDirectory=${dir}
ExecStart=${join(dir, m.run.entry)}
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
InaccessiblePaths=-/etc/kumi -/var/backups/kumi -/var/lib/postgresql -/run/postgresql -/var/lib/kumi
IPAddressDeny=10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 fc00::/7 fe80::/10
MemoryMax=512M
CPUQuota=50%

[Install]
WantedBy=multi-user.target
`;
}
/** The compose service a Docker install would add (printed, not written, in this version). */
export function composeService(m: Manifest, port: number): string {
  if (m.run.mode !== "local") throw new Error("not local");
  const image = m.run.image ?? "(this plugin publishes no container image: it can't run on a Docker install yet)";
  return `  plugin-${m.name}:
    image: ${image}
    restart: unless-stopped
    env_file: ./plugins/${m.name}.env
    environment: { PORT: "${port}" }
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
export function servicePlan(m: Manifest, port: number, docker: boolean, paths = servicePaths()): ServicePlan {
  const dir = resolve(paths.root, m.name, m.version), envFile = join(paths.envDir, `${m.name}.env`);
  return { name: m.name, version: m.version, dir, envFile, unitFile: join(paths.unitDir, unitName(m.name)), unit: unitFile(m, dir, envFile, port), compose: docker ? composeService(m, port) : null, port,
    envNames: ["PORT", "OPENPADEL_URL", "OPENPADEL_MCP", "OPENPADEL_TOKEN", "OPENPADEL_WEBHOOK_SECRET", "OPENPADEL_HOOK_SECRET", "OPENPADEL_PLUGIN"] };
}
/** Writes what the plan says (systemd installs only): the release unpacked, its environment (root's alone) and its unit. */
export function writeService(p: ServicePlan, release: Buffer, entry: string, env: Record<string, string>): void {
  unpack(release, p.dir, entry);
  mkdirSync(resolve(p.envFile, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(p.envFile, envFileText(env), { mode: 0o600 });
  writeFileSync(p.unitFile, p.unit, { mode: 0o644 });
}
