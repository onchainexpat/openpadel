// Connectors (the WebConnectors board; connectors.ts on the server): everything the club plugs into, as one kind of
// card. The built-in services (Stripe, Resend, Twilio, Playtomic, offsite backups) are judged by `openpadel doctor`'s
// own checks; installed plugins by their health and keys (Plugins.tsx). Each says its status (on, waiting, needs
// attention, off), what it does and may see, its health, and what can be done, through the previews that already
// exist. Below them, the club's agents and people's assistants and webhooks (Agents.tsx). New things are connected by
// the club's agent: the page gives the words to give it, opens Ask openPadel, and shows the catalog in words. Never a
// secret: keys read "added, ends in 4F2A" or missing. For the owner and managers.
import { useEffect, useState } from "preact/hooks";
import { EmptyState, Skeleton, api, ApiError, lang, me, t, usePreview } from "@kumi/ui";
import { ServiceSettings, type ServiceFormSpec, type ServiceSetting } from "./ServiceForm.tsx";
import { Agents } from "./Agents.tsx";
import { Catalog, mono, PluginConnector, STATUS_WORDS, type ConnectorStatus, type Plugin } from "./Plugins.tsx";

type BuiltIn = { key: string; name: string; kind: string; does: string; sees: string | null; status: ConnectorStatus; health: string;
  checks: { id: string; state: string; status: ConnectorStatus; text: string; doc?: string }[]; settings: ServiceSetting[]; form: ServiceFormSpec; doc: string; page: string | null };
type View = { summary: Record<ConnectorStatus, number>; built_ins: BuiltIn[]; plugins: Plugin[]; ask: { commands: string[]; prompt: string } };

/** Opens Ask openPadel over the page (App.tsx listens). */
const openAsk = () => dispatchEvent(new Event("kumi:ask"));

/** Back from connecting a plugin (the club's /plugins/<name>/callback sends the browser here with ?plugin=&connected=):
 *  which plugin and whether it worked, read once and taken out of the address so a reload doesn't say it again. */
function backFromConnect(): { plugin: string; ok: boolean } | null {
  const q = new URLSearchParams(location.search), plugin = q.get("plugin"), connected = q.get("connected");
  if (!plugin || !/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(plugin) || (connected !== "0" && connected !== "1")) return null;
  q.delete("plugin"); q.delete("connected");
  history.replaceState(history.state, "", `${location.pathname}${q.toString() ? `?${q}` : ""}${location.hash}`);
  return { plugin, ok: connected === "1" };
}

/** Opened from `openpadel connect <service> --link`: the service whose form to open, once the server says the link
 *  is still good (15 minutes, the owner's). Taken out of the address straight away, so it isn't kept or shared. */
