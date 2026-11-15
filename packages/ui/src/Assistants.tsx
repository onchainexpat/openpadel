import { useEffect, useState } from "preact/hooks";
import { api, ApiError, lang, t, clubTime } from "./state.ts";
import { dollars } from "./Preview.tsx";

type A = { id: string; name: string; weekly_cap_cents: number; spent_cents: number; connected_at: string };
const CAPS = [0, 2500, 5000, 10000, 20000, 50000];

/** The assistants a person connected (the MCP door): what each spent this week against the limit they set,
 *  a new limit, or disconnecting it. Hidden when there are none. */
export function Assistants() {
  const [list, setList] = useState<A[] | null>(null), [cap, setCap] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<{ id: string; runId: string; summary: string } | null>(null), [error, setError] = useState<string | null>(null);
  const load = () => api<A[]>("/my/assistants").then(setList).catch(() => setList(null));
  useEffect(() => { void load(); }, []);
  const ask = async (id: string, action: "assistant.set_cap" | "assistant.disconnect", input: Record<string, unknown>) => {
    setError(null);
    try { const p = await api<{ run_id: string; summary: string }>(`/actions/${action}/plan`, { grant_id: id, ...input }); setPending({ id, runId: p.run_id, summary: p.summary }); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };
  const confirm = async () => {
    try { await api(`/runs/${pending!.runId}/apply`, {}, { "idempotency-key": pending!.runId }); setPending(null); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setPending(null); }
  };
  // Opened from the Wallet's "Change limit" (/profile#assistants): brought into view once it has loaded.
  useEffect(() => { if (list && location.hash === "#assistants") document.getElementById("assistants")?.scrollIntoView({ block: "start" }); }, [list !== null]);
  if (!list) return null;   // shown with none yet too: it says how to connect one
  return (
    <section class="card" id="assistants">
      <h2>{t("ui.assistants_title")}</h2>
      <p class="meta">{t("ui.assistants_hint")}</p>
      <p class="meta">{t("ui.assistants_how", { address: `${location.origin}/mcp` })}</p>
      {list.map((a) => {
        const want = cap[a.id] ?? a.weekly_cap_cents;
        return (
          <div>
            <p><strong>{a.name}</strong><br /><span class="meta">{t("ui.assistant_connected", { when: clubTime(a.connected_at, { dateStyle: "medium" }) })}. {t("ui.assistant_spent", { spent: dollars(a.spent_cents, lang.value), cap: dollars(a.weekly_cap_cents, lang.value) })}</span></p>
            <label>{t("ui.assistant_cap")}
              <select value={want} onChange={(e) => setCap({ ...cap, [a.id]: Number(e.currentTarget.value) })}>
                {[...new Set([...CAPS, a.weekly_cap_cents])].sort((x, y) => x - y).map((c) => <option value={c}>{c ? dollars(c, lang.value) : t("ui.assistant_cap_none")}</option>)}
              </select>
            </label>
            {pending?.id !== a.id && <p>
              <button disabled={want === a.weekly_cap_cents} onClick={() => ask(a.id, "assistant.set_cap", { weekly_cap_cents: want })}>{t("ui.assistant_change_cap")}</button>{" "}
              <button onClick={() => ask(a.id, "assistant.disconnect", {})}>{t("ui.assistant_disconnect")}</button>
            </p>}
            {pending?.id === a.id && <div class="sheet"><p>{pending.summary}</p><button type="button" class="primary" onClick={confirm}>{t("ui.confirm")}</button> <button type="button" onClick={() => setPending(null)}>{t("ui.back")}</button></div>}
          </div>
        );
      })}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}
