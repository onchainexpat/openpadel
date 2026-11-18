// The club's installed plugins as Connectors cards (plugins.ts, connectors.ts): each one's status, health, keys and
// settings, what it may do and what it sends, its own cards for the Connectors page, with Set up, Pause or Turn back
// on, and Remove, each through the preview like every change. Installing is the club's agent's (openpadel plugin
// install), so the page gives the command to give it, and the catalog in words.
import { useEffect, useState } from "preact/hooks";
import { api, clubTime, lang, me, PluginCards, serverNow, t, type PluginCardData } from "@kumi/ui";
import { formatLocale } from "@kumi/i18n/format";

type Setting = { key: string; type: "string" | "integer" | "boolean" | "choice" | "courts"; label: string; help: string | null; required: boolean; default: unknown;
  choices?: { value: string; label: string }[] };
export type ConnectorStatus = "on" | "waiting" | "attention" | "off";
export type Plugin = { id: string; name: string; version: string; status: "waiting" | "on" | "paused" | "removed"; mode: "remote" | "local"; source: "catalog" | "url" | "file"; source_host: string | null;
  address: string | null; publisher: string; description: string; can: string; reads: string; events: string[]; sends: string; runs: string; cost: { charges: boolean; note: string };
  installed_at: string; installed_by: string | null; removed_at: string | null; registration_error: string | null; registration_problem: string | null; last_event_at: string | null; last_used_at: string | null;
  keys: { name: string; vault_name: string; label: string; where: string; added: boolean; last4: string | null }[]; settings: Setting[]; settings_values: Record<string, unknown>;
  health: { state: "ok" | "down" | "paused" | "waiting"; problem?: string; ms?: number } | null; connector_status: ConnectorStatus; cards: PluginCardData[] };
type Send = (action: string, input: unknown) => Promise<void>;

export const when = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
/** "2 min ago", "3 days ago": how long since, in the reader's language. */
export function ago(iso: string): string {
  const s = (Date.parse(iso) - serverNow()) / 1000, f = new Intl.RelativeTimeFormat(formatLocale(lang.value), { numeric: "auto", style: "short" });
  const a = Math.abs(s);
  return a < 60 ? f.format(Math.round(s), "second") : a < 3600 ? f.format(Math.round(s / 60), "minute") : a < 86400 ? f.format(Math.round(s / 3600), "hour") : f.format(Math.round(s / 86400), "day");
}
export const STATUS_WORDS: Record<ConnectorStatus, "ui.connector_on" | "ui.connector_waiting" | "ui.connector_attention" | "ui.connector_off"> =
  { on: "ui.connector_on", waiting: "ui.connector_waiting", attention: "ui.connector_attention", off: "ui.connector_off" };
/** The two letters on a connector's card. */
export const mono = (name: string) => name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).replace(/^./, (c) => c.toUpperCase());

