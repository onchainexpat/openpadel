// The start screen's drawing for "can't reach the club" (and a slow start), written into each app's index.html as a
// data: URL where it says KUMI_OFFLINE_ART. With no connection nothing else can load, and the service worker is only
// there for people who turned on notifications, so the picture travels inside the page itself (about 5.5 kB).
import { readFileSync } from "node:fs";

export const OFFLINE_ART = "KUMI_OFFLINE_ART";

/** The drawing as a data: URL. */
export const offlineArtUrl = () => `data:image/webp;base64,${readFileSync(new URL("./assets/illustrations/offline.webp", import.meta.url)).toString("base64")}`;

/** Fills the page's KUMI_OFFLINE_ART in, in development and in the build alike. */
export function bootArt() {
  return { name: "kumi-boot-art", transformIndexHtml: { order: "pre" as const, handler: (html: string) => html.replaceAll(OFFLINE_ART, offlineArtUrl()) } };
}
