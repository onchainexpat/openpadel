import { useState } from "preact/hooks";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, ApiError, club, loadMe, t } from "./state.ts";

export function SignIn() {
  const [email, setEmail] = useState(""), [code, setCode] = useState(""), [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const attempt = async (f: () => Promise<void>) => { setBusy(true); setError(null); try { await f(); } catch (e) { setError(e instanceof ApiError ? e.message : String((e as Error).message)); } finally { setBusy(false); } };

  const send = (e: Event) => { e.preventDefault(); attempt(async () => { await api("/auth/email/start", { email }); setSent(true); }); };
  const verify = (e: Event) => { e.preventDefault(); attempt(async () => { await api("/auth/email/verify", { email, code }); await loadMe(); }); };
  const passkey = () => attempt(async () => {
    const o = await api<{ challenge_id: string; options: any }>("/auth/passkey/sign-in/options", {});
    const response = await startAuthentication({ optionsJSON: o.options });
    await api("/auth/passkey/sign-in/verify", { challenge_id: o.challenge_id, response });
    await loadMe();
  });

  return (
    <main class="card">
      <h1>{t("ui.sign_in_title", { club: club.value?.name ?? "Kumi" })}</h1>
      {!sent ? (
        <form onSubmit={send}>
          <label>{t("ui.email")}<input type="email" required autocomplete="username webauthn" value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
          <button class="primary" disabled={busy}>{t("ui.send_code")}</button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <p>{t("ui.code_sent", { email })}</p>
          <label>{t("ui.code")}<input inputMode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} /></label>
          <button class="primary" disabled={busy}>{t("ui.verify")}</button>
          <button type="button" class="link" onClick={() => { setSent(false); setCode(""); }}>{t("ui.other_email")}</button>
        </form>
      )}
      <p class="or">{t("ui.or")}</p>
      <button onClick={passkey} disabled={busy}>{t("ui.use_passkey")}</button>
      {error && <p class="error" role="alert">{error}</p>}
    </main>
  );
}
