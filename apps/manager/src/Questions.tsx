// Members' questions, for front desk and up: the ones waiting first (the longest wait at the top), each a
// thread with who's asking (their membership and level). Staff answer, give a question to someone, close
// it, or turn an answer into a club fact. The club facts are the club's own answers: members see the
// switched-on ones as Common questions before they ask.
import { useEffect, useState } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { api, lang, t, usePreview, clubTime } from "@kumi/ui";

type Status = "open" | "answered" | "closed";
type Row = { id: string; status: Status; waiting_since: string | null; alerted_at: string | null; created_at: string; asker: string; about: string | null; assignee: string | null; first: string; last_side: string | null };
type Thread = { id: string; person_id: string; status: Status; asker: string; about: string; junior: boolean; assignee: string | null; assigned_to: string | null; waiting_since: string | null; alerted_at: string | null;
  membership: string | null; level: string | null; parents: string[]; desk: { id: string; name: string }[];
  messages: { id: string; side: "member" | "staff" | "club"; body: string; at: string; author: string | null; fact_id: string | null;
    kumi: { fact: string; by: string; confidence: number | null; corrected: "not_answered" | "wants_person" | null } | null }[] };
type Fact = { id: string; topic: string; question_en: string | null; answer_en: string | null; question_es: string | null; answer_es: string | null; active: boolean; public: boolean };

const TOPICS = ["general", "hours", "prices", "bookings", "memberships", "programs", "lessons", "juniors", "rules", "parking", "facilities"] as const;
const when = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
const VIEWS = [["waiting", "ui.q_waiting"], ["answered", "ui.q_answered"], ["closed", "ui.q_closed"]] as const;

export function Questions() {
  const { query } = useLocation();
  const view = (query.view as string) || "waiting";
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => { setRows(null); api<{ questions: Row[] }>(`/staff/questions?view=${encodeURIComponent(view)}`).then((r) => setRows(r.questions)); }, [view, lang.value]);
  return (
    <main>
      <h1>{t("ui.questions_title")}</h1>
      <p class="chips">{VIEWS.map(([v, k]) => <a class={v === view ? "chip on" : "chip"} href={`/questions?view=${v}`}>{t(k)}</a>)} <a href="/facts">{t("ui.club_facts")}</a></p>
      <section class="card">
        {!rows ? <p>{t("ui.loading")}</p> : !rows.length ? <p class="meta">{t("ui.q_none")}</p> : <ul class="plain">{rows.map((q) =>
          <li key={q.id} class="row"><span><a href={`/questions/${q.id}`}>{q.first}</a><br />
            <span class="meta">{q.about ? `${q.asker} (${t("ui.question_about", { name: q.about })})` : q.asker}
              {q.status === "open" && q.waiting_since ? ` · ${t("ui.q_waiting_since", { time: when(q.waiting_since) })}` : ` · ${when(q.created_at)}`}
              {q.assignee ? ` · ${t("ui.q_assigned", { name: q.assignee })}` : ""}{q.alerted_at && q.status === "open" ? ` · ${t("ui.q_alerted")}` : ""}</span></span></li>)}</ul>}
      </section>
    </main>
  );
}

