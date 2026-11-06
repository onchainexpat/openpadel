// Gift cards (gift_cards.ts): buy one (paid by card in the sheet), see the codes of the cards you bought, to give
// or print, and redeem a code into your club credit.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, club, dollars, lang, me, t, usePreview } from "@kumi/ui";
import type { Key } from "@kumi/i18n";
import { PaySheet } from "./Pay.tsx";

type Card = { id: string; amount_cents: number; status: "pending" | "active" | "redeemed" | "void"; for_name: string | null; message: string | null; last4: string; bought: boolean; code: string | null };

export function GiftCards() {
  const [cards, setCards] = useState<Card[]>([]), [paying, setPaying] = useState<{ id: string; cents: number } | null>(null), [error, setError] = useState<string | null>(null);
  const { preview, sheet } = usePreview(() => void load());
  const load = async () => setCards(await api<Card[]>("/my/gift-cards").catch(() => []));
  useEffect(() => { void load(); }, []);
  const c = club.value, pid = me.value?.person.id;
  const buy = async (e: Event) => {
    e.preventDefault(); setError(null);
    const f = e.currentTarget as HTMLFormElement, v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
    try {
      const p = await api<{ run_id: string }>("/actions/gift_card.buy/plan", { person_id: pid, cents: Math.round(Number(v("amount")) * 100), for_name: v("for") || undefined, message: v("message") || undefined });
      const r = await api<{ result?: { payment_id: string } }>(`/runs/${p.run_id}/apply`, {}, { "idempotency-key": p.run_id });
      if (r.result) setPaying({ id: r.result.payment_id, cents: Math.round(Number(v("amount")) * 100) });
    } catch (x) { setError(x instanceof ApiError ? x.message : String(x)); }
  };
  return (
    <main>
      <h1>{t("ui.gift_cards_title")}</h1>
      <p class="meta">{t("ui.gift_card_hint")}</p>
      {c?.gift_cards && <section class="card"><h2>{t("ui.gift_card_buy")}</h2>
        <form class="card-form" onSubmit={buy}>
          <label>{t("ui.gift_card_amount")}<input name="amount" type="number" required min={(c.gift_card_min_cents ?? 1000) / 100} max={(c.gift_card_max_cents ?? 50000) / 100} step="1" defaultValue="50" /></label>
          <label>{t("ui.gift_card_for")}<input name="for" maxLength={80} /></label>
          <label>{t("ui.gift_card_message")}<input name="message" maxLength={300} /></label>
          {error && <p class="error" role="alert">{error}</p>}
          <button class="primary">{t("ui.gift_card_buy")}</button>
        </form></section>}
      <section class="card"><h2>{t("ui.gift_card_redeem")}</h2>
        <form class="inline" onSubmit={(e) => { e.preventDefault(); preview("gift_card.redeem", { person_id: pid, code: ((e.currentTarget as HTMLFormElement).elements.namedItem("code") as HTMLInputElement).value }); }}>
          <input name="code" required autocomplete="off" aria-label={t("ui.gift_card_code")} placeholder="XXXX-XXXX-XXXX-XXXX" />
          <button>{t("ui.gift_card_redeem")}</button></form></section>
      {cards.length > 0 && <section class="card"><h2>{t("ui.gift_card_yours")}</h2>
        <ul class="plain">{cards.map((x) => <li key={x.id} class="gift">
          <p><strong>{dollars(x.amount_cents, lang.value)}</strong>{x.for_name ? ` · ${x.for_name}` : ""} · {t(`ui.gift_card_status_${x.status}` as Key)}</p>
          {x.code && <p class="code">{x.code}</p>}
          {x.message && <p class="meta">{x.message}</p>}
          {x.code && <button class="small" onClick={() => print()}>{t("ui.gift_card_print")}</button>}
        </li>)}</ul></section>}
      {paying && <PaySheet paymentId={paying.id} amountCents={paying.cents} name={t("ui.gift_cards_title")} onClose={() => { setPaying(null); void load(); }} onPaid={() => { setPaying(null); void load(); }} />}
      {sheet}
    </main>
  );
}
