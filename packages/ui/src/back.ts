// The phone's back button (and the browser's) closes what's open over the page, as an app's does, instead of leaving
// the page: an entry in the history while it's open, taken back off when it's closed another way. A link opened from
// inside it leaves its entry behind (one more press of Back comes back to the page, closed).
import { useEffect, useRef } from "preact/hooks";

export function useBackCloses(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open || typeof history === "undefined") return;
    const mark = Math.random().toString(36).slice(2);
    history.pushState({ ...(history.state ?? {}), kumiOpen: mark }, "");
    let popped = false;
    // Back pressed: the entry under ours is now current. Something opened over this one (its own entry) closes first.
    const onPop = () => { if (history.state?.kumiOpen !== mark) { popped = true; window.removeEventListener("popstate", onPop); latest.current(); } };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!popped && history.state?.kumiOpen === mark) history.back();
    };
  }, [open]);
}
