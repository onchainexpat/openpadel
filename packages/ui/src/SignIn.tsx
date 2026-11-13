import { useState } from "preact/hooks";
import { startAuthentication } from "@simplewebauthn/browser";
import type { Lang } from "@kumi/i18n";
import { api, ApiError, club, emailedNote, farewell, lang, loadMe, passkeyFailure, t, type Club } from "./state.ts";
import { protectedPost } from "./pow.ts";
import { PolicyLinks, shownPolicies } from "./Policies.tsx";

export function SignIn() {
  // By email, or by a code texted to a mobile number when the club texts.
  const [by, setBy] = useState<"email" | "phone">("email");
  const [email, setEmail] = useState(""), [phone, setPhone] = useState(""), [code, setCode] = useState(""), [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  // A new address or number: after the code, they give their name (and, with an email, whether they want club news).
  const [ticket, setTicket] = useState<string | null>(null), [ticketBy, setTicketBy] = useState<"email" | "phone">("email");
  const [name, setName] = useState(""), [locale, setLocale] = useState<Lang>(lang.value), [news, setNews] = useState(false);
  // A field people never see (or fill in): a script that fills every field gets nowhere (bot.ts).
  const [website, setWebsite] = useState("");
  const trap = <label class="trap" aria-hidden="true">Website<input tabIndex={-1} autocomplete="off" value={website} onInput={(e) => setWebsite(e.currentTarget.value)} /></label>;
  const attempt = async (f: () => Promise<void>) => { setBusy(true); setError(null); try { await f(); } catch (e) { setError(e instanceof ApiError ? e.message : passkeyFailure(e) ? t("error.passkey_failed") : String((e as Error).message)); } finally { setBusy(false); } };

  const send = (e: Event) => { e.preventDefault(); attempt(async () => {
    await (by === "phone" ? protectedPost("/auth/phone/start", { phone }, website) : protectedPost("/auth/email/start", { email }, website));
    setSent(true);
  }); };
  const verify = (e: Event) => { e.preventDefault(); attempt(async () => {
    const r = by === "phone" ? await api<{ signed_in?: boolean; sign_up?: boolean; ticket?: string }>("/auth/phone/verify", { phone, code })
      : await api<{ signed_in?: boolean; sign_up?: boolean; ticket?: string }>("/auth/email/verify", { email, code });
    if (r.sign_up && r.ticket) { setTicket(r.ticket); setTicketBy(by); return; }
    await loadMe();
  }); };
  const join = (e: Event) => { e.preventDefault(); attempt(async () => {
    try { await protectedPost("/auth/sign-up", { ticket, display_name: name, locale, club_news: ticketBy === "email" && news, policies: shownPolicies() }, website); }
    catch (x) {
      // The club may have changed its terms or privacy policy while the page was open: the new links show, to look at first.
      if (x instanceof ApiError && x.status === 409) club.value = await api<Club>("/club");
      throw x;
    }
    lang.value = locale; await loadMe();
  }); };
  const passkey = () => attempt(async () => {
    const o = await api<{ challenge_id: string; options: any }>("/auth/passkey/sign-in/options", {});
    const response = await startAuthentication({ optionsJSON: o.options });
    await api("/auth/passkey/sign-in/verify", { challenge_id: o.challenge_id, response });
    await loadMe();
  });
  const switchTo = (to: "email" | "phone") => { setBy(to); setSent(false); setCode(""); setError(null); };

  const clubName = club.value?.name ?? "";
  // Keyed, so Preact builds the join form fresh: reusing the code box would carry its digits-only pattern into the name.
  if (ticket) return (
    <main class="card" key="join">
      <SignInMark />
      <h1>{t("ui.join_title", { club: clubName })}</h1>
      <form onSubmit={join}>
        <label>{t("ui.your_name")}<input required maxLength={80} autocomplete="name" value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
        <label>{t("ui.join_language")}
          <select value={locale} onChange={(e) => setLocale(e.currentTarget.value as Lang)}><option value="en">English</option><option value="es">Español</option></select>
        </label>
        {ticketBy === "email" ? <>
          <label class="check"><input type="checkbox" checked={news} onChange={(e) => setNews(e.currentTarget.checked)} /> {t("ui.club_news_consent", { club: clubName })}</label>
          <p class="meta">{t("ui.account_emails_note")}</p>
        </> : <p class="meta">{t("ui.join_by_phone_note")}</p>}
        <PolicyLinks join />
        {trap}
        <button class="primary" disabled={busy}>{t("ui.join_club")}</button>
      </form>
      {error && <p class="error" role="alert">{error}</p>}
    </main>
  );
  return (
    <main class="card" key="sign-in">
      <SignInMark />
      <h1>{t("ui.sign_in_title", { club: clubName })}</h1>
      {farewell.value && <p class="note" role="status">{t("ui.account_deleted")}</p>}
      {club.value?.public_page && <p class="meta"><a href="/public">{t("ui.about_the_club")}</a></p>}
      {!sent ? (
        <form onSubmit={send} key={by}>
          {by === "phone"
            ? <label>{t("ui.texts_phone")}<input type="tel" required autocomplete="tel" inputMode="tel" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} /></label>
            : <label>{t("ui.email")}<input type="email" required autocomplete="username webauthn" value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>}
          {trap}
          <button class="primary" disabled={busy}>{t(by === "phone" ? "ui.text_me_code" : "ui.send_code")}</button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <p>{by === "phone" ? t("ui.code_texted", { phone }) : emailedNote(t("ui.code_sent", { email }))}</p>
          <label>{t("ui.code")}<input inputMode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} /></label>
          <button class="primary" disabled={busy}>{t("ui.verify")}</button>
          <button type="button" class="link" onClick={() => { setSent(false); setCode(""); }}>{t(by === "phone" ? "ui.other_phone" : "ui.other_email")}</button>
        </form>
      )}
      {club.value?.phone_sign_in && !sent && <p><button type="button" class="link" onClick={() => switchTo(by === "phone" ? "email" : "phone")}>{t(by === "phone" ? "ui.use_email" : "ui.use_phone")}</button></p>}
      <p class="or">{t("ui.or")}</p>
      <button onClick={passkey} disabled={busy}>{t("ui.use_passkey")}</button>
      {error && <p class="error" role="alert">{error}</p>}
    </main>
  );
}

/** The club's logo over the sign-in card, growing in once (only a fade with less motion). Without a logo, the start
 *  screen's mark (drawn from the name) on the club's colour. */
function SignInMark() {
  const src = club.value?.logo ?? club.value?.mark;
  return src ? <img class="signin-mark" src={src} alt="" width={72} height={72} /> : null;
}
