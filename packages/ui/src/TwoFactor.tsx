// Two-step sign-in, both apps. After the emailed code, someone who must use two steps gives an authenticator
// code (or a recovery code, or signs in with their passkey); someone with nothing set up sets it up first. And a
// sensitive change that needs a second step (StepUp): given, or set up there and then, and the change goes on.
// Loaded only when it's needed.
import { useEffect, useState } from "preact/hooks";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api, ApiError, club, emailedNote, loadMe, me, signOutHere, t } from "./state.ts";
import { protectedPost } from "./pow.ts";
import { passkeyWords } from "./passkeys.ts";
import { usePreview } from "./Preview.tsx";

type Status = { required: boolean; for_changes?: boolean; authenticator: boolean; passkeys: number; recovery_left: number; two_step_now: boolean; by_link?: boolean };
const message = (e: unknown) => (e instanceof ApiError ? e.message : passkeyWords(e) ?? String((e as Error).message));

/** The recovery codes, once: they're never shown again. */
function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div>
      <h2>{t("ui.recovery_codes_title")}</h2>
      <p>{t("ui.recovery_codes_hint")}</p>
      <ol class="codes">{codes.map((c) => <li>{c}</li>)}</ol>
      <button class="primary" onClick={onDone}>{t("ui.recovery_codes_saved")}</button>
    </div>
  );
}

/** Setting up an authenticator app: scan the code (or type the key), give the first code, keep the recovery codes. */
export function AuthenticatorSetup({ onDone, onStale }: { onDone: () => void; onStale?: () => void }) {
  const [setup, setSetup] = useState<{ challenge_id: string; key: string; qr: string } | null>(null), [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  // Only right after a sign-in (passkeys.ts): later, onStale (the change's sheet then signs in again by email first).
  useEffect(() => { api<{ challenge_id: string; key: string; qr: string }>("/auth/totp/setup", {}).then(setSetup)
    .catch((e) => { if (onStale && e instanceof ApiError && e.code === "error.recent_sign_in") onStale(); else setError(message(e)); }); }, []);
  const confirm = async (e: Event) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { setCodes((await api<{ codes: string[] }>("/auth/totp/confirm", { challenge_id: setup!.challenge_id, code })).codes); }
    catch (x) { setError(message(x)); } finally { setBusy(false); }
  };
  if (codes) return <Codes codes={codes} onDone={onDone} />;
  return (
    <div>
      {setup && <>
        <p>{t("ui.authenticator_scan", { club: club.value?.name ?? "" })}</p>
        <img class="qr" src={setup.qr} alt={t("ui.authenticator_qr_alt")} width={200} height={200} />
        <p class="meta">{t("ui.authenticator_key")} <span class="key">{setup.key}</span></p>
        <form onSubmit={confirm}>
          <label>{t("ui.authenticator_code")}<input inputMode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} /></label>
          <button class="primary" disabled={busy}>{t("ui.authenticator_turn_on")}</button>
        </form>
      </>}
      {error && <p class="error" role="alert">{error}</p>}
    </div>
  );
}

