import { useEffect, useState } from "preact/hooks";
import { api, lang, t, usePreview } from "@kumi/ui";

type M = { status: { last_sync_at: string; last_ok_at: string | null; failed: boolean; fetched: number | null } | null;
  unmapped: { courtRef: string; courtName: string; bookings: number }[];
  linked: { resource_id: string; name: string; court_id: string; court: string }[];
  conflicts: { ref: string; court: string; kind: string; starts_at: string; ends_at: string; event: string | null; session_id: string | null }[] };
type Court = { id: string; name: string };

/** The read-only Playtomic mirror: link its courts to Kumi's, and see bookings that clash with Kumi's events. */
export function Mirror() {
  const [d, setD] = useState<M | null>(null), [courts, setCourts] = useState<Court[]>([]), [pick, setPick] = useState<Record<string, string>>({});
  const load = () => api<M>("/staff/mirror").then(setD);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); api<Court[]>("/staff/courts").then(setCourts); }, [lang.value]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const fmt = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const free = courts.filter((c) => !d.linked.some((l) => l.court_id === c.id));
  return (
    <main>
      <h1>{t("ui.mirror_title")}</h1>
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
      <section class="card"><h2>{t("ui.mirror_conflicts")}</h2>
        {d.conflicts.length === 0 ? <p class="meta">{t("ui.mirror_no_conflicts")}</p> :
          <ul class="plain">{d.conflicts.map((c) => (
            <li><strong>{c.court}</strong> {fmt(c.starts_at)} · {c.kind}{c.event && <> · {c.session_id ? <a href={`/sessions/${c.session_id}`}>{c.event}</a> : c.event}</>}</li>))}</ul>}
      </section>
    </main>
  );
}
