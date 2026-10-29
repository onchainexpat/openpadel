import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, me, t, usePreview } from "@kumi/ui";

type P = { id: string; name: string; capacity: number; booked: number; price_cents: number; rated: boolean; level_min: string | null; level_max: string | null; refund_window_hours: number; first_start: string | null; my_status: string | null };

export function WhatsOn() {
  const [rows, setRows] = useState<P[] | null>(null);
  const load = () => api<P[]>("/open-programs").then(setRows);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "");
  return (
    <main>
      <h1>{t("ui.nav_whats_on")}</h1>
      {sheet}
      {rows?.length === 0 && <p>{t("ui.nothing_on")}</p>}
      <ul class="changes">{(rows ?? []).map((p) => {
        const left = p.capacity - p.booked;
        return (
          <li class="card" key={p.id}>
            <div class="summary">{p.name}</div>
            <div class="meta">{when(p.first_start)} · {dollars(p.price_cents, lang.value)}{p.level_min && p.level_max ? ` · ${t("ui.level_band", { min: p.level_min, max: p.level_max })}` : ""}</div>
            <div class="meta">{t(p.rated ? "ui.rated_label" : "ui.friendly_label")} · {t("ui.refund_rule", { hours: p.refund_window_hours })}</div>
            <div class="meta">{left > 0 ? t("ui.places_left", { count: left }) : t("ui.full_waitlist")}</div>
            {p.my_status ? <p class="note">{p.my_status === "booked" ? t("ui.youre_in") : t("ui.waitlist")}</p>
              : <button class="primary" onClick={() => preview("enrolment.join", { program_id: p.id, person_id: me.value!.person.id })}>{t("ui.join")}</button>}
          </li>
        );
      })}</ul>
    </main>
  );
}
