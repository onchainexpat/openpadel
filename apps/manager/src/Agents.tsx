// Agents, on the Connectors page (agents.ts, webhooks.ts): every agent and assistant connected to the club, and the
// club's webhooks. Club agents (an n8n workflow, a bot, a desk agent running all night) are the club's: made, changed
// and revoked here, each with a role that caps it and a weekly limit on the money its changes move. People's own
// assistants are listed with who connected them and can be disconnected. Installed plugins are the page's own cards
// (Plugins.tsx). The owner and managers read it; every change is previewed (a manager's asks wait for the owner).
import { useEffect, useState } from "preact/hooks";
import { api, clubTime, dollars, lang, t, usePreview } from "@kumi/ui";
import { amountInput, amountPattern, currencySign, parseAmount } from "@kumi/i18n/format";

type Agent = { id: string; name: string; role: string | null; role_name: string; can: string; created_by: string | null; created_at: string; revoked_at: string | null;
  last_used_at: string | null; token_last4: string | null; weekly_cap_cents: number; spent_cents: number; webhooks: number };
type Assistant = { id: string; name: string; person_id: string; person: string; roles: string[]; weekly_cap_cents: number; spent_cents: number; connected_at: string; last_used_at: string | null };
type Hook = { id: string; url: string; topics: string[]; secret_last4: string; created_at: string; paused_at: string | null; paused_why: string | null; failures: number;
  last_ok_at: string | null; last_error: string | null; agent_id: string | null; for: string; week: { sent: number; waiting: number; failed: number; dropped: number } };
type Data = { owner: boolean; agents: Agent[]; assistants: Assistant[]; webhooks: Hook[]; roles: { key: string; name: string }[]; max_cap_cents: number; topics: { topic: string; area: string }[] };
/** A secret shown once: an agent's token, or a webhook's signing secret. */
type Shown = { kind: "token" | "secret"; value: string; name: string };

const when = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
/** The limit as typed, in the club's currency and way of writing amounts (format.ts): its smallest unit, or NaN. */
const cents = (text: string) => (text.trim() ? parseAmount(text.trim()) ?? NaN : 0);

/** `onChange`: told after each change, so the page around it reads its own parts again. */
export function Agents({ onChange }: { onChange?: () => void }) {
  const [d, setD] = useState<Data | null>(null), [shown, setShown] = useState<Shown | null>(null);
  const load = () => api<Data>("/staff/agents").then(setD);
  // A token or a secret comes back once, with the change that made it: shown here until the page is left.
  const { preview, sheet } = usePreview((r?: { token?: string | null; secret?: string | null; name?: string }) => {
    if (r?.token) setShown({ kind: "token", value: r.token, name: r.name ?? "" });
    if (r?.secret) setShown({ kind: "secret", value: r.secret, name: "" });
    onChange?.();
    void load();
  });
  useEffect(() => { void load(); }, [lang.value]);
  if (!d) return <section class="card"><p>{t("ui.loading")}</p></section>;
  const live = d.agents.filter((a) => !a.revoked_at), gone = d.agents.filter((a) => a.revoked_at);
  return (
    <div id="agents">
      <h2>{t("ui.agents_title")}</h2>
      <p class="meta">{t("ui.agents_intro")}</p>
      {shown && <ShownOnce s={shown} close={() => setShown(null)} />}
      <section class="card">
        <h2>{t("ui.agents_club")}</h2>
        {!live.length && <p class="meta">{t("ui.agents_none")}</p>}
        <ul class="plain">{live.map((a) => <AgentRow key={a.id} a={a} d={d} send={preview} />)}</ul>
        {gone.length > 0 && <details><summary>{t("ui.agents_revoked", { count: gone.length })}</summary>
          <ul class="plain">{gone.map((a) => <li class="meta">{a.name} · {a.role_name} · {t("ui.agent_revoked_at", { when: when(a.revoked_at!) })}</li>)}</ul></details>}
      </section>
      <NewAgent d={d} send={preview} />
      <section class="card">
        <h2>{t("ui.agents_assistants")}</h2>
        <p class="meta">{t("ui.agents_assistants_hint", { address: `${location.origin}/mcp` })}</p>
        {!d.assistants.length && <p class="meta">{t("ui.agents_assistants_none")}</p>}
        <ul class="plain">{d.assistants.map((a) => (
          <li class="row">
            <div>
              <strong>{a.name || t("ui.agents_an_assistant")}</strong> <span class="meta">{t("ui.agents_connected_by", { name: a.person })}{a.roles.length ? ` (${a.roles.join(", ")})` : ""}</span>
              <p class="meta">{[t("ui.assistant_spent", { spent: dollars(a.spent_cents, lang.value), cap: dollars(a.weekly_cap_cents, lang.value) }),
                a.last_used_at ? t("ui.agents_last_used", { when: when(a.last_used_at) }) : t("ui.agents_never_used"), t("ui.assistant_connected", { when: clubTime(a.connected_at, { dateStyle: "medium" }) })].join(" · ")}</p>
            </div>
            <button onClick={() => preview("assistant.disconnect", { grant_id: a.id })}>{t("ui.assistant_disconnect")}</button>
          </li>))}</ul>
      </section>
      <section class="card">
        <h2>{t("ui.webhooks_title")}</h2>
        <p class="meta">{t("ui.webhooks_intro")}</p>
        {!d.webhooks.length && <p class="meta">{t("ui.webhooks_none")}</p>}
        <ul class="plain">{d.webhooks.map((h) => <HookRow key={h.id} h={h} send={preview} />)}</ul>
      </section>
      <NewHook d={d} send={preview} />
      {sheet}
    </div>
  );
}

