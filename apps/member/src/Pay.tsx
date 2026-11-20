// Paying for a place with Stripe's own card form (the Payment Element): card details go from the
// browser to Stripe and never touch Kumi. Kumi then checks with Stripe that the payment went through.
// The same form saves a card without paying (a membership joined before its plan starts).
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, Skeleton, api, ApiError, club, dollars, lang, protectedPost, serverNow, t, useBackCloses } from "@kumi/ui";
import { cardFormOptions, payMode } from "./pay_mode.ts";
import { clearConfirming, isConfirmingAt, markConfirmingAt } from "./confirming.ts";

/** Whether a payment still waiting in a list was taken by the card form a moment ago (confirming.ts). */
export const isConfirming = (paymentId: string | null | undefined) => isConfirmingAt(paymentId, serverNow());

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

/** Ask Kumi to check with Stripe, a few times: a card can take a moment to settle. "pending": still processing,
 *  and the minute job or Stripe's webhook will record it. */
export async function waitPaid(paymentId: string, tries = 8, check = `/my/payments/${paymentId}/check`): Promise<"succeeded" | "failed" | "pending"> {
  for (let i = 0; i < tries; i++) {
    const r = await api<{ status: string }>(check, {}).catch(() => ({ status: "pending" }));
    if (r.status === "succeeded" || r.status === "failed") return r.status;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return "pending";
}
export async function confirmPaid(paymentId: string, tries = 8, check = `/my/payments/${paymentId}/check`): Promise<boolean> {
  return (await waitPaid(paymentId, tries, check)) === "succeeded";
}

/** While any of these payments reads as confirming (confirming.ts), the list is asked again every few seconds, so
 *  it turns to paid as soon as it's recorded. */
export function useConfirming(paymentIds: (string | null | undefined)[], reload: () => unknown) {
  const waiting = paymentIds.some((id) => isConfirming(id));
  useEffect(() => {
    if (!waiting) return;
    const id = setTimeout(() => void reload(), 4000);
    return () => clearTimeout(id);
  });
}

/** `cardFor`: save the card for that membership instead of paying (nothing is charged). `familyCard`: save the
 *  family card a parent's kids pay with. `cardOnFile`: save the member's card on file (Me), the one everything later
 *  goes on (`replace`: there's one already). A kid's own payment never shows a card form: it goes on the family
 *  card, or to a parent to pay. */
export function PaySheet({ paymentId: firstPayment, cardFor, familyCard, cardOnFile, replace, cardOnly, back, amountCents: firstAmount, name, detail, onClose, onPaid }: { paymentId?: string; cardFor?: string; familyCard?: boolean; cardOnFile?: boolean; replace?: boolean; cardOnly?: boolean; back?: string; amountCents: number; name: string; detail?: string | null; onClose: () => void; onPaid: () => void }) {
  const box = useRef<HTMLDivElement>(null), stripe = useRef<{ stripe: any; elements: any } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "paying" | "checking">("loading"), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  // Prices that include tax: how much of this is tax (the server's includedTaxOf, as its receipt will say).
  const [tax, setTax] = useState<{ cents: number; label: string; rate: string | null } | null>(null);
  // The phone's back button closes the card form, as its Cancel does.
  useBackCloses(true, onClose);
  // Saving a card charges nothing; a gift card or a pass is paid by card only (no credit, passes or promo codes),
  // but it's still a payment: the bot check, then confirmed as a payment (pay_mode.ts).
  const { saveCard, extras } = payMode({ cardFor, familyCard, cardOnFile, cardOnly });
  // Club credit first (credit.ts): asked before the card form opens, since a card form already open can't change.
  // Paid all from credit, the sheet is done; part of a place, the card is asked for the rest, a payment of its own.
  const [paymentId, setPaymentId] = useState(firstPayment), [amountCents, setAmountCents] = useState(firstAmount);
  const [credit, setCredit] = useState<number | null>(extras ? null : 0), [useCredit, setUseCredit] = useState(true), [step, setStep] = useState<"credit" | "card">(extras ? "credit" : "card");
  // A pass of theirs that covers this (passes.ts) is offered first, with the credit; either pays it before any card.
  const [passes, setPasses] = useState<{ id: string; name: string; uses_left: number }[]>([]);
  useEffect(() => {
    if (!extras) return;
    Promise.all([api<{ cents: number }>("/my/credit").catch(() => ({ cents: 0 })), firstPayment ? api<{ id: string; name: string; uses_left: number }[]>(`/my/payments/${firstPayment}/passes`).catch(() => []) : Promise.resolve([])])
      .then(([c, p]) => { setCredit(c.cents); setPasses(p); if (c.cents <= 0 && p.length === 0 && !club.value?.promos) setStep("card"); });
  }, []);
  // A promo code (promo_codes.ts), before the card: the payment is asked again for what's left, or is paid.
  const [promo, setPromo] = useState(""), [promoNote, setPromoNote] = useState<string | null>(null);
  const applyPromo = async () => {
    setError(null); setState("paying");
    try {
      const p = await api<{ run_id: string; summary: string }>("/actions/payment.use_promo/plan", { payment_id: paymentId, code: promo });
      const r = await api<{ result?: { paid: boolean; payment_id: string; rest_cents?: number } }>(`/runs/${p.run_id}/apply`, {}, { "idempotency-key": p.run_id });
      if (r.result?.paid) { onPaid(); return; }
      setPaymentId(r.result?.payment_id); setAmountCents(r.result?.rest_cents ?? amountCents); setPromoNote(p.summary); setPasses([]); setState("ready");
    } catch (e) { setError(e instanceof ApiError ? e.message : t("ui.pay_unavailable")); setState("ready"); }
  };
  const payWithPass = async (passId: string) => {
    setError(null); setState("paying");
    try {
      const p = await api<{ run_id: string }>("/actions/payment.use_pass/plan", { payment_id: paymentId, pass_id: passId });
      await api(`/runs/${p.run_id}/apply`, {}, { "idempotency-key": p.run_id });
      onPaid();
    } catch (e) { setError(e instanceof ApiError ? e.message : t("ui.pay_unavailable")); setState("ready"); }
  };
  const spend = async () => {
    setError(null); setState("paying");
    try {
      const p = await api<{ run_id: string }>("/actions/payment.use_credit/plan", { payment_id: paymentId });
      const r = await api<{ result?: { paid: boolean; payment_id: string; rest_cents?: number } }>(`/runs/${p.run_id}/apply`, {}, { "idempotency-key": p.run_id });
      if (r.result?.paid) { onPaid(); return; }
      setPaymentId(r.result?.payment_id); setAmountCents(r.result?.rest_cents ?? amountCents); setState("loading"); setStep("card");
    } catch (e) { setError(e instanceof ApiError ? e.message : t("ui.pay_unavailable")); setState("ready"); setUseCredit(false); }
  };
  const amount = dollars(amountCents, lang.value);
  const urls = cardOnFile ? { open: "/my/card", check: "", back: "/account" }
    : familyCard ? { open: "/my/family/card", check: "", back: "/family?card=1" }
    : cardFor ? { open: `/my/memberships/${cardFor}/card`, check: `/my/memberships/${cardFor}/card/check`, back: `/membership?card=${cardFor}` }
    : { open: `/my/payments/${paymentId}/intent`, check: `/my/payments/${paymentId}/check`, back: back ?? `/places?paid=${paymentId}` };
  const check = useRef(urls.check), backTo = useRef(urls.back);
  const title = cardOnFile ? t(replace ? "ui.card_replace_title" : "ui.card_add_title") : familyCard ? t("ui.family_card_title") : cardFor ? t("ui.save_card_title", { name }) : t("ui.pay_title", { amount, name });

  useEffect(() => {
    if (step !== "card") return;
    let gone = false;
    (async () => {
      try {
        type Opened = { client_secret: string; publishable_key: string | null; stripe_account: string | null; card_id?: string; family?: "paid" | "parent"; cents?: number; paid?: boolean; tax_cents?: number; tax_label?: string; tax_rate?: string | null };
        // A card form for a payment passes the bot check first (the server's bot.ts); saving a card doesn't charge.
        const it = saveCard ? await api<Opened>(urls.open, {}) : await protectedPost<Opened>(urls.open, {});
        // Paid already (a second tap after the card went through): nothing to pay twice.
        if (it.family === "paid" || it.paid) { onPaid(); return; }
        if (it.family === "parent") { setNote(t("ui.kid_parent_pays")); return; }
        // The card setup's own check (and, back from a bank's page, the address that checks it).
        if (it.card_id && cardOnFile) { check.current = `/my/card/${it.card_id}/check`; backTo.current = `/account?card=${it.card_id}`; }
        else if (it.card_id) check.current = `/my/family/card/${it.card_id}/check`;
        if (it.tax_cents) setTax({ cents: it.tax_cents, label: it.tax_label ?? "", rate: it.tax_rate ?? null });
        if (!it.publishable_key) throw new Error("no publishable key");
        await loadStripeJs();
        if (gone) return;
        // Under Connect the payment is made on the club's own Stripe account, so the form names it.
        const s = window.Stripe!(it.publishable_key, { locale: lang.value === "es" ? "es-419" : "en", ...(it.stripe_account ? { stripeAccount: it.stripe_account } : {}) });
        const brand = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() || "#0B5A55";
        const elements = s.elements({ clientSecret: it.client_secret, appearance: { theme: "stripe", variables: { colorPrimary: brand, borderRadius: "8px" } } });
        elements.create("payment", cardFormOptions(club.value?.country)).mount(box.current!);
        stripe.current = { stripe: s, elements };
        setState("ready");
      } catch (e) { setError(e instanceof ApiError ? e.message : t("ui.pay_unavailable")); }
    })();
    return () => { gone = true; };
  }, [paymentId, cardFor, step]);

  const pay = async () => {
    if (!stripe.current) return;
    setState("paying"); setError(null);
    // Only cards that need a bank's page leave the app.
    const confirm = { elements: stripe.current.elements, redirect: "if_required", confirmParams: { return_url: `${location.origin}${backTo.current}` } };
    const r = saveCard ? await stripe.current.stripe.confirmSetup(confirm) : await stripe.current.stripe.confirmPayment(confirm);
    if (r.error) { setError(r.error.message ?? t("ui.pay_failed")); setState("ready"); return; }
    // The card was taken: it reads as paid, being confirmed, everywhere until it's recorded (confirming.ts).
    if (!saveCard && paymentId) markConfirmingAt(paymentId, serverNow());
    setState("checking");
    const status = await waitPaid(paymentId ?? "", 8, check.current);
    if (status === "succeeded" || (status === "pending" && !saveCard)) { onPaid(); return; }
    if (status === "failed" && paymentId) clearConfirming(paymentId);
    setError(t(status === "failed" ? "ui.pay_failed" : "ui.pay_still_processing")); setState("ready");
  };

  return (
    <div class="dock">
      <div class="card sheet" role="dialog" aria-modal="true" aria-label={title}>
        <p><strong>{title}</strong></p>
        {detail && <p class="meta">{detail}</p>}
        {tax && step === "card" && <p class="meta">{t(tax.rate ? "ui.pay_tax_included_rate" : "ui.pay_tax_included", { amount: dollars(tax.cents, lang.value), tax: tax.label, rate: tax.rate ?? "" })}</p>}
        {cardFor && <p class="meta">{t("ui.save_card_hint", { amount })}</p>}
        {familyCard && <p class="meta">{t("ui.family_card_hint")}</p>}
        {cardOnFile && <p class="meta">{t("ui.card_save_hint")}</p>}
        {step === "credit" && passes.length > 0 && paymentId === firstPayment && <div class="pass-step">
          {passes.map((x) => <p key={x.id}><button class="primary" disabled={state === "paying"} onClick={() => void payWithPass(x.id)}>{t("ui.pass_pay_with", { name: x.name, left: String(x.uses_left) })}</button></p>)}
          {credit !== null && credit <= 0 && !club.value?.promos && <p><button onClick={() => { setError(null); setStep("card"); }}>{t("ui.pass_other_way")}</button>{" "}<button onClick={onClose}>{t("ui.cancel")}</button></p>}
          {credit !== null && credit <= 0 && !club.value?.promos && error && <p class="error" role="alert">{error}</p>}
        </div>}
        {step === "credit" && credit !== null && credit > 0 && <div class="credit-step">
          <p>{t("ui.credit_have", { amount: dollars(credit, lang.value) })}</p>
          <label class="check"><input type="checkbox" checked={useCredit} onChange={(e) => setUseCredit((e.target as HTMLInputElement).checked)} /> {t("ui.credit_use", { amount: dollars(Math.min(credit, amountCents), lang.value) })}</label>
          {useCredit && credit < amountCents && <p class="meta">{t("ui.credit_rest", { amount: dollars(amountCents - credit, lang.value) })}</p>}
          {error && <p class="error" role="alert">{error}</p>}
          <p>{useCredit ? <button class="primary" disabled={state === "paying"} onClick={spend}>{credit >= amountCents ? t("ui.credit_pay", { amount }) : t("ui.credit_continue")}</button>
            : <button class="primary" onClick={() => { setError(null); setStep("card"); }}>{t("ui.credit_continue")}</button>}{" "}<button onClick={onClose}>{t("ui.cancel")}</button></p>
        </div>}
        {step === "card" && (note ? <p class="note" role="status">{note}</p> : <div ref={box} class="card-form" />)}
        {step === "credit" && credit === null && <Skeleton shape="rows" rows={2} />}
        {step === "credit" && credit !== null && club.value?.promos && <div class="promo-step">
          {promoNote ? <p class="note" role="status">{promoNote}</p> : <form class="inline" onSubmit={(e) => { e.preventDefault(); void applyPromo(); }}>
            <input value={promo} onInput={(e) => setPromo(e.currentTarget.value)} maxLength={40} autocomplete="off" aria-label={t("ui.promo_code")} placeholder={t("ui.promo_have")} />
            <button disabled={state === "paying" || promo.trim().length < 2}>{t("ui.promo_apply")}</button></form>}
          {credit <= 0 && <p><button class="primary" onClick={() => { setError(null); setStep("card"); }}>{t("ui.promo_continue")}</button>{" "}<button onClick={onClose}>{t("ui.cancel")}</button></p>}
          {credit <= 0 && error && <p class="error" role="alert">{error}</p>}
        </div>}
        {step === "card" && <>
          {state === "loading" && !error && !note && <Skeleton shape="rows" rows={2} />}
          {state === "checking" && <p class="note" role="status">{t("ui.pay_confirming")}</p>}
          {error && <p class="error" role="alert">{error}</p>}
          {!note && <button class="primary" disabled={state !== "ready"} onClick={pay}>{!cardOnFile && !familyCard && !cardFor && <Icon name="credit-card" />}{cardOnFile ? t("ui.card_save") : familyCard ? t("ui.family_card_save") : cardFor ? t("ui.save_card") : t("ui.pay_now", { amount })}</button>}{" "}
          <button onClick={onClose}>{note ? t("ui.close") : t("ui.cancel")}</button>
        </>}
      </div>
    </div>
  );
}
