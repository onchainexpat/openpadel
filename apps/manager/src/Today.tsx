// Today: what needs a person now, today's takings so far and what happened since the person last looked
// (apps/server/src/today.ts). The server sends only what the person's roles read, with no names for a role that doesn't
// read people; each row links to the page where it's handled. The one change made here is checking in a booking from Now and next, previewed first like any other.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, clubTime, coversLocation, dollars, EmptyState, lang, mayDo, me, PluginCards, serverNow, t, usePluginCards, usePreview, type ApiError, type PluginCardData } from "@kumi/ui";
import { label } from "./words.ts";
import { allIn, bookingsIn, checkInInput } from "./check_in.ts";

type Item = { text: string | null; sub?: string | null; at?: string | null; cents?: number | null; href?: string | null };
type Need = { kind: "approvals" | "owed" | "disputes" | "levels" | "questions" | "cover" | "failed" | "alerts"; count: number; href: string; items: Item[] };
/** What's on now and next across the club (today.ts nowNext): a booking says how many of its places are checked in. */
type NextItem = { kind: "booking" | "session"; id: string; start: string; end: string; court: string; location_id: string; location: string | null; title: string; sub: string | null;
  href: string | null; places?: number; checked_in?: number; check_in_open?: boolean };
type TodayView = {
  now: string; time_zone: string; people: boolean; needs: Need[];
  takings: { total_cents: number; last_week_cents: number; rows: { type: string; cents: number }[] } | null;
  next: { time_zone: string; items: NextItem[] } | null;
  since: { from: string; counts: Partial<Record<"booked" | "cancelled" | "places" | "answered", number>>; changes: { id: string; summary: string; rest?: string | null; by: string; at: string }[] | null; more: number };
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
  const load = () => api<TodayView>(`/staff/today${since ? `?since=${encodeURIComponent(since)}` : ""}`).then(setV).catch((e: ApiError) => setError(e.message));
  // Checking in from Now and next previews first, like every change, then the list is read again.
  const { preview, sheet } = usePreview(() => { void load(); });
  useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [lang.value]);
  // Each court's tile with plugins' cards on it (lights on until 21:30, say), read again with the page.
  const courts = usePluginCards<{ court_id: string; court: string; cards: PluginCardData[] }[]>("/staff/grid/cards", v?.now);
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
        {v.next && <NowNext next={v.next} preview={preview} />}
        {courts && courts.length > 0 && <section class="card today-courts" aria-labelledby="today-courts">
          <h2 id="today-courts">{t("ui.today_courts")}</h2>
          <ul class="plain">{courts.map((c) => <li key={c.court_id}><strong>{c.court}</strong><PluginCards cards={c.cards} bare /></li>)}</ul>
        </section>}
        <section class="card today-since" aria-labelledby="today-since">
          <h2 id="today-since">{t("ui.today_since")}</h2>
          <p class="meta">{t("ui.today_since_at", { time: sinceWords })}</p>
          {counts.length > 0 && <div class="chips">{counts.map(([k, n]) => <span class="count-chip">{t(`count.since_${k}` as Key, { count: n! })}</span>)}</div>}
          {v.since.changes && v.since.changes.length > 0 && <ul class="plain since-list">{v.since.changes.map((c) => (
            <li><span class="meta num">{at(c.at, { hour: "numeric", minute: "2-digit" })}</span><span><span class="since-what">{c.summary}</span> <span class="meta">· {c.by}</span>
              {c.rest && <details class="since-rest"><summary class="meta">{t("ui.since_rest")}</summary><p>{c.rest}</p></details>}</span></li>))}</ul>}
          {counts.length === 0 && !v.since.changes?.length && <p class="meta">{t("ui.since_quiet")}</p>}
          {v.since.changes && <p>{v.since.more > 0 && <span class="meta">{t("count.since_more", { count: v.since.more })} · </span>}<a href="/changes">{t("ui.since_all_changes")}</a></p>}
        </section>
      </div>
      {sheet}
    </main>
  );
}

/** Now and next: what's on the courts now and what starts in the next few hours, each booking with Check in (or Checked
 *  in, to take it back) and how many bookings are checked in; a program date opens its page, where who came is marked. */
function NowNext({ next, preview }: { next: NonNullable<TodayView["next"]>; preview: (action: string, input: unknown) => Promise<void> }) {
  const clock = (iso: string) => clubTime(iso, { hour: "numeric", minute: "2-digit" }, next.time_zone), now = serverNow();
  const counts = bookingsIn(next.items);
  return (
    <section class="card today-next" id="now-next" aria-labelledby="today-next">
      <h2 id="today-next">{t("ui.now_next")}</h2>
      <p class="meta">{counts.total ? t("count.bookings_checked_in", counts) : t("ui.next_nothing_to_check_in")}</p>
      {next.items.length === 0 ? <p class="meta">{t("ui.next_none_today")}</p> : <ul class="plain next-list">{next.items.map((x) => {
        const on = Date.parse(x.start) <= now, may = x.kind === "booking" && x.check_in_open && (x.places ?? 0) > 0 && mayDo("booking.check_in") && coversLocation(x.location_id);
        return <li>
          <span class="meta num next-time">{on ? t("ui.next_now") : clock(x.start)}</span>
          <span class="next-body"><strong>{x.href ? <a href={x.href}>{x.title}</a> : x.title}</strong>
            <span class="meta">{[x.court, x.location, x.sub, x.kind === "booking" && (x.places ?? 0) > 0 ? t("count.checked_in_of", { count: x.checked_in ?? 0, total: x.places ?? 0 }) : null].filter(Boolean).join(" · ")}</span></span>
          {may && <button type="button" class={`small${allIn(x) ? " checked" : ""}`} aria-pressed={allIn(x)}
            onClick={() => preview("booking.check_in", checkInInput(x))}>{t(allIn(x) ? "ui.checked_in" : "ui.check_in")}</button>}
        </li>; })}</ul>}
    </section>
  );
}
