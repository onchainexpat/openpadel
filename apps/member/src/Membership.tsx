// Membership: mine (what it gives, when it renews, cancelling or keeping it, paying a renewal whose card was
// declined, or the next period of one paid at the desk), or without one, the plans to join and pay for here. A plan that hasn't started yet (a founding
// offer) is joined by saving a card, first charged on its start date. Dates are the club's.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, dollars, lang, me, NewOnly, t, usePreview } from "@kumi/ui";
import { confirmPaid, isConfirming, PaySheet, useConfirming } from "./Pay.tsx";
import { formatLocale } from "@kumi/i18n/format";

type Perks = { days_ahead: number | null; member_prices: boolean; period: "month" | "year"; program_percent_off: number | null; program_cents_off: number | null;
  included_sessions: number | null; included_kinds: string[]; included_used?: number | null };
type Family = { size: number; extra_cents: number | null; payer: string; covered: { person_id: string; display_name: string; until: string | null }[]; can_add: { id: string; display_name: string }[] };
type Mine = Perks & { id: string; brought_from?: string | null; name: string; description: string | null; price_cents: number; period: "month" | "year"; status: string; source: string; cancel_at_period_end: boolean;
  ends_on: string | null; retry_on: string | null; pay_now: { payment_id: string; cents: number } | null; starts_on: string | null; card_saved: boolean; perks_now: boolean; paused_until: string | null;
  balance_cents: number; pay_next: { cents: number } | null;
  mine: boolean; covered_by: string | null; family: Family | null };
type Offer = Perks & { id: string; name: string; description: string | null; price_cents: number; period: "month" | "year"; places_left: number | null; starts_on: string | null;
  family_size: number | null; extra_person_cents: number | null };

