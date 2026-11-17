// The club vault: keys and small documents only the owner sees, sealed with the server's key. A value or file
// goes to the server first, then the usual preview and confirm. A secret is never shown again, only its end.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, lang, needsStep, t, usePreview, useStepUp, clubTime } from "@kumi/ui";

type Item = { id: string; kind: "secret" | "document"; name: string; note: string | null; last4: string | null; filename: string | null; size_bytes: number;
  created_at: string; updated_at: string; by: string | null; downloads: { at: string; by: string | null }[] };
/** A key an installed plugin needs that the vault doesn't have yet (plugins.ts). */
type Request = { plugin: string; by: string | null; asked_at: string; why: string; can: string | null; keys: { name: string; vault_name: string; label: string; where: string }[] };
type D = { items: Item[]; limits: { secret_chars: number; document_bytes: number }; requests?: Request[] };

const kb = (n: number) => Math.max(1, Math.round(n / 1000));
/** A file as base64, for the upload. */
function readFile(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

export function Vault() {
  const [d, setD] = useState<D | null>(null), [failed, setFailed] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [n, setN] = useState(0);
  // The vault opens only with a second step (vault.ts): without one, the sheet to give it (or set it up), then again.
  const step = useStepUp();
  const load = (): Promise<void> => api<D>("/staff/vault").then(setD).catch((e) => { if (needsStep(e)) step.ask(() => void load()); else setFailed(e instanceof ApiError ? e.message : String(e)); });
  useEffect(() => { void load(); }, [lang.value]);
  const { preview, sheet } = usePreview(() => { setError(null); setN((x) => x + 1); void load(); });
  if (failed) return <main class="card"><p class="error">{failed}</p></main>;
  if (step.sheet) return <main>{step.sheet}</main>;
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const day = (iso: string) => clubTime(iso, { dateStyle: "medium" });
  const secrets = d.items.filter((x) => x.kind === "secret"), docs = d.items.filter((x) => x.kind === "document");
  // Send the value or file, then preview what the vault action will do with it.
  const send = async (up: Record<string, unknown>, action: "vault.add" | "vault.replace", input: Record<string, unknown>) => {
    setError(null);
    try { const r = await api<{ upload_id: string }>("/staff/vault/upload", up); await preview(action, { ...input, upload_id: r.upload_id }); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };
  return (
    <main>
      <h1>{t("ui.vault_title")}</h1>
      <p class="meta">{t("ui.vault_help")}</p>
      {/* What the server said about a value or file it wouldn't keep: the page and what was typed stay. */}
      {error && <p class="error" role="alert" onClick={() => setError(null)}>{error}</p>}
      {(d.requests ?? []).map((r) => (
        <section class="card" key={`${r.plugin}:${n}`}>
          <h2>{t("ui.vault_asked_title", { plugin: r.plugin })}</h2>
          <p class="meta">{r.why}{r.can ? ` ${t("ui.vault_asked_can", { can: r.can })}` : ""}</p>
          <p class="meta">{t("ui.vault_asked_by", { when: day(r.asked_at), who: r.by ?? "" })}</p>
          {r.keys.map((k) => <AskedKey key={k.vault_name} k={k} max={d.limits.secret_chars} onSend={(value) => send({ kind: "secret", value }, "vault.add", { name: k.vault_name })} />)}
          <p class="meta">{t("ui.vault_asked_never")}</p>
        </section>))}
      <section class="card">
        <h2>{t("ui.vault_secrets")}</h2>
        {!secrets.length ? <p class="meta">{t("ui.vault_no_secrets")}</p> : <ul class="plain">{secrets.map((x) => (
          <li class="row"><span><strong>{x.name}</strong>{" "}<span class="meta">{x.last4 ? t("ui.vault_ending", { last4: x.last4 }) : t("ui.vault_short")}</span>
            {x.note && <><br /><span class="meta">{x.note}</span></>}<br />
            <span class="meta">{t("ui.vault_kept", { when: day(x.updated_at), who: x.by ?? "" })}</span></span>
            <span><ReplaceSecret key={`${x.id}:${n}`} onSend={(value) => send({ kind: "secret", value }, "vault.replace", { item_id: x.id })} />{" "}
              <button class="small" onClick={() => preview("vault.remove", { item_id: x.id })}>{t("ui.vault_remove")}</button></span></li>))}</ul>}
        <AddSecret key={`s${n}`} max={d.limits.secret_chars} onSend={(name, value, note) => send({ kind: "secret", value }, "vault.add", { name, ...(note ? { note } : {}) })} />
      </section>
      <section class="card">
        <h2>{t("ui.vault_documents")}</h2>
        {!docs.length ? <p class="meta">{t("ui.vault_no_documents")}</p> : <ul class="plain">{docs.map((x) => (
          <li class="row"><span><strong>{x.name}</strong>{" "}<span class="meta">{x.filename} · {t("ui.vault_kb", { kb: kb(x.size_bytes) })}</span>
            {x.note && <><br /><span class="meta">{x.note}</span></>}<br />
            <span class="meta">{t("ui.vault_kept", { when: day(x.updated_at), who: x.by ?? "" })}</span>
            {x.downloads.map((dl) => <><br /><span class="meta">{t("ui.vault_downloaded", { when: day(dl.at), who: dl.by ?? "" })}</span></>)}</span>
            <span><a class="button small" href={`/staff/vault/${x.id}/file`} download>{t("ui.vault_download")}</a>{" "}
              <ReplaceDoc key={`${x.id}:${n}`} onSend={(data, filename) => send({ kind: "document", data, filename }, "vault.replace", { item_id: x.id })} />{" "}
              <button class="small" onClick={() => preview("vault.remove", { item_id: x.id })}>{t("ui.vault_remove")}</button></span></li>))}</ul>}
        <AddDoc key={`d${n}`} maxMb={d.limits.document_bytes / 1_000_000} onSend={(name, data, filename, note) => send({ kind: "document", data, filename }, "vault.add", { name, ...(note ? { note } : {}) })} />
      </section>
      {sheet}
    </main>
  );
}

function AddSecret({ max, onSend }: { max: number; onSend: (name: string, value: string, note: string) => void }) {
  const [name, setName] = useState(""), [value, setValue] = useState(""), [note, setNote] = useState("");
  return (
    <form class="card-form" onSubmit={(e) => { e.preventDefault(); onSend(name.trim(), value, note.trim()); }}>
      <h3>{t("ui.vault_add_secret")}</h3>
      <label>{t("ui.vault_name")}<input value={name} maxLength={80} required onInput={(e) => setName(e.currentTarget.value)} /></label>
      <label>{t("ui.vault_value")}<input type="password" autocomplete="new-password" value={value} maxLength={max} required onInput={(e) => setValue(e.currentTarget.value)} /></label>
      <label>{t("ui.vault_note")}<input value={note} maxLength={300} onInput={(e) => setNote(e.currentTarget.value)} /></label>
      <p class="meta">{t("ui.vault_never_shown")}</p>
      <button class="primary" type="submit" disabled={!name.trim() || !value}>{t("ui.preview")}</button>
    </form>
  );
}

function AddDoc({ maxMb, onSend }: { maxMb: number; onSend: (name: string, data: string, filename: string, note: string) => void }) {
  const [name, setName] = useState(""), [file, setFile] = useState<File | null>(null), [note, setNote] = useState("");
  return (
    <form class="card-form" onSubmit={async (e) => { e.preventDefault(); if (file) onSend(name.trim(), await readFile(file), file.name, note.trim()); }}>
      <h3>{t("ui.vault_add_document")}</h3>
      <label>{t("ui.vault_name")}<input value={name} maxLength={80} required onInput={(e) => setName(e.currentTarget.value)} /></label>
      <label>{t("ui.vault_file", { mb: maxMb })}<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} /></label>
      <label>{t("ui.vault_note")}<input value={note} maxLength={300} onInput={(e) => setNote(e.currentTarget.value)} /></label>
      <button class="primary" type="submit" disabled={!name.trim() || !file}>{t("ui.preview")}</button>
    </form>
  );
}

function ReplaceSecret({ onSend }: { onSend: (value: string) => void }) {
  const [open, setOpen] = useState(false), [value, setValue] = useState("");
  if (!open) return <button class="small" onClick={() => setOpen(true)}>{t("ui.vault_replace")}</button>;
  return (
    <form class="inline" onSubmit={(e) => { e.preventDefault(); onSend(value); }}>
      <input type="password" autocomplete="new-password" aria-label={t("ui.vault_new_value")} placeholder={t("ui.vault_new_value")} value={value} onInput={(e) => setValue(e.currentTarget.value)} />
      <button class="small primary" type="submit" disabled={!value}>{t("ui.preview")}</button>
    </form>
  );
}

function ReplaceDoc({ onSend }: { onSend: (data: string, filename: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button class="small" onClick={() => setOpen(true)}>{t("ui.vault_replace")}</button>;
  return <input type="file" aria-label={t("ui.vault_new_file")} accept="application/pdf,image/jpeg,image/png,image/webp"
    onChange={async (e) => { const f = e.currentTarget.files?.[0]; if (f) onSend(await readFile(f), f.name); }} />;
}

/** One key a plugin asked for: what it is, where the owner gets it, and the field for it (its name is the plugin's own). */
function AskedKey({ k, max, onSend }: { k: Request["keys"][number]; max: number; onSend: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form class="card-form" onSubmit={(e) => { e.preventDefault(); onSend(value); }}>
      <label>{k.label} <span class="meta">({k.name})</span>
        <input type="password" autocomplete="new-password" value={value} maxLength={max} required onInput={(e) => setValue(e.currentTarget.value)} /></label>
      <p class="meta">{k.where}</p>
      <button class="primary" type="submit" disabled={!value}>{t("ui.vault_asked_save")}</button>
    </form>
  );
}
