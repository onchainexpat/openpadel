// A "take my place" link, opened: whose place, the match, and (inside the band) taking it and paying. The
// place is the sub's once the payment goes through; until then its player is still in.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, dollars, lang, me, t, usePreview } from "@kumi/ui";
import { PaySheet } from "./Pay.tsx";
import { formatLocale } from "@kumi/i18n/format";

type Offer = { from: string; share_cents: number; can: "take" | "outside" | "closed" | "not_yours" | "in";
  match: { id: string; court: string; location: string; time_zone: string; start: string; level_min: string; level_max: string; rated: boolean; my_level: number | null;
    me: { pending_payment_id: string | null; sub: boolean } | null } };

export function TakePlace({ code }: { code: string }) {
  const [o, setO] = useState<Offer | null>(null), [error, setError] = useState<string | null>(null), [paying, setPaying] = useState<string | null>(null), [provider, setProvider] = useState("test");
  const load = () => api<Offer>(`/my/place-offers/${encodeURIComponent(code)}`).then(setO).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  const { preview, sheet } = usePreview((r?: { payment_id?: string }) => { if (r?.payment_id) setPaying(r.payment_id); void load(); });
  useEffect(() => { void load(); api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {}); }, [code]);
  if (error) return <main class="card"><p class="error">{error}</p></main>;
  if (!o) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const m = o.match, amount = dollars(o.share_cents, lang.value), band = `${Number(m.level_min).toFixed(2)}-${Number(m.level_max).toFixed(2)}`;
  const when = new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: m.time_zone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(m.start));
  const pending = m.me?.sub ? m.me.pending_payment_id : null;
  return (
    <main>
      <h1>{t("ui.take_title", { name: o.from })}</h1>
      {sheet}
      {paying && <PaySheet paymentId={paying} amountCents={o.share_cents} name={m.court} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); void load(); }} />}
      {paying && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => { await api(`/dev/payments/${paying}/settle`, {}); setPaying(null); void load(); }}>{t("ui.pay_test")}</button></p>}
      <section class="card">
        <p><strong>{when}</strong> · {m.court}, {m.location}</p>
        <p class="meta">{t("ui.levels_band", { band })} · {t(m.rated ? "ui.match_rated" : "ui.match_friendly")} · {t("ui.place_price", { amount })}</p>
        {o.can === "take" && (pending
          ? <button class="primary" onClick={() => setPaying(pending)}>{t("ui.pay_now", { amount })}</button>
          : <button class="primary" onClick={() => preview("booking.take_place", { code, person_id: me.value!.person.id })}>{t("ui.take_pay", { amount })}</button>)}
        {o.can === "outside" && <p class="meta">{t("error.take_outside_band", { level: m.my_level === null ? t("ui.no_level_yet") : m.my_level.toFixed(2), band })}</p>}
        {o.can === "closed" && <p class="meta">{t("error.offer_closed")}</p>}
        {o.can === "not_yours" && <p class="meta">{t("error.offer_not_yours")}</p>}
        {o.can === "in" && <p>{t("ui.take_in")}</p>}
        <p><a href={`/match/${m.id}`}>{t("ui.see_match")}</a></p>
      </section>
    </main>
  );
}
