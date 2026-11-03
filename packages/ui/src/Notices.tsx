import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { club, t } from "./state.ts";
import { noticesShown, whyNothingNew } from "./notices.ts";

const PHONE = "(max-width: 640px)";

/** The notices at the top of every page (read-only, moved, the day the club's Kumi ends, support access, a waiver to
 *  read), most important first. On a phone only the first shows, with how many more there are, so a page isn't
 *  pushed below the fold; one tap opens the rest. */
export function Notices({ items }: { items: (ComponentChildren | null | undefined | false | "")[] }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const q = matchMedia(PHONE), on = () => setPhone(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  const all = items.filter(Boolean).length;
  const { shown, more } = noticesShown(items, open, phone);
  if (!shown.length) return null;
  return (
    <div class="notices" role="status">
      {shown.map((n) => <p class="note banner">{n}</p>)}
      {more > 0 && <p class="banner-more"><button class="link" onClick={() => setOpen(true)}>{t("ui.banners_more", { count: more })}</button></p>}
      {open && phone && all > 1 && <p class="banner-more"><button class="link" onClick={() => setOpen(false)}>{t("ui.banners_fewer")}</button></p>}
    </div>
  );
}

/** A button that starts something new (a booking, a sign-up, a membership): while the club's app takes nothing new,
 *  why not, in its place, rather than a button that's refused after the tap. `quiet`: nothing in its place, for a
 *  button beside one that already says why. */
export function NewOnly({ children, quiet }: { children: ComponentChildren; quiet?: boolean }) {
  const why = whyNothingNew(club.value);
  if (!why) return <>{children}</>;
  return quiet ? null : <span class="meta">{t(why === "moved" ? "ui.not_here_moved" : "ui.not_while_read_only")}</span>;
}
