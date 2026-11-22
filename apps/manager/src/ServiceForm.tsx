// A built-in service's settings on its Connectors card (service_routes.ts on the server): each one set or not, and
// where from ("in the app" or "on the server"); for the owner, the form that sets them up or changes them, Remove,
// and the service's test call. A value goes to the server once, sealed into the vault's waiting room, then the usual
// preview and confirm (vault.service_set). A secret never comes back: the card says "set, ending 4f2a".
import { useState } from "preact/hooks";
import { api, ApiError, needsStep, t, useStepUp } from "@kumi/ui";

export type ServiceSetting = { field: string; name: string; secret: boolean; needed: boolean; set: boolean; source: "server" | "app" | null; last4: string | null; value: string | null; file_only?: boolean };
export type ServiceFormSpec = { fields: { field: string; name: string; secret: boolean; needed: boolean; label: string }[]; keys_at: string; how: string; test: boolean };

/** One setting in words: not set; set (ending 4f2a) or its plain value; and where it's from. */
export function settingWords(s: ServiceSetting, label?: string): string {
  const name = label ?? s.name;
  if (!s.set) return t("ui.service_setting_missing", { name });
  const where = t(s.source === "app" ? "ui.service_in_app" : "ui.service_on_server");
  if (s.secret) return s.last4 ? t("ui.service_setting_ending", { name, last4: s.last4, where }) : t("ui.service_setting_set", { name, where });
  return t("ui.service_setting_value", { name, value: s.value ?? "", where });
}

export function ServiceSettings({ service, name, settings, form, owner, opened, preview, onTested }: {
  service: string; name: string; settings: ServiceSetting[]; form: ServiceFormSpec; owner: boolean; opened: boolean;
  preview: (action: string, input: unknown) => Promise<void>; onTested: () => void;
}) {
  const [open, setOpen] = useState(opened), [error, setError] = useState<string | null>(null), [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false), [n, setN] = useState(0);
  const step = useStepUp();
  const label = (s: ServiceSetting) => form.fields.find((f) => f.field === s.field)?.label;
  const inApp = settings.some((s) => s.source === "app"), anySet = settings.some((s) => s.set && !s.file_only);
  const send = async (values: Record<string, string>) => {
    setError(null); setBusy(true);
    try {
      const r = await api<{ values: { field: string; upload_id: string }[] }>(`/staff/connectors/${service}/stage`, { values });
      await preview("vault.service_set", { service, values: r.values });
      setOpen(false); setN((x) => x + 1);
    } catch (e) {
      if (needsStep(e)) step.ask(() => void send(values));
      else setError(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const test = async () => {
    setTested(null); setError(null);
    try { setTested(await api<{ ok: boolean; text: string }>(`/staff/connectors/${service}/test`, {})); onTested(); }
    catch (e) { if (needsStep(e)) step.ask(() => void test()); else setError(e instanceof ApiError ? e.message : String(e)); }
  };
  return (
    <div class="service-settings">
      <ul class="plain service-setting-list">{settings.map((s) => <li class="meta">{settingWords(s, label(s))}</li>)}</ul>
      {error && <p class="error" role="alert">{error}</p>}
      {tested && <p class={tested.ok ? "note" : "error"} role="status">{tested.text}</p>}
      {owner && !open && <div class="connector-actions">
        <button class="small primary" onClick={() => setOpen(true)}>{t(anySet ? "ui.service_change" : "ui.connector_set_up")}</button>
        {inApp && <button class="small" onClick={() => void preview("vault.service_remove", { service })}>{t("ui.service_remove")}</button>}
        {form.test && anySet && <button class="small" onClick={() => void test()}>{t("ui.service_test")}</button>}
      </div>}
      {!owner && <p class="meta">{t("ui.service_owner_sets")}</p>}
      {owner && open && <ServiceFields key={n} service={service} name={name} form={form} settings={settings} busy={busy} onSend={send} onCancel={() => { setOpen(false); setError(null); }} />}
      {step.sheet}
    </div>
  );
}

function ServiceFields({ service, name, form, settings, busy, onSend, onCancel }: {
  service: string; name: string; form: ServiceFormSpec; settings: ServiceSetting[]; busy: boolean; onSend: (values: Record<string, string>) => void; onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
  const attrs = (field: string, set?: boolean) => ({ name: field, autocomplete: "off", spellcheck: false, value: values[field] ?? "", placeholder: set ? t("ui.service_keep_placeholder") : "",
    onInput: (e: { currentTarget: HTMLInputElement }) => setValues({ ...values, [field]: e.currentTarget.value }) });
  const missing = form.fields.filter((f) => f.needed && !filled[f.field] && !settings.find((s) => s.field === f.field)?.set);
  return (
    <form class="service-form" id={`service-form-${service}`} onSubmit={(e) => { e.preventDefault(); if (Object.keys(filled).length) onSend(filled); }}>
      <h3>{t("ui.service_form_title", { name })}</h3>
      <p class="meta">{form.how}{" "}<a href={form.keys_at} target="_blank" rel="noopener noreferrer">{t("ui.service_keys_at", { name })}</a></p>
      {form.fields.map((f) => {
        const now = settings.find((s) => s.field === f.field);
        return <label key={f.field}>{f.label}{!f.needed && <span class="meta"> ({t("ui.service_optional")})</span>}
          {f.secret ? <input type="password" {...attrs(f.field, now?.set)} /> : <input type="text" {...attrs(f.field, now?.set)} />}
          <span class="meta mono">{f.name}{now?.source === "server" ? ` · ${t("ui.service_file_wins")}` : ""}</span></label>;
      })}
      {missing.length > 0 && Object.keys(filled).length > 0 && <p class="meta">{t("ui.service_still_needs", { list: missing.map((f) => f.label).join(", ") })}</p>}
      <p class="meta">{t("ui.service_never_shown")}</p>
      <div class="connector-actions">
        <button class="primary" type="submit" disabled={busy || !Object.keys(filled).length}>{t("ui.service_preview")}</button>
        <button type="button" onClick={onCancel}>{t("ui.cancel")}</button>
      </div>
    </form>
  );
}
