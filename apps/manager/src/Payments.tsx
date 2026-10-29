import { useEffect, useState } from "preact/hooks";
import { api, ApiError, t } from "@kumi/ui";

type P = { mode: "test" | "direct" | "connect"; live: boolean; account: { tail: string; charges_enabled: boolean; details_submitted: boolean } | null };

/** Where the club's card payments go. Hosted Kumi: "Connect with Stripe", then Stripe's own setup pages. */
export function Payments() {
  const [d, setD] = useState<P | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  const load = () => api<P>("/staff/payments").then(setD);
  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ url?: string; awaiting_approval?: string }>("/staff/payments/connect", {});
      if (r.url) { location.href = r.url; return; }
      setNote(t("ui.sent_for_approval"));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    setBusy(false);
  };
  useEffect(() => {
    // Back from Stripe: "return" when the person finished or left setup, "refresh" when the link ran out.
    const back = new URLSearchParams(location.search).get("stripe");
    if (back) history.replaceState(null, "", "/payments");
    if (back === "refresh") { void connect(); return; }
    (back === "return" ? api("/staff/payments/refresh", {}).catch(() => {}) : Promise.resolve()).then(load);
  }, []);
  // Stripe has the details and is checking them: the server asks Stripe every 30 seconds, so look again.
  const checking = Boolean(d?.account?.details_submitted && !d.account.charges_enabled);
  useEffect(() => {
    if (!checking) return;
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [checking]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const a = d.account;
  return (
    <main>
      <h1>{t("ui.payments_title")}</h1>
      <section class="card">
        {d.mode === "test" && <p>{t("ui.payments_test")}</p>}
        {d.mode === "direct" && <p>{t("ui.payments_direct")}</p>}
        {d.mode === "connect" && !a && <>
          <p>{t("ui.payments_connect_intro")}</p>
          <ul>{(["ui.payments_point_money", "ui.payments_point_fees", "ui.payments_point_refunds"] as const).map((k) => <li>{t(k)}</li>)}</ul>
          <p class="meta">{t("ui.payments_who")}</p>
          <button class="primary" disabled={busy} onClick={connect}>{t("ui.payments_connect")}</button>
        </>}
        {d.mode === "connect" && checking && <>
          <p>{t("ui.payments_checking", { tail: a!.tail })}</p>
          <p class="meta">{t("ui.payments_checking_more")}</p>
          <button disabled={busy} onClick={connect}>{t("ui.payments_continue")}</button>
        </>}
        {d.mode === "connect" && a && !a.charges_enabled && !a.details_submitted && <>
          <p>{t("ui.payments_finish", { tail: a.tail })}</p>
          <button class="primary" disabled={busy} onClick={connect}>{t("ui.payments_continue")}</button>
        </>}
        {d.mode === "connect" && a?.charges_enabled && <>
          <p>{t("ui.payments_ready", { tail: a.tail })}</p>
          <p><a href="https://dashboard.stripe.com/" target="_blank" rel="noopener">{t("ui.payments_dashboard")}</a></p>
        </>}
        {d.mode !== "test" && !d.live && <p class="meta">{t("ui.payments_test_mode")}</p>}
        {note && <p class="note" role="status">{note}</p>}
        {error && <p class="error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
