// A person's weekly courts (booking_series.ts), for My places and the staff's page of the person: the pattern, and
// each week from today: booked, waiting for the booking window, or left out (and why). One week is cancelled like any
// booking; "this and the rest" ends the series from that week, each week under its own cancel rules.
import { useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { clubTime, lang, t } from "./state.ts";
import { dollars } from "./Preview.tsx";

export type WeeklyCourt = { id: string; court: string; starts: string; minutes: number; pay: "card" | "desk"; from_playtomic?: boolean; time_zone: string;
  weeks: { date: string; starts_at: string; price_cents: number; state: "booked" | "owed" | "cancelled" | "missed" | "waiting"; missed: string | null; code: string | null; charged: boolean }[] };

export function WeeklyCourts({ series, preview, staff }: { series: WeeklyCourt[]; preview: (action: string, input: unknown) => Promise<void> | void; staff?: boolean }) {
  const [refund, setRefund] = useState("rule");
  if (!series.length) return null;
  return (
    <section class="card">
      <h2>{t("ui.weekly_courts")}</h2>
      {series.map((s) => {
        const first = s.weeks[0]!, at = (iso: string, o: Intl.DateTimeFormatOptions) => clubTime(iso, o, s.time_zone);
        const end = (from?: string) => preview("booking.repeat_end", { series_id: s.id, ...(from ? { from_date: from } : {}), ...(staff && refund !== "rule" ? { refund } : {}) });
        return (
          <div key={s.id}>
            <p><strong>{t("ui.weekly_pattern", { court: s.court, weekday: at(first.starts_at, { weekday: "long" }), time: at(first.starts_at, { hour: "numeric", minute: "2-digit" }), minutes: s.minutes })}</strong></p>
            <p class="meta">{t(s.from_playtomic ? "ui.weekly_from_playtomic" : s.pay === "card" ? "ui.weekly_on_card" : "ui.weekly_at_desk")}</p>
            <ul class="plain">{s.weeks.map((w) => (
              <li class="row" key={w.date}>
                <span>{at(w.starts_at, { weekday: "short", month: "short", day: "numeric" })} · {dollars(w.price_cents, lang.value)} · {w.state === "missed"
                  ? t("ui.weekly_missed", { why: t(`msg.repeat_why_${w.missed ?? "taken"}` as Key) })
                  : t(`ui.weekly_${w.state}` as Key)}{w.state === "booked" && w.charged && s.pay === "card" ? ` · ${t("ui.weekly_charged")}` : ""}{w.code ? <span class="meta"> · {w.code}</span> : null}</span>
                {(w.state === "booked" || w.state === "waiting") && <button class="small" onClick={() => end(w.date)}>{t("ui.cancel_from_week")}</button>}
              </li>
            ))}</ul>
            {staff && <label>{t("ui.weekly_refund")}<select value={refund} onChange={(e) => setRefund(e.currentTarget.value)}>
              <option value="rule">{t("ui.refund_by_rule")}</option><option value="full">{t("ui.refund_all")}</option><option value="none">{t("ui.refund_nothing_more")}</option></select></label>}
          </div>
        );
      })}
    </section>
  );
}
