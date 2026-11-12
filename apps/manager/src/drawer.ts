// Panels that open over or beside a page: the menu on a phone, the Schedule's side panel and its Create panel.
import { useEffect, useRef, useState } from "preact/hooks";

/** Below this width the menu and the Schedule's side panel open over the page instead of beside it. */
export const NARROW = "(max-width: 899px)";

/** Whether a media query matches now, kept up to date as the window changes. */
export function useMedia(query: string) {
  const [on, setOn] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia(query), change = () => setOn(mq.matches);
    change();
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, [query]);
  return on;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Escape closes the panel (not while a preview is open over it, nor when something inside used the key already).
 *  With `trap` (a panel over the page), focus moves into it when it opens, Tab and Shift+Tab stay inside it and the
 *  preview docked at the bottom, which opens over it, and focus goes back where it was when it closes. */
export function useDrawer<T extends HTMLElement>(open: boolean, onClose: () => void, trap: boolean) {
  const ref = useRef<T>(null), close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null, el = ref.current;
    if (trap && el) (el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented || document.querySelector(".dock .sheet")) return;
        // Beside the page (not over it), only from inside the panel: Escape elsewhere is the page's own.
        if (!trap && el && !el.contains(document.activeElement)) return;
        e.preventDefault(); close.current(); return;
      }
      if (!trap || e.key !== "Tab" || !el) return;
      const list = [...el.querySelectorAll<HTMLElement>(FOCUSABLE), ...document.querySelectorAll<HTMLElement>(`.dock ${FOCUSABLE.split(", ").join(", .dock ")}`)]
        .filter((x) => x.getClientRects().length > 0);
      if (!list.length) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); list.at(-1)!.focus(); }
      else if (!e.shiftKey && (at === -1 || at === list.length - 1)) { e.preventDefault(); list[0]!.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (trap && before && document.contains(before)) before.focus();
    };
  }, [open, trap]);
  return ref;
}
