// What the command line keeps on the computer it runs on, for the clubs it's signed in to (cli_remote.ts):
// - clubs.json: each club's address, its sign-in server, the connection's client id, who signed in, and which
//   club is the current one. Nothing secret.
// - the tokens: in the system's keychain when there is one (secret-tool on Linux, security on a Mac), otherwise in
//   secrets.json, readable by this user only (0600).
// - runs.json: the previews this computer made lately, so `kumi confirm <run_id>` finds its command and a command
//   run again with --yes does what was previewed once, not twice.
// All in OPENPADEL_CONFIG_DIR, or ~/.config/kumi (XDG_CONFIG_HOME), or %APPDATA%\kumi on Windows.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setting } from "@kumi/core";

export interface ClubEntry {
  url: string; issuer: string; resource: string; token_endpoint: string; client_id: string;
  person: string; lang: "en" | "es"; club_name: string; time_zone: string; store: "keychain" | "file"; server_version: string;
  /** Who signed in, and their connection at the club (whoami): a preview kept here is only ever theirs. */
  person_id?: string; connection_id?: string;
}
export interface Tokens { access_token: string; refresh_token: string; expires_at: number }
/** A preview made here: `input` is a hash of the command's input (a --key reused with a different one is refused),
 *  `person` and `connection` whose it is, `targets` the ids it names (what a later change to the same thing shares). */
export interface RunEntry { club: string; tool: string; key: string; run_id: string; summary: string; expires_at: string; done_at?: string; result?: unknown;
  input?: string; person?: string; connection?: string; targets?: string[]; at?: string }
interface Clubs { current: string | null; clubs: Record<string, ClubEntry> }

export function configDir(env = process.env): string {
  if (setting("CONFIG_DIR", env)) return setting("CONFIG_DIR", env)!;
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "kumi");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kumi");
}

/** One club's address as the key everything is kept under: lower-case origin, no trailing slash. */
export function clubKey(raw: string): string {
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(raw) ? `http://${raw}` : `https://${raw}`);
  const u = new URL(withScheme);
  return u.origin.toLowerCase();
}

