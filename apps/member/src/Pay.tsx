// Paying for a place with Stripe's own card form (the Payment Element): card details go from the
// browser to Stripe and never touch Kumi. Kumi then checks with Stripe that the payment went through.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, dollars, lang, t } from "@kumi/ui";

declare global { interface Window { Stripe?: (publishableKey: string, options?: object) => any } }

let stripeJs: Promise<void> | null = null;
/** Stripe's script must come from Stripe, never bundled; it's loaded the first time someone pays. */
function loadStripeJs(): Promise<void> {
  stripeJs ??= new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/";
    s.onload = () => ok();
    s.onerror = () => { stripeJs = null; fail(new Error("stripe.js didn't load")); };
    document.head.append(s);
  });
  return stripeJs;
}

/** Ask Kumi to check with Stripe, a few times: a card can take a moment to settle. */
export async function confirmPaid(paymentId: string, tries = 8): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await api<{ status: string }>(`/my/payments/${paymentId}/check`, {});
    if (r.status === "succeeded") return true;
    if (r.status === "failed") return false;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return false;   // still processing: the minute job or Stripe's webhook will record it
}

export function PaySheet({ paymentId, amountCents, name, onClose, onPaid }: { paymentId: string; amountCents: number; name: string; onClose: () => void; onPaid: () => void }) {
  const box = useRef<HTMLDivElement>(null), stripe = useRef<{ stripe: any; elements: any } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "paying" | "checking">("loading"), [error, setError] = useState<string | null>(null);
  const amount = dollars(amountCents, lang.value);

  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const it = await api<{ client_secret: string; publishable_key: string | null; stripe_account: string | null }>(`/my/payments/${paymentId}/intent`, {});
        if (!it.publishable_key) throw new Error("no publishable key");
        await loadStripeJs();
        if (gone) return;
        // Under Connect the payment is made on the club's own Stripe account, so the form names it.
        const s = window.Stripe!(it.publishable_key, { locale: lang.value === "es" ? "es-419" : "en", ...(it.stripe_account ? { stripeAccount: it.stripe_account } : {}) });
        const brand = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() || "#0B5A55";
        const elements = s.elements({ clientSecret: it.client_secret, appearance: { theme: "stripe", variables: { colorPrimary: brand, borderRadius: "8px" } } });
        elements.create("payment", { layout: "tabs" }).mount(box.current!);
        stripe.current = { stripe: s, elements };
        setState("ready");
      } catch (e) { setError(e instanceof ApiError ? e.message : t("ui.pay_unavailable")); }
    })();
    return () => { gone = true; };
  }, [paymentId]);

  const pay = async () => {
    if (!stripe.current) return;
    setState("paying"); setError(null);
    const r = await stripe.current.stripe.confirmPayment({ elements: stripe.current.elements, redirect: "if_required",
      confirmParams: { return_url: `${location.origin}/places?paid=${paymentId}` } });   // only cards that need a bank's page leave the app
    if (r.error) { setError(r.error.message ?? t("ui.pay_failed")); setState("ready"); return; }
    setState("checking");
    if (await confirmPaid(paymentId)) onPaid(); else { setError(t("ui.pay_still_processing")); setState("ready"); }
  };

  return (
    <div class="dock">
      <div class="card sheet" role="dialog" aria-modal="true" aria-label={t("ui.pay_title", { amount, name })}>
        <p><strong>{t("ui.pay_title", { amount, name })}</strong></p>
        <div ref={box} class="card-form" />
        {state === "loading" && !error && <p class="meta">{t("ui.loading")}</p>}
        {state === "checking" && <p class="note" role="status">{t("ui.pay_confirming")}</p>}
        {error && <p class="error" role="alert">{error}</p>}
        <button class="primary" disabled={state !== "ready"} onClick={pay}>{t("ui.pay_now", { amount })}</button> <button onClick={onClose}>{t("ui.cancel")}</button>
      </div>
    </div>
  );
}
