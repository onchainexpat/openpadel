import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, t, usePreview } from "@kumi/ui";
import { confirmPaid, PaySheet } from "./Pay.tsx";

type Place = { id: string; status: string; waitlist_position: number | null; name: string; price_cents: number; first_start: string | null; offer_expires_at: string | null; pending_payment_id: string | null; paid_cents: number };

export function MyPlaces() {
  const [rows, setRows] = useState<Place[] | null>(null);
  const [provider, setProvider] = useState<string | null>(null), [paying, setPaying] = useState<Place | null>(null), [paid, setPaid] = useState(false);
  const load = () => api<Place[]>("/my/places").then(setRows);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  useEffect(() => {
    api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {});
    // Back from a bank's own check (only some cards need one): see whether the payment went through.
    const back = new URLSearchParams(location.search).get("paid");
    if (back) { history.replaceState(null, "", "/places"); confirmPaid(back).then((ok) => { setPaid(ok); load(); }); }
  }, []);
  const clock = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "");
  const payTest = async (id: string) => { await api(`/dev/payments/${id}/settle`, {}); load(); };
  return (
    <main>
      <h1>{t("ui.nav_my")}</h1>
      {sheet}
      {paid && <p class="note" role="status">{t("ui.pay_done")}</p>}
      {paying && <PaySheet paymentId={paying.pending_payment_id!} amountCents={paying.price_cents} name={paying.name} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); setPaid(true); load(); }} />}
      {rows?.length === 0 && <p>{t("ui.no_places")}</p>}
      <ul class="changes">{(rows ?? []).map((p) => (
        <li class="card" key={p.id}>
          <div class="summary">{p.name}</div>
          <div class="meta">{when(p.first_start)} · {p.status === "booked" ? t("ui.youre_in") : t("ui.on_waitlist", { n: p.waitlist_position ?? 0 })}
            {p.paid_cents > 0 ? ` · ${t("ui.you_paid", { amount: dollars(p.paid_cents, lang.value) })}` : p.pending_payment_id ? ` · ${t("ui.pay_pending")}` : ""}</div>
          {p.offer_expires_at && <p class="note">{t("ui.offer_ends", { time: clock(p.offer_expires_at) })} <button class="small primary" onClick={() => preview("enrolment.accept_offer", { enrolment_id: p.id })}>{t("ui.take_place")}</button></p>}
          {p.pending_payment_id && provider === "stripe" && <button class="small primary" onClick={() => setPaying(p)}>{t("ui.pay_now", { amount: dollars(p.price_cents, lang.value) })}</button>}
          {import.meta.env.DEV && p.pending_payment_id && provider === "test" && <button class="small" onClick={() => payTest(p.pending_payment_id!)}>{t("ui.pay_test")}</button>}
          {" "}<button class="small" onClick={() => preview("enrolment.leave", { enrolment_id: p.id })}>{t("ui.leave")}</button>
        </li>
      ))}</ul>
    </main>
  );
}
