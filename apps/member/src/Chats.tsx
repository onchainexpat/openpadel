// Chats in the games a member plays in (chat.ts): the list, with what's unread, and one game's chat. Only the
// players in a game read its chat (and the club); juniors are told plainly why they see none.
import { useEffect, useRef, useState } from "preact/hooks";
import { useRoute } from "preact-iso";
import { ApiError, api, clubTime, lang, loadChatsUnread, shortTime, t, usePreview } from "@kumi/ui";

type Chat = { kind: "booking" | "session"; id: string; title: string; starts_at: string; unread: number; last_at: string | null; muted: boolean; can_post: boolean };
type List = { off: boolean; junior: boolean; chats: Chat[] };
type Message = { id: string; mine: boolean; author: string | null; at: string; edited: boolean; state: "shown" | "removed" | "hidden"; body: string | null;
  can_edit: boolean; can_remove: boolean; can_report: boolean; reported: boolean };
type Thread = { kind: Chat["kind"]; id: string; title: string; starts_at: string; people: string[]; players: number; can_post: boolean; cannot_post: string | null; muted: boolean;
  max_chars: number; messages: Message[] };

const gameWhen = (iso: string) => clubTime(iso, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Plain text, with web links as links (opened apart from the app, and never vouched for). */
function Words({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  return <p class="pre">{parts.map((p, i) => (i % 2 ? <a href={p} target="_blank" rel="noopener nofollow ugc">{p}</a> : p))}</p>;
}

export function Chats() {
  const [d, setD] = useState<List | null>(null);
  useEffect(() => { api<List>("/my/chats").then(setD).catch(() => setD({ off: false, junior: false, chats: [] })); }, [lang.value]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  return (
    <main>
      <h1>{t("ui.chats_title")}</h1>
      {d.off ? <section class="card"><p>{t("error.chat_off")}</p></section>
        : d.junior ? <section class="card"><p>{t("error.chat_junior")}</p></section>
        : <section class="card">
          <p class="meta">{t("ui.chats_intro")}</p>
          {!d.chats.length ? <p>{t("ui.chats_none")}</p>
            : <ul class="plain">{d.chats.map((c) => <li key={`${c.kind}:${c.id}`} class="row">
              <span><a href={`/chats/${c.kind}/${c.id}`}>{c.title}</a><br /><span class="meta">{gameWhen(c.starts_at)}{c.muted ? ` · ${t("ui.chat_muted")}` : ""}</span></span>
              {c.unread > 0 && <span class="badge" aria-label={t("count.unread", { count: c.unread })}>{c.unread}</span>}
            </li>)}</ul>}
        </section>}
    </main>
  );
}

export function ChatThread() {
  const { params } = useRoute();
  const [d, setD] = useState<Thread | null>(null), [error, setError] = useState<string | null>(null), [gone, setGone] = useState<string | null>(null);
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [editing, setEditing] = useState<{ id: string; text: string } | null>(null), [asking, setAsking] = useState<string | null>(null);
  const path = `/my/chats/${params.kind}/${params.id}`;
  const end = useRef<HTMLLIElement>(null);
  const load = () => api<Thread>(path).then((x) => {
    setD((before) => {
      // Read up to now, when something new shows (others' messages only count).
      if (!before || x.messages.length !== before.messages.length) void api(`${path}/seen`, {}).then(() => loadChatsUnread()).catch(() => {});
      return x;
    });
  }).catch((e) => setGone(e instanceof ApiError ? e.message : String(e)));
  const { preview, sheet } = usePreview(() => { void load(); });
  useEffect(() => { void load(); const id = setInterval(load, 10_000); return () => clearInterval(id); }, [path, lang.value]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [d?.messages.length]);
  if (gone) return <main class="card"><p>{gone}</p><p><a href="/chats">{t("ui.chat_back")}</a></p></main>;
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await f(); await load(); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); }
  };
  const send = () => act(async () => { await api(path, { body: text }); setText(""); });
  const save = () => act(async () => { await api(`/my/chats/messages/${editing!.id}/edit`, { body: editing!.text }); setEditing(null); });
  const remove = (id: string) => act(async () => { await api(`/my/chats/messages/${id}/remove`, {}); setAsking(null); });
  const mute = () => act(() => api(`${path}/mute`, { muted: !d.muted }));
  return (
    <main>
      <p><a href="/chats">{t("ui.chat_back")}</a></p>
      <h1>{d.title}</h1>
      {sheet}
      <section class="card">
        <p class="meta">{gameWhen(d.starts_at)}{d.kind === "session" && d.players ? ` · ${t("ui.chat_players", { count: d.players })}` : ""}{d.people.length ? ` · ${t("ui.chat_people", { names: d.people.join(", ") })}` : ""}</p>
        <p class="meta">{t("ui.chat_safety")}</p>
        <p><button onClick={mute} disabled={busy}>{t(d.muted ? "ui.chat_unmute" : "ui.chat_mute")}</button></p>
        {d.muted && <p class="meta">{t("ui.chat_mute_hint")}</p>}
        {!d.messages.length ? <p>{t("ui.chat_empty_thread")}</p> : <ul class="plain thread">{d.messages.map((m, i) => (
          <li key={m.id} ref={i === d.messages.length - 1 ? end : undefined} class={`msg ${m.mine ? "mine" : "other"}`}>
            <p class="meta">{m.mine ? t("ui.chat_you") : m.author} · {shortTime(m.at)}{m.edited ? ` · ${t("ui.chat_edited")}` : ""}</p>
            {m.state === "removed" ? <p class="meta">{t("ui.chat_removed")}</p> : m.state === "hidden" ? <p class="meta">{t("ui.chat_hidden")}</p>
              : editing?.id === m.id ? <>
                <textarea aria-label={t("ui.chat_write")} rows={3} maxLength={d.max_chars} value={editing.text} onInput={(e) => setEditing({ id: m.id, text: e.currentTarget.value })} />
                <p><button class="primary" disabled={busy || !editing.text.trim()} onClick={save}>{t("ui.chat_save")}</button> <button onClick={() => setEditing(null)}>{t("ui.chat_back_edit")}</button></p>
              </> : <Words text={m.body ?? ""} />}
            {asking === m.id ? <p>{t("ui.chat_remove_ask")} <button class="primary" disabled={busy} onClick={() => remove(m.id)}>{t("ui.chat_remove")}</button> <button onClick={() => setAsking(null)}>{t("ui.chat_back_edit")}</button></p>
              : editing?.id !== m.id && (m.can_edit || m.can_remove || m.can_report || m.reported) && <p>
                {m.can_edit && <button onClick={() => setEditing({ id: m.id, text: m.body ?? "" })}>{t("ui.chat_edit")}</button>}{" "}
                {m.can_remove && <button onClick={() => setAsking(m.id)}>{t("ui.chat_remove")}</button>}
                {m.can_report && <button onClick={() => preview("chat.report", { message_id: m.id })}>{t("ui.chat_report")}</button>}
                {m.reported && <span class="badge muted">{t("ui.chat_reported")}</span>}
              </p>}
          </li>))}</ul>}
      </section>
      <section class="card card-form">
        {d.can_post ? <>
          <label>{t("ui.chat_write")}<textarea rows={3} maxLength={d.max_chars} value={text} onInput={(e) => setText(e.currentTarget.value)} /></label>
          <button class="primary" disabled={busy || !text.trim()} onClick={send}>{t("ui.chat_send")}</button>
        </> : <p>{d.cannot_post}</p>}
        {error && <p class="error">{error}</p>}
      </section>
    </main>
  );
}