/** The screen between the emailed code and the app, while this session owes its second step. */
export function TwoFactor() {
  const gate = me.value?.gate;
  const [status, setStatus] = useState<Status | null>(null), [mode, setMode] = useState<"code" | "recovery" | "choose" | "authenticator">(gate === "setup" ? "choose" : "code");
  const [code, setCode] = useState(""), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { api<Status>("/my/two-factor").then(setStatus).catch(() => {}); }, []);
  const attempt = async (f: () => Promise<void>) => { setBusy(true); setError(null); try { await f(); } catch (e) { setError(message(e)); } finally { setBusy(false); } };
  const verify = (e: Event) => { e.preventDefault(); attempt(async () => { await api(mode === "recovery" ? "/auth/recovery" : "/auth/totp/verify", { code }); await loadMe(); }); };
  const passkey = () => attempt(async () => {
    const o = await api<{ challenge_id: string; options: any }>("/auth/passkey/sign-in/options", {});
    await api("/auth/passkey/sign-in/verify", { challenge_id: o.challenge_id, response: await startAuthentication({ optionsJSON: o.options }) });
    await loadMe();
  });
  // A new passkey is both steps, but this session was made with the emailed code: sign in with it once.
  const addPasskey = () => attempt(async () => {
    const o = await api<{ challenge_id: string; options: any }>("/auth/passkey/add/options", {});
    await api("/auth/passkey/add/verify", { challenge_id: o.challenge_id, response: await startRegistration({ optionsJSON: o.options }), name: t("ui.passkey_name_default") });
    setNote(t("ui.two_step_passkey_added"));
    await passkey();
  });
  const signOut = () => signOutHere();

  return (
    <main class="card">
      <h1>{t("ui.two_step_title")}</h1>
      {gate === "setup" && mode === "choose" && <>
        <p>{t(status?.by_link ? "ui.two_step_setup_intro_link" : "ui.two_step_setup_intro", { club: club.value?.name ?? "" })}</p>
        <button class="primary" disabled={busy} onClick={addPasskey}>{t("ui.two_step_use_passkey_here")}</button>
        <p class="or">{t("ui.or")}</p>
        <button disabled={busy} onClick={() => setMode("authenticator")}>{t("ui.two_step_use_app")}</button>
      </>}
      {gate === "setup" && mode === "authenticator" && <AuthenticatorSetup onDone={() => void loadMe()} />}
      {gate === "verify" && <>
        {status?.authenticator && <form onSubmit={verify}>
          <p>{t(mode === "recovery" ? "ui.two_step_recovery_hint" : "ui.two_step_code_hint")}</p>
          <label>{t(mode === "recovery" ? "ui.recovery_code" : "ui.authenticator_code")}
            {/* Keyed: a reused box would keep the digits-only pattern, and a recovery code would never pass it. */}
            {mode === "recovery" ? <input key="recovery" required autocomplete="off" value={code} onInput={(e) => setCode(e.currentTarget.value)} />
              : <input key="code" inputMode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} />}
          </label>
          <button class="primary" disabled={busy}>{t("ui.verify")}</button>
          <button type="button" class="link" onClick={() => { setMode(mode === "recovery" ? "code" : "recovery"); setCode(""); }}>{t(mode === "recovery" ? "ui.two_step_use_app_code" : "ui.two_step_use_recovery")}</button>
        </form>}
        {status && status.passkeys > 0 && <><p class="or">{status.authenticator ? t("ui.or") : t("ui.two_step_passkey_hint")}</p><button disabled={busy} onClick={passkey}>{t("ui.use_passkey")}</button></>}
      </>}
      {note && <p class="note" role="status">{note}</p>}
      {error && <p class="error" role="alert">{error}</p>}
      <p><button class="link" onClick={signOut}>{t("ui.sign_out")}</button></p>
    </main>
  );
}

/** A sensitive change refused for want of a second step (Preview.tsx, useStepUp): someone who has one gives it (their
 *  passkey, or the authenticator's code); someone with none sets one up, a passkey on this device or an authenticator
 *  app. Adding one is only for a fresh sign-in (passkeys.ts, mayAddSecondStep): later, a code emailed to them first
 *  makes it fresh. Then onDone, and the change is tried again. */