function linkFromAgent(): { service: string; token: string } | null {
  const q = new URLSearchParams(location.search), service = q.get("set"), token = q.get("link");
  if (!service || !token || !/^[a-z]{2,20}$/.test(service) || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  q.delete("set"); q.delete("link");
  history.replaceState(history.state, "", `${location.pathname}${q.toString() ? `?${q}` : ""}${location.hash}`);
  return { service, token };
}

export function Connectors() {
  const [back, setBack] = useState(backFromConnect);
  const [link] = useState(linkFromAgent), [opened, setOpened] = useState<string | null>(null), [linkGone, setLinkGone] = useState(false);
  useEffect(() => {
    if (!link) return;
    api<{ service: string }>(`/staff/connectors/link/${link.token}`).then((r) => setOpened(r.service)).catch((e) => setLinkGone(e instanceof ApiError));
  }, []);
  useEffect(() => { if (opened && v) document.getElementById(`connector-${opened}`)?.scrollIntoView(); }, [opened]);
  const [v, setV] = useState<View | null>(null), [failed, setFailed] = useState(false), [asking, setAsking] = useState(false), [browsing, setBrowsing] = useState(false);
  const load = (fresh = false) => api<View>(`/staff/connectors${fresh ? "?fresh=1" : ""}`).then((x) => { setV(x); setFailed(false); }).catch(() => setFailed(true));
  const { preview, sheet } = usePreview(() => { void load(); });
  useEffect(() => { void load(); }, [lang.value]);
  // Opened from an old address (/agents) or a link to a part of it: there once it's drawn.
  useEffect(() => { if (v && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView(); }, [Boolean(v)]);
  const order: ConnectorStatus[] = ["on", "attention", "waiting", "off"];
  return (
    <main class="wide">
      <h1>{t("ui.connectors_title")}</h1>
      <p class="meta">{t("ui.connectors_intro")}</p>
      {back && <p class={`note banner${back.ok ? "" : " error"}`} role="status">
        {t(back.ok ? "ui.connectors_connected" : "ui.connectors_not_connected", { plugin: back.plugin })}{" "}
        <button class="small" onClick={() => setBack(null)}>{t("ui.close")}</button></p>}
      {failed && <p class="error" role="alert">{t("ui.connectors_failed")}</p>}
      {linkGone && <p class="note banner" role="status">{t("ui.service_link_gone")} <button class="small" onClick={() => setLinkGone(false)}>{t("ui.close")}</button></p>}
      {!v && !failed && <Skeleton shape="card" />}
      {v && <>
        <div class="connector-summary">{order.filter((s) => v.summary[s]).map((s) => <span class={`pill pill-${s === "on" ? "yes" : s}`}>{t(`count.connectors_${s}`, { count: v.summary[s] })}</span>)}</div>
        <p class="connector-actions">
          <button class="primary" aria-expanded={asking} onClick={() => setAsking(!asking)}>{t("ui.connectors_ask")}</button>
          <button aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>{t("ui.connectors_browse")}</button>
          <button onClick={() => load(true)}>{t("ui.connectors_check_again")}</button>
        </p>
        {asking && <section class="card connector-ask">
          <h2>{t("ui.connectors_ask")}</h2>
          <p>{t("ui.connectors_ask_say")}</p>
          <blockquote>{v.ask.prompt}</blockquote>
          <p class="meta">{t("ui.connectors_ask_commands")}</p>
          {v.ask.commands.map((c) => <code>{c}</code>)}
          <p class="meta">{t("ui.connectors_ask_preview")}</p>
          <p><button onClick={openAsk}>{t("ui.connectors_open_ask")}</button></p>
        </section>}
        {browsing && <Catalog />}
        {!v.plugins.length && !v.summary.on && !v.summary.waiting && !v.summary.attention && <EmptyState art="connectors" size="s" class="meta">{t("ui.connectors_none_yet")}</EmptyState>}
        <h2>{t("ui.connectors_built_in")}</h2>
        <ul class="plain connector-grid">{v.built_ins.map((b) => <BuiltInCard key={`${b.key}:${opened === b.key}`} b={b} opened={opened === b.key} preview={preview} reload={() => void load(true)} />)}</ul>
        <h2 id="plugins">{t("ui.plugins_title")}</h2>
        {!v.plugins.length ? <p class="meta">{t("ui.plugins_none")} {t("ui.plugins_install_hint")}</p>
          : <ul class="plain connector-grid">{v.plugins.map((p) => <PluginConnector key={p.id} p={p} send={preview} />)}</ul>}
      </>}
      <Agents onChange={() => void load()} />
      {sheet}
    </main>
  );
}

/** A service openPadel has built in: each setting said to be there (a secret by its last four), and where from; the
 *  owner sets it up here, or it's in the server's settings file, which wins. */
function BuiltInCard({ b, opened, preview, reload }: { b: BuiltIn; opened: boolean; preview: (action: string, input: unknown) => Promise<void>; reload: () => void }) {
  const owner = Boolean(me.value?.roles.some((r) => r.key === "owner"));
  return (
    <li class={`card connector status-${b.status}`} id={`connector-${b.key}`}>
      <div class="connector-head">
        <span class="connector-mono" aria-hidden="true">{mono(b.name)}</span>
        <div><strong>{b.name}</strong><br /><span class="meta">{b.kind}</span></div>
        <span class={`pill pill-${b.status === "on" ? "yes" : b.status}`}>{t(STATUS_WORDS[b.status])}</span>
      </div>
      <p>{b.does}</p>
      <p class="meta">{b.health}</p>
      {b.checks.slice(1).filter((c) => c.status === "attention").map((c) => <p class="meta">{c.text}</p>)}
      <ServiceSettings service={b.key} name={b.name} settings={b.settings} form={b.form} owner={owner} opened={opened} preview={preview} onTested={reload} />
      <details><summary>{t("ui.connector_more")}</summary>
        {b.sees && <p class="meta">{t("ui.connector_sees", { what: b.sees })}</p>}
        <p class="meta">{t("ui.connector_guide", { doc: b.doc })}</p>
      </details>
      {b.page && <div class="connector-actions"><a class="button small" href={b.page}>{t("ui.connector_open")}</a></div>}
    </li>
  );
}
