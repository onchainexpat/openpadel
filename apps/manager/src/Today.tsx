// Today: what needs a person now, today's takings so far and what happened since the person last looked
// (apps/server/src/today.ts). The server sends only what the person's roles read, with no names for a role that doesn't
// read people; each row links to the page where it's handled. Nothing is changed here.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, clubTime, dollars, EmptyState, lang, me, serverNow, t, type ApiError } from "@kumi/ui";
import { label } from "./words.ts";

type Item = { text: string | null; sub?: string | null; at?: string | null; cents?: number | null; href?: string | null };
type Need = { kind: "approvals" | "owed" | "disputes" | "levels" | "questions" | "cover" | "failed" | "alerts"; count: number; href: string; items: Item[] };
type TodayView = {
  now: string; time_zone: string; people: boolean; needs: Need[];
  takings: { total_cents: number; last_week_cents: number; rows: { type: string; cents: number }[] } | null;
  since: { from: string; counts: Partial<Record<"booked" | "cancelled" | "places" | "answered", number>>; changes: { id: string; summary: string; by: string; at: string }[] | null; more: number };
};
const ICON: Record<Need["kind"], string> = { approvals: "✓", owed: "$", disputes: "!", levels: "L", questions: "?", cover: "C", failed: "$", alerts: "!" };

/** When this person last looked at Today, on this device: a look lasts half an hour, so reloading doesn't move it; the
 *  next one after that counts from the start of this one. Null the first time (the server says the last 12 hours). */
function lastLook(): string | null {
  const key = `kumi.today.${me.value?.person.id ?? ""}`, now = serverNow();
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null") as { at: number; prev: number | null } | null;
    if (v && now - v.at < 30 * 60_000) return v.prev ? new Date(v.prev).toISOString() : null;
    localStorage.setItem(key, JSON.stringify({ at: now, prev: v?.at ?? null }));
    return v?.at ? new Date(v.at).toISOString() : null;
  } catch { return null; }
}

export function Today() {
  const [v, setV] = useState<TodayView | null>(null), [error, setError] = useState<string | null>(null), [since] = useState(lastLook);
  useEffect(() => {
    const load = () => api<TodayView>(`/staff/today${since ? `?since=${encodeURIComponent(since)}` : ""}`).then(setV).catch((e: ApiError) => setError(e.message));
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [lang.value]);
  if (error && !v) return <main class="card"><p class="error" role="alert">{error}</p></main>;
  if (!v) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const at = (iso: string, o: Intl.DateTimeFormatOptions) => clubTime(iso, o, v.time_zone);
  const money = (c: number) => dollars(c, lang.value);
  const sinceWords = at(v.since.from, Date.parse(v.now) - Date.parse(v.since.from) > 20 * 3600_000 ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" });
  const counts = Object.entries(v.since.counts).filter(([, n]) => n);
  const top = v.takings ? Math.max(1, ...v.takings.rows.map((r) => r.cents)) : 1;

  return (
    <main class="wide today">
      <div class="page-head"><h1>{label("ui.nav_today")}</h1><span class="meta">{at(v.now, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span></div>
      <p class="meta">{t("ui.today_lead")}</p>
      <div class="today-grid">
        <section class="today-needs" aria-labelledby="today-needs">
          <h2 id="today-needs">{t("ui.today_needs")}</h2>
          {v.needs.length === 0 ? <EmptyState art="youre-in" size="s">{t("ui.today_nothing")}</EmptyState> : (
            <ul class="plain need-list">{v.needs.map((n) => (
              <li class="card need" key={n.kind}>
                <span class={`need-icon need-${n.kind}`} aria-hidden="true">{ICON[n.kind]}</span>
                <div class="need-body">
                  <strong>{t(`count.today_${n.kind}` as Key, { count: n.count })}</strong>
                  {n.items.length > 0 && <ul class="plain need-items">{n.items.map((x) => {
                    const words = <>{x.text && <span>{x.text}</span>}{x.text && x.sub && " · "}{x.sub && <span class="meta">{x.sub}</span>}
                      {x.cents ? <> · <span class="num">{money(x.cents)}</span></> : null}</>;
                    return <li>{x.href ? <a href={x.href}>{words}</a> : words}</li>;
                  })}</ul>}
                </div>
                <a class="button small" href={n.href}>{t("ui.today_open")}</a>
              </li>))}
            </ul>)}
        </section>
        {v.takings && <section class="card today-takings" aria-labelledby="today-takings">
          <h2 id="today-takings">{t("ui.today_takings")}</h2>
          <p class="today-total num">{money(v.takings.total_cents)}</p>
          <p class="meta">{t("ui.today_takings_vs", { amount: money(v.takings.last_week_cents) })}</p>
          {v.takings.rows.length === 0 ? <p class="meta">{t("ui.today_takings_none")}</p> : (
            <ul class="plain take-rows">{v.takings.rows.map((r) => (
              <li><span>{t(`ui.today_rev_${r.type}` as Key)}</span><span class="num">{money(r.cents)}</span>
                <span class="take-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, r.cents) / top * 100}%` }} /></span></li>))}
            </ul>)}
          <p class="meta">{t("ui.today_takings_note")}</p>
        </section>}
        <section class="card today-since" aria-labelledby="today-since">
          <h2 id="today-since">{t("ui.today_since")}</h2>
          <p class="meta">{t("ui.today_since_at", { time: sinceWords })}</p>
          {counts.length > 0 && <div class="chips">{counts.map(([k, n]) => <span class="count-chip">{t(`count.since_${k}` as Key, { count: n! })}</span>)}</div>}
          {v.since.changes && v.since.changes.length > 0 && <ul class="plain since-list">{v.since.changes.map((c) => (
            <li><span class="meta num">{at(c.at, { hour: "numeric", minute: "2-digit" })}</span><span>{c.summary} <span class="meta">· {c.by}</span></span></li>))}</ul>}
          {counts.length === 0 && !v.since.changes?.length && <p class="meta">{t("ui.since_quiet")}</p>}
          {v.since.changes && <p>{v.since.more > 0 && <span class="meta">{t("count.since_more", { count: v.since.more })} · </span>}<a href="/changes">{t("ui.since_all_changes")}</a></p>}
        </section>
      </div>
    </main>
  );
}
