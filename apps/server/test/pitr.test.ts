// Point-in-time backups (pitr.ts): pgBackRest's settings from the server's, when base backups are due, the minute a
// person asks for on the club's clock, and the scratch recovery run as the postgres user would (a pretend runner;
// the real thing ran against Postgres 17 and pgBackRest 2.60 in a container).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  basePlan, baseSlot, checkTarget, clubMinute, confOffsite, confRepos, extractAt, parseInfo, pgTime, pitrCipherPass, pitrConf, PitrRefused, restorableFrom, type ArchiveInfo, type Runner,
} from "../src/pitr.ts";
import { toArg } from "../src/pitr_cli.ts";

const key = randomBytes(32);
const offsite = { KUMI_OFFSITE_ENDPOINT: "https://abc123.r2.cloudflarestorage.com", KUMI_OFFSITE_BUCKET: "kestrel-backups", KUMI_OFFSITE_ACCESS_KEY_ID: "AKID", KUMI_OFFSITE_SECRET_ACCESS_KEY: "SECRET", KUMI_OFFSITE_REGION: "auto" };

test("pgBackRest's settings: this server's copy always, the offsite one beside the nightly copies, sealed with a key from the backup key", () => {
  const local = pitrConf({}, { backupKey: key });
  assert.deepEqual(local.repos, [{ n: 1, where: "local" }]);
  assert.equal(local.offsite, "off");
  assert.ok(!/repo2-/.test(local.text));
  const both = pitrConf(offsite, { backupKey: key });
  assert.deepEqual(both.repos.map((r) => r.where), ["local", "offsite"]);
  for (const want of ["repo2-type=s3", "repo2-path=/kumi/pitr", "repo2-s3-endpoint=abc123.r2.cloudflarestorage.com", "repo2-s3-bucket=kestrel-backups", "repo2-s3-uri-style=path",
    "repo2-cipher-type=aes-256-cbc", `repo2-cipher-pass=${pitrCipherPass(key)}`, "repo2-retention-full-type=time", "archive-async=y", "[kumi]", "pg1-path=/var/lib/postgresql/17/main"]) assert.ok(both.text.includes(want), want);
  assert.ok(!both.text.includes(key.toString("base64")), "the backup key itself is never in the file");
  assert.equal(pitrCipherPass(key), pitrCipherPass(Buffer.from(key)), "the same key always opens it");
  assert.deepEqual(confRepos(both.text), [1, 2]);
  assert.equal(confOffsite(both.text), "on");
  assert.ok(pitrConf({ ...offsite, KUMI_OFFSITE_PREFIX: "clubs/kestrel" }, { backupKey: key }).text.includes("repo2-path=/clubs/kestrel/pitr"));
  // One folder per Postgres cluster: a server set up again archives beside the one it replaced.
  assert.ok(pitrConf(offsite, { backupKey: key, systemId: "7703746194498146349" }).text.includes("repo2-path=/kumi/pitr/7703746194498146349"));
});

test("no offsite archive when its key can't delete (it expires its own old pieces), without the backup key, or over plain http", () => {
  assert.equal(pitrConf({ ...offsite, KUMI_OFFSITE_PRUNE: "0" }, { backupKey: key }).offsite, "no_prune");
  assert.equal(pitrConf(offsite, { backupKey: null }).offsite, "no_key");
  assert.equal(pitrConf({ ...offsite, KUMI_OFFSITE_ENDPOINT: "http://minio.local:9000" }, { backupKey: key }).offsite, "not_https");
  for (const env of [{ ...offsite, KUMI_OFFSITE_PRUNE: "0" }]) assert.deepEqual(confRepos(pitrConf(env, { backupKey: key }).text), [1]);
  assert.equal(confOffsite(pitrConf({ ...offsite, KUMI_OFFSITE_PRUNE: "0" }, { backupKey: key }).text), "no_prune");
});

// As pgBackRest 2.60 printed it (trimmed), for the container test's archive.
const INFO = JSON.stringify([{ archive: [{ id: "17-1", max: "000000010000000000000002", min: "000000010000000000000001" }],
  backup: [
    { database: { id: 1, "repo-key": 1 }, error: false, label: "20261103-011046F", timestamp: { start: 1793668246, stop: 1793668249 }, type: "full" },
    { database: { id: 1, "repo-key": 2 }, error: false, label: "20261103-011100F", timestamp: { start: 1793668260, stop: 1793668270 }, type: "full" },
    { database: { id: 1, "repo-key": 1 }, error: true, label: "20261104-033700D", timestamp: { start: 1793761020, stop: 1793761030 }, type: "diff" },
  ],
  name: "kumi", repo: [{ key: 1, status: { code: 0, message: "ok" } }, { key: 2, status: { code: 0, message: "ok" } }], status: { code: 0, message: "ok" } }]);

