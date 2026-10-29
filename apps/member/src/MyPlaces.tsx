import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, t, usePreview } from "@kumi/ui";

type Place = { id: string; status: string; waitlist_position: number | null; name: string; price_cents: number; first_start: string | null; offer_expires_at: string | null; pending_payment_id: string | null; paid_cents: number };

export function MyPlaces() {
  const [rows, setRows] = useState<Place[] | null>(null);
  const load = () => api<Place[]>("/my/places").then(setRows);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  const clock = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "");
  const payTest = async (id: string) => { await api(`/dev/payments/${id}/settle`, {}); load(); };
  return (
    <main>
      <h1>{t("ui.nav_my")}</h1>
      {sheet}
      {rows?.length === 0 && <p>{t("ui.no_places")}</p>}
      <ul class="changes">{(rows ?? []).map((p) => (
        <li class="card" key={p.id}>
          <div class="summary">{p.name}</div>
          <div class="meta">{when(p.first_start)} · {p.status === "booked" ? t("ui.youre_in") : t("ui.on_waitlist", { n: p.waitlist_position ?? 0 })}
            {p.paid_cents > 0 ? ` · ${t("ui.you_paid", { amount: dollars(p.paid_cents, lang.value) })}` : p.pending_payment_id ? ` · ${t("ui.pay_pending")}` : ""}</div>
          {p.offer_expires_at && <p class="note">{t("ui.offer_ends", { time: clock(p.offer_expires_at) })} <button class="small primary" onClick={() => preview("enrolment.accept_offer", { enrolment_id: p.id })}>{t("ui.take_place")}</button></p>}
          {import.meta.env.DEV && p.pending_payment_id && <button class="small" onClick={() => payTest(p.pending_payment_id!)}>{t("ui.pay_test")}</button>}
          {" "}<button class="small" onClick={() => preview("enrolment.leave", { enrolment_id: p.id })}>{t("ui.leave")}</button>
        </li>
      ))}</ul>
    </main>
  );
}
