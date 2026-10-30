// Membership: mine (what it gives, when it renews, cancelling or keeping it, paying a renewal whose card was
// declined), or without one, the plans to join and pay for here. Dates are the club's.
import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, me, t, usePreview } from "@kumi/ui";
import { PaySheet } from "./Pay.tsx";

type Perks = { days_ahead: number | null; member_prices: boolean };
type Mine = Perks & { id: string; name: string; description: string | null; price_cents: number; period: "month" | "year"; status: string; source: string; cancel_at_period_end: boolean;
  ends_on: string | null; retry_on: string | null; pay_now: { payment_id: string; cents: number } | null };
type Offer = Perks & { id: string; name: string; description: string | null; price_cents: number; period: "month" | "year" };

const clubDay = (date: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const price = (p: { price_cents: number; period: string }) => t(p.period === "year" ? "ui.price_a_year" : "ui.price_a_month", { amount: dollars(p.price_cents, lang.value) });

function PerkList({ p }: { p: Perks }) {
  if (!p.member_prices && !p.days_ahead) return null;
  return <ul>{p.member_prices && <li>{t("ui.perk_prices")}</li>}{p.days_ahead && <li>{t("ui.perk_window", { count: p.days_ahead })}</li>}</ul>;
}

export function Membership() {
  const [mine, setMine] = useState<Mine | null | undefined>(undefined), [offers, setOffers] = useState<Offer[]>([]), [provider, setProvider] = useState("test");
  const [chosen, setChosen] = useState<Offer | null>(null), [paying, setPaying] = useState<{ id: string; cents: number; name: string } | null>(null), [welcome, setWelcome] = useState(false);
  const load = async () => {
    const r = await api<{ membership: Mine | null }>("/my/membership");
    setMine(r.membership);
    if (!r.membership) setOffers(await api<Offer[]>("/membership-plans"));
  };
  const { preview, sheet } = usePreview((r?: { payment_id?: string }) => {
    if (r?.payment_id && chosen) setPaying({ id: r.payment_id, cents: chosen.price_cents, name: chosen.name });
    else void load();
  });
  useEffect(() => { void load(); api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {}); }, [lang.value]);
  const paid = async () => { setPaying(null); setWelcome(!mine); setChosen(null); await load(); };
  if (mine === undefined) return <main class="card"><p>{t("ui.loading")}</p></main>;

  return (
    <main>
      <h1>{t("ui.nav_membership")}</h1>
      {sheet}
      {paying && <PaySheet paymentId={paying.id} amountCents={paying.cents} name={paying.name} onClose={() => setPaying(null)} onPaid={paid} />}
      {paying && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => { await api(`/dev/payments/${paying.id}/settle`, {}); await paid(); }}>{t("ui.pay_test")}</button></p>}
      {welcome && <p class="note" role="status">{t("ui.welcome_member")}</p>}
      {mine ? (
        <section class="card">
          <h2>{mine.name}</h2>
          {mine.description && <p>{mine.description}</p>}
          <PerkList p={mine} />
          {mine.status === "past_due" && mine.pay_now && <div class="note">
            <p>{t("ui.renewal_declined", { amount: dollars(mine.pay_now.cents, lang.value), date: mine.retry_on ? clubDay(mine.retry_on) : "" })}</p>
            <button class="primary" onClick={() => setPaying({ id: mine.pay_now!.payment_id, cents: mine.pay_now!.cents, name: mine.name })}>{t("ui.pay_now", { amount: dollars(mine.pay_now.cents, lang.value) })}</button>
          </div>}
          {mine.source === "app" ? <>
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
          <button class="primary" onClick={() => { setChosen(o); void preview("membership.join", { plan_id: o.id, person_id: me.value!.person.id }); }}>{t("ui.join_plan", { amount: dollars(o.price_cents, lang.value) })}</button>
        </section>
      ))}
    </main>
  );
}
