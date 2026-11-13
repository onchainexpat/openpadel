// The start screen each app shows while it starts (index.html's #boot): the club's mark on its colour, as the phone's
// own start screen has it, so the hand-off doesn't show. It never holds the app back: it goes the moment the app knows
// who's here (signed in or not) and can draw its first screen, with no minimum time. A slow start shows a quiet
// loading line, then (from index.html's own styles, even before this code arrives) a word about the connection and
// a link that tries again; an app that can't reach the club says so at once and keeps trying by itself (RETRY_MS, and
// when the phone is back online). Its colour and words come before the app does, from /manifest/boot.css; this puts the words in the
// reader's language.
import { effect } from "@preact/signals";
import { loadMe, me, t, unreachable } from "./state.ts";
import { lessMotion } from "./greet.ts";

/** Takes the start screen away: a short fade (none with less motion), then it's gone from the page. */
export function bootDone(): void {
  const el = document.getElementById("boot");
  if (!el || el.classList.contains("boot-gone")) return;
  if (lessMotion()) { el.remove(); return; }
  el.classList.add("boot-gone");
  const gone = () => el.remove();
  el.addEventListener("transitionend", gone, { once: true });
  setTimeout(gone, 400);   // no transition (a hidden tab): gone all the same
}

/** How long to wait before each try while the club can't be reached, in ms: soon, then less often. */
export const RETRY_MS = [3_000, 10_000, 30_000] as const;

/** Starts watching: the start screen's words in the reader's language, "can't reach the club" when that's so (and
 *  trying again by itself, sooner when the phone says it's back online), and gone once the first screen can draw.
 *  Call once, before the first render. */
export function startBoot(): void {
  const el = document.getElementById("boot");
  if (!el) return;
  const text = el.querySelector<HTMLElement>(".boot-late-text"), retry = el.querySelector<HTMLAnchorElement>(".boot-retry");
  let tries = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const again = () => { clearTimeout(timer); timer = undefined; void loadMe().then(() => { if (unreachable.peek()) later(); }); };
  const later = () => { if (!timer) timer = setTimeout(again, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]); };
  addEventListener("online", () => { if (unreachable.peek()) again(); });
  // Tries again without a reload when the app is already here; the link reloads when it isn't (no code yet).
  retry?.addEventListener("click", (e) => { if (unreachable.peek()) { e.preventDefault(); again(); } });
  effect(() => {
    const off = unreachable.value;
    if (text) text.textContent = t(off ? "ui.boot_offline" : "ui.boot_slow");
    if (retry) retry.textContent = t("ui.try_again");
    el.classList.toggle("boot-offline", off);
    if (off) later();
  });
  // The first screen draws in the same frame as `me` arrives; the start screen goes on the next one.
  effect(() => { if (me.value !== undefined) { clearTimeout(timer); requestAnimationFrame(() => bootDone()); } });
}
