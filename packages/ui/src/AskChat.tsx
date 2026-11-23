// Ask openPadel (the server's assistant.ts): a conversation with the hosted assistant. Its changes come back as previews
// and open in the same sheet every change uses; only the person's Confirm there makes them happen. In the staff app it
// opens over any page (Ctrl+K); in the members' app it sits on the Ask tab, with "Ask a person" to hand what they asked
// to the front desk as a question to the club.
import { useEffect, useRef, useState } from "preact/hooks";
import { Skeleton } from "./Skeleton.tsx";
import { api, ApiError, club, clubTime, lang, me, t } from "./state.ts";
import { dollars, usePreview, type Pending } from "./Preview.tsx";
import type { AskStatus } from "./ask_status.ts";

type Preview = { run_id: string; status: Pending["status"]; action: string; input: unknown; summary: string; charge?: Pending["charge"]; rows?: Pending["rows"]; yeses_needed?: number };
type Turn = { role: "user" | "assistant"; text: string; previews?: Preview[] };

const pending = (p: Preview): Pending => ({ runId: p.run_id, status: p.status, summary: p.summary, action: p.action, input: p.input, charge: p.charge, rows: p.rows, yesesNeeded: p.yeses_needed });

export function AskChat({ surface, status: given, autoFocus }: { surface: "staff" | "member"; status?: AskStatus; autoFocus?: boolean }) {
  const [status, setStatus] = useState<AskStatus | null>(given ?? null), [chatId, setChatId] = useState<string | null>(null), [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const load = () => api<AskStatus>(`/assistant?app=${surface}`).then(setStatus).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  const { preview, sheet, show } = usePreview(() => void load());
  const box = useRef<HTMLTextAreaElement>(null), end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!given) void load(); }, [lang.value]);
  useEffect(() => { if (autoFocus) box.current?.focus(); }, [status !== null]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest" }); }, [turns.length, busy]);

  const send = async () => {
    const said = text.trim();
    if (!said || busy) return;
    setError(null); setBusy(true); setTurns((x) => [...x, { role: "user", text: said }]); setText("");
    try {
      const r = await api<{ chat_id: string; text: string; previews: Preview[] }>("/assistant/turn", { app: surface, chat_id: chatId, text: said });
      setChatId(r.chat_id);
      setTurns((x) => [...x, { role: "assistant", text: r.text, previews: r.previews }]);
      // The first change it set up opens straight away, as any change's preview does.
      if (r.previews[0]) show(pending(r.previews[0]));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setTurns((x) => x.slice(0, -1)); setText(said);
    } finally { setBusy(false); box.current?.focus(); }
  };
  const open = async (id: string) => {
    setError(null);
    try {
      const c = await api<{ id: string; turns: Turn[] }>(`/assistant/chats/${id}`);
      setChatId(c.id); setTurns(c.turns);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };
  const fresh = () => { setChatId(null); setTurns([]); setError(null); box.current?.focus(); };
  const turnOn = async () => { await api("/assistant/turn-on", {}); await load(); };
  // "Ask a person": what they asked here goes to the front desk, as a question to the club (previewed like any).
  const handOff = () => {
    const said = turns.filter((x) => x.role === "user").map((x) => `- ${x.text}`).join("\n");
    const body = [...t("ui.assistant_handoff", { said })].slice(0, 2000).join("");
    void preview("question.ask", { person_id: me.value!.person.id, body });
  };

  if (!status) return error ? <p class="error" role="alert">{error}</p> : <Skeleton shape="rows" rows={2} />;
  if (!status.on) return surface === "staff" ? <p class="meta">{t("ui.assistant_off_staff")}</p> : null;
  if (status.turned_off) return <p>{t("ui.assistant_turned_off")} <button type="button" onClick={turnOn}>{t("ui.assistant_turn_on")}</button></p>;
  const cap = status.spending.weekly_cap_cents;
  return (
    <div class="ask-chat">
      {sheet}
      <p class="meta">{surface === "staff" ? t("ui.assistant_acts_staff")
        : cap ? t("ui.assistant_acts_member", { cap: dollars(cap, lang.value), spent: dollars(status.spending.spent_cents, lang.value) }) : t("ui.assistant_acts_member_none")}
        {surface === "member" && <> <a href="/profile#assistants">{t("ui.assistant_change_limit")}</a></>}</p>
      {status.paused && <p class="note" role="status">{t("assistant.usage_paused")}</p>}
      <ul class="plain thread" aria-live="polite">
        {turns.map((x) => <li class={`msg ${x.role === "user" ? "mine" : "other"}`}>
          <p class="meta">{x.role === "user" ? t("ui.assistant_you") : surface === "staff" ? t("ui.assistant_title") : club.value?.assistant_name || t("ui.assistant_club_title")}</p>
          <p class="pre">{x.text}</p>
          {x.previews?.map((p) => <p><button type="button" class="small" onClick={() => show(pending(p))}>{t("ui.assistant_review")}</button> <span class="meta">{p.summary}</span></p>)}
        </li>)}
        {busy && <li class="msg other"><p class="meta" role="status">{t("ui.assistant_thinking")}</p></li>}
      </ul>
      <div ref={end} />
      <label>{t("ui.assistant_your_message")}
        <textarea ref={box} rows={2} maxLength={2000} value={text} placeholder={t(surface === "staff" ? "ui.assistant_placeholder_staff" : "ui.assistant_placeholder_member")}
          onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } }} /></label>
      <p>
        <button type="button" class="primary" disabled={busy || !text.trim()} onClick={send}>{t("ui.assistant_send")}</button>{" "}
        {turns.length > 0 && <button type="button" onClick={fresh}>{t("ui.assistant_new")}</button>}{" "}
        {surface === "member" && turns.some((x) => x.role === "user") && <button type="button" title={t("ui.assistant_ask_person_hint")} onClick={handOff}>{t("ui.ask_person")}</button>}
      </p>
      {error && <p class="error" role="alert">{error}</p>}
      {status.chats.length > 0 && <details>
        <summary>{t("ui.assistant_history")}</summary>
        <ul class="plain">{status.chats.map((c) => <li class="row" key={c.id}>
          <span><button type="button" class="link" onClick={() => open(c.id)}>{c.title}</button><br /><span class="meta">{clubTime(c.updated_at, { dateStyle: "medium", timeStyle: "short" })}</span></span>
          <button type="button" class="small" onClick={() => { if (c.id === chatId) fresh(); void preview("assistant.chat_delete", { chat_id: c.id }); }}>{t("ui.assistant_delete")}</button>
        </li>)}</ul>
        <p class="meta">{t("ui.assistant_kept")} <button type="button" class="link" onClick={() => { fresh(); void preview("assistant.chat_delete", {}); }}>{t("ui.assistant_delete_all")}</button></p>
      </details>}
    </div>
  );
}
