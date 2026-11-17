import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { wording } from "../../packages/i18n/src/vite.ts";
import { bootArt, offlineShell } from "../../packages/ui/vite.ts";

// The members' app on 5174, proxying to the Kumi server on 8790 like the staff app does.
const api = "http://127.0.0.1:8790";
const proxied = ["/auth", "/me", "/club", "/actions", "/runs", "/assistant", "/plugins", "/open-programs", "/my", "/payments", "/dev", "/health", "/manifest", "/availability", "/booking-options", "/quote", "/bookings", "/membership-plans", "/open-matches", "/matches", "/public", "/calendar", "/unsubscribe"];
/** A path and what's under it, not every path that starts the same way ("/me" isn't "/membership"). */
const whole = (p: string) => `^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|\\?|$)`;
export default defineConfig({
  // Only the wording this app uses, one language at a time, the first screen's part first; the build fails over the 200 kB speed budget.
  plugins: [preact(), bootArt(), offlineShell(), wording({ dirs: [fileURLToPath(new URL("./src", import.meta.url)), fileURLToPath(new URL("../../packages/ui/src", import.meta.url))], entry: fileURLToPath(new URL("./src/main.tsx", import.meta.url)), budgetKB: 200 })],
  server: { port: 5174, strictPort: true, proxy: Object.fromEntries(proxied.map((p) => [whole(p), { target: api, changeOrigin: false }])) },
  build: { target: "es2022" },
});
