// What the staff lists share: tabs above a list (or a page), and page numbers below a long list.
import { t } from "@kumi/ui";

/** Up to two letters for someone's round badge: their first and last names' first letters. */
export const initials = (name: string) => { const w = name.trim().split(/\s+/).filter(Boolean); return ((w[0]?.[0] ?? "") + (w.length > 1 ? w.at(-1)![0] : "")).toUpperCase(); };

/** Tabs as buttons in a tab list: arrow keys (and Home, End) move between them, the one picked is the one shown. Each
 *  panel is `${id}-panel-${key}`, labelled by its tab, `${id}-tab-${key}`. */
export function Tabs({ label, tabs, on, pick, id }: { label: string; tabs: [string, string][]; on: string; pick: (key: string) => void; id: string }) {
  const keys = (e: KeyboardEvent) => {
    const i = tabs.findIndex(([k]) => k === on), n = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : n ? (i + n + tabs.length) % tabs.length : -1;
    if (to < 0) return;
    e.preventDefault(); pick(tabs[to]![0]);
    requestAnimationFrame(() => document.getElementById(`${id}-tab-${tabs[to]![0]}`)?.focus());
  };
  return <div class="tabs" role="tablist" aria-label={label} onKeyDown={keys}>{tabs.map(([k, w]) => (
    <button type="button" role="tab" id={`${id}-tab-${k}`} aria-selected={k === on} aria-controls={k === on ? `${id}-panel-${k}` : undefined} tabIndex={k === on ? 0 : -1} onClick={() => pick(k)}>{w}</button>))}</div>;
}

/** Page numbers for a long list: the one shown, the ones beside it, the first and the last. */
export function Pager({ page, pages, go, shown, total, per }: { page: number; pages: number; go: (p: number) => void; shown: number; total: number; per: number }) {
  const first = (page - 1) * per + 1;
  if (pages <= 1) return <p class="meta">{t("ui.showing_all", { count: total })}</p>;
  const nums = [...new Set([1, page - 1, page, page + 1, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return (
    <nav class="pager" aria-label={t("ui.pages")}>
      <span class="meta">{t("ui.showing_of", { from: first, to: first + shown - 1, total })}</span>
      <button type="button" onClick={() => go(page - 1)} disabled={page <= 1} aria-label={t("ui.page_before")}>‹</button>
      {nums.map((n, i) => <>{i > 0 && n - nums[i - 1]! > 1 && <span aria-hidden="true">…</span>}
        <button type="button" aria-current={n === page ? "page" : undefined} aria-label={t("ui.page_n", { n })} onClick={() => go(n)}>{n}</button></>)}
      <button type="button" onClick={() => go(page + 1)} disabled={page >= pages} aria-label={t("ui.page_after")}>›</button>
    </nav>
  );
}
