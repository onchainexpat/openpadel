// Joining a booking from its link: what it is, what your part costs, then pay it.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, dollars, lang, me, t, usePreview } from "@kumi/ui";
import { PaySheet } from "./Pay.tsx";

type Invite = { id: string; open_match: boolean; code: string; court: string; location: string; time_zone: string; organiser: string | null; start: string; end: string; share_cents: number; spots_left: number; open: boolean };

export function Join({ code }: { code: string }) {
  const [inv, setInv] = useState<Invite | null>(null), [error, setError] = useState<string | null>(null), [paying, setPaying] = useState<string | null>(null), [done, setDone] = useState(false);
  const [provider, setProvider] = useState("test");
  const { preview, sheet } = usePreview((r?: { payment_id?: string }) => { if (r?.payment_id) setPaying(r.payment_id); });
  useEffect(() => {
    // An open match's link goes to the match's own page, where its level band applies.
    api<Invite>(`/bookings/invite/${encodeURIComponent(code)}`).then((x) => { if (x.open_match) location.replace(`/match/${x.id}?code=${encodeURIComponent(code)}`); else setInv(x); })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
    api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {});
  }, [code]);
  if (error) return <main class="card"><p class="error">{error}</p></main>;
  if (!inv) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const when = new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { timeZone: inv.time_zone, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(new Date(inv.start));
  if (done) return <main class="card"><h1>{t("ui.joined_booking")}</h1><p>{inv.court} · {when}</p><p><a href="/places">{t("ui.see_my_bookings")}</a></p></main>;
  return (
    <main>
      {sheet}
      {paying && <PaySheet paymentId={paying} amountCents={inv.share_cents} name={t("ui.court_booking")} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); setDone(true); }} />}
      {paying && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => { await api(`/dev/payments/${paying}/settle`, {}); setPaying(null); setDone(true); }}>{t("ui.pay_test")}</button></p>}
      <section class="card">
        <h1>{t("ui.join_booking_title", { organiser: inv.organiser ?? "" })}</h1>
        <p>{inv.court}, {inv.location} · {when}</p>
        {inv.open ? <>
          <p>{t("ui.your_part", { amount: dollars(inv.share_cents, lang.value) })}</p>
          <button class="primary" onClick={() => preview("booking.join", { invite_code: code, person_id: me.value!.person.id })}>{t("ui.join_and_pay", { amount: dollars(inv.share_cents, lang.value) })}</button>
        </> : <p class="meta">{t("error.invite_closed")}</p>}
      </section>
    </main>
  );
}
