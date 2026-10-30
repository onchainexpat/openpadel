import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// In development the Kumi server runs on 8790 and Vite proxies to it, so the session cookie and
// passkeys see one origin (start the server with KUMI_PUBLIC_URL=http://localhost:5173).
const api = "http://127.0.0.1:8790";
const proxied = ["/auth", "/me", "/my", "/club", "/actions", "/runs", "/changes", "/staff", "/oauth", "/.well-known", "/mcp", "/health", "/manifest"];
/** A path and what's under it, not every path that starts the same way ("/me" isn't "/membership"). */
const whole = (p: string) => `^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|\\?|$)`;
export default defineConfig({
  plugins: [preact()],
  server: { port: 5173, strictPort: true, proxy: Object.fromEntries(proxied.map((p) => [whole(p), { target: api, changeOrigin: false }])) },
  build: { target: "es2022" },
});
