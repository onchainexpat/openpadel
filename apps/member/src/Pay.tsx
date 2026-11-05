// Paying for a place with Stripe's own card form (the Payment Element): card details go from the
// browser to Stripe and never touch Kumi. Kumi then checks with Stripe that the payment went through.
// The same form saves a card without paying (a membership joined before its plan starts).
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, dollars, lang, protectedPost, t, useBackCloses } from "@kumi/ui";

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
export async function confirmPaid(paymentId: string, tries = 8, check = `/my/payments/${paymentId}/check`): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await api<{ status: string }>(check, {});
    if (r.status === "succeeded") return true;
    if (r.status === "failed") return false;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return false;   // still processing: the minute job or Stripe's webhook will record it
}

/** `cardFor`: save the card for that membership instead of paying (nothing is charged). `familyCard`: save the
 *  family card a parent's kids pay with. A kid's own payment never shows a card form: it goes on the family
 *  card, or to a parent to pay. */
export function PaySheet({ paymentId, cardFor, familyCard, amountCents, name, onClose, onPaid }: { paymentId?: string; cardFor?: string; familyCard?: boolean; amountCents: number; name: string; onClose: () => void; onPaid: () => void }) {
  const box = useRef<HTMLDivElement>(null), stripe = useRef<{ stripe: any; elements: any } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "paying" | "checking">("loading"), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  // The phone's back button closes the card form, as its Cancel does.
  useBackCloses(true, onClose);
  const amount = dollars(amountCents, lang.value), setup = Boolean(cardFor || familyCard);
  const urls = familyCard ? { open: "/my/family/card", check: "", back: "/family?card=1" }
    : cardFor ? { open: `/my/memberships/${cardFor}/card`, check: `/my/memberships/${cardFor}/card/check`, back: `/membership?card=${cardFor}` }
    : { open: `/my/payments/${paymentId}/intent`, check: `/my/payments/${paymentId}/check`, back: `/places?paid=${paymentId}` };
  const check = useRef(urls.check);
  const title = familyCard ? t("ui.family_card_title") : cardFor ? t("ui.save_card_title", { name }) : t("ui.pay_title", { amount, name });

  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        type Opened = { client_secret: string; publishable_key: string | null; stripe_account: string | null; card_id?: string; family?: "paid" | "parent"; cents?: number };
        // A card form for a payment passes the bot check first (the server's bot.ts); saving a card doesn't charge.
        const it = setup ? await api<Opened>(urls.open, {}) : await protectedPost<Opened>(urls.open, {});
        if (it.family === "paid") { onPaid(); return; }
        if (it.family === "parent") { setNote(t("ui.kid_parent_pays")); return; }
        if (it.card_id) check.current = `/my/family/card/${it.card_id}/check`;
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
  }, [paymentId, cardFor]);

  const pay = async () => {
    if (!stripe.current) return;
    setState("paying"); setError(null);
    // Only cards that need a bank's page leave the app.
    const confirm = { elements: stripe.current.elements, redirect: "if_required", confirmParams: { return_url: `${location.origin}${urls.back}` } };
    const r = setup ? await stripe.current.stripe.confirmSetup(confirm) : await stripe.current.stripe.confirmPayment(confirm);
    if (r.error) { setError(r.error.message ?? t("ui.pay_failed")); setState("ready"); return; }
    setState("checking");
    if (await confirmPaid(paymentId ?? "", 8, check.current)) onPaid(); else { setError(t("ui.pay_still_processing")); setState("ready"); }
  };

  return (
    <div class="dock">
      <div class="card sheet" role="dialog" aria-modal="true" aria-label={title}>
        <p><strong>{title}</strong></p>
        {cardFor && <p class="meta">{t("ui.save_card_hint", { amount })}</p>}
        {familyCard && <p class="meta">{t("ui.family_card_hint")}</p>}
        {note ? <p class="note" role="status">{note}</p> : <div ref={box} class="card-form" />}
        {state === "loading" && !error && !note && <p class="meta">{t("ui.loading")}</p>}
        {state === "checking" && <p class="note" role="status">{t("ui.pay_confirming")}</p>}
        {error && <p class="error" role="alert">{error}</p>}
        {!note && <button class="primary" disabled={state !== "ready"} onClick={pay}>{familyCard ? t("ui.family_card_save") : cardFor ? t("ui.save_card") : t("ui.pay_now", { amount })}</button>}{" "}
        <button onClick={onClose}>{note ? t("ui.close") : t("ui.cancel")}</button>
      </div>
    </div>
  );
}
