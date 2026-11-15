// Wallet: the member's money at the club in one place. Their club credit and what came in and went out of it
// (credit.ts creditHistory), the passes they hold (Passes has the rest), and links to what already lives elsewhere:
// their membership, the card on file (Me), what assistants may spend (Profile) and their receipts. Reads only: there's
// no topping up credit (credit comes from gift cards and refunds), so there's no button for it.
// Loaded when it's first opened.
import { useEffect, useState } from "preact/hooks";
import { api, club, clubTime, dollars, lang, me, t } from "@kumi/ui";
import { brandName, creditKindKey, signedCents } from "./wallet_lines.ts";

type Credit = { cents: number; history: { at: string; cents: number; kind: string }[] };
type Pass = { id: string; name: string; uses: number; uses_left: number; expires_at: string | null; status: "active" | "refunded" };
type Assistant = { id: string; name: string; weekly_cap_cents: number; spent_cents: number };
type CardInfo = { card: { brand: string; last4: string } | null };

export function Wallet() {
  const m = me.value!, c = club.value;
  const [credit, setCredit] = useState<Credit | null | undefined>(undefined), [passes, setPasses] = useState<Pass[]>([]);
  const [plan, setPlan] = useState<string | null>(null), [assistants, setAssistants] = useState<Assistant[]>([]), [card, setCard] = useState<CardInfo["card"] | undefined>(undefined);
  useEffect(() => {
    api<Credit>("/my/credit").then(setCredit).catch(() => setCredit(null));
    api<{ mine: Pass[] }>("/my/passes").then((r) => setPasses(r.mine.filter((x) => x.status === "active" && x.uses_left > 0))).catch(() => {});
    api<{ membership: { name: string } | null }>("/my/membership").then((r) => setPlan(r.membership?.name ?? null)).catch(() => {});
    api<Assistant[]>("/my/assistants").then(setAssistants).catch(() => {});
    if (!m.kid) api<CardInfo>("/my/card").then((r) => setCard(r.card)).catch(() => setCard(null));
  }, [lang.value]);
  const day = (iso: string) => clubTime(iso, { dateStyle: "medium" });
  return (
    <main>
      <h1>{t("ui.wallet_title")}</h1>

      <section class="card" aria-labelledby="wallet-credit">
        <h2 id="wallet-credit">{t("ui.credit_title")}</h2>
        <p class="wallet-balance">{credit === undefined ? "…" : dollars(credit?.cents ?? 0, lang.value)}</p>
        <p class="meta">{t("ui.credit_hint")}</p>
      </section>

      <section class="card" aria-labelledby="wallet-history">
        <h2 id="wallet-history">{t("ui.credit_history")}</h2>
        {credit === undefined ? <p class="meta">{t("ui.loading")}</p> : !credit?.history.length ? <p class="meta">{t("ui.wallet_history_none")}</p> :
          <ul class="plain wallet-list">{credit.history.map((h) => <li>
            <span class="wallet-what"><span>{t(creditKindKey(h.kind))}</span><span class="meta">{day(h.at)}</span></span>
            <span class={`wallet-amount${h.cents > 0 ? " in" : ""}`}>{signedCents(h.cents, (x) => dollars(x, lang.value))}</span>
          </li>)}</ul>}
      </section>

      {(passes.length > 0 || c?.passes) && <section class="card" aria-labelledby="wallet-passes">
        <h2 id="wallet-passes">{t("ui.pass_yours")}</h2>
        {passes.length === 0 ? <p class="meta">{t("ui.wallet_passes_none")}</p> : <ul class="plain wallet-list">{passes.map((x) => <li>
          <span class="wallet-what"><strong>{x.name}</strong>{x.expires_at && <span class="meta">{t("ui.pass_use_by", { date: day(x.expires_at) })}</span>}</span>
          <span class="wallet-amount">{t("ui.pass_uses_left", { left: String(x.uses_left), uses: String(x.uses) })}</span>
        </li>)}</ul>}
        <p><a class="button" href="/passes">{t("ui.wallet_passes_open")}</a></p>
      </section>}

      {assistants.length > 0 && <section class="card" aria-labelledby="wallet-assistants">
        <h2 id="wallet-assistants">{t("ui.wallet_assistants_title")}</h2>
        <ul class="plain wallet-list">{assistants.map((a) => <li>
          <span class="wallet-what"><strong>{a.name}</strong><span class="meta">{t("ui.assistant_spent", { spent: dollars(a.spent_cents, lang.value), cap: dollars(a.weekly_cap_cents, lang.value) })}</span></span>
        </li>)}</ul>
        <p><a class="button" href="/profile#assistants">{t("ui.assistant_change_cap")}</a></p>
      </section>}

      <section class="card list-card" aria-labelledby="wallet-more">
        <h2 id="wallet-more">{t("ui.me_more_title")}</h2>
        <ul class="plain">
          {plan && <li><a class="tap row-link" href="/membership">{t("ui.home_member_pill", { plan })}</a></li>}
          {!m.kid && <li><a class="tap row-link" href="/account#card">{card ? t("ui.wallet_card_row", { card: card.last4 ? t("ui.card_ending", { brand: brandName(card.brand), last4: card.last4 }) : t("ui.me_card_title") }) : t("ui.me_card_title")}</a></li>}
          <li><a class="tap row-link" href="/receipts">{t("ui.receipts_title")}</a></li>
          {c?.gift_cards && <li><a class="tap row-link" href="/gift-cards">{t("ui.gift_cards_title")}</a></li>}
        </ul>
      </section>
    </main>
  );
}
