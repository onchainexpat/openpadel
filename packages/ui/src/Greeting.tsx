// The short welcome each app plays once, at someone's first sign-in there: the club's mark grows in on its colour,
// a drawing and "Welcome, Ana" rise under it, and it all fades to the app, in about a second. A tap or any key ends it at once.
// It's only CSS (transform and opacity, so a phone's compositor keeps it smooth); with less motion asked for it only
// fades. It never takes focus, and the page under it stays in reach of a screen reader, which hears the welcome once.
// Played is noted on the person (POST /me/greeted) as it starts, so it never plays again, on any phone.
import { useEffect, useState } from "preact/hooks";
import { api, club, me, t } from "./state.ts";
import { GREET_MS, greetFor, lessMotion } from "./greet.ts";
import { Illustration } from "./Illustration.tsx";

export function Greeting({ app: which }: { app: "member" | "staff" }) {
  const [{ play, note }] = useState(() => greetFor(which, me.value));
  const [on, setOn] = useState(play), [ending, setEnding] = useState(false), [said, setSaid] = useState(false);
  // The words go into the live region a frame after it's on the page, so a screen reader announces them.
  useEffect(() => { if (on) requestAnimationFrame(() => setSaid(true)); }, []);
  useEffect(() => {
    if (!note) return;
    if (me.value) me.value = { ...me.value, ...(which === "member" ? { greet_member: false } : { greet_staff: false }) };
    void api("/me/greeted", { app: which }).catch(() => undefined);   // offline: it may play once more, nothing worse
  }, []);
  useEffect(() => {
    if (!on) return;
    const skip = () => setEnding(true);
    addEventListener("keydown", skip);
    // Its own end (animationend), or this, whichever comes first: a hidden tab runs no animation.
    const done = setTimeout(() => setOn(false), (lessMotion() ? GREET_MS.still : GREET_MS.motion) + 300);
    return () => { removeEventListener("keydown", skip); clearTimeout(done); };
  }, [on]);
  if (!on) return null;
  const name = me.value?.person.display_name.trim().split(/\s+/)[0] ?? "";
  return (
    <div class={`greet${ending ? " greet-skip" : ""}`} onClick={() => setEnding(true)}
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) setOn(false); }}>
      <img class="greet-mark" src={club.value?.mark ?? "/manifest/mark.png"} alt="" width={192} height={192} />
      <Illustration name="welcome" tone="on-brand" class="greet-art" />
      <div role="status">{said && <>
        <p class="greet-title">{t(which === "staff" ? "ui.greet_staff" : "ui.greet_member", { name })}</p>
        <p class="greet-sub">{club.value?.name}</p>
      </>}</div>
    </div>
  );
}
