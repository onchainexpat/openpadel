// Players' chats as the staff see them (chat.ts): every chat with something in the last 30 days, a reported message
// first; in one, a hidden message's words too, who reported what, and the club's say: hide a message (or show it
// again), stop its author posting for a while, or let them post again. Each is in Changes.
import { useEffect, useState } from "preact/hooks";
import { useRoute } from "preact-iso";
import { Skeleton, ApiError, api, clubTime, lang, shortTime, t, usePreview } from "@kumi/ui";

type Row = { id: string; kind: "booking" | "session"; ref_id: string; title: string; starts_at: string; last_at: string; messages: number; reports: number };
type Message = { id: string; person_id: string; author: string; at: string; edited: boolean; state: "shown" | "removed" | "hidden"; body: string | null;
  author_stopped_until: string | null; reports: { by: string; at: string; reason: string | null }[] };
type Thread = { id: string; title: string; starts_at: string; people: string[]; messages: Message[] };

const gameWhen = (iso: string) => clubTime(iso, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function Chats() {
  const [rows, setRows] = useState<Row[] | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Row[]>("/staff/chats").then(setRows).catch((e) => setError(e instanceof ApiError ? e.message : String(e))); }, [lang.value]);
  if (error) return <main class="card"><p class="error">{error}</p></main>;
  if (!rows) return <Skeleton />;
  return (
    <main>
      <h1>{t("ui.staff_chats_title")}</h1>
      <section class="card">
        <p class="meta">{t("ui.staff_chats_intro")}</p>
        {!rows.length ? <p>{t("ui.staff_chats_none")}</p> : <ul class="plain">{rows.map((r) => <li key={r.id} class="row">
          <span><a href={`/chats/${r.id}`}>{r.title}</a><br /><span class="meta">{gameWhen(r.starts_at)} · {t("ui.staff_chat_messages", { count: r.messages })}</span></span>
          {r.reports > 0 && <span class="badge warn">{t("ui.staff_chat_reports", { count: r.reports })}</span>}
        </li>)}</ul>}
      </section>
    </main>
  );
}

export function ChatPage() {
  const { params } = useRoute();
  const [d, setD] = useState<Thread | null>(null), [error, setError] = useState<string | null>(null), [days, setDays] = useState<Record<string, number>>({});
  const load = () => api<Thread>(`/staff/chats/${params.id}`).then(setD).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  const { preview, sheet } = usePreview(() => { void load(); });
  useEffect(() => { void load(); }, [params.id, lang.value]);
  if (error) return <main class="card"><p class="error">{error}</p><p><a href="/chats">{t("ui.chat_back")}</a></p></main>;
  if (!d) return <Skeleton />;
  return (
    <main>
      <p><a href="/chats">{t("ui.chat_back")}</a></p>
      <h1>{d.title}</h1>
      {sheet}
      <section class="card">
        <p class="meta">{gameWhen(d.starts_at)}{d.people.length ? ` · ${t("ui.chat_people", { names: d.people.join(", ") })}` : ""}</p>
        {!d.messages.length ? <p>{t("ui.chat_empty_thread")}</p> : <ul class="plain thread">{d.messages.map((m) => <li key={m.id} class="msg other">
          <p class="meta"><a href={`/people/${m.person_id}`}>{m.author || t("ui.chat_a_player")}</a> · {shortTime(m.at)}{m.edited ? ` · ${t("ui.chat_edited")}` : ""}</p>
          {m.state === "removed" ? <p class="meta">{t("ui.chat_removed")}</p> : <p class="pre">{m.body}</p>}
          {m.state === "hidden" && <p class="meta">{t("ui.staff_chat_hidden_note")}</p>}
          {m.reports.map((r) => <p class="meta">{t("ui.staff_chat_reported_by", { name: r.by || t("ui.chat_a_player") })} · {shortTime(r.at)}{r.reason ? `: ${r.reason}` : ""}</p>)}
          {m.author_stopped_until && <p class="meta">{t("ui.staff_chat_stopped_until", { until: gameWhen(m.author_stopped_until) })}</p>}
          {m.state !== "removed" && <p>
            <button onClick={() => preview("chat.hide", { message_id: m.id, hidden: m.state !== "hidden" })}>{t(m.state === "hidden" ? "ui.staff_chat_show" : "ui.staff_chat_hide")}</button>{" "}
            {m.author_stopped_until
              ? <button onClick={() => preview("chat.allow", { person_id: m.person_id })}>{t("ui.staff_chat_allow")}</button>
              : <>
                <label class="inline">{t("ui.staff_chat_stop_days")} <select value={days[m.person_id] ?? 7} onChange={(e) => setDays({ ...days, [m.person_id]: Number(e.currentTarget.value) })}>
                  {[1, 3, 7, 14, 30, 90].map((n) => <option value={n}>{t("count.days", { count: n })}</option>)}</select></label>{" "}
                <button onClick={() => preview("chat.stop", { person_id: m.person_id, days: days[m.person_id] ?? 7 })}>{t("ui.staff_chat_stop")}</button>
              </>}
          </p>}
        </li>)}</ul>}
      </section>
    </main>
  );
}