export class Store {
  readonly dir: string;
  private keychainOn: boolean;
  constructor(dir = configDir(), keychainOn = setting("CLI_KEYCHAIN") !== "0") {
    this.dir = dir; this.keychainOn = keychainOn;
  }
  private path(name: string) { return join(this.dir, name); }
  private read<T>(name: string, empty: T): T {
    try { return JSON.parse(readFileSync(this.path(name), "utf8")) as T; } catch { return empty; }
  }
  /** Written whole, to a new file renamed into place, readable by this user only. */
  private write(name: string, v: unknown) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = this.path(`${name}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path(name));
    try { chmodSync(this.path(name), 0o600); } catch { /* Windows */ }
  }

  clubs(): Clubs { return this.read<Clubs>("clubs.json", { current: null, clubs: {} }); }
  club(key: string): ClubEntry | null { return this.clubs().clubs[key] ?? null; }
  /** The club a command is for: --club, then OPENPADEL_CLUB, then the one signed in to last (or chosen with kumi use). */
  pick(flag?: string | null, env = process.env): ClubEntry | null {
    const c = this.clubs();
    const want = flag || setting("CLUB", env) || c.current;
    return want ? c.clubs[clubKey(want)] ?? null : null;
  }
  saveClub(e: ClubEntry, tokens: Tokens) {
    const store = this.keychainOn && keychainSet(e.url, JSON.stringify(tokens)) ? "keychain" : "file";
    if (store === "file") { const s = this.read<Record<string, Tokens>>("secrets.json", {}); s[e.url] = tokens; this.write("secrets.json", s); }
    else this.dropFileTokens(e.url);
    const c = this.clubs();
    c.clubs[e.url] = { ...e, store }; c.current = e.url;
    this.write("clubs.json", c);
    return store;
  }
  use(key: string): boolean {
    const c = this.clubs();
    if (!c.clubs[key]) return false;
    c.current = key; this.write("clubs.json", c);
    return true;
  }
  forget(key: string) {
    const c = this.clubs(), e = c.clubs[key];
    if (!e) return;
    if (e.store === "keychain") keychainDelete(key);
    this.dropFileTokens(key);
    delete c.clubs[key];
    if (c.current === key) c.current = Object.keys(c.clubs)[0] ?? null;
    this.write("clubs.json", c);
    const runs = this.read<RunEntry[]>("runs.json", []).filter((r) => r.club !== key);
    this.write("runs.json", runs);
  }
  private dropFileTokens(key: string) {
    if (!existsSync(this.path("secrets.json"))) return;
    const s = this.read<Record<string, Tokens>>("secrets.json", {});
    if (key in s) { delete s[key]; this.write("secrets.json", s); }
  }
  tokens(e: ClubEntry): Tokens | null {
    if (e.store === "keychain") { const v = keychainGet(e.url); return v ? JSON.parse(v) as Tokens : null; }
    return this.read<Record<string, Tokens>>("secrets.json", {})[e.url] ?? null;
  }
  setTokens(e: ClubEntry, t: Tokens) {
    if (e.store === "keychain" && keychainSet(e.url, JSON.stringify(t))) return;
    const s = this.read<Record<string, Tokens>>("secrets.json", {}); s[e.url] = t; this.write("secrets.json", s);
    if (e.store === "keychain") { const c = this.clubs(); if (c.clubs[e.url]) { c.clubs[e.url]!.store = "file"; this.write("clubs.json", c); } }
  }

  /** One process at a time refreshes a club's tokens: a refresh token used twice ends the whole sign-in (oauth.ts),
   *  so two commands run at once must not both refresh. Waits up to `ms` for the other one. */
  async locked<T>(name: string, fn: () => Promise<T>, ms = 15_000): Promise<T> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = this.path(`${name}.lock`), until = Date.now() + ms;
    let fd: number | null = null;
    while (fd === null) {
      try { fd = openSync(lock, "wx", 0o600); }
      catch {
        // A lock left by a process that died more than a minute ago is taken over.
        try { if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { force: true }); } catch { /* gone already */ }
        if (Date.now() > until) throw new Error("another kumi command is signing in again; try once more");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    try { return await fn(); } finally { closeSync(fd); rmSync(lock, { force: true }); }
  }

  runs(): RunEntry[] { return this.read<RunEntry[]>("runs.json", []); }
  /** The previews kept: a day's worth, newest first. 200 at most of those made without a --key; one with a --key is
   *  kept for its day however many others come after (the newest for each key), since a retry with the key must find it. */
  saveRun(r: RunEntry) {
    const day = Date.now() - 864e5;
    const recent = [r, ...this.runs().filter((x) => x.run_id !== r.run_id && new Date(x.done_at ?? x.expires_at).getTime() > day)];
    const keyed = new Set<string>(), kept: RunEntry[] = [];
    let plain = 0;
    for (const x of recent) {
      if (x.key.startsWith("key:")) {
        const k = `${x.club}|${x.person ?? ""}|${x.key}`;
        if (keyed.has(k)) continue;
        keyed.add(k); kept.push(x);
      } else if (plain++ < 200) kept.push(x);
    }
    this.write("runs.json", kept);
  }
  dropRun(runId: string) { this.write("runs.json", this.runs().filter((r) => r.run_id !== runId)); }
  /** A club's previews, gone: when someone else signs in to it on this computer, theirs aren't the new person's. */
  dropRuns(club: string, keep: (r: RunEntry) => boolean = () => false) { this.write("runs.json", this.runs().filter((r) => r.club !== club || keep(r))); }
  pending(device: string): unknown { return this.read<Record<string, unknown>>("pending.json", {})[device] ?? null; }
  setPending(device: string, v: unknown | null) {
    const p = this.read<Record<string, unknown>>("pending.json", {});
    if (v === null) delete p[device]; else p[device] = v;
    this.write("pending.json", p);
  }
}

// ---- The system keychain ----
// Linux: secret-tool (libsecret), with the secret on its standard input. A Mac: security, whose -w takes the secret
// as an argument (the process list shows it for that moment; set OPENPADEL_CLI_KEYCHAIN=0 to keep it in the file instead).
const has = (bin: string) => spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
function keychainSet(account: string, secret: string): boolean {
  try {
    if (process.platform === "linux" && has("secret-tool")) {
      const r = spawnSync("secret-tool", ["store", "--label", `Kumi: ${account}`, "service", "kumi", "club", account], { input: secret, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 });
      return r.status === 0 && keychainGet(account) === secret;
    }
    if (process.platform === "darwin") {
      execFileSync("security", ["add-generic-password", "-U", "-s", "kumi", "-a", account, "-w", secret], { stdio: "ignore", timeout: 5000 });
      return true;
    }
  } catch { /* no keychain to use: the file instead */ }
  return false;
}
function keychainGet(account: string): string | null {
  try {
    if (process.platform === "linux") return execFileSync("secret-tool", ["lookup", "service", "kumi", "club", account], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }) || null;
    if (process.platform === "darwin") return execFileSync("security", ["find-generic-password", "-s", "kumi", "-a", account, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || null;
  } catch { /* not there */ }
  return null;
}
function keychainDelete(account: string) {
  try {
    if (process.platform === "linux") spawnSync("secret-tool", ["clear", "service", "kumi", "club", account], { stdio: "ignore", timeout: 5000 });
    if (process.platform === "darwin") spawnSync("security", ["delete-generic-password", "-s", "kumi", "-a", account], { stdio: "ignore", timeout: 5000 });
  } catch { /* nothing to remove */ }
}
