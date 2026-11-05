// A program as members see it on What's On: when, their price, the level band, rated or not, the refund
// rule, places left (or how many more it needs to run). Staff see the same card before publishing.
import type { ComponentChildren } from "preact";
import { lang, t, clubTime } from "./state.ts";
import { dollars } from "./Preview.tsx";

export type ProgramCardData = { id: string; name: string; capacity: number; booked: number; offered: number; price_cents: number; rated: boolean; level_min: string | null; level_max: string | null;
  refund_window_hours: number; first_start: string | null; min_players: number | null; my_price_cents: number; my_basis: "full" | "member" | "included"; included: { n: number; of: number } | null; members_cents: number | null;
  /** Signed up per date: each date has its own places (shown with the dates, not here). */
  per_date?: boolean };

/** Places nobody holds (a waitlist offer holds one). */
export const placesLeft = (p: ProgramCardData) => p.capacity - p.booked - p.offered;

/** The price as this person pays it: an included session, their member price, or the price (and what members pay). */
const priceLine = (p: ProgramCardData) => p.my_basis === "included" ? (p.included ? t("ui.your_included", { n: p.included.n, of: p.included.of }) : t("ui.included_in_yours"))
  : p.my_basis === "member" ? t("ui.your_member_price", { amount: dollars(p.my_price_cents, lang.value) })
  : dollars(p.price_cents, lang.value) + (p.members_cents !== null ? ` (${t("ui.members_price", { amount: dollars(p.members_cents, lang.value) })})` : "");

export function ProgramCard({ p, children }: { p: ProgramCardData; children?: ComponentChildren }) {
  const when = (iso: string | null) => (iso ? clubTime(iso, { weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
  const left = placesLeft(p), need = p.min_players !== null ? p.min_players - p.booked : 0;
  return (
    <li class="card">
      <div class="summary">{p.name}</div>
      <div class="meta">{when(p.first_start)} · {priceLine(p)}{p.level_min && p.level_max ? ` · ${t("ui.level_band", { min: p.level_min, max: p.level_max })}` : ""}</div>
      <div class="meta">{t(p.rated ? "ui.rated_label" : "ui.friendly_label")} · {t("ui.refund_rule", { hours: p.refund_window_hours })}</div>
      <div class="meta">{p.per_date ? t("ui.per_date_note") : <>{left > 0 ? t("ui.places_left", { count: left }) : t("ui.full_waitlist")}{need > 0 ? ` · ${t("ui.needs_more", { count: need })}` : ""}</>}</div>
      {children}
    </li>
  );
}
