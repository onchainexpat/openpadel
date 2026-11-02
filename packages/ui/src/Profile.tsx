import { useEffect, useState } from "preact/hooks";
import { startRegistration } from "@simplewebauthn/browser";
import type { Key, Lang } from "@kumi/i18n";
import { api, ApiError, club, farewell, loadMe, me, t } from "./state.ts";
import { AccountData } from "./AccountData.tsx";
import { protectedPost } from "./pow.ts";
import { lazy } from "preact-iso";

// Two-step sign-in, loaded when the profile opens.
const TwoStepSettings = lazy(() => import("./TwoFactor.tsx").then((m) => m.TwoStepSettings));
// Connected assistants and their weekly limits, loaded when the profile opens.
const Assistants = lazy(() => import("./Assistants.tsx").then((m) => m.Assistants));

/** Notifications on this device: the browser's own permission, then a subscription the club's server pushes
 *  to. `app` says which app's messages it gets (staff alerts in the staff app, the rest in the members'). */
function PushToggle({ app }: { app: "member" | "staff" }) {
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
  const [state, setState] = useState<"loading" | "on" | "off" | "blocked" | "unsupported">(supported ? "loading" : "unsupported");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const current = async () => (await (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription()) ?? null;
  useEffect(() => {
    if (!supported) return;
    if (Notification.permission === "denied") { setState("blocked"); return; }
    current().then((s) => setState(s ? "on" : "off")).catch(() => setState("off"));
  }, []);
  const run = (f: () => Promise<void>) => async () => { setBusy(true); setError(null); try { await f(); } catch (e) { setError(e instanceof ApiError ? e.message : t("ui.notifications_failed")); } finally { setBusy(false); } };
  const on = run(async () => {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const answer = await Notification.requestPermission();
    if (answer !== "granted") { setState(answer === "denied" ? "blocked" : "off"); return; }
    const { public_key } = await api<{ public_key: string }>("/my/push/key");
    const key = Uint8Array.from(atob(public_key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api("/my/push", { app, ...sub.toJSON() });
    setState("on");
  });
  const off = run(async () => {
    const sub = await current();
    if (sub) { await api("/my/push/off", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    setState("off");
  });
  return (
    <section class="card">
      <h2>{t("ui.notifications")}</h2>
      <p class="meta">{t(state === "unsupported" ? "ui.notifications_unsupported" : state === "blocked" ? "ui.notifications_blocked" : state === "on" ? "ui.notifications_are_on" : "ui.notifications_hint")}</p>
      {state === "off" && <button class="primary" disabled={busy} onClick={on}>{t("ui.notifications_turn_on")}</button>}
      {state === "on" && <button disabled={busy} onClick={off}>{t("ui.notifications_turn_off")}</button>}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}

/** Club news by email: the member's own yes or no, which every club news email's link can also turn off. */
function ClubNews({ personId }: { personId: string }) {
  const [on, setOn] = useState<boolean | null | undefined>(undefined), [pending, setPending] = useState<{ runId: string; summary: string } | null>(null), [error, setError] = useState<string | null>(null);
  const load = () => api<{ granted: boolean | null }>("/my/club-news").then((r) => setOn(r.granted)).catch(() => setOn(undefined));
  useEffect(() => { void load(); }, []);
  const ask = async (granted: boolean) => {
    setError(null);
    try { const p = await api<{ run_id: string; summary: string }>("/actions/consent.club_news/plan", { person_id: personId, granted }); setPending({ runId: p.run_id, summary: p.summary }); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };
  const confirm = async () => {
    try { await api(`/runs/${pending!.runId}/apply`, {}, { "idempotency-key": pending!.runId }); setPending(null); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setPending(null); }
  };
  if (on === undefined) return null;
  return (
    <section class="card">
      <h2>{t("ui.club_news_title")}</h2>
      <p class="meta">{t(on ? "ui.club_news_on" : "ui.club_news_off", { club: club.value?.name ?? "" })}</p>
      {!pending ? <button class={on ? "" : "primary"} onClick={() => ask(!on)}>{t(on ? "ui.club_news_turn_off" : "ui.club_news_turn_on")}</button> : (
        <div class="sheet"><p>{pending.summary}</p><button type="button" class="primary" onClick={confirm}>{t("ui.confirm")}</button> <button type="button" onClick={() => setPending(null)}>{t("ui.cancel")}</button></div>
      )}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}

/** Texts: their number, confirmed with a texted code, then their own yes to the words shown, never ticked for
 *  them (texts.ts). Shown only when the club sends texts; a kid sees it once their parents turn texts on. */
function Texts({ personId }: { personId: string }) {
  type S = { on: boolean; phone: string | null; waiting_code_for: string | null; answer: boolean | null; kid: { allowed: boolean } | null; form: { version: string; words: string } };
  const [s, setS] = useState<S | null>(null), [editing, setEditing] = useState(false), [phone, setPhone] = useState(""), [code, setCode] = useState(""), [yes, setYes] = useState(false);
  const [pending, setPending] = useState<{ runId: string; summary: string } | null>(null), [note, setNote] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const load = () => api<S>("/my/texts").then((x) => { setS(x); setEditing(!x.phone); setYes(false); }).catch(() => setS(null));
  useEffect(() => { void load(); }, []);
  const guard = (f: () => Promise<void>) => async () => { setBusy(true); setError(null); setNote(null); try { await f(); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); } };
  const sendCode = guard(async () => { const r = await protectedPost<{ phone?: string }>("/my/phone/start", { phone }); setNote(t("ui.texts_sent_code", { phone: r.phone ?? phone })); await load(); setEditing(true); });
  const confirmCode = guard(async () => { await api("/my/phone/verify", { code }); setCode(""); await load(); });
  const ask = (granted: boolean) => guard(async () => {
    const p = await api<{ run_id: string; summary: string }>("/actions/consent.texts/plan", { person_id: personId, granted, ...(granted ? { form_version: s!.form.version, app: "member", device: navigator.userAgent.slice(0, 300) } : {}) });
    setPending({ runId: p.run_id, summary: p.summary });
  });
  const confirm = guard(async () => { try { await api(`/runs/${pending!.runId}/apply`, {}, { "idempotency-key": pending!.runId }); } finally { setPending(null); } await load(); });
  if (!s?.on) return null;
  if (s.kid && !s.kid.allowed) return <section class="card"><h2>{t("ui.texts_title")}</h2><p class="meta">{t("ui.texts_kid_off")}</p></section>;
  return (
    <section class="card">
      <h2>{t("ui.texts_title")}</h2>
      <p class="meta">{t("ui.texts_hint")}</p>
      {s.phone && !editing && <>
        <p>{t(s.answer ? "ui.texts_on" : "ui.texts_off", { phone: s.phone })}</p>
        {!pending && (s.answer ? <button disabled={busy} onClick={ask(false)}>{t("ui.texts_turn_off")}</button> : <>
          <label class="check"><input type="checkbox" checked={yes} onChange={(e) => setYes(e.currentTarget.checked)} /> {s.form.words}</label>
          <button class="primary" disabled={busy || !yes} onClick={ask(true)}>{t("ui.texts_turn_on")}</button>
        </>)}
        {!pending && <p><button class="link" onClick={() => setEditing(true)}>{t("ui.texts_change_number")}</button></p>}
      </>}
      {editing && <>
        <form onSubmit={(e) => { e.preventDefault(); void sendCode(); }}>
          <label>{t("ui.texts_phone")}<input type="tel" autocomplete="tel" inputMode="tel" required value={phone} onInput={(e) => setPhone(e.currentTarget.value)} /></label>
          <button class={s.waiting_code_for ? "" : "primary"} disabled={busy}>{t("ui.texts_send_code")}</button>
        </form>
        {s.waiting_code_for && <form onSubmit={(e) => { e.preventDefault(); void confirmCode(); }}>
          <label>{t("ui.texts_code")}<input inputMode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required value={code} onInput={(e) => setCode(e.currentTarget.value)} /></label>
          <button class="primary" disabled={busy}>{t("ui.confirm")}</button>
        </form>}
        {s.phone && <p><button class="link" onClick={() => setEditing(false)}>{t("ui.cancel")}</button></p>}
      </>}
      {pending && <div class="sheet"><p>{pending.summary}</p><button type="button" class="primary" disabled={busy} onClick={confirm}>{t("ui.confirm")}</button> <button type="button" onClick={() => setPending(null)}>{t("ui.cancel")}</button></div>}
      {note && <p class="note" role="status">{note}</p>}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}

/** An email for an account that joined by phone: a code to the address, then it's theirs (auth.ts). Asked
 *  for, never required: receipts and messages also wait in the app. */
function AddEmail() {
  const [email, setEmail] = useState(""), [code, setCode] = useState(""), [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const run = (f: () => Promise<void>) => async (e: Event) => { e.preventDefault(); setBusy(true); setError(null); try { await f(); } catch (x) { setError(x instanceof ApiError ? x.message : (x as Error).message); } finally { setBusy(false); } };
  const send = run(async () => { await api("/my/email/start", { email }); setSent(true); });
  const confirm = run(async () => { await api("/my/email/verify", { code }); await loadMe(); });
  return (
    <section class="card" id="email">
      <h2>{t("ui.email_title")}</h2>
      <p class="meta">{t("ui.email_none")}</p>
      {!sent ? <form onSubmit={send}>
        <label>{t("ui.email")}<input type="email" required autocomplete="email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
        <button class="primary" disabled={busy}>{t("ui.email_add")}</button>
      </form> : <form onSubmit={confirm}>
        <p>{t("ui.email_code_sent", { email })}</p>
        <label>{t("ui.code")}<input inputMode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} /></label>
        <button class="primary" disabled={busy}>{t("ui.confirm")}</button>
      </form>}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}

export function Profile({ app = "member" }: { app?: "member" | "staff" }) {
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
        <p>{t("ui.roles", { roles: m.roles.map((r) => r.name ?? t(`role.${r.key}` as Key)).join(", ") })}</p>
        <p class="meta">{t(m.signed_in_with === "passkey" ? "ui.signed_in_with_passkey" : m.signed_in_with === "two_factor" ? "ui.signed_in_with_two_steps"
          : m.signed_in_with === "phone_code" ? "ui.signed_in_with_phone_code" : "ui.signed_in_with_email_code")}</p>
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
      {app === "member" && m.has_email === false && <AddEmail />}
      <PushToggle app={app} />
      {app === "member" && !m.kid && <ClubNews personId={m.person.id} />}
      {app === "member" && <Texts personId={m.person.id} />}
      {app === "member" && <section class="card"><h2>{t("ui.receipts_title")}</h2><p><a href="/receipts">{t("ui.receipts_link")}</a></p></section>}
      <section class="card">
        <h2>{t("ui.passkeys")}</h2>
        <button onClick={addPasskey}>{t("ui.add_passkey")}</button>
      </section>
      <Assistants />
      <TwoStepSettings />
      <AccountData personId={m.person.id} self kid={Boolean(m.kid)} onDeleted={() => { farewell.value = true; me.value = null; }} />
      {note && <p class="note" role="status">{note}</p>}
      {error && <p class="error" role="alert">{error}</p>}
    </main>
  );
}