function ShownOnce({ s, close }: { s: Shown; close: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(s.value).then(() => setCopied(true)).catch(() => {});
  return (
    <section class="card" role="status">
      <h2>{s.kind === "token" ? t("ui.agent_token_title", { name: s.name }) : t("ui.webhook_secret_title")}</h2>
      <p>{s.kind === "token" ? t("ui.agent_token_once") : t("ui.webhook_secret_once")}</p>
      <p><code style="word-break:break-all">{s.value}</code></p>
      <p><button onClick={copy}>{copied ? t("ui.copied") : t("ui.copy")}</button> <button onClick={close}>{t("ui.agent_token_kept")}</button></p>
      {s.kind === "token" && <>
        <p class="meta">{t("ui.agent_token_mcp", { address: `${location.origin}/mcp` })}</p>
        <p class="meta">{t("ui.agent_token_cli", { address: location.origin })}</p>
      </>}
      {s.kind === "secret" && <p class="meta">{t("ui.webhook_secret_how")}</p>}
    </section>
  );
}

function AgentRow({ a, d, send }: { a: Agent; d: Data; send: (action: string, input: unknown) => Promise<void> }) {
  const [editing, setEditing] = useState(false), [name, setName] = useState(a.name), [role, setRole] = useState(a.role ?? ""), [cap, setCap] = useState(amountInput(a.weekly_cap_cents));
  const change = () => Number.isFinite(cents(cap)) && send("agent.update", { agent_id: a.id, ...(name.trim() !== a.name ? { name: name.trim() } : {}), ...(role !== a.role ? { role } : {}),
    ...(cents(cap) !== a.weekly_cap_cents ? { weekly_cap_cents: cents(cap) } : {}) });
  return (
    <li class="row">
      <div>
        <strong>{a.name}</strong> <span class="pill pill-yes">{t("ui.agent_on")}</span> <span class="meta">{a.role_name}</span>
        <p class="meta">{[t("ui.agent_moved", { spent: dollars(a.spent_cents, lang.value), cap: dollars(a.weekly_cap_cents, lang.value) }),
          a.last_used_at ? t("ui.agents_last_used", { when: when(a.last_used_at) }) : t("ui.agents_never_used"),
          a.token_last4 ? t("ui.agent_token_ending", { last4: a.token_last4 }) : null, a.webhooks ? t("ui.agent_webhooks", { count: a.webhooks }) : null].filter(Boolean).join(" · ")}</p>
        <p class="meta">{a.created_by ? t("ui.agent_made_by", { name: a.created_by, when: clubTime(a.created_at, { dateStyle: "medium" }) }) : t("ui.agent_made", { when: clubTime(a.created_at, { dateStyle: "medium" }) })}</p>
        <details><summary>{t("ui.agent_can")}</summary><p class="meta">{a.can}</p></details>
        {editing && <div class="card-form">
          <label>{t("ui.agent_name")}<input value={name} maxLength={60} onInput={(e) => setName(e.currentTarget.value)} /></label>
          <label>{t("ui.agent_role")}<select value={role} onChange={(e) => setRole(e.currentTarget.value)}>{d.roles.map((r) => <option value={r.key}>{r.name}</option>)}</select></label>
          <label>{t("ui.agent_cap")} ({currencySign()})<input inputMode="decimal" pattern={amountPattern()} title={t("ui.amount_format")} value={cap} onInput={(e) => setCap(e.currentTarget.value)} /></label>
          <p><button class="primary" disabled={!name.trim()} onClick={change}>{t("ui.preview")}</button> <button onClick={() => setEditing(false)}>{t("ui.back")}</button></p>
        </div>}
      </div>
      {!editing && <div>
        <button onClick={() => setEditing(true)}>{t("ui.agent_change")}</button>{" "}
        <button onClick={() => send("agent.new_token", { agent_id: a.id })}>{t("ui.agent_new_token")}</button>{" "}
        <button onClick={() => send("agent.revoke", { agent_id: a.id })}>{t("ui.agent_revoke")}</button>
      </div>}
    </li>
  );
}

function NewAgent({ d, send }: { d: Data; send: (action: string, input: unknown) => Promise<void> }) {
  const [name, setName] = useState(""), [role, setRole] = useState(d.roles.find((r) => r.key === "front_desk")?.key ?? d.roles[0]?.key ?? ""), [cap, setCap] = useState("0");
  const c = cents(cap), ok = name.trim() && role && Number.isFinite(c) && c >= 0 && c <= d.max_cap_cents;
  return (
    <section class="card card-form">
      <h2>{t("ui.agent_new_title")}</h2>
      <p class="meta">{t("ui.agent_new_hint")}</p>
      <label>{t("ui.agent_name")}<input value={name} maxLength={60} placeholder={t("ui.agent_name_example")} onInput={(e) => setName(e.currentTarget.value)} /></label>
      <label>{t("ui.agent_role")}<select value={role} onChange={(e) => setRole(e.currentTarget.value)}>{d.roles.map((r) => <option value={r.key}>{r.name}</option>)}</select></label>
      <p class="meta">{t("ui.agent_role_hint")} <a href="/roles">{t("ui.roles_link")}</a></p>
      <label>{t("ui.agent_cap")} ({currencySign()})<input inputMode="decimal" pattern={amountPattern()} title={t("ui.amount_format")} value={cap} onInput={(e) => setCap(e.currentTarget.value)} /></label>
      <p class="meta">{t("ui.agent_cap_hint")}</p>
      {!d.owner && <p class="meta">{t("ui.agent_manager_asks")}</p>}
      <button class="primary" disabled={!ok} onClick={() => send("agent.create", { name: name.trim(), role, weekly_cap_cents: c })}>{t("ui.preview")}</button>
    </section>
  );
}

function HookRow({ h, send }: { h: Hook; send: (action: string, input: unknown) => Promise<void> }) {
  const status = h.paused_at ? "paused" : h.failures ? "failing" : "on";
  return (
    <li class="row">
      <div>
        <strong style="word-break:break-all">{h.url}</strong>{" "}
        <span class={`pill ${status === "on" ? "pill-yes" : "pill-paused"}`}>{t(status === "paused" ? "ui.webhook_paused" : status === "failing" ? "ui.webhook_failing" : "ui.webhook_on")}</span>
        <p class="meta">{t("ui.webhook_for", { name: h.for })} · {h.topics.join(", ")}</p>
        <p class="meta">{[t("ui.webhook_secret_ending", { last4: h.secret_last4 }), h.last_ok_at ? t("ui.webhook_last_ok", { when: when(h.last_ok_at) }) : t("ui.webhook_never_ok"),
          t("ui.webhook_week", { sent: h.week.sent, failed: h.week.failed + h.week.dropped })].join(" · ")}</p>
        {h.paused_at && <p class="meta">{t("ui.webhook_paused_at", { when: when(h.paused_at), why: h.paused_why ?? "" })}</p>}
        {!h.paused_at && h.last_error && <p class="meta">{t("ui.webhook_last_error", { error: h.last_error })}</p>}
      </div>
      <div>
        <button onClick={() => send("webhook.test", { subscription_id: h.id })}>{t("ui.webhook_test")}</button>{" "}
        {h.paused_at && <><button onClick={() => send("webhook.update", { subscription_id: h.id, resume: true })}>{t("ui.webhook_resume")}</button>{" "}</>}
        <button onClick={() => send("webhook.remove", { subscription_id: h.id })}>{t("ui.webhook_remove")}</button>
      </div>
    </li>
  );
}

function NewHook({ d, send }: { d: Data; send: (action: string, input: unknown) => Promise<void> }) {
  const live = d.agents.filter((a) => !a.revoked_at);
  const [url, setUrl] = useState(""), [forAgent, setFor] = useState(""), [topics, setTopics] = useState<string[]>([]);
  const areas = [...new Set(d.topics.map((x) => x.area))];
  const toggle = (topic: string, on: boolean) => setTopics(on ? [...topics, topic] : topics.filter((x) => x !== topic));
  return (
    <section class="card card-form">
      <h2>{t("ui.webhook_new_title")}</h2>
      <p class="meta">{t("ui.webhook_new_hint")}</p>
      <label>{t("ui.webhook_url")}<input type="url" value={url} placeholder="https://" onInput={(e) => setUrl(e.currentTarget.value)} /></label>
      <label>{t("ui.webhook_reads_as")}<select value={forAgent} onChange={(e) => setFor(e.currentTarget.value)}>
        <option value="">{t("ui.webhook_reads_as_me")}</option>
        {live.map((a) => <option value={a.id}>{a.name}</option>)}
      </select></label>
      <fieldset><legend>{t("ui.webhook_topics")}</legend>
        {areas.map((area) => <div><p class="meta">{area}</p>
          {d.topics.filter((x) => x.area === area).map((x) => <label class="check"><input type="checkbox" checked={topics.includes(x.topic)} onChange={(e) => toggle(x.topic, e.currentTarget.checked)} /> {x.topic}</label>)}
        </div>)}
      </fieldset>
      {!d.owner && <p class="meta">{t("ui.agent_manager_asks")}</p>}
      <button class="primary" disabled={!url.trim() || !topics.length} onClick={() => send("webhook.subscribe", { url: url.trim(), topics, ...(forAgent ? { agent_id: forAgent } : {}) })}>{t("ui.preview")}</button>
    </section>
  );
}
