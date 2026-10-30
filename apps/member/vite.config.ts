import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// The members' app on 5174, proxying to the Kumi server on 8790 like the staff app does.
const api = "http://127.0.0.1:8790";
const proxied = ["/auth", "/me", "/club", "/actions", "/runs", "/open-programs", "/my", "/payments", "/dev", "/health", "/manifest", "/availability", "/booking-options", "/quote", "/bookings"];
export default defineConfig({
  plugins: [preact()],
  server: { port: 5174, strictPort: true, proxy: Object.fromEntries(proxied.map((p) => [p, { target: api, changeOrigin: false }])) },
  build: { target: "es2022" },
});
