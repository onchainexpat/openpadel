// The in-app inbox: everything Kumi told this person, newest first. Opening it marks it all read.
import { useEffect, useState } from "preact/hooks";
import { api, shortTime, t, unread } from "./state.ts";

type M = { id: string; subject: string; body: string; link: string | null; created_at: string; read_at: string | null };

export function Inbox() {
  const [box, setBox] = useState<M[] | null>(null);
  useEffect(() => {
    api<{ messages: M[] }>("/my/inbox").then((r) => {
      setBox(r.messages);
      if (r.messages.some((m) => !m.read_at)) api("/my/inbox/read", {}).then(() => { unread.value = 0; }).catch(() => {});
    });
  }, []);
  if (!box) return <main class="card"><p>{t("ui.loading")}</p></main>;
  return (
    <main>
      <h1>{t("ui.inbox_title")}</h1>
      {box.length === 0 && <section class="card"><p>{t("ui.inbox_empty")}</p></section>}
      {box.map((m) => (
        <section class={m.read_at ? "card" : "card unread"}>
          <p><strong>{m.subject}</strong> <span class="meta">{shortTime(m.created_at)}</span></p>
          <p>{m.body}</p>
          {m.link && <p><a href={m.link}>{t("ui.inbox_open")}</a></p>}
        </section>
      ))}
    </main>
  );
}

/** The nav link, with how many are unread. */
export function InboxLink() {
  return <a href="/inbox" aria-label={unread.value ? `${t("ui.nav_inbox")}, ${t("count.unread", { count: unread.value })}` : undefined}>
    {t("ui.nav_inbox")}{unread.value > 0 && <span class="badge">{unread.value}</span>}
  </a>;
}
