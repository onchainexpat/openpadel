// Membership: mine (what it gives, when it renews, cancelling or keeping it, paying a renewal whose card was
// declined), or without one, the plans to join and pay for here. A plan that hasn't started yet (a founding
// offer) is joined by saving a card, first charged on its start date. Dates are the club's.
import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, me, t, usePreview } from "@kumi/ui";
import { confirmPaid, PaySheet } from "./Pay.tsx";

type Perks = { days_ahead: number | null; member_prices: boolean };
type Mine = Perks & { id: string; name: string; description: string | null; price_cents: number; period: "month" | "year"; status: string; source: string; cancel_at_period_end: boolean;
  ends_on: string | null; retry_on: string | null; pay_now: { payment_id: string; cents: number } | null; starts_on: string | null; card_saved: boolean; paused_until: string | null };
type Offer = Perks & { id: string; name: string; description: string | null; price_cents: number; period: "month" | "year"; places_left: number | null; starts_on: string | null };

const clubDay = (date: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const price = (p: { price_cents: number; period: string }) => t(p.period === "year" ? "ui.price_a_year" : "ui.price_a_month", { amount: dollars(p.price_cents, lang.value) });

function PerkList({ p }: { p: Perks }) {
  if (!p.member_prices && !p.days_ahead) return null;
  return <ul>{p.member_prices && <li>{t("ui.perk_prices")}</li>}{p.days_ahead && <li>{t("ui.perk_window", { count: p.days_ahead })}</li>}</ul>;
}

export function Membership() {
  const [mine, setMine] = useState<Mine | null | undefined>(undefined), [offers, setOffers] = useState<Offer[]>([]), [provider, setProvider] = useState("test");
  const [chosen, setChosen] = useState<Offer | null>(null), [welcome, setWelcome] = useState(false);
  const [paying, setPaying] = useState<{ id: string; cents: number; name: string; card?: boolean } | null>(null);
  const load = async () => {
    const r = await api<{ membership: Mine | null }>("/my/membership");
    setMine(r.membership);
    if (!r.membership) setOffers(await api<Offer[]>("/membership-plans"));
  };
  const { preview, sheet } = usePreview((r?: { payment_id?: string; membership_id?: string; save_card?: boolean }) => {
    if (r?.payment_id && chosen) setPaying({ id: r.payment_id, cents: chosen.price_cents, name: chosen.name });
    else if (r?.save_card && r.membership_id && chosen) { setPaying({ id: r.membership_id, cents: chosen.price_cents, name: chosen.name, card: true }); void load(); }
    else void load();
  });
  useEffect(() => {
    void load(); api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {});
    // Back from a bank's own check while saving a card: see whether it was saved.
    const back = new URLSearchParams(location.search).get("card");
    if (back) { history.replaceState(null, "", "/membership"); confirmPaid("", 8, `/my/memberships/${back}/card/check`).then(() => load()); }
  }, [lang.value]);
  const paid = async () => { setPaying(null); setWelcome(!mine); setChosen(null); await load(); };
  if (mine === undefined) return <main class="card"><p>{t("ui.loading")}</p></main>;

  return (
    <main>
      <h1>{t("ui.nav_membership")}</h1>
      {sheet}
      {paying && <PaySheet {...(paying.card ? { cardFor: paying.id } : { paymentId: paying.id })} amountCents={paying.cents} name={paying.name} onClose={() => setPaying(null)} onPaid={paid} />}
      {paying && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => {
        await api(paying.card ? `/dev/memberships/${paying.id}/card` : `/dev/payments/${paying.id}/settle`, {}); await paid(); }}>{t(paying.card ? "ui.save_card_test" : "ui.pay_test")}</button></p>}
      {welcome && <p class="note" role="status">{t("ui.welcome_member")}</p>}
      {mine ? (
        <section class="card">
          <h2>{mine.name}</h2>
          {mine.description && <p>{mine.description}</p>}
          <PerkList p={mine} />
          {mine.paused_until && <p class="note">{t("ui.membership_paused_until", { date: clubDay(mine.paused_until) })}</p>}
          {mine.status === "upcoming" && <>
            <p>{mine.card_saved ? t("ui.place_saved", { date: clubDay(mine.starts_on!), amount: dollars(mine.price_cents, lang.value) })
              : t("ui.place_needs_card", { date: clubDay(mine.starts_on!) })}</p>
            {!mine.card_saved && <button class="primary" onClick={() => setPaying({ id: mine.id, cents: mine.price_cents, name: mine.name, card: true })}>{t("ui.save_card")}</button>}{" "}
            <button onClick={() => preview("membership.cancel", { membership_id: mine.id })}>{t("ui.give_up_place")}</button>
          </>}
          {mine.status === "past_due" && mine.pay_now && <div class="note">
            <p>{t("ui.renewal_declined", { amount: dollars(mine.pay_now.cents, lang.value), date: mine.retry_on ? clubDay(mine.retry_on) : "" })}</p>
            <button class="primary" onClick={() => setPaying({ id: mine.pay_now!.payment_id, cents: mine.pay_now!.cents, name: mine.name })}>{t("ui.pay_now", { amount: dollars(mine.pay_now.cents, lang.value) })}</button>
          </div>}
          {mine.status === "upcoming" ? null : mine.source === "app" ? <>
            <p class="meta">{mine.cancel_at_period_end ? t("ui.cancelled_runs_until", { date: clubDay(mine.ends_on!) })
              : t("ui.renews_on_for", { date: clubDay(mine.ends_on!), amount: dollars(mine.price_cents, lang.value) })}</p>
            {mine.cancel_at_period_end
              ? <button class="primary" onClick={() => preview("membership.resume", { membership_id: mine.id })}>{t("ui.keep_membership")}</button>
              : <button onClick={() => preview("membership.cancel", { membership_id: mine.id })}>{t("ui.cancel_membership")}</button>}
          </> : <p class="meta">{mine.ends_on ? t("ui.membership_runs_until", { date: clubDay(mine.ends_on) }) : t("ui.given_by_club")}</p>}
        </section>
      ) : offers.length === 0 ? <p class="card">{t("ui.no_plans_in_app")}</p> : offers.map((o) => (
        <section class="card">
          <h2>{o.name} <span class="meta">{price(o)}</span></h2>
          {o.description && <p>{o.description}</p>}
          <PerkList p={o} />
          {(o.starts_on || o.places_left !== null) && <p class="meta">{[o.starts_on ? t("ui.plan_starts_on", { date: clubDay(o.starts_on) }) : null,
            o.places_left ? t("ui.places_left", { count: o.places_left }) : null].filter(Boolean).join(" · ")}</p>}
          {o.places_left === 0 ? <p class="meta">{t("ui.plan_full")}</p>
            : <button class="primary" onClick={() => { setChosen(o); void preview("membership.join", { plan_id: o.id, person_id: me.value!.person.id }); }}>
              {o.starts_on ? t("ui.join_presale") : t("ui.join_plan", { amount: dollars(o.price_cents, lang.value) })}</button>}
        </section>
      ))}
    </main>
  );
}
