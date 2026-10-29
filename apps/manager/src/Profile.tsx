import { useState } from "preact/hooks";
import { startRegistration } from "@simplewebauthn/browser";
import type { Key, Lang } from "@kumi/i18n";
import { api, ApiError, club, loadMe, me, t } from "./state.ts";

export function Profile() {
  const m = me.value!;
  const [name, setName] = useState(m.person.display_name), [locale, setLocale] = useState<Lang>(m.person.locale as Lang);
  const [pending, setPending] = useState<{ runId: string; summary: string } | null>(null);
  const [note, setNote] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const guard = async (f: () => Promise<void>) => { setError(null); setNote(null); try { await f(); } catch (e) { setError(e instanceof ApiError ? e.message : (e as Error).message); } };

  const preview = (e: Event) => { e.preventDefault(); guard(async () => {
    const p = await api<{ run_id: string; summary: string }>("/actions/person.update_profile/plan", { person_id: m.person.id, display_name: name, locale });
    setPending({ runId: p.run_id, summary: p.summary });
  }); };
  const confirm = () => guard(async () => {
    await api(`/runs/${pending!.runId}/apply`, {}, { "idempotency-key": pending!.runId });
    setPending(null); await loadMe(); setNote(t("ui.saved"));
  });
  const addPasskey = () => guard(async () => {
    const o = await api<{ challenge_id: string; options: any }>("/auth/passkey/add/options", {});
    const response = await startRegistration({ optionsJSON: o.options });
    await api("/auth/passkey/add/verify", { challenge_id: o.challenge_id, response, name: t("ui.passkey_name_default") });
    setNote(t("ui.passkey_added"));
  });

  return (
    <main>
      <h1>{t("ui.profile_title")}</h1>
      <section class="card">
        <p>{t("ui.roles", { roles: m.roles.map((r) => t(`role.${r.key}` as Key)).join(", ") })}</p>
        <p class="meta">{t(m.signed_in_with === "passkey" ? "ui.signed_in_with_passkey" : "ui.signed_in_with_email_code")}</p>
      </section>
      <form class="card" onSubmit={preview}>
        <label>{t("ui.display_name")}<input value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
        <label>{t("ui.language")}
          <select value={locale} onChange={(e) => setLocale(e.currentTarget.value as Lang)}>
            {(club.value?.languages ?? ["en", "es"]).map((l) => <option value={l}>{t(`ui.lang_${l}` as Key)}</option>)}
          </select>
        </label>
        {!pending ? <button class="primary">{t("ui.preview")}</button> : (
          <div class="sheet"><p>{pending.summary}</p><button type="button" class="primary" onClick={confirm}>{t("ui.confirm")}</button> <button type="button" onClick={() => setPending(null)}>{t("ui.cancel")}</button></div>
        )}
      </form>
      <section class="card">
        <h2>{t("ui.passkeys")}</h2>
        <button onClick={addPasskey}>{t("ui.add_passkey")}</button>
      </section>
      {note && <p class="note" role="status">{note}</p>}
      {error && <p class="error" role="alert">{error}</p>}
    </main>
  );
}
