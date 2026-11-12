// Writes release.sh's read_gone and carry_gone (and, given kumi-hosted's checkout, its GONE in src/update.ts) from
// after_restore.ts, so the three run the same SQL byte for byte (gone_after_restore.test and kumi-hosted's in-step
// test check it). Run after changing GONE: `node tools/gen_gone.ts [path/to/kumi-hosted]`; `--check` only says
// whether release.sh is current (exit 1 if not).
import { readFileSync, writeFileSync } from "node:fs";
import { GONE, GONE_LIST, GONE_NEEDS, GONE_PARTS, GONE_PEOPLE_OLD, REVOKED } from "../apps/server/src/after_restore.ts";

const root = new URL("..", import.meta.url).pathname;
const check = process.argv.includes("--check"), hosted = process.argv.slice(2).find((a) => !a.startsWith("--"));
const name = (t: string) => /^CREATE TEMP TABLE (\w+)/.exec(t)![1]!;
const q = (s: string) => s.replace(/[\\"$`]/g, (m) => `\\${m}`);   // inside "..." in bash
const MARK = "INSERT INTO restore_check (since) SELECT coalesce((SELECT max(created_at) FROM payment), now() - interval '400 days')";

let read = `read_gone() {\n  local g=$1 t k c\n  # A database from before the queue (082) can't answer the people read: its deletions alone.\n`;
read += `  psql_kumi -c "COPY (${q(GONE.people.read)}) TO STDOUT" > "$g/people" 2>/dev/null || psql_kumi -c "COPY (${q(GONE_PEOPLE_OLD)}) TO STDOUT" > "$g/people" 2>/dev/null || : > "$g/people"\n`;
for (const p of GONE_PARTS.slice(1)) read += `  psql_kumi -c "COPY (${q(GONE[p].read)}) TO STDOUT" > "$g/${p}" 2>/dev/null || : > "$g/${p}"\n`;
read += `  while read -r t k c; do\n    psql_kumi -c "COPY (SELECT $k::text, $c FROM $t WHERE $c IS NOT NULL) TO STDOUT" > "$g/rev.$t.$c" 2>/dev/null || : > "$g/rev.$t.$c"\n  done <<< "$REVOKED"\n}\n`;
let carry = `carry_gone() {\n  local g=$1 t k c n failed=0 list\n  if [ -s "$g/people" ]; then\n    if has_column erase_after_restore deleted_by; then\n`;
carry += `      psql_kumi -c "${q(GONE.people.table)}" -c "COPY kumi_gone FROM STDIN" \\\n        -c "${q(GONE.people.apply)}" < "$g/people" || failed=1\n    else\n`;
carry += `      # A snapshot from before the queue: who came back, kept for the staff (0640, the kumi group) and said, to delete again by hand.\n      list="$BACKUPS/deleted-again-by-hand-$(date -u +%Y%m%dT%H%M%SZ).txt"\n`;
carry += `      (umask 027; psql_kumi -At -F ' ' -c "${q(GONE.people.table)}" -c "COPY kumi_gone FROM STDIN" \\\n        -c "${q(GONE_LIST)}" < "$g/people" | tr -d '\\000-\\010\\013-\\037\\177' > "$list") || failed=1\n      chgrp kumi "$list" 2>/dev/null || :\n`;
carry += `      n=$(grep -c . "$list" 2>/dev/null || echo 0)\n      if [ "\${n:-0}" -gt 0 ] 2>/dev/null; then\n        say "$n account(s) deleted since the snapshot are back in it, and this release can't delete them again by itself: delete them again in the staff app (Customers). They are (id, name, who deleted it), also in $list:"\n        while read -r line; do say "  $line"; done < "$list"\n      else rm -f "$list"; fi\n    fi\n  fi\n`;
for (const p of GONE_PARTS.slice(1)) carry += `  if [ -s "$g/${p}" ] && has_table ${GONE_NEEDS[p]}; then\n    psql_kumi -c "${q(GONE[p].table)}" -c "COPY ${name(GONE[p].table)} FROM STDIN" \\\n      -c "${q(GONE[p].apply)}" < "$g/${p}" || failed=1\n  fi\n`;
carry += `  while read -r t k c; do\n    [ -s "$g/rev.$t.$c" ] && has_column "$t" "$c" || continue\n    psql_kumi -c "CREATE TEMP TABLE kumi_rev (k text, at timestamptz)" -c "COPY kumi_rev FROM STDIN" \\\n      -c "UPDATE $t x SET $c = r.at FROM kumi_rev r WHERE x.$k::text = r.k AND x.$c IS NULL" < "$g/rev.$t.$c" || failed=1\n  done <<< "$REVOKED"\n`;
carry += `  # Card payments and refunds the provider has from after the snapshot: looked up when the server starts (payments_after_restore.ts).\n  if has_table restore_check; then psql_kumi -c "${q(MARK)}" || failed=1; fi\n`;
carry += `  # Every part is tried; any that failed is said by the caller.\n  return $failed\n}\n`;
const revoked = `REVOKED="${REVOKED.map((r) => r.join(" ")).join("\n")}"\n`;

const shPath = `${root}deploy/release.sh`, sh = readFileSync(shPath, "utf8");
const a = sh.indexOf("read_gone() {"), b = sh.indexOf("\n# Keep the running release");
const next = sh.slice(0, a) + read + carry + sh.slice(b);
if (check) { if (next !== sh) { console.error("release.sh's carry-over isn't current: run node tools/gen_gone.ts"); process.exit(1); } console.log("release.sh is current"); }
else writeFileSync(shPath, next);
if (!next.includes(revoked)) console.error(`release.sh's REVOKED list differs from after_restore.ts: update it by hand to\n${revoked}`);

if (hosted && !check) {
  const lit = (s: string) => JSON.stringify(s);
  let out = "export const GONE = {\n";
  for (const k of GONE_PARTS) out += `  ${k}: { read: ${lit(GONE[k].read)},\n    table: ${lit(GONE[k].table)},\n    apply: ${lit(GONE[k].apply)},\n    needs: ["${GONE_NEEDS[k]}"] },\n`;
  out += "} as const;\n";
  out += `/** A database from before the queue (Kumi's migration 082) can't answer GONE.people.read: its deletions alone. */\nexport const GONE_PEOPLE_OLD = ${lit(GONE_PEOPLE_OLD)};\n`;
  out += `/** A snapshot from before the queue: who came back (id, name, who deleted it), to be deleted again by hand. */\nexport const GONE_LIST = ${lit(GONE_LIST)};\n`;
  out += `/** After the carry: card payments and refunds the provider has from after the snapshot, looked up when the club's server starts. */\nexport const GONE_MARK = ${lit(MARK)};\n`;
  const p = `${hosted}/src/update.ts`;
  let s = readFileSync(p, "utf8");
  const x = s.indexOf("export const GONE = {"), y = s.indexOf("// \"$t $k $c\": the table, its key and the column ended or used");
  s = s.slice(0, x) + out + s.slice(y);
  writeFileSync(p, s);
  console.log(`wrote ${p}`);
}