test("what the archive holds: each base backup and its copy, the broken ones left out, and how far back it reaches", () => {
  const info = parseInfo(INFO);
  assert.equal(info.status, "ok");
  assert.deepEqual(info.backups.map((b) => `${b.label}@${b.repo}`), ["20261103-011046F@1", "20261103-011100F@2"]);
  assert.equal(restorableFrom(info)!.toISOString(), "2026-11-03T01:10:49.000Z");
  assert.equal(restorableFrom(info, 2)!.toISOString(), "2026-11-03T01:11:10.000Z");
  assert.equal(parseInfo(INFO, "other").status, "no stanza");
});

test("base backups: a full one first, then the nightly differential after 3:37 club time, and a full one weekly", () => {
  const tz = "America/Los_Angeles", empty: ArchiveInfo = { status: "", backups: [], repos: [] };
  const at = (iso: string) => new Date(iso);
  assert.deepEqual(basePlan(empty, [1, 2], at("2026-11-03T12:00:00Z"), tz), [{ repo: 1, type: "full" }, { repo: 2, type: "full" }]);
  // A full one at 3:40 am on Nov 3 (11:40 UTC): nothing more that day; the next night a differential.
  const full = (repo: number, iso: string): ArchiveInfo["backups"][number] => ({ label: "F", type: "full", repo, start: at(iso), stop: at(iso) });
  const info: ArchiveInfo = { status: "ok", backups: [full(1, "2026-11-03T11:40:00Z")], repos: [] };
  assert.deepEqual(basePlan(info, [1], at("2026-11-03T20:00:00Z"), tz), []);
  assert.deepEqual(basePlan(info, [1], at("2026-11-04T11:38:00Z"), tz), [{ repo: 1, type: "diff" }]);
  assert.deepEqual(basePlan(info, [1], at("2026-11-04T11:30:00Z"), tz), [], "3:30 is before tonight's slot");
  assert.deepEqual(basePlan(info, [1], at("2026-11-10T11:38:00Z"), tz), [{ repo: 1, type: "full" }], "a week on, a full one");
  // The clock change on Nov 1 2026 (PDT to PST): 3:37 is 10:37 UTC before, 11:37 after.
  assert.equal(baseSlot(at("2026-11-01T12:00:00Z"), tz).toISOString(), "2026-11-01T11:37:00.000Z");
  assert.equal(baseSlot(at("2026-10-31T12:00:00Z"), tz).toISOString(), "2026-10-31T10:37:00.000Z");
});

test("the minute asked for is on the club's clock, and one that can't be gone back to is refused before anything runs", () => {
  const tz = "America/New_York";
  assert.equal(clubMinute("2026-11-03 14:05", tz).toISOString(), "2026-11-03T19:05:00.000Z");
  assert.equal(clubMinute("2026-11-03T14:05", tz).toISOString(), "2026-11-03T19:05:00.000Z");
  assert.equal(pgTime(new Date("2026-11-03T19:05:00Z")), "2026-11-03 19:05:00+00");
  const why = (f: () => unknown) => { try { f(); return "ran"; } catch (e) { return e instanceof PitrRefused ? e.why : (e as Error).message; } };
  assert.equal(why(() => clubMinute("yesterday at 2", tz)), "bad_time");
  assert.equal(why(() => clubMinute("2027-03-14 02:30", tz)), "no_such_minute", "the hour skipped when the clocks go forward");
  const info = parseInfo(INFO), now = new Date("2026-11-03T20:00:00Z");
  assert.equal(why(() => checkTarget(new Date("2026-11-03T19:59:30Z"), info, now, tz)), "too_recent");
  assert.equal(why(() => checkTarget(new Date("2026-11-02T12:00:00Z"), info, now, tz)), "too_old");
  assert.equal(why(() => checkTarget(new Date("2026-11-03T19:00:00Z"), { status: "", backups: [], repos: [] }, now, tz)), "no_base_backup");
  assert.equal(why(() => checkTarget(new Date("2026-11-03T19:00:00Z"), info, now, tz)), "ran");
  assert.equal(toArg(["restore", "--to=2026-11-03 14:05", "--yes"]), "2026-11-03 14:05");
  assert.equal(toArg(["restore", "--to", "2026-11-03 14:05", "--yes"]), "2026-11-03 14:05");
  assert.equal(toArg(["restore", "backup.dump", "--yes"]), undefined);
});

