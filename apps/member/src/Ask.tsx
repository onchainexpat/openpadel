// Asking the club: its common questions first, searched as the member types; what they still want to know
// goes to the staff as a thread, and the answer comes back in the app (and by email or push). A parent can
// ask about one of their juniors.
import { useEffect, useState } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { api, lang, me, t, usePreview, clubTime } from "@kumi/ui";
import { ForWhom } from "./ForWhom.tsx";

type Fact = { id: string; topic: string; question: string; answer: string };
type Status = "open" | "answered" | "closed";
type Mine = { id: string; status: Status; first: string; created_at: string; last_side: string | null; about: string | null };
type Thread = { id: string; status: Status; about: string | null; messages: { id: string; side: "member" | "staff" | "club"; body: string; at: string; author: string | null; fact: boolean }[] };

const when = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
const statusText = (s: Status) => t(s === "open" ? "ui.q_status_open" : s === "answered" ? "ui.q_status_answered" : "ui.q_status_closed");

function FactList({ facts }: { facts: Fact[] }) {
  return <ul class="plain facts">{facts.map((f) => <li key={f.id}><details><summary>{f.question}</summary><p class="pre">{f.answer}</p></details></li>)}</ul>;
}

export function Ask() {
  const { route } = useLocation();
  const [search, setSearch] = useState(""), [facts, setFacts] = useState<Fact[] | null>(null), [text, setText] = useState(""), [matches, setMatches] = useState<Fact[]>([]);
  const [mine, setMine] = useState<Mine[] | null>(null), [forId, setFor] = useState(me.value!.person.id);
  const loadMine = () => api<Mine[]>("/my/questions").then(setMine);
  const { preview, sheet } = usePreview((r?: { question_id?: string }) => { if (r?.question_id) route(`/ask/${r.question_id}`); else void loadMine(); });
  useEffect(() => { const id = setTimeout(() => { api<Fact[]>(`/my/facts?q=${encodeURIComponent(search)}`).then(setFacts); }, search ? 250 : 0); return () => clearTimeout(id); }, [search, lang.value]);
  useEffect(() => { void loadMine(); }, [lang.value]);
  // While they write a question, the common questions that might already answer it.
  useEffect(() => {
    const id = setTimeout(() => { if (text.trim().length > 3) api<Fact[]>(`/my/facts?q=${encodeURIComponent(text)}`).then((f) => setMatches(f.slice(0, 3))); else setMatches([]); }, 300);
    return () => clearTimeout(id);
  }, [text]);
  return (
    <main>
      <h1>{t("ui.ask_title")}</h1>
      {sheet}
      <section class="card">
        <h2>{t("ui.common_questions")}</h2>
        <label>{t("ui.search_questions")}<input type="search" value={search} onInput={(e) => setSearch(e.currentTarget.value)} /></label>
        {!facts ? <p class="meta">{t("ui.loading")}</p> : facts.length ? <FactList facts={facts} /> : <p class="meta">{t(search.trim() ? "ui.no_facts_match" : "ui.no_facts_yet")}</p>}
      </section>
      <section class="card card-form">
        <h2>{t("ui.ask_heading")}</h2>
        <ForWhom value={forId} onChange={setFor} />
        <label>{t("ui.your_question")}<textarea rows={4} maxLength={2000} value={text} onInput={(e) => setText(e.currentTarget.value)} /></label>
        {matches.length > 0 && <div class="note"><p>{t("ui.ask_these_first")}</p><FactList facts={matches} /></div>}
        <button class="primary" disabled={text.trim().length < 2} onClick={() => preview("question.ask", { person_id: forId, body: text.trim() })}>{t("ui.ask_send")}</button>
      </section>
      <section class="card">
        <h2>{t("ui.your_questions")}</h2>
        {!mine ? <p class="meta">{t("ui.loading")}</p> : !mine.length ? <p class="meta">{t("ui.no_questions")}</p>
          : <ul class="plain">{mine.map((q) => <li key={q.id} class="row"><span><a href={`/ask/${q.id}`}>{q.first}</a><br />
            <span class="meta">{when(q.created_at)}{q.about ? ` · ${t("ui.question_about", { name: q.about })}` : ""}</span></span>
            <span class={q.status === "answered" ? "badge" : q.status === "open" ? "badge warn" : "badge muted"}>{statusText(q.status)}</span></li>)}</ul>}
      </section>
    </main>
  );
}

export function AskThread() {
  const { params } = useRoute();
  const [d, setD] = useState<Thread | null>(null), [reply, setReply] = useState(""), [gone, setGone] = useState(false);
  const load = () => api<Thread>(`/my/questions/${params.id}`).then((x) => { setD(x); setReply(""); }).catch(() => setGone(true));
  const { preview, sheet } = usePreview(load);
  useEffect(() => { void load(); }, [params.id, lang.value]);
  if (gone) return <main class="card"><p>{t("ui.q_none")}</p><p><a href="/ask">{t("ui.all_questions")}</a></p></main>;
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const last = d.messages[d.messages.length - 1];
  return (
    <main>
      <p><a href="/ask">{t("ui.all_questions")}</a></p>
      <h1>{t("ui.ask_title")}</h1>
      {sheet}
      <section class="card">
        <p class="meta">{statusText(d.status)}{d.about ? ` · ${t("ui.question_about", { name: d.about })}` : ""}</p>
        <ul class="plain thread">{d.messages.map((m) => <li key={m.id} class={`msg ${m.side}`}>
          <p class="meta">{m.side === "club" ? t("ui.club_answer") : m.side === "member" ? (m.author === me.value?.person.display_name ? t("ui.question_you") : m.author) : m.author} · {when(m.at)}</p>
          <p class="pre">{m.body}</p></li>)}</ul>
        {last?.side === "club" && d.status === "answered" && <p><button onClick={() => preview("question.not_answered", { question_id: d.id })}>{t("ui.not_answered")}</button>{" "}
          <button onClick={() => preview("question.ask_person", { question_id: d.id })}>{t("ui.ask_person")}</button></p>}
      </section>
      <section class="card card-form">
        <label>{t("ui.your_reply")}<textarea rows={3} maxLength={2000} value={reply} onInput={(e) => setReply(e.currentTarget.value)} /></label>
        <button class="primary" disabled={reply.trim().length < 2} onClick={() => preview("question.reply", { question_id: d.id, body: reply.trim() })}>{t("ui.send_reply")}</button>{" "}
        {d.status !== "closed" && <button onClick={() => preview("question.close", { question_id: d.id })}>{t("ui.close_question")}</button>}
      </section>
    </main>
  );
}
