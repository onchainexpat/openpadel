// "Tell me when" (the boards' priority alerts): on Book, a court freeing up on the day shown, for a start in a window
// the member picks; on Play, an open match whose levels include theirs. Each is a switch with its own preview: turning
// it on or off is play_alert.set or play_alert.end, shown before anything changes. The server sends what it finds
// (play_alerts.ts) as the club's other messages go: in the app, and by push and email outside quiet hours.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, clubTime, me, NewOnly, t, usePreview } from "@kumi/ui";
import { windowTimes } from "./alert_bits.ts";

type Alert = { id: string; kind: "court" | "match"; location_id: string | null; date: string | null; from: string | null; until: string | null };

function useAlerts() {
  const [rows, setRows] = useState<Alert[] | null>(null);
  const load = () => api<Alert[]>("/my/alerts").then(setRows).catch(() => setRows([]));
  useEffect(() => { void load(); }, []);
  return { rows, load };
}

/** "6:00 PM" for a time of day, HH:MM, as the app says times. */
function clock(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return clubTime(Date.UTC(2000, 0, 1, h, m), { hour: "numeric", minute: "2-digit" }, "UTC");
}

/** The switch, with the board's heading and what it tells, and what goes with it underneath. */
function Switch({ title, on, onChange, children }: { title: string; on: boolean; onChange: (on: boolean) => void; children?: ComponentChildren }) {
  return <section class="card alert-card">
    <NewOnly quiet><label class="check toggle"><input type="checkbox" role="switch" checked={on}
      onChange={(e) => { const want = e.currentTarget.checked; e.currentTarget.checked = on; onChange(want); }} />
      {" "}<span><strong>{t("ui.alert_heading")}</strong><br /><span class="meta">{title}</span></span></label></NewOnly>
    {children}
  </section>;
}

/** Book's switch for the day shown. On, it says the window; turning it on first asks for the window, then previews. */
export function CourtAlert({ location, date, dayLabel, open, tz }: { location: string; date: string; dayLabel: string; open: { opens: string; closes: string } | null; tz: string }) {
  const { rows, load } = useAlerts(), [picking, setPicking] = useState(false);
  const { preview, sheet } = usePreview(() => { setPicking(false); void load(); });
  const times = windowTimes(open, tz), [w, setW] = useState({ from: "", until: "" });
  useEffect(() => { setPicking(false); setW({ from: times[0] ?? "", until: times.at(-1) ?? "" }); }, [location, date, open?.opens]);
  if (!rows || !times.length) return null;
  const mine = rows.find((a) => a.kind === "court" && a.location_id === location && a.date === date);
  return <Switch title={t("ui.alert_court", { day: dayLabel })} on={Boolean(mine) || picking}
    onChange={(on) => { if (on) setPicking(true); else if (mine) void preview("play_alert.end", { alert_id: mine.id }); else setPicking(false); }}>
    {sheet}
    {mine && !picking && <p class="meta">{t("ui.alert_court_on", { from: clock(mine.from!), until: clock(mine.until!) })}</p>}
    {picking && <form class="court-row" onSubmit={(e) => { e.preventDefault(); void preview("play_alert.set", { person_id: me.value!.person.id, kind: "court", location_id: location, date, from: w.from, until: w.until }); }}>
      <label>{t("ui.from")}<select value={w.from} onChange={(e) => setW({ ...w, from: e.currentTarget.value })}>{times.map((x) => <option value={x}>{clock(x)}</option>)}</select></label>
      <label>{t("ui.to")}<select value={w.until} onChange={(e) => setW({ ...w, until: e.currentTarget.value })}>{times.map((x) => <option value={x}>{clock(x)}</option>)}</select></label>
      <button class="primary">{t("ui.alert_turn_on")}</button>
    </form>}
  </Switch>;
}

/** Play's switch: an open match at my level, anywhere at the club. Without a level, where to set one. */
export function MatchAlert() {
  const { rows, load } = useAlerts(), { preview, sheet } = usePreview(() => { void load(); });
  const [level, setLevel] = useState<number | null | undefined>(undefined);
  useEffect(() => { api<{ rating: { level: string } | null }>("/my/level").then((r) => setLevel(r.rating ? Number(r.rating.level) : null)).catch(() => setLevel(null)); }, []);
  if (!rows || level === undefined) return null;
  if (level === null) return <p class="meta">{t("ui.alert_match_no_level")} <a href="/level">{t("ui.set_level")}</a></p>;
  const mine = rows.find((a) => a.kind === "match");
  return <Switch title={t("ui.alert_match", { level: level.toFixed(2) })} on={Boolean(mine)}
    onChange={(on) => void (on ? preview("play_alert.set", { person_id: me.value!.person.id, kind: "match" }) : mine && preview("play_alert.end", { alert_id: mine.id }))}>
    {sheet}
  </Switch>;
}
