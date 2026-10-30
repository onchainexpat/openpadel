import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { wording } from "../../packages/i18n/src/vite.ts";

// The members' app on 5174, proxying to the Kumi server on 8790 like the staff app does.
const api = "http://127.0.0.1:8790";
const proxied = ["/auth", "/me", "/club", "/actions", "/runs", "/open-programs", "/my", "/payments", "/dev", "/health", "/manifest", "/availability", "/booking-options", "/quote", "/bookings", "/membership-plans", "/open-matches", "/matches", "/public", "/calendar"];
/** A path and what's under it, not every path that starts the same way ("/me" isn't "/membership"). */
const whole = (p: string) => `^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|\\?|$)`;
export default defineConfig({
  // Only the wording this app uses, one language at a time; the build fails over the 200 kB speed budget.
  plugins: [preact(), wording({ dirs: [fileURLToPath(new URL("./src", import.meta.url)), fileURLToPath(new URL("../../packages/ui/src", import.meta.url))], budgetKB: 200 })],
  server: { port: 5174, strictPort: true, proxy: Object.fromEntries(proxied.map((p) => [whole(p), { target: api, changeOrigin: false }])) },
  build: { target: "es2022" },
});
