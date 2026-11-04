// The apps' wording, as Vite modules: `virtual:kumi-wording/en` and `/es` hold only the keys the app's own
// code uses (wording.ts finds them), and each loads when that language is needed. Each comes in two parts: the
// first screen's keys, and `/en/rest` with the keys only the pages loaded later use, fetched after the first
// screen. The build also checks what loads before the first screen (the app's code and one language's first
// part) against the app's budget.
import { en } from "./en.ts";
import { es } from "./es.ts";
import { LANGS, type Lang } from "./format.ts";
import { firstScreenFiles, keysUsed, sourceFiles } from "./wording.ts";

const ID = "virtual:kumi-wording/";
const catalogs: Record<Lang, Record<string, unknown>> = { en, es };

type Chunk = { type: "chunk"; fileName: string; code: string; isEntry: boolean; imports: string[]; facadeModuleId: string | null };
type Output = Chunk | { type: "asset" };
type DevServer = { moduleGraph: { getModuleById(id: string): unknown; invalidateModule(m: unknown): void }; ws: { send(p: { type: "full-reload" }): void } };

/** dirs: the folders of the app's code (its own and the shared ui). entry: the app's first file (src/main.tsx), whose
 *  imports make the first screen; without it every key comes first. budgetKB: the most, in kB of 1000 bytes. */
export function wording(o: { dirs: string[]; entry?: string; budgetKB?: number }) {
  const parts = () => {
    const all = Object.keys(en), keys = keysUsed(sourceFiles(o.dirs), all).keys;
    const first = new Set(o.entry ? keysUsed(firstScreenFiles(o.entry, o.dirs), all).keys : keys);
    return { first: keys.filter((k) => first.has(k)), rest: keys.filter((k) => !first.has(k)) };
  };
  const signature = (p: ReturnType<typeof parts>) => `${p.first.join(",")}|${p.rest.join(",")}`;
  let shipped = "";
  return {
    name: "kumi-wording",
    resolveId(id: string) { return id.startsWith(ID) ? `\0${id}` : undefined; },
    load(this: { error(m: string): never }, id: string) {
      if (!id.startsWith(`\0${ID}`)) return undefined;
      const [lang, part = "first"] = id.slice(ID.length + 1).split("/") as [Lang, ("first" | "rest")?];
      if (!LANGS.includes(lang) || (part !== "first" && part !== "rest")) this.error(`No wording for "${id.slice(ID.length + 1)}"`);
      const p = parts();
      shipped = signature(p);
      return `export default ${JSON.stringify(Object.fromEntries(p[part].map((k) => [k, catalogs[lang][k]])))};`;
    },
    // While developing: code that starts using a new key gets it on the next load of the page.
    handleHotUpdate({ file, server }: { file: string; server: DevServer }) {
      if (!/\.tsx?$/.test(file) || !o.dirs.some((d) => file.startsWith(d)) || signature(parts()) === shipped) return undefined;
      for (const l of LANGS) for (const id of [`\0${ID}${l}`, `\0${ID}${l}/rest`]) { const m = server.moduleGraph.getModuleById(id); if (m) server.moduleGraph.invalidateModule(m); }
      server.ws.send({ type: "full-reload" });
      return [];
    },
    generateBundle(this: { error(m: string): never }, _options: unknown, bundle: Record<string, Output>) {
      const chunks = Object.values(bundle).filter((c): c is Chunk => c.type === "chunk");
      const byFile = new Map(chunks.map((c) => [c.fileName, c])), startup = new Set<Chunk>();
      const add = (c: Chunk) => { if (startup.has(c)) return; startup.add(c); for (const i of c.imports) { const d = byFile.get(i); if (d) add(d); } };
      for (const c of chunks) if (c.isEntry) add(c);
      const size = (c: Chunk) => Buffer.byteLength(c.code), kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;
      const code = [...startup].reduce((n, c) => n + size(c), 0);
      const words = chunks.filter((c) => c.facadeModuleId?.startsWith(`\0${ID}`)).map((c) => ({ name: c.facadeModuleId!.slice(ID.length + 1), bytes: size(c) }));
      const firsts = words.filter((w) => !w.name.endsWith("/rest")), rest = (lang: string) => words.find((w) => w.name === `${lang}/rest`);
      const first = code + Math.max(0, ...firsts.map((w) => w.bytes));
      console.log(`kumi-wording: ${kb(code)} of code + wording (${firsts.map((w) => `${w.name} ${kb(w.bytes)}${rest(w.name) ? `, ${kb(rest(w.name)!.bytes)} after` : ""}`).join("; ")}) = ${kb(first)} before the first screen${o.budgetKB ? `, budget ${o.budgetKB} kB` : ""}`);
      if (o.budgetKB && first > o.budgetKB * 1000) this.error(`The app loads ${kb(first)} of JavaScript before its first screen, over its ${o.budgetKB} kB budget.`);
    },
  };
}
