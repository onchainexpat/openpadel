// The card beside a block on the Schedule while the mouse rests on it or the keyboard is on it: what it is, its court
// and times, and who plays (each with their level and membership plan here when they have one, and what they've paid,
// for those who see money). Everything in it is what the server sent for the grid, under the grid's own rules for
// names and money: nothing is fetched for it. Loaded with the Schedule's later parts, so the first screen doesn't carry it.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon, dollars, lang, t } from "@kumi/ui";
import type { Item } from "./Courts.tsx";
import { placeCard } from "./card_place.ts";

/** One row of the card: a player, or a place still open. */
type Row = { name: string; guest?: boolean; level?: number; plan?: string; paid_cents?: number; owed_cents?: number };

/** What the block is, in a few words: the card's title. */
export const cardTitle = (it: Item) =>
  it.kind === "hold" ? t("ui.being_paid")
  : it.kind === "block" ? t("ui.card_blocked", { reason: it.label ?? "" })
  : it.session_id || it.kind === "mirror" ? it.label ?? ""
  : it.booking_kind === "lesson" ? (it.coach ? t("ui.lesson_with", { coach: it.coach }) : t("ui.kind_lesson"))
  : it.open_match ? t("ui.kind_open_match") : t("grid.booked");

/** The players to list: a booking's places (arrivals), or a Playtomic copy's players from the club's archive. */
export const cardRows = (it: Item): Row[] => it.kind === "mirror" ? it.roster ?? [] : it.arrivals ?? [];

export function HoverCard({ id, it, court, clock, money, anchor, onClose }: { id: string; it: Item; court: string; clock: (s: string | number) => string; money: boolean; anchor: HTMLElement;
  onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null), [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // Escape puts it away, and so does a scroll or a resize (it would no longer be beside its block).
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", esc); addEventListener("scroll", onClose, true); addEventListener("resize", onClose);
    return () => { removeEventListener("keydown", esc); removeEventListener("scroll", onClose, true); removeEventListener("resize", onClose); };
  }, [onClose]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setAt(placeCard(anchor.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, document.documentElement.clientWidth, window.innerHeight));
  }, [anchor, it]);
  const rows = cardRows(it), open = it.open_match && it.places ? Math.max(0, it.places - rows.length) : 0;
  const unnamed = !it.open_match && it.places ? Math.max(0, it.places - rows.length) : 0;
  const ptPaid = it.pt_payment === "PAID" ? "ui.mirror_paid" : it.pt_payment === "PARTIAL_PAID" ? "ui.mirror_partly_paid" : it.pt_payment ? "ui.mirror_unpaid" : null;
  return (
    <div id={id} ref={ref} role="tooltip" class="hover-card" style={at ? `left:${at.left}px;top:${at.top}px` : "visibility:hidden;left:0;top:0"}>
      <div class="hc-head">
        <strong>{cardTitle(it)}</strong>
        <span class="meta">{t("ui.card_when", { court, from: clock(it.start), to: clock(it.end) })}</span>
        {/* The mark beside its words, so it's read once. */}
        {it.kind === "mirror" && <span class="hc-imported"><span class="pt-mark"><Icon name="import" /></span>{t("ui.imported_playtomic")}</span>}
      </div>
      {(rows.length > 0 || open > 0) && <ul class="hc-rows">
        {rows.map((r) => <li>
          <span class="hc-avatar" aria-hidden="true">{(r.name || t("ui.player")).trim().charAt(0).toUpperCase()}</span>
          <span class="hc-who">
            <span class="hc-name"><span class="hc-n">{r.name || t("ui.player")}</span>{r.guest && <span class="meta">{t("ui.guest")}</span>}
              {r.level !== undefined && <span class="hc-level"><span aria-hidden="true">{r.level.toFixed(2)}</span><span class="sr-only">{t("ui.card_level", { level: r.level.toFixed(2) })}</span></span>}</span>
            {r.plan && <span class="hc-plan">{r.plan}</span>}
          </span>
          {money && r.paid_cents !== undefined && (r.paid_cents !== 0 || (r.owed_cents ?? 0) > 0) && <span class="hc-money">
            {dollars(r.paid_cents, lang.value)}
            {(r.owed_cents ?? 0) > 0 ? <span class="hc-owes">{t("ui.card_owes", { amount: dollars(r.owed_cents!, lang.value) })}</span>
              : <span class="hc-paid"><Icon name="circle-check-big" label={t("ui.card_paid")} /></span>}
          </span>}
        </li>)}
        {Array.from({ length: open }, () => <li class="hc-open"><span class="hc-avatar" aria-hidden="true" /><span class="hc-who meta">{t("ui.card_open_place")}</span></li>)}
      </ul>}
      {unnamed > 0 && <p class="meta hc-foot">{t("count.card_unnamed", { count: unnamed })}</p>}
      {it.booking_id && it.arrivals && rows.length === 0 && open === 0 && unnamed === 0 && <p class="meta hc-foot">{t("ui.card_no_players")}</p>}
      {money && it.kind === "mirror" && (it.pt_price_cents != null || ptPaid) && <p class="meta hc-foot">
        {[it.pt_price_cents != null ? dollars(it.pt_price_cents, lang.value) : "", ptPaid ? t(ptPaid) : ""].filter(Boolean).join(" · ")}</p>}
    </div>
  );
}
