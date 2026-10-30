import { useState } from "preact/hooks";
import { startAuthentication } from "@simplewebauthn/browser";
import type { Lang } from "@kumi/i18n";
import { api, ApiError, club, lang, loadMe, t } from "./state.ts";

export function SignIn() {
  const [email, setEmail] = useState(""), [code, setCode] = useState(""), [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  // A new address: after the code, they give their name and say whether they want club news.
  const [ticket, setTicket] = useState<string | null>(null), [name, setName] = useState(""), [locale, setLocale] = useState<Lang>(lang.value), [news, setNews] = useState(false);
  const attempt = async (f: () => Promise<void>) => { setBusy(true); setError(null); try { await f(); } catch (e) { setError(e instanceof ApiError ? e.message : String((e as Error).message)); } finally { setBusy(false); } };

  const send = (e: Event) => { e.preventDefault(); attempt(async () => { await api("/auth/email/start", { email }); setSent(true); }); };
  const verify = (e: Event) => { e.preventDefault(); attempt(async () => {
    const r = await api<{ signed_in?: boolean; sign_up?: boolean; ticket?: string }>("/auth/email/verify", { email, code });
    if (r.sign_up && r.ticket) { setTicket(r.ticket); return; }
    await loadMe();
  }); };
  const join = (e: Event) => { e.preventDefault(); attempt(async () => { await api("/auth/sign-up", { ticket, display_name: name, locale, club_news: news }); lang.value = locale; await loadMe(); }); };
  const passkey = () => attempt(async () => {
    const o = await api<{ challenge_id: string; options: any }>("/auth/passkey/sign-in/options", {});
    const response = await startAuthentication({ optionsJSON: o.options });
    await api("/auth/passkey/sign-in/verify", { challenge_id: o.challenge_id, response });
    await loadMe();
  });

  const clubName = club.value?.name ?? "Kumi";
  // Keyed, so Preact builds the join form fresh: reusing the code box would carry its digits-only pattern into the name.
  if (ticket) return (
    <main class="card" key="join">
      <h1>{t("ui.join_title", { club: clubName })}</h1>
      <form onSubmit={join}>
        <label>{t("ui.your_name")}<input required maxLength={80} autocomplete="name" value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
        <label>{t("ui.join_language")}
          <select value={locale} onChange={(e) => setLocale(e.currentTarget.value as Lang)}><option value="en">English</option><option value="es">Español</option></select>
        </label>
        <label class="check"><input type="checkbox" checked={news} onChange={(e) => setNews(e.currentTarget.checked)} /> {t("ui.club_news_consent", { club: clubName })}</label>
        <p class="meta">{t("ui.account_emails_note")}</p>
        <button class="primary" disabled={busy}>{t("ui.join_club")}</button>
      </form>
      {error && <p class="error" role="alert">{error}</p>}
    </main>
  );
  return (
    <main class="card" key="sign-in">
      <h1>{t("ui.sign_in_title", { club: clubName })}</h1>
      {club.value?.public_page && <p class="meta"><a href="/public">{t("ui.about_the_club")}</a></p>}
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
