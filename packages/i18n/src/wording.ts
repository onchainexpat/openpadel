// Which keys an app's code can ask for, so the app ships only those. Two kinds of use count: a string that
// is a key ("ui.book"), and the fixed start of a template string, which takes every key it begins
// (`kind.${k}` takes kind.clinic, kind.social and the rest). wording.test.ts checks every t() call is one of these.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every .ts and .tsx file under these folders. */
export function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(p); }
      else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
    }
  };
  for (const d of dirs) walk(d);
  return out.sort();
}

const LITERAL = /(["'`])([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\1/g;   // "ui.book", 'kind.clinic'
const PREFIX = /`([a-z][a-z0-9_]*\.[a-z0-9_.]*)\$\{/g;            // `kind.${k}`, `ui.period_${p}`

/** The keys these files use, and each template prefix with how many keys it takes. */
export function keysUsed(files: string[], keys: readonly string[]): { keys: string[]; prefixes: Map<string, number> } {
  const known = new Set(keys), used = new Set<string>(), prefixes = new Map<string, number>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(LITERAL)) if (known.has(m[2]!)) used.add(m[2]!);
    for (const m of src.matchAll(PREFIX)) {
      const p = m[1]!, taken = keys.filter((k) => k.startsWith(p));
      for (const k of taken) used.add(k);
      prefixes.set(p, taken.length);
    }
  }
  return { keys: [...used].sort(), prefixes };
}
