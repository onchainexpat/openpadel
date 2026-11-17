// The club's installed plugins, on Settings > Agents (plugins.ts): each one's status, health, keys and settings, what it
// may do and what it sends, with Set up, Pause or Turn back on, and Remove, each through the preview like every change.
// Installing is the club's agent's (openpadel plugin install), so here it's the command to give it. A later Connectors
// page (Round C) takes this list in.
import { useEffect, useState } from "preact/hooks";
import { api, clubTime, lang, t } from "@kumi/ui";

type Setting = { key: string; type: "string" | "integer" | "boolean" | "choice" | "courts"; label: string; help: string | null; required: boolean; default: unknown;
  choices?: { value: string; label: string }[] };
type Plugin = { id: string; name: string; version: string; status: "waiting" | "on" | "paused" | "removed"; mode: "remote" | "local"; source: "catalog" | "url" | "file"; source_host: string | null;
  address: string | null; publisher: string; description: string; can: string; reads: string; events: string[]; sends: string; runs: string; cost: { charges: boolean; note: string };
  installed_at: string; installed_by: string | null; removed_at: string | null; registration_error: string | null; last_event_at: string | null; last_used_at: string | null;
  keys: { name: string; vault_name: string; label: string; where: string; added: boolean; last4: string | null }[]; settings: Setting[]; settings_values: Record<string, unknown>;
  health: { state: "ok" | "down" | "paused" | "waiting"; error?: string; ms?: number } | null };
type Send = (action: string, input: unknown) => Promise<void>;

const when = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });

export function Plugins({ send, owner, n }: { send: Send; owner: boolean; n: number }) {
  const [list, setList] = useState<Plugin[] | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => { api<Plugin[]>("/staff/plugins").then(setList).catch(() => setFailed(true)); }, [lang.value, n]);
  const live = (list ?? []).filter((p) => p.status !== "removed"), gone = (list ?? []).filter((p) => p.status === "removed");
  return (
    <section class="card">
      <h2>{t("ui.plugins_title")}</h2>
      <p class="meta">{t("ui.plugins_intro")}</p>
      {failed && <p class="error">{t("ui.plugins_failed")}</p>}
      {!list && !failed && <p class="meta">{t("ui.loading")}</p>}
      {list && !live.length && <p class="meta">{t("ui.plugins_none")}</p>}
      <ul class="plain">{live.map((p) => <PluginRow key={p.id} p={p} send={send} />)}</ul>
      {gone.length > 0 && <details><summary>{t("ui.plugins_removed", { count: gone.length })}</summary>
        <ul class="plain">{gone.map((p) => <li class="meta">{p.name} {p.version} · {t("ui.plugin_removed_at", { when: when(p.removed_at!) })}</li>)}</ul></details>}
      <p class="meta">{t("ui.plugins_install_hint")} <code>openpadel plugin search</code>, <code>openpadel plugin install --name …</code></p>
      {!owner && <p class="meta">{t("ui.agent_manager_asks")}</p>}
    </section>
  );
}