export function StepUp({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [status, setStatus] = useState<Status | null>(null), [mode, setMode] = useState<"choose" | "authenticator" | "recovery" | "code" | "fresh">("choose");
  const [code, setCode] = useState(""), [sent, setSent] = useState(false), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { api<Status>("/my/two-factor").then(setStatus).catch((e) => setError(message(e))); }, []);
  const attempt = async (f: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await f(); }
    catch (e) { if (e instanceof ApiError && e.code === "error.recent_sign_in") setMode("fresh"); else setError(message(e)); }
    finally { setBusy(false); }
  };
  const finish = async () => { await loadMe(); onDone(); };
  const passkeySignIn = async () => {
    const o = await api<{ challenge_id: string; options: any }>("/auth/passkey/sign-in/options", {});
    await api("/auth/passkey/sign-in/verify", { challenge_id: o.challenge_id, response: await startAuthentication({ optionsJSON: o.options }) });
  };
  const passkey = () => attempt(async () => { await passkeySignIn(); await finish(); });
  // A new passkey is both steps, but this session was made with the emailed code: sign in with it once.
  const addPasskey = () => attempt(async () => {
    const o = await api<{ challenge_id: string; options: any }>("/auth/passkey/add/options", {});
    await api("/auth/passkey/add/verify", { challenge_id: o.challenge_id, response: await startRegistration({ optionsJSON: o.options }), name: t("ui.passkey_name_default") });
    await passkeySignIn(); await finish();
  });
  const verify = (e: Event) => { e.preventDefault(); attempt(async () => { await api(mode === "recovery" ? "/auth/recovery" : "/auth/totp/verify", { code }); setCode(""); await finish(); }); };
  // Signing in again by an emailed code, right here: the new session is fresh, so a second step can be added to it.
  const email = me.value?.email ?? null;
  const sendCode = () => attempt(async () => { await protectedPost("/auth/email/start", { email }); setSent(true); });
  const freshen = (e: Event) => { e.preventDefault(); attempt(async () => { await api("/auth/email/verify", { email, code }); setCode(""); setSent(false); await loadMe(); setMode("choose"); }); };
  const has = Boolean(status && (status.authenticator || status.passkeys > 0));
  return (
    <div>
      <h2>{t("ui.step_up_title")}</h2>
      {status && mode === "fresh" && (email ? <>
        <p>{t("ui.step_up_fresh", { email })}</p>
        {!sent ? <button class="primary" disabled={busy} onClick={sendCode}>{t("ui.step_up_send")}</button> : <form onSubmit={freshen}>
          <p class="meta">{emailedNote(t("ui.code_sent", { email }))}</p>
          <label>{t("ui.step_up_code")}<input inputMode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} /></label>
          <button class="primary" disabled={busy}>{t("ui.verify")}</button>
        </form>}
      </> : <p>{t("ui.step_up_fresh_no_email")}</p>)}
      {status && mode !== "fresh" && has && <>
        <p>{t("ui.step_up_have")}</p>
        {status.authenticator && <form onSubmit={verify}>
          <label>{t(mode === "recovery" ? "ui.recovery_code" : "ui.authenticator_code")}
            {mode === "recovery" ? <input key="recovery" required autocomplete="off" value={code} onInput={(e) => setCode(e.currentTarget.value)} />
              : <input key="code" inputMode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} />}
          </label>
          <button class="primary" disabled={busy}>{t("ui.verify")}</button>
          <button type="button" class="link" onClick={() => { setMode(mode === "recovery" ? "choose" : "recovery"); setCode(""); }}>{t(mode === "recovery" ? "ui.two_step_use_app_code" : "ui.two_step_use_recovery")}</button>
        </form>}
        {status.passkeys > 0 && <>{status.authenticator && <p class="or">{t("ui.or")}</p>}<button disabled={busy} onClick={passkey}>{t("ui.use_passkey")}</button></>}
      </>}
      {status && mode === "choose" && !has && <>
        <p>{t("ui.step_up_intro")}</p>
        <button class="primary" disabled={busy} onClick={addPasskey}>{t("ui.two_step_use_passkey_here")}</button>
        <p class="or">{t("ui.or")}</p>
        <button disabled={busy} onClick={() => setMode("authenticator")}>{t("ui.two_step_use_app")}</button>
      </>}
      {status && mode === "authenticator" && !has && <AuthenticatorSetup onDone={() => void attempt(finish)} onStale={() => setMode("fresh")} />}
      {error && <p class="error" role="alert">{error}</p>}
      <p><button class="link" onClick={onCancel}>{t("ui.back")}</button></p>
    </div>
  );
}

/** In Profile: whether two steps are on, the authenticator, and new recovery codes. */
export function TwoStepSettings() {
  const [status, setStatus] = useState<Status | null>(null), [setting, setSetting] = useState(false), [codes, setCodes] = useState<string[] | null>(null), [error, setError] = useState<string | null>(null);
  const load = () => api<Status>("/my/two-factor").then(setStatus).catch(() => {});
  const { preview, sheet } = usePreview(() => void load());
  useEffect(() => { void load(); }, []);
  const newCodes = async () => { setError(null); try { setCodes((await api<{ codes: string[] }>("/my/two-factor/codes", {})).codes); await load(); } catch (e) { setError(message(e)); } };
  if (!status) return null;
  return (
    <section class="card">
      <h2>{t("ui.two_step_title")}</h2>
      {codes ? <Codes codes={codes} onDone={() => setCodes(null)} /> : setting ? <AuthenticatorSetup onDone={() => { setSetting(false); void load(); }} /> : <>
        <p class="meta">{t(status.required ? "ui.two_step_required" : "ui.two_step_optional")}{!status.required && status.for_changes ? ` ${t("ui.two_step_for_changes")}` : ""}</p>
        <p>{t(status.authenticator ? "ui.authenticator_on" : "ui.authenticator_off")}{status.authenticator ? ` ${t("ui.recovery_left", { count: status.recovery_left })}` : ""}</p>
        {!status.authenticator && <button onClick={() => setSetting(true)}>{t("ui.authenticator_set_up")}</button>}
        {status.authenticator && <><button onClick={newCodes}>{t("ui.recovery_new")}</button> <button onClick={() => preview("person.factor_remove", { person_id: me.value!.person.id })}>{t("ui.authenticator_remove")}</button></>}
      </>}
      {error && <p class="error" role="alert">{error}</p>}
      {sheet}
    </section>
  );
}
