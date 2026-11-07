import { useEffect, useState } from "preact/hooks";
import { api, lang, mayDo, t, usePreview, clubTime } from "@kumi/ui";

type M = { status: { last_sync_at: string; last_ok_at: string | null; failed: boolean; fetched: number | null } | null;
  unmapped: { courtRef: string; courtName: string; bookings: number }[];
  linked: { resource_id: string; name: string; court_id: string; court: string }[];
  conflicts: { ref: string; court: string; kind: string; starts_at: string; ends_at: string; event: string | null; session_id: string | null }[];
  compare: { days: { day: string; court: string; playtomic: number; held: number; taken: number; kumi: number }[];
    diffs: { key: string; kind: "clash" | "missing" | "moved" | "cancelled"; court: string; starts_at: string; kind_label: string; code?: string | null }[] } | null;
  take_over: { booking_id: string; starts_at: string; court: string; kind: string; price: string | null; payment_status: string | null; held: boolean; owner: string | null; owner_known: boolean }[] };
type Court = { id: string; name: string };

/** The read-only Playtomic mirror: link its courts to Kumi's, and see bookings that clash with Kumi's events. */
export function Mirror() {
  const [d, setD] = useState<M | null>(null), [courts, setCourts] = useState<Court[]>([]), [pick, setPick] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const load = () => api<M>("/staff/mirror").then((m) => { setD(m); setChosen(new Set()); });
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); api<Court[]>("/staff/courts").then(setCourts); }, [lang.value]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const fmt = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
  const free = courts.filter((c) => !d.linked.some((l) => l.court_id === c.id));
  return (
    <main>
      <h1>{t("ui.mirror_title")}</h1>
      {mayDo("credit.bring_in") && <p><a href="/playtomic/move-in">{t("ui.movein_link")}</a></p>}
      <section class="card">
        <p>{!d.status ? t("ui.mirror_off") : d.status.failed ? t("ui.mirror_failed", { when: fmt(d.status.last_sync_at) }) : t("ui.mirror_ok", { when: fmt(d.status.last_sync_at) })}</p>
      </section>
      {sheet}
      {d.unmapped.length > 0 && <section class="card"><h2>{t("ui.mirror_unlinked")}</h2><p class="meta">{t("ui.mirror_unlinked_help")}</p>
        <ul class="plain">{d.unmapped.map((u) => (
          <li><strong>{u.courtName}</strong> <span class="meta">{t("count.bookings", { count: u.bookings })}</span>
            <select value={pick[u.courtRef] ?? ""} onChange={(e) => setPick({ ...pick, [u.courtRef]: e.currentTarget.value })}>
              <option value="">{t("ui.choose_court")}</option>{free.map((c) => <option value={c.id}>{c.name}</option>)}
            </select>
            <button disabled={!pick[u.courtRef]} onClick={() => preview("connector.map_court", { resource_id: u.courtRef, resource_name: u.courtName, court_id: pick[u.courtRef] })}>{t("ui.mirror_link")}</button>
          </li>))}</ul></section>}
      {d.linked.length > 0 && <section class="card"><h2>{t("ui.mirror_linked")}</h2>
        <ul class="plain">{d.linked.map((l) => <li>{l.court} <span class="meta">· {t("ui.mirror_is", { name: l.name })}</span></li>)}</ul></section>}
      {d.compare && <section class="card"><h2>{t("ui.mirror_compare")}</h2><p class="meta">{t("ui.mirror_compare_help")}</p>
        {d.compare.diffs.length === 0 ? <p class="meta">{t("ui.mirror_compare_none")}</p> :
          <ul class="plain">{d.compare.diffs.map((x) => (
            <li><strong>{x.court}</strong> {fmt(x.starts_at)} · {x.kind_label} · {x.kind === "moved" ? t("ui.mirror_diff_moved", { code: x.code ?? "" }) : x.kind === "cancelled" ? t("ui.mirror_diff_cancelled", { code: x.code ?? "" })
              : t(x.kind === "clash" ? "ui.mirror_diff_clash" : "ui.mirror_diff_missing")}</li>))}</ul>}
        {d.compare.days.length > 0 && <div class="table-scroll"><table class="stack">
          <thead><tr><th>{t("ui.mirror_compare_day")}</th><th>{t("ui.mirror_compare_court")}</th><th>{t("ui.mirror_compare_playtomic")}</th><th>{t("ui.mirror_compare_held")}</th>
            <th>{t("ui.mirror_compare_taken")}</th><th>{t("ui.mirror_compare_kumi")}</th></tr></thead>
          <tbody>{d.compare.days.map((r) => (
            <tr><td data-label={t("ui.mirror_compare_day")}>{clubTime(`${r.day}T12:00:00Z`, { dateStyle: "medium" }, "UTC")}</td><td data-label={t("ui.mirror_compare_court")}>{r.court}</td>
              <td data-label={t("ui.mirror_compare_playtomic")}>{r.playtomic}</td><td data-label={t("ui.mirror_compare_held")}>{r.held}</td>
              <td data-label={t("ui.mirror_compare_taken")}>{r.taken}</td><td data-label={t("ui.mirror_compare_kumi")}>{r.kumi}</td></tr>))}</tbody>
        </table></div>}
      </section>}
      {d.status && <section class="card"><h2>{t("ui.mirror_take_over")}</h2><p class="meta">{t("ui.mirror_take_over_help")}</p>
        {d.take_over.length === 0 ? <p class="meta">{t("ui.mirror_take_over_none")}</p> : <>
          <p><button class="small" onClick={() => setChosen(new Set(d.take_over.map((x) => x.booking_id)))}>{t("ui.mirror_take_over_all")}</button></p>
          <ul class="plain">{d.take_over.map((x) => (
            <li><label class="check"><input type="checkbox" checked={chosen.has(x.booking_id)}
              onChange={(e) => { const n = new Set(chosen); if (e.currentTarget.checked) n.add(x.booking_id); else n.delete(x.booking_id); setChosen(n); }} />
              <span><strong>{x.court}</strong> {fmt(x.starts_at)} · {x.kind} · {x.owner_known ? x.owner : `${x.owner ?? ""} (${t("ui.mirror_owner_unknown")})`}
                <span class="meta"> · {x.price ?? ""} {t(x.payment_status === "PAID" ? "ui.mirror_paid" : "ui.mirror_unpaid")}{x.held ? "" : ` · ${t("ui.mirror_not_held")}`}</span></span></label></li>))}</ul>
          <button disabled={chosen.size === 0} onClick={() => preview("mirror.take_over", { booking_ids: [...chosen] })}>{t("ui.mirror_take_over_pick")}</button>
        </>}
      </section>}
      <section class="card"><h2>{t("ui.mirror_conflicts")}</h2>
        {d.conflicts.length === 0 ? <p class="meta">{t("ui.mirror_no_conflicts")}</p> :
          <ul class="plain">{d.conflicts.map((c) => (
            <li><strong>{c.court}</strong> {fmt(c.starts_at)} · {c.kind}{c.event && <> · {c.session_id ? <a href={`/sessions/${c.session_id}`}>{c.event}</a> : c.event}</>}</li>))}</ul>}
      </section>
    </main>
  );
}