function PluginRow({ p, send }: { p: Plugin; send: Send }) {
  const [setting, setSetting] = useState(false);
  const pill = p.status === "paused" ? "ui.plugin_paused" : p.status === "waiting" ? "ui.plugin_waiting" : p.health?.state === "down" ? "ui.plugin_down" : "ui.plugin_on";
  const needed = p.keys.filter((k) => !k.added);
  return (
    <li class="row">
      <div>
        <strong>{p.name}</strong> <span class="meta">{p.version} · {p.publisher}</span>{" "}
        <span class={`pill ${pill === "ui.plugin_on" ? "pill-yes" : "pill-paused"}`}>{t(pill)}</span>
        {p.source !== "catalog" && <> <span class="pill pill-paused">{t("ui.plugin_not_reviewed")}</span></>}
        <p class="meta">{p.description}</p>
        <p class="meta">{[p.health?.state === "ok" ? t("ui.plugin_healthy", { ms: p.health.ms ?? 0 }) : p.health?.state === "down" ? t("ui.plugin_health_down", { error: p.health.error ?? "" }) : null,
          p.last_event_at ? t("ui.plugin_last_event", { when: when(p.last_event_at) }) : null,
          p.last_used_at ? t("ui.agents_last_used", { when: when(p.last_used_at) }) : null,
          p.installed_by ? t("ui.plugin_installed_by", { name: p.installed_by, when: clubTime(p.installed_at, { dateStyle: "medium" }) }) : null].filter(Boolean).join(" · ")}</p>
        {p.status === "waiting" && p.registration_error && <p class="meta">{t("ui.plugin_registration_error", { error: p.registration_error })}</p>}
        {p.keys.length > 0 && <p class="meta">{t("ui.plugin_keys")}: {p.keys.map((k) => k.added ? t("ui.plugin_key_added", { name: k.name, last4: k.last4 ?? "" }) : t("ui.plugin_key_needed", { name: k.name })).join(" · ")}</p>}
        {needed.length > 0 && <p class="meta"><a href="/vault">{t("ui.plugin_add_keys")}</a></p>}
        <details><summary>{t("ui.plugin_what")}</summary>
          <p class="meta">{t("plan.plugin.row_able")}: {p.can}. {t("plan.plugin.row_reads")}: {p.reads}.{p.events.length ? ` ${t("plan.plugin.row_events")}: ${p.events.join(", ")}.` : ""}</p>
          <p class="meta">{t("plan.plugin.row_sends")}: {p.sends}</p>
          <p class="meta">{t("plan.plugin.row_runs")}: {p.runs}. {t("plan.plugin.row_cost")}: {p.cost.note}</p>
        </details>
        {setting && <Configure p={p} send={send} close={() => setSetting(false)} />}
      </div>
      {!setting && <div>
        {p.settings.length > 0 && <><button onClick={() => setSetting(true)}>{t("ui.plugin_configure")}</button>{" "}</>}
        {p.status === "paused" ? <button onClick={() => send("plugin.resume", { plugin: p.name })}>{t("ui.plugin_resume")}</button>
          : <button onClick={() => send("plugin.pause", { plugin: p.name })}>{t("ui.plugin_pause")}</button>}{" "}
        <button onClick={() => send("plugin.remove", { plugin: p.name })}>{t("ui.plugin_remove")}</button>
      </div>}
    </li>
  );
}

/** A form made from the manifest's settings; the server checks every value again and previews it. */
function Configure({ p, send, close }: { p: Plugin; send: Send; close: () => void }) {
  const shown = (s: Setting) => { const v = p.settings_values[s.key] ?? s.default; return Array.isArray(v) ? "" : v === undefined || v === null ? "" : v; };
  const [values, setValues] = useState<Record<string, unknown>>(Object.fromEntries(p.settings.map((s) => [s.key, shown(s)])));
  const set = (k: string, v: unknown) => setValues({ ...values, [k]: v });
  // Only what changed goes in the preview; courts are typed by name.
  const changed = () => Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== shown(p.settings.find((s) => s.key === k)!) && !(v === "" && p.settings.find((s) => s.key === k)!.type === "courts")));
  return (
    <div class="card-form">
      {p.settings.map((s) => (
        <label>{s.label}{s.required ? " *" : ""}
          {s.type === "boolean" ? <input type="checkbox" checked={values[s.key] === true} onChange={(e) => set(s.key, e.currentTarget.checked)} />
            : s.type === "choice" ? <select value={String(values[s.key] ?? "")} onChange={(e) => set(s.key, e.currentTarget.value)}>{(s.choices ?? []).map((c) => <option value={c.value}>{c.label}</option>)}</select>
            : <input value={String(values[s.key] ?? "")} inputMode={s.type === "integer" ? "numeric" : undefined} placeholder={s.type === "courts" ? t("ui.plugin_courts_hint") : undefined}
                onInput={(e) => set(s.key, e.currentTarget.value)} />}
          {s.help && <span class="meta">{s.help}</span>}
        </label>))}
      <p><button class="primary" disabled={!Object.keys(changed()).length} onClick={() => send("plugin.configure", { plugin: p.name, settings: changed() })}>{t("ui.preview")}</button>{" "}
        <button onClick={close}>{t("ui.back")}</button></p>
    </div>
  );
}