export function QuestionPage() {
  const { params } = useRoute();
  const [d, setD] = useState<Thread | null>(null), [text, setText] = useState("");
  const load = () => api<Thread>(`/staff/questions/${params.id}`).then((x) => { setD(x); setText(""); });
  const { preview, sheet } = usePreview(load);
  useEffect(() => { void load(); }, [params.id, lang.value]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  return (
    <main>
      <p><a href="/questions">{t("ui.questions_title")}</a></p>
      {/* Who's asking, and (a parent asking about a junior) whom it's about, each linked to their page. */}
      <h1>{d.about === d.asker ? <a href={`/people/${d.person_id}`}>{d.asker}</a> : d.asker}</h1>
      {d.about !== d.asker && <p><a href={`/people/${d.person_id}`}>{t("ui.question_about", { name: d.about })}</a></p>}
      {sheet}
      <section class="card">
        <p class="meta">
          {d.membership ? t("ui.q_membership", { plan: d.membership }) : t("ui.q_no_membership")}
          {d.level ? ` · ${t("ui.q_level", { level: d.level })}` : ` · ${t("ui.no_level_yet")}`}
          {d.junior && d.parents.length ? ` · ${t("ui.q_junior_parents", { names: d.parents.join(", ") })}` : ""}
        </p>
        <ul class="plain thread">{d.messages.map((m) => <li key={m.id} class={`msg ${m.side}`}>
          <p class="meta">{m.side === "club" ? t("ui.club_answer") : m.author} · {when(m.at)}</p>
          <p class="pre">{m.body}</p>
          {/* Kumi sent this fact by itself: which one, how sure, and what the member said about it. */}
          {m.kumi && <p class="meta">{t("ui.kumi_picked", { fact: m.kumi.fact, sure: m.kumi.confidence === null ? "" : t("ui.kumi_sure", { pct: Math.round(m.kumi.confidence * 100) }) })}
            {m.kumi.corrected && <><br />{t(m.kumi.corrected === "not_answered" ? "ui.kumi_not_answered" : "ui.kumi_wants_person")}</>}</p>}
          {m.side === "staff" && <p><a class="small" href={`/facts?from=${d.id}&message=${m.id}`}>{t("ui.make_fact")}</a></p>}</li>)}</ul>
      </section>
      <section class="card card-form">
        <label>{t("ui.answer_label")}<textarea rows={4} maxLength={2000} value={text} onInput={(e) => setText(e.currentTarget.value)} /></label>
        <button class="primary" disabled={text.trim().length < 2} onClick={() => preview("question.answer", { question_id: d.id, body: text.trim() })}>{t("ui.send_answer")}</button>{" "}
        <button disabled={text.trim().length < 2} onClick={() => preview("question.answer", { question_id: d.id, body: text.trim(), close: true })}>{t("ui.send_and_close")}</button>{" "}
        {d.status !== "closed" && <button onClick={() => preview("question.close", { question_id: d.id })}>{t("ui.close_question")}</button>}
        <label>{t("ui.q_give_to")}<select value={d.assigned_to ?? ""} onChange={(e) => preview("question.assign", { question_id: d.id, to: e.currentTarget.value || null })}>
          <option value="">{t("ui.q_nobody")}</option>{d.desk.map((p) => <option value={p.id}>{p.name}</option>)}</select></label>
      </section>
    </main>
  );
}

type Form = { topic: string; question_en: string; answer_en: string; question_es: string; answer_es: string; public: boolean };
const blank: Form = { topic: "general", question_en: "", answer_en: "", question_es: "", answer_es: "", public: false };
const formOf = (f: Fact): Form => ({ topic: f.topic, question_en: f.question_en ?? "", answer_en: f.answer_en ?? "", question_es: f.question_es ?? "", answer_es: f.answer_es ?? "", public: f.public });

function FactForm({ start, onSend, from }: { start: Form; onSend: (f: Form) => void; from?: string }) {
  const [f, setF] = useState(start);
  const set = (k: keyof Form, v: string | boolean) => setF({ ...f, [k]: v });
  return (
    <form class="card-form" onSubmit={(e) => { e.preventDefault(); onSend(f); }}>
      {from && <p class="note">{t("ui.fact_from_question", { person: from })}</p>}
      <label>{t("ui.fact_topic")}<select value={f.topic} onChange={(e) => set("topic", e.currentTarget.value)}>{TOPICS.map((x) => <option value={x}>{t(`ui.topic_${x}`)}</option>)}</select></label>
      <label>{t("ui.fact_question_en")}<input value={f.question_en} maxLength={2000} onInput={(e) => set("question_en", e.currentTarget.value)} /></label>
      <label>{t("ui.fact_answer_en")}<textarea rows={3} maxLength={2000} value={f.answer_en} onInput={(e) => set("answer_en", e.currentTarget.value)} /></label>
      <label>{t("ui.fact_question_es")}<input value={f.question_es} maxLength={2000} onInput={(e) => set("question_es", e.currentTarget.value)} /></label>
      <label>{t("ui.fact_answer_es")}<textarea rows={3} maxLength={2000} value={f.answer_es} onInput={(e) => set("answer_es", e.currentTarget.value)} /></label>
      <label class="check"><input type="checkbox" checked={f.public} onChange={(e) => set("public", e.currentTarget.checked)} /> {t("ui.fact_public")}</label>
      <button class="primary">{t("ui.preview")}</button>
    </form>
  );
}

export function Facts() {
  const { query, route } = useLocation();
  const [facts, setFacts] = useState<Fact[] | null>(null), [editing, setEditing] = useState<string | null>(null), [prefill, setPrefill] = useState<{ form: Form; person: string; message: string } | null>(null), [key, setKey] = useState(0);
  const load = () => api<Fact[]>("/staff/facts").then((x) => { setFacts(x); setEditing(null); setKey((k) => k + 1); });
  const { preview, sheet } = usePreview(() => { if (prefill) { setPrefill(null); route("/facts", true); } void load(); });
  useEffect(() => { void load(); }, [lang.value]);
  // From a question: its first words as the question, the staff answer as the answer, in the reader's language.
  useEffect(() => {
    if (!query.from) return;
    api<Thread>(`/staff/questions/${query.from}`).then((q) => {
      const ask = q.messages.find((m) => m.side === "member")?.body ?? "", ans = q.messages.find((m) => m.id === query.message)?.body ?? "";
      const l = lang.value === "es" ? "es" : "en";
      setPrefill({ form: { ...blank, [`question_${l}`]: ask, [`answer_${l}`]: ans }, person: q.asker, message: String(query.message ?? "") });
    }).catch(() => {});
  }, [query.from, query.message]);
  const save = (id: string | null, start: Form) => (f: Form) => {
    const fields = { topic: f.topic, question_en: f.question_en || null, answer_en: f.answer_en || null, question_es: f.question_es || null, answer_es: f.answer_es || null, public: f.public };
    if (!id) return preview("fact.create", { ...fields, ...(prefill?.message ? { from_message_id: prefill.message } : {}) });
    const diff = Object.fromEntries(Object.entries(fields).filter(([k, v]) => (start as any)[k] !== (v ?? "")));
    return preview("fact.update", { fact_id: id, ...diff });
  };
  if (!facts) return <main class="card"><p>{t("ui.loading")}</p></main>;
  return (
    <main>
      <p><a href="/questions">{t("ui.questions_title")}</a></p>
      <h1>{t("ui.club_facts")}</h1>
      <p class="meta">{t("ui.facts_help")}</p>
      {sheet}
      <section class="card">
        <h2>{t("ui.new_fact")}</h2>
        <FactForm key={`new-${key}-${prefill ? "q" : ""}`} start={prefill?.form ?? blank} from={prefill?.person} onSend={save(null, blank)} />
      </section>
      {TOPICS.filter((x) => facts.some((f) => f.topic === x)).map((topic) => <section class="card" key={topic}>
        <h2>{t(`ui.topic_${topic}`)}</h2>
        <ul class="plain">{facts.filter((f) => f.topic === topic).map((f) => <li key={f.id}>
          <p><strong>{(lang.value === "es" ? f.question_es ?? f.question_en : f.question_en ?? f.question_es) ?? ""}</strong>
            {!f.active && <span class="badge muted">{t("ui.fact_hidden")}</span>}{f.public && f.active && <span class="badge">{t("ui.fact_on_public")}</span>}</p>
          <p class="pre meta">{(lang.value === "es" ? f.answer_es ?? f.answer_en : f.answer_en ?? f.answer_es) ?? ""}</p>
          <p><button class="small" onClick={() => setEditing(editing === f.id ? null : f.id)}>{t("ui.edit")}</button>{" "}
            <button class="small" onClick={() => preview("fact.update", { fact_id: f.id, active: !f.active })}>{t(f.active ? "ui.fact_hide" : "ui.fact_show")}</button></p>
          {editing === f.id && <FactForm key={`${f.id}-${key}`} start={formOf(f)} onSend={save(f.id, formOf(f))} />}
        </li>)}</ul>
      </section>)}
    </main>
  );
}
