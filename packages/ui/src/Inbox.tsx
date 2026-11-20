// The in-app inbox: everything Kumi told this person, newest first. Opening it marks it all read.
import { useEffect, useState } from "preact/hooks";
import { Skeleton } from "./Skeleton.tsx";
import { Icon } from "./Icon.tsx";
import { EmptyState } from "./Illustration.tsx";
import { api, shortTime, t, unread } from "./state.ts";
/** A link to a file the server sends (a data download), not a page: the browser fetches it, the app's router doesn't take it. */
const isFile = (href: string) => /^\/my\/privacy\/export\/|\.(csv|ics|json|zip)(\?|$)/.test(href);

type M = { id: string; subject: string; body: string; link: string | null; created_at: string; read_at: string | null };

export function Inbox() {
  const [box, setBox] = useState<M[] | null>(null);
  useEffect(() => {
    api<{ messages: M[] }>("/my/inbox").then((r) => {
      setBox(r.messages);
      if (r.messages.some((m) => !m.read_at)) api("/my/inbox/read", {}).then(() => { unread.value = 0; }).catch(() => {});
    });
  }, []);
  if (!box) return <Skeleton />;
  return (
    <main>
      <h1>{t("ui.inbox_title")}</h1>
      {box.length === 0 && <EmptyState art="no-messages" size="s">{t("ui.inbox_empty")}</EmptyState>}
      {box.map((m) => (
        <section class={m.read_at ? "card" : "card unread"}>
          <p><strong>{m.subject}</strong> <span class="meta">{shortTime(m.created_at)}</span></p>
          <p>{m.body}</p>
          {/* "small": a thumb's 44 px on a touch screen (styles.css), and a plain link otherwise. */}
          {m.link && <p><a class="small" href={m.link} download={isFile(m.link) || undefined}>{t("ui.inbox_open")}</a></p>}
        </section>
      ))}
    </main>
  );
}

/** The nav link, with how many are unread. */
export function InboxLink({ current, icon }: { current?: "page"; icon?: boolean } = {}) {
  return <a href="/inbox" aria-current={current} aria-label={unread.value ? `${t("ui.nav_inbox")}, ${t("count.unread", { count: unread.value })}` : undefined}>
    {icon ? <><Icon name="inbox" /><span class="nav-word">{t("ui.nav_inbox")}</span></> : t("ui.nav_inbox")}{unread.value > 0 && <span class="badge">{unread.value}</span>}
  </a>;
}
