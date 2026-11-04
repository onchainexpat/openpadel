// Which keys an app's code can ask for, so the app ships only those. Two kinds of use count: a string that
// is a key ("ui.book"), and the fixed start of a template string, which takes every key it begins
// (`kind.${k}` takes kind.clinic, kind.social and the rest). wording.test.ts checks every t() call is one of these.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

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

// `import ... from "x"`, `import "x"` and `export ... from "x"` at the start of a line, types included (a type's keys
// are cheap to ship, and a union of keys can come in that way); `import("x")` isn't one.
const STATIC = /^\s*(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/gm;

/** The file an import names, if it's one of ours (.ts or .tsx): a path from this file, or a package by its exports. */
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) { try { return createRequire(from).resolve(spec); } catch { return null; } }
  const base = resolve(dirname(from), spec);
  for (const f of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (/\.tsx?$/.test(f) && existsSync(f) && statSync(f).isFile()) return f;
  return null;
}

/** The files under these folders that load with the app's first screen: the entry and everything it imports, and
 *  so on, but not what's only imported with import() (the pages loaded when they're first opened). */
export function firstScreenFiles(entry: string, dirs: string[]): string[] {
  // Real paths throughout: a package resolves to its real folder, which a linked checkout's dirs may not spell the same.
  const real = dirs.map((d) => `${realpathSync(d)}/`), seen = new Set<string>(), todo = [realpathSync(entry)];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(STATIC)) {
      const found = resolveImport(f, m[1]!), to = found && realpathSync(found);
      if (to && /\.tsx?$/.test(to) && real.some((d) => to.startsWith(d))) todo.push(to);
    }
  }
  return [...seen].sort();
}