const clubDay = (date: string) => new Intl.DateTimeFormat(formatLocale(lang.value), { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const price = (p: { price_cents: number; period: string }) => t(p.period === "year" ? "ui.price_a_year" : "ui.price_a_month", { amount: dollars(p.price_cents, lang.value) });

function PerkList({ p }: { p: Perks }) {
  const items = [p.member_prices && t("ui.perk_prices"), p.days_ahead && t("ui.perk_window", { count: p.days_ahead }),
    p.program_percent_off ? t("ui.perk_program_percent", { percent: p.program_percent_off }) : p.program_cents_off ? t("ui.perk_program_cents", { amount: dollars(p.program_cents_off, lang.value) }) : null,
    p.included_sessions && t("ui.perk_included", { count: p.included_sessions, period: t(`ui.period_${p.period}`), kinds: p.included_kinds.map((k) => t(`kind.${k}` as Key)).join(", ") }),
    p.included_sessions && p.included_used != null && t("ui.included_used", { used: p.included_used, of: p.included_sessions })].filter(Boolean);
  return items.length ? <ul>{items.map((x) => <li>{x}</li>)}</ul> : null;
}

/** A family plan: who it covers (the payer and the people they added), and who else from the family can be added. */
function FamilyCover({ m, send }: { m: Mine; send: (action: string, input: unknown) => Promise<void> }) {
  const f = m.family!;
  return (
    <section class="card">
      <h2>{t("ui.family_covered")}</h2>
      <p class="meta">{t("ui.family_size_note", { count: f.size })}{f.extra_cents !== null ? ` ${t("ui.family_extra_note", { amount: dollars(f.extra_cents, lang.value), period: t(`ui.period_${m.period}`) })}` : ""}</p>
      <ul class="plain">
        <li class="row"><span>{f.payer}{m.mine ? ` (${t("ui.you_label")})` : ""}</span></li>
        {f.covered.map((x) => <li class="row"><span>{x.display_name}{x.until ? <span class="meta"> · {t("ui.family_until", { date: clubDay(x.until) })}</span> : null}</span>
          {m.mine && !x.until && <button class="small" onClick={() => send("membership.remove_person", { membership_id: m.id, person_id: x.person_id })}>{t("ui.take_off")}</button>}</li>)}
      </ul>
      {m.mine && f.can_add.length > 0 && <>
        <h2>{t("ui.family_add_from")}</h2>
        <ul class="plain">{f.can_add.map((x) => <li class="row"><span>{x.display_name}</span>
          <button class="small primary" onClick={() => send("membership.add_person", { membership_id: m.id, person_id: x.id })}>{t("ui.family_add")}</button></li>)}</ul>
      </>}
      {m.mine && !f.can_add.length && !f.covered.length && <p class="meta">{t("ui.family_none_to_add")} <a href="/family">{t("ui.nav_family")}</a></p>}
    </section>
  );
}

export function Membership() {
  const [mine, setMine] = useState<Mine | null | undefined>(undefined), [offers, setOffers] = useState<Offer[]>([]), [provider, setProvider] = useState("test");
  const [chosen, setChosen] = useState<Offer | null>(null), [welcome, setWelcome] = useState(false);
  const [paying, setPaying] = useState<{ id: string; cents: number; name: string; card?: boolean } | null>(null);
  // Paying the next period of one from the desk: what the card form is for, once the payment is asked.
  const [next, setNext] = useState<{ cents: number; name: string } | null>(null);
  const load = async () => {
    const r = await api<{ membership: Mine | null }>("/my/membership");
    setMine(r.membership);
    if (!r.membership) setOffers(await api<Offer[]>("/membership-plans"));
  };
  const { preview, sheet } = usePreview((r?: { payment_id?: string; membership_id?: string; save_card?: boolean }) => {
    if (r?.payment_id && next) { setPaying({ id: r.payment_id, cents: next.cents, name: next.name }); setNext(null); }
    else if (r?.payment_id && chosen) setPaying({ id: r.payment_id, cents: chosen.price_cents, name: chosen.name });
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
  useConfirming([mine?.pay_now?.payment_id], load);
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
          {mine.covered_by && <p class="note">{t("ui.covered_by", { name: mine.covered_by, plan: mine.name })}</p>}
          {mine.description && <p>{mine.description}</p>}
          <PerkList p={mine} />
          {mine.paused_until && <p class="note">{t("ui.membership_paused_until", { date: clubDay(mine.paused_until) })}</p>}
          {mine.status === "upcoming" && mine.perks_now && <p class="note">{t("ui.perks_already", { date: clubDay(mine.starts_on!) })}</p>}
          {mine.mine && mine.status === "upcoming" && <>
            <p>{mine.card_saved ? t("ui.place_saved", { date: clubDay(mine.starts_on!), amount: dollars(mine.price_cents, lang.value) })
              : t("ui.place_needs_card", { date: clubDay(mine.starts_on!) })}</p>
            {!mine.card_saved && <button class="primary" onClick={() => setPaying({ id: mine.id, cents: mine.price_cents, name: mine.name, card: true })}>{t("ui.save_card")}</button>}{" "}
            <button onClick={() => preview("membership.cancel", { membership_id: mine.id })}>{t("ui.give_up_place")}</button>
          </>}
          {mine.mine && mine.status === "past_due" && mine.pay_now && <div class="note">
            <p>{t("ui.renewal_declined", { amount: dollars(mine.pay_now.cents, lang.value), date: mine.retry_on ? clubDay(mine.retry_on) : "" })}</p>
            {isConfirming(mine.pay_now.payment_id) ? <p class="meta" role="status">{t("ui.paid_confirming")}</p>
              : <button class="primary" onClick={() => setPaying({ id: mine.pay_now!.payment_id, cents: mine.pay_now!.cents, name: mine.name })}>{t("ui.pay_now", { amount: dollars(mine.pay_now.cents, lang.value) })}</button>}
          </div>}
          {mine.mine && mine.brought_from && mine.source === "app" && !mine.card_saved && mine.status === "active" && <div class="note">
            <p>{t("ui.brought_keep", { date: clubDay(mine.ends_on!), amount: dollars(mine.price_cents, lang.value), period: t(`ui.period_${mine.period}` as Key) })}</p>
            <button class="primary" onClick={() => setPaying({ id: mine.id, cents: mine.price_cents, name: mine.name, card: true })}>{t("ui.brought_add_card")}</button>
          </div>}
          {mine.status === "upcoming" || !mine.mine || (mine.brought_from && mine.source === "app" && !mine.card_saved) ? null : mine.source === "app" ? <>
            <p class="meta">{mine.cancel_at_period_end ? t("ui.cancelled_runs_until", { date: clubDay(mine.ends_on!) })
              : t("ui.renews_on_for", { date: clubDay(mine.ends_on!), amount: dollars(mine.price_cents, lang.value) })}</p>
            {mine.cancel_at_period_end
              ? <button class="primary" onClick={() => preview("membership.resume", { membership_id: mine.id })}>{t("ui.keep_membership")}</button>
              : <button onClick={() => preview("membership.cancel", { membership_id: mine.id })}>{t("ui.cancel_membership")}</button>}
          </> : <>
            <p class="meta">{mine.ends_on ? t("ui.membership_runs_until", { date: clubDay(mine.ends_on) }) : t("ui.given_by_club")}</p>
            {mine.mine && mine.balance_cents > 0 && <p class="note">{t("ui.membership_owed_member", { amount: dollars(mine.balance_cents, lang.value) })}</p>}
            {mine.mine && mine.pay_next && <div class="note">
              <p>{t("ui.pay_next_hint")}</p>
              <button class="primary" onClick={() => { setNext({ cents: mine.pay_next!.cents, name: mine.name }); void preview("membership.pay_next", { membership_id: mine.id }); }}>
                {t("ui.pay_next_period", { amount: dollars(mine.pay_next.cents, lang.value) })}</button>
            </div>}
          </>}
        </section>
      ) : null}
      {mine?.family && <FamilyCover m={mine} send={preview} />}
      {mine ? null : me.value?.kid ? <p class="card">{t("ui.kid_membership_parents")}</p> : offers.length === 0 ? <p class="card">{t("ui.no_plans_in_app")}</p> : offers.map((o) => (
        <section class="card">
          <h2>{o.name} <span class="meta">{price(o)}</span></h2>
          {o.description && <p>{o.description}</p>}
          <PerkList p={o} />
          {o.family_size && <p class="meta">{t("ui.family_size_note", { count: o.family_size })}{o.extra_person_cents !== null ? ` ${t("ui.family_extra_note", { amount: dollars(o.extra_person_cents, lang.value), period: t(`ui.period_${o.period}`) })}` : ""}</p>}
          {(o.starts_on || o.places_left !== null) && <p class="meta">{[o.starts_on ? t("ui.plan_starts_on", { date: clubDay(o.starts_on) }) : null,
            o.places_left ? t("ui.places_left", { count: o.places_left }) : null].filter(Boolean).join(" · ")}</p>}
          {o.places_left === 0 ? <p class="meta">{t("ui.plan_full")}</p>
            : <NewOnly><button class="primary" onClick={() => { setChosen(o); void preview("membership.join", { plan_id: o.id, person_id: me.value!.person.id }); }}>
              {o.starts_on ? t("ui.join_presale") : t("ui.join_plan", { amount: dollars(o.price_cents, lang.value) })}</button></NewOnly>}
        </section>
      ))}
    </main>
  );
}