/** One installed plugin, as the same kind of card as the built-in services. */
export function PluginConnector({ p, send }: { p: Plugin; send: Send }) {
  const [setting, setSetting] = useState(false);
  const needed = p.keys.filter((k) => !k.added);
  const health = [p.health?.state === "ok" ? t("ui.plugin_healthy", { ms: p.health.ms ?? 0 }) : p.health?.state === "down" ? t("ui.plugin_health_down", { error: p.health.problem ?? "" }) : null,
    p.last_event_at ? t("ui.plugin_last_event", { when: ago(p.last_event_at) }) : t("ui.plugin_no_event"),
    p.last_used_at ? t("ui.agents_last_used", { when: ago(p.last_used_at) }) : null].filter(Boolean).join(" · ").replace(/^./, (c) => c.toUpperCase());
  const owner = (me.value?.roles ?? []).some((r) => r.key === "owner");
  return (
    <li class={`card connector status-${p.connector_status}`} id={`plugin-${p.name}`}>
      <div class="connector-head">
        <span class="connector-mono" aria-hidden="true">{mono(p.name)}</span>
        <div><strong>{p.name}</strong><br /><span class="meta">{t("ui.connector_plugin_kind", { version: p.version, publisher: p.publisher })}</span></div>
        <span class={`pill pill-${p.connector_status === "on" ? "yes" : p.connector_status}`}>{p.status === "paused" ? t("ui.plugin_paused") : t(STATUS_WORDS[p.connector_status])}</span>
      </div>
      {p.source !== "catalog" && <p><span class="pill pill-paused">{t("ui.plugin_not_reviewed")}</span></p>}
      <p>{p.description}</p>
      <p class="meta">{health}</p>
      {p.status === "waiting" && p.registration_problem && <p class="meta">{t("ui.plugin_registration_error", { error: p.registration_problem })}</p>}
      {p.keys.length > 0 && <p class="meta">{t("ui.plugin_keys")}: {p.keys.map((k) => k.added ? t("ui.plugin_key_added", { name: k.name, last4: k.last4 ?? "" }) : t("ui.plugin_key_needed", { name: k.name })).join(" · ")}</p>}
      {needed.length > 0 && <p class="meta">{owner ? <a href="/vault">{t("ui.plugin_add_keys")}</a> : t("ui.plugin_keys_owner")}</p>}
      <PluginCards cards={p.cards} bare />
      <details><summary>{t("ui.plugin_what")}</summary>
        <p class="meta">{t("plan.plugin.row_able")}: {p.can}. {t("plan.plugin.row_reads")}: {p.reads}.{p.events.length ? ` ${t("plan.plugin.row_events")}: ${p.events.join(", ")}.` : ""}</p>
        <p class="meta">{t("plan.plugin.row_sends")}: {p.sends}</p>
        <p class="meta">{t("plan.plugin.row_runs")}: {p.runs}. {t("plan.plugin.row_cost")}: {p.cost.note}</p>
        {p.installed_by && <p class="meta">{t("ui.plugin_installed_by", { name: p.installed_by, when: clubTime(p.installed_at, { dateStyle: "medium" }) })}</p>}
      </details>
      {setting ? <Configure p={p} send={send} close={() => setSetting(false)} /> : <div class="connector-actions">
        {p.settings.length > 0 && <button class={p.connector_status === "attention" ? "primary" : undefined} onClick={() => setSetting(true)}>{t("ui.plugin_configure")}</button>}
        {p.status === "paused" ? <button onClick={() => send("plugin.resume", { plugin: p.name })}>{t("ui.plugin_resume")}</button>
          : <button onClick={() => send("plugin.pause", { plugin: p.name })}>{t("ui.plugin_pause")}</button>}
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

type CatalogItem = { name: string; publisher: string; version: string; description: string; mode: string; charges: boolean; installed: boolean };
type CatalogInfo = { words: { label: string; text: string }[]; installed: { version: string; status: string } | null };
/** Browse the catalog: each plugin with what it does and, opened, everything its install preview will say, and the
 *  command for the club's agent. Nothing installs from here: the agent previews it and the owner says yes. */
export function Catalog() {
  const [q, setQ] = useState(""), [list, setList] = useState<CatalogItem[] | null>(null), [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Record<string, CatalogInfo | "loading">>({});
  const search = (v: string) => { setQ(v); api<{ plugins: CatalogItem[] }>(`/staff/plugins/catalog?q=${encodeURIComponent(v)}`).then((r) => setList(r.plugins)).catch(() => setFailed(true)); };
  useEffect(() => { search(q); }, [lang.value]);
  const more = (name: string) => {
    if (open[name]) { const { [name]: _, ...rest } = open; setOpen(rest); return; }
    setOpen({ ...open, [name]: "loading" });
    api<CatalogInfo>(`/staff/plugins/catalog/${encodeURIComponent(name)}`).then((i) => setOpen((o) => ({ ...o, [name]: i }))).catch(() => setFailed(true));
  };
  return (
    <section class="card" id="catalog" aria-labelledby="catalog-title">
      <h2 id="catalog-title">{t("ui.connector_catalog")}</h2>
      <p class="meta">{t("ui.connector_catalog_intro")}</p>
      <label>{t("ui.connector_catalog_search")}<input type="search" value={q} onInput={(e) => search(e.currentTarget.value)} /></label>
      {failed && <p class="error">{t("ui.plugins_failed")}</p>}
      {list && !list.length && <p class="meta">{t("ui.connector_catalog_none")}</p>}
      <ul class="plain">{(list ?? []).map((p) => {
        const info = open[p.name];
        return <li class="row" key={p.name}>
          <div>
            <strong>{p.name}</strong> <span class="meta">{p.version} · {p.publisher} · {t(p.charges ? "ui.connector_charges" : "ui.connector_free")}</span>
            {p.installed && <> <span class="pill pill-yes">{t("ui.connector_installed")}</span></>}
            <p class="meta">{p.description}</p>
            {info && info !== "loading" && <>
              <dl class="plugin-card-rows">{info.words.map((w) => <div><dt>{w.label}</dt><dd>{w.text}</dd></div>)}</dl>
              {!p.installed && <p class="meta">{t("ui.connector_install_tell")} <code>openpadel plugin install --name {p.name}</code></p>}
            </>}
          </div>
          <button aria-expanded={Boolean(info)} onClick={() => more(p.name)}>{info ? t("ui.connector_less") : t("ui.connector_what_it_asks")}</button>
        </li>;
      })}</ul>
    </section>
  );
}
