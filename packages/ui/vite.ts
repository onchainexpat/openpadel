// The start screen's drawing for "can't reach the club" (and a slow start), written into each app's index.html as a
// data: URL where it says KUMI_OFFLINE_ART. The picture travels inside the page itself (about 5.5 kB), so it shows
// whenever the page does: from the network, or with no connection from the copy the service worker put aside
// (offlineShell() below, sw/worker.js).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const OFFLINE_ART = "KUMI_OFFLINE_ART";

/** The drawing as a data: URL. */
export const offlineArtUrl = () => `data:image/webp;base64,${readFileSync(new URL("./assets/illustrations/offline.webp", import.meta.url)).toString("base64")}`;

/** Fills the page's KUMI_OFFLINE_ART in, in development and in the build alike. */
export function bootArt() {
  return { name: "kumi-boot-art", transformIndexHtml: { order: "pre" as const, handler: (html: string) => html.replaceAll(OFFLINE_ART, offlineArtUrl()) } };
}

// --- the start screen with no connection (sw/worker.js) ---

type ShellChunk = { type: "chunk"; fileName: string; isEntry: boolean; imports: string[]; facadeModuleId: string | null; viteMetadata?: { importedCss?: Set<string> } };
type ShellOutput = ShellChunk | { type: "asset"; fileName: string; source: string | Uint8Array };

/** What a page needs to start with no connection, as /assets/ paths: the entry code and everything it imports up front,
 *  their styles, and each language's first-screen wording (the start screen says "can't reach the club" in it). The
 *  pages loaded later, their wording and the illustrations aren't in it. */
export function shellFiles(bundle: Record<string, ShellOutput>): string[] {
  const chunks = Object.values(bundle).filter((c): c is ShellChunk => c.type === "chunk");
  const byFile = new Map(chunks.map((c) => [c.fileName, c])), out = new Set<string>();
  const add = (c: ShellChunk) => {
    if (out.has(c.fileName)) return;
    out.add(c.fileName);
    for (const css of c.viteMetadata?.importedCss ?? []) out.add(css);
    for (const i of c.imports) { const d = byFile.get(i); if (d) add(d); }
  };
  const firstWords = /^\0virtual:kumi-wording\/[a-z]+$/;
  for (const c of chunks) if (c.isEntry || (c.facadeModuleId && firstWords.test(c.facadeModuleId))) add(c);
  return [...out].map((f) => `/${f}`).sort();
}

/** The worker as served: the build's set (null while developing, when it only does notifications) above sw/worker.js. */
export const workerSource = (shell: { version: string; files: string[] } | null) =>
  `const SHELL = ${JSON.stringify(shell)};\n${readFileSync(new URL("./sw/worker.js", import.meta.url), "utf8")}`;

/** Writes each app's /sw.js: the worker with this build's set, under a version that changes with the page or any file
 *  in it. Fails the build if the page loads a file the set doesn't hold. While developing, /sw.js is the worker
 *  without a set. */
export function offlineShell() {
  return {
    name: "kumi-offline-shell",
    enforce: "post" as const,
    configureServer(server: { middlewares: { use(path: string, f: (req: unknown, res: { setHeader(k: string, v: string): void; end(b: string): void }) => void): void } }) {
      server.middlewares.use("/sw.js", (_req, res) => { res.setHeader("content-type", "text/javascript; charset=utf-8"); res.setHeader("cache-control", "no-cache"); res.end(workerSource(null)); });
    },
    generateBundle(this: { error(m: string): never; emitFile(f: { type: "asset"; fileName: string; source: string }): void }, _o: unknown, bundle: Record<string, ShellOutput>) {
      const page = bundle["index.html"];
      if (!page || page.type !== "asset") this.error("kumi-offline-shell: no index.html in the build");
      const html = typeof page.source === "string" ? page.source : Buffer.from(page.source).toString("utf8");
      const files = shellFiles(bundle);
      const loads = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((m) => m[1]!);
      const missing = loads.filter((f) => !files.includes(f));
      if (!loads.length || missing.length) this.error(`kumi-offline-shell: index.html loads ${missing.join(", ") || "nothing from /assets/"}, not in the offline set`);
      const version = createHash("sha256").update(html).update(files.join("\n")).update(workerSource(null)).digest("hex").slice(0, 12);
      this.emitFile({ type: "asset", fileName: "sw.js", source: workerSource({ version, files }) });
    },
  };
}