/** A pretend postgres user: every command written down, and Postgres replaying for one check before it opens. */
function pretend(o: { startFails?: string } = {}) {
  const calls: string[] = [], files = new Map<string, string>(), removed: string[] = [];
  let polls = 0;
  const runner: Runner = {
    async run(cmd, args) {
      calls.push(`${cmd.split("/").at(-1)} ${args.join(" ")}`);
      if (cmd.endsWith("pg_ctl") && args.at(-1) === "start" && o.startFails) return { code: 1, stdout: "", stderr: "failed" };
      if (cmd === "tail") return { code: 0, stdout: o.startFails ?? "", stderr: "" };
      if (cmd.endsWith("psql") && args.includes("SELECT pg_is_in_recovery()")) return polls++ ? { code: 0, stdout: "f\n", stderr: "" } : { code: 2, stdout: "", stderr: "starting up" };
      if (cmd.endsWith("psql")) return { code: 0, stdout: "2026-11-03 19:04:12+00\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    async write(path, text) { files.set(path, text); },
    async mkdir() {},
    async remove(path) { removed.push(path); },
  };
  return { runner, calls, files, removed };
}

test("going back to a minute: the archive recovered into a scratch folder up to it, the club's database dumped, the scratch removed", async () => {
  const p = pretend(), target = new Date("2026-11-03T19:05:00Z");
  const r = await extractAt(target, "kumi", "/var/lib/postgresql/at.dump", { runner: p.runner, base: "/var/lib/postgresql/17" });
  assert.equal(r.lastChange, "2026-11-03 19:04:12+00");
  const restore = p.calls.find((c) => c.startsWith("pgbackrest") && c.endsWith(" restore"))!;
  for (const want of ["--stanza=kumi", "--type=time", "--target=2026-11-03 19:05:00+00", "--target-action=promote", "--archive-mode=off", "--db-include=kumi", "--pg1-path=/var/lib/postgresql/17/kumi-pitr-"])
    assert.ok(restore.includes(want), `${want} in ${restore}`);
  const conf = [...p.files].find(([k]) => k.endsWith("/postgresql.conf"))![1];
  assert.match(conf, /listen_addresses = ''/);
  assert.match(conf, /archive_mode = off/);
  assert.match(conf, /hot_standby = off/);
  assert.equal([...p.files].find(([k]) => k.endsWith("/pg_hba.conf"))![1], "local all postgres peer\n");
  assert.ok(p.calls.some((c) => c.startsWith("pg_dump -Fc --no-owner --no-acl") && c.includes("-d kumi -f /var/lib/postgresql/at.dump")));
  assert.ok(p.calls.at(-1)!.startsWith("pg_ctl -D /var/lib/postgresql/17/kumi-pitr-") && p.calls.at(-1)!.includes("stop"));
  assert.equal(p.removed.length, 1);
  assert.match(p.removed[0]!, /kumi-pitr-[0-9a-f]{8}$/);
});

test("a minute the archive doesn't reach yet says so, and leaves no scratch copy behind", async () => {
  const p = pretend({ startFails: "LOG:  database system is starting up\nFATAL:  recovery ended before configured recovery target was reached\n" });
  await assert.rejects(extractAt(new Date("2026-11-03T19:05:00Z"), "kumi", "/x.dump", { runner: p.runner, base: "/b" }), /doesn't reach that minute yet/);
  assert.equal(p.removed.length, 1);
  assert.ok(!p.calls.some((c) => c.startsWith("pg_dump")));
});

test("setup turns archiving on once, and the units run as the postgres user", () => {
  const setup = readFileSync(new URL("../../../deploy/server-setup.sh", import.meta.url), "utf8");
  // pgBackRest refuses to back up unless archive_command has "pgbackrest" in it (its check, error 068): the trial's
  // first base backup failed on a wrapper named archive-wal.
  const command = /archive_command = '([^']*)'/.exec(setup)![1]!;
  assert.match(command, /pgbackrest/, "pgBackRest's check wants pgbackrest in archive_command");
  assert.match(setup, new RegExp(`cat > ${command.split(" ")[0]!.replace(/[/.-]/g, "\\$&")} <<'SH'\n[\\s\\S]*?exec pgbackrest --stanza=kumi archive-push "\\$1"`), "the wrapper it names is the one setup writes");
  for (const want of ["apt-get install -yq pgbackrest", "archive_mode = on", "archive_timeout = 60", 'systemctl "$pitr_apply" postgresql',
    "[ -f /etc/pgbackrest/pgbackrest.conf ] || exit 0",
    "kumi-pitr.timer", "kumi-pitr-test.timer", "User=postgres", "cli.ts pitr tick", "cli.ts pitr test --scheduled", "cli.ts pitr conf", "stanza-create", "pitr extract --out="]) assert.ok(setup.includes(want), want);
  const release = readFileSync(new URL("../../../deploy/release.sh", import.meta.url), "utf8");
  assert.ok(!/restart postgresql/.test(release), "an update never restarts Postgres");
});
