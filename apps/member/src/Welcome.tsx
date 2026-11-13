// The welcome for members who moved in from Playtomic (the server's welcome.ts), once, at their first sign-in after
// the move: what came across (upcoming bookings, level, club credit, membership), each only when there is one and
// said plainly when there isn't; a yes to texts, never ticked for them, in the same words and through the same
// consent.texts change as Profile; a word about adding a card before a membership renews; and a way to tell the club
// something's wrong. Continue goes to Home. Asking the server for it notes it as seen, so it never shows again.
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api, ApiError, club, clubTime, dollars, Illustration, lang, me, protectedPost, t, usePreview } from "@kumi/ui";
import { offerTexts as offered, textsConsent, type TextsState as Texts } from "./welcome_texts.ts";

type Facts = { moved_in: boolean; first?: boolean; time_zone?: string; bookings?: { id: string; court: string; start: string }[]; level?: string | null; credit_cents?: number;
  membership?: { name: string; renews: boolean; needs_card: boolean; date: string | null } | null };

/** "Dec 1, 2026" for a club date (YYYY-MM-DD). */
const day = (date: string) => clubTime(`${date}T12:00:00Z`, { dateStyle: "medium" }, "UTC");

export function Welcome() {
  const { route } = useLocation();
  const [f, setF] = useState<Facts | null>(null), [texts, setTexts] = useState<Texts | null>(null);
  const [yes, setYes] = useState(false), [phone, setPhone] = useState(""), [code, setCode] = useState(""), [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const home = () => route("/", true);
  const { preview, sheet } = usePreview(home);
  const loadTexts = () => api<Texts>("/my/texts").then(setTexts).catch(() => setTexts(null));
  useEffect(() => {
    // Seen once it's asked for: the app doesn't bring anyone back here again, even before they press Continue.
    api<Facts>("/my/welcome", {}).then((x) => { if (me.value) me.value = { ...me.value, welcome: false }; if (!x.moved_in) home(); else setF(x); }).catch(() => home());
    void loadTexts();
  }, []);
  const guard = (fn: () => Promise<void>) => async () => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); } };
  const sendCode = guard(async () => { await protectedPost("/my/phone/start", { phone }); setSent(true); await loadTexts(); });
  const confirmCode = guard(async () => { await api("/my/phone/verify", { code }); setCode(""); await loadTexts(); });
  // Asked only when ticked, and only once the number is confirmed: the same change, preview and words as Profile's.
  const go = () => {
    const consent = textsConsent(yes, texts, me.value!.person.id, navigator.userAgent);
    if (!consent) return home();
    void preview("consent.texts", consent);
  };
  if (!f) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const name = me.value?.person.display_name.split(/\s+/)[0] ?? "";
  const offerTexts = offered(texts);
  const m = f.membership, b = f.bookings ?? [];
  return (
    <main class="welcome">
      <section class="club-head">
        <Illustration name="welcome" class="welcome-art" />
        {club.value?.logo ? <img class="monogram monogram-logo" src={club.value.logo} alt="" width={56} height={56} />
          : <span class="monogram" aria-hidden="true">{(club.value?.name ?? "").trim().charAt(0).toUpperCase()}</span>}
        <div><p class="meta">{club.value?.name}</p><h1>{t("ui.welcome_title", { name })}</h1></div>
      </section>
      <p>{t("ui.welcome_lead")}</p>
      <section class="card" aria-labelledby="came-across">
        <h2 id="came-across">{t("ui.welcome_came_across")}</h2>
        <ul class="plain">
          <li>{b.length ? <><strong>{t("ui.welcome_bookings", { count: b.length })}</strong>
            <ul class="plain">{b.map((x) => <li key={x.id} class="meta">{x.court} · {clubTime(x.start, { dateStyle: "medium", timeStyle: "short" }, f.time_zone)}</li>)}</ul></>
            : <span class="meta">{t("ui.welcome_no_bookings")}</span>}</li>
          <li>{f.level ? <><strong>{t("ui.welcome_level", { level: Number(f.level).toFixed(2) })}</strong> <span class="meta">{t("ui.welcome_level_note")}</span></>
            : <span class="meta">{t("ui.welcome_no_level")}</span>}</li>
          <li>{f.credit_cents ? <><strong>{t("ui.welcome_credit", { amount: dollars(f.credit_cents, lang.value) })}</strong> <span class="meta">{t("ui.welcome_credit_note")}</span></>
            : <span class="meta">{t("ui.welcome_no_credit")}</span>}</li>
          <li>{m ? <><strong>{t("ui.welcome_membership", { name: m.name })}</strong>{m.date && <> <span class="meta">{t(m.renews ? "ui.welcome_renews" : "ui.welcome_paid_through", { date: day(m.date) })}</span></>}</>
            : <span class="meta">{t("ui.welcome_no_membership")}</span>}</li>
        </ul>
      </section>
      {offerTexts && texts && <section class="card">
        <label class="check"><input type="checkbox" checked={yes} onChange={(e) => setYes(e.currentTarget.checked)} />
          <span><strong>{t("ui.welcome_texts")}</strong><br /><span class="meta">{texts.form.words}</span></span></label>
        {yes && texts.phone && <p class="meta">{t("ui.welcome_texts_confirmed", { phone: texts.phone })}</p>}
        {yes && !texts.phone && <>
          <form onSubmit={(e) => { e.preventDefault(); void sendCode(); }}>
            <label>{t("ui.welcome_texts_phone")}<input type="tel" autocomplete="tel" inputMode="tel" required value={phone} onInput={(e) => setPhone(e.currentTarget.value)} /></label>
            <button class={sent || texts.waiting_code_for ? "" : "primary"} disabled={busy}>{t("ui.texts_send_code")}</button>
          </form>
          {(sent || texts.waiting_code_for) && <form onSubmit={(e) => { e.preventDefault(); void confirmCode(); }}>
            <label>{t("ui.texts_code")}<input inputMode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required value={code} onInput={(e) => setCode(e.currentTarget.value)} /></label>
            <button class="primary" disabled={busy}>{t("ui.confirm")}</button>
          </form>}
        </>}
      </section>}
      {m?.needs_card && m.date && <p class="note">{t("ui.welcome_add_card", { date: day(m.date) })} <a href="/membership">{t("ui.welcome_add_card_link")}</a></p>}
      {error && <p class="error" role="alert">{error}</p>}
      {/* Ticked texts wait for a confirmed number: untick to go on without them. */}
      <button class="primary" disabled={busy || (yes && offerTexts && !texts?.phone)} onClick={go}>{t("ui.welcome_continue")}</button>
      <p class="meta">{t("ui.welcome_missing")} <a href="/ask">{t("ui.welcome_tell")}</a></p>
      {sheet}
    </main>
  );
}
