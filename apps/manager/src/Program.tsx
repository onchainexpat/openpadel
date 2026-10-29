import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, lang, t, shortTime } from "@kumi/ui";
import { usePreview, dollars } from "@kumi/ui";

type Person = { id: string; person_id: string; display_name: string; status: string; waitlist_position: number | null; paid_by: string; paid_cents: number; level: string | null;
  comp_note: string | null; left_how: string | null; left_reason: string | null; refund_outcome: string | null; refund_cents: number | null; offer_expires_at: string | null };
type Data = { program: any; sessions: { id: string; starts_at: string; ends_at: string; courts: string[]; has_draw: boolean }[]; roster: Person[] };
type Court = { id: string; name: string };

export function Program({ id }: { id: string }) {
  const [d, setD] = useState<Data | null>(null), [courts, setCourts] = useState<Court[]>([]);
  const [removing, setRemoving] = useState<Person | null>(null), [reason, setReason] = useState("late_cancel");
  const [override, setOverride] = useState(false), [outcome, setOutcome] = useState("full"), [amount, setAmount] = useState(0), [why, setWhy] = useState("");
  const [date, setDate] = useState({ starts: "", ends: "", courts: [] as string[] });
  const [adding, setAdding] = useState(false), [search, setSearch] = useState(""), [found, setFound] = useState<{ id: string; display_name: string }[]>([]), [compNote, setCompNote] = useState("");
  const load = () => api<Data>(`/staff/programs/${id}`).then((x) => { setD(x); api<Court[]>(`/staff/courts?location_id=${x.program.location_id}`).then(setCourts); });
  const { preview, sheet } = usePreview(() => { setRemoving(null); setAdding(false); load(); });
  useEffect(() => { load(); }, [id]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const p = d.program, money = (c: number) => dollars(c, lang.value);
  const when = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const booked = d.roster.filter((r) => r.status === "booked"), waiting = d.roster.filter((r) => r.status === "waitlisted"), gone = d.roster.filter((r) => r.status === "cancelled");

  const remove = (e: Event) => {
    e.preventDefault();
    preview("enrolment.remove", { enrolment_id: removing!.id, reason, ...(override ? { refund: { outcome, cents: Math.round(amount * 100), note: why } } : {}) });
  };
  const addDate = (e: Event) => { e.preventDefault(); preview("session.add", { program_id: id, starts_at: new Date(date.starts).toISOString(), ends_at: new Date(date.ends).toISOString(), court_ids: date.courts }); };
  const find = async (q: string) => { setSearch(q); setFound(q.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(q)}`) : []); };

  return (
    <main>
      <h1>{p.name}</h1>
      <p class="meta">{t(`kind.${p.kind}` as Key)} · {t("ui.places_taken", { booked: booked.length, capacity: p.capacity })} · {money(p.price_cents)} · {t(`ui.status_${p.status}` as Key)}</p>
      {p.status === "draft" && <button class="primary" onClick={() => preview("program.publish", { program_id: id })}>{t("ui.publish")}</button>}
      {sheet}

      <section class="card">
        <h2>{t("ui.dates")}</h2>
        {d.sessions.map((s) => <p>{when(s.starts_at)} · {s.courts.join(", ")} {p.format && <a href={`/sessions/${s.id}`}>{t("ui.open_night")}</a>}</p>)}
        {!adding ? <button onClick={() => setAdding(true)}>{t("ui.add_date")}</button> : <form onSubmit={addDate}>
          <label>{t("ui.starts")}<input type="datetime-local" required value={date.starts} onInput={(e) => setDate({ ...date, starts: e.currentTarget.value })} /></label>
          <label>{t("ui.ends")}<input type="datetime-local" required value={date.ends} onInput={(e) => setDate({ ...date, ends: e.currentTarget.value })} /></label>
          <fieldset><legend>{t("ui.courts")}</legend>{courts.map((c) => <label class="check"><input type="checkbox" checked={date.courts.includes(c.id)} onChange={(e) => setDate({ ...date, courts: e.currentTarget.checked ? [...date.courts, c.id] : date.courts.filter((x) => x !== c.id) })} /> {c.name}</label>)}</fieldset>
          <button class="primary">{t("ui.preview")}</button> <button type="button" onClick={() => setAdding(false)}>{t("ui.cancel")}</button>
        </form>}
      </section>

      <section class="card">
        <h2>{t("ui.roster")}</h2>
        <ul class="plain">{booked.map((r) => (
          <li class="row"><div><a href={`/people/${r.person_id}/level`}>{r.display_name}</a>{r.level && <span class="meta"> · {t("ui.level")} {r.level}</span>}
            <span class="meta"> · {r.paid_by === "comp" ? t("ui.comped", { note: r.comp_note ?? "" }) : r.paid_cents > 0 ? t("ui.paid", { amount: money(r.paid_cents) }) : t("ui.unpaid")}</span></div>
            <button class="small" onClick={() => { setRemoving(r); setOverride(false); setReason("late_cancel"); }}>{t("ui.remove")}</button></li>))}</ul>
        {removing && (
          <form class="card sheet" onSubmit={remove}>
            <p><strong>{removing.display_name}</strong></p>
            <label>{t("ui.reason")}<select value={reason} onChange={(e) => setReason(e.currentTarget.value)}>{["late_cancel", "no_show", "found_sub", "club", "other"].map((k) => <option value={k}>{t(`reason.${k}` as Key)}</option>)}</select></label>
            <label class="check"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.currentTarget.checked)} /> {t("ui.change_refund")}</label>
            {override && <>
              <label>{t("ui.refund")}<select value={outcome} onChange={(e) => setOutcome(e.currentTarget.value)}>{["none", "full", "partial", "credit"].map((k) => <option value={k}>{t(`ui.outcome_${k}` as Key)}</option>)}</select></label>
              {outcome === "partial" && <label>{t("ui.amount")}<input type="number" min="0" step="0.01" value={amount} onInput={(e) => setAmount(Number(e.currentTarget.value))} /></label>}
              <label>{t("ui.note")}<input required value={why} onInput={(e) => setWhy(e.currentTarget.value)} /></label>
            </>}
            <button class="primary">{t("ui.preview")}</button> <button type="button" onClick={() => setRemoving(null)}>{t("ui.cancel")}</button>
          </form>
        )}
        {waiting.length > 0 && <><h2>{t("ui.waitlist")}</h2><ol>{waiting.map((r) => <li>{r.display_name}{r.offer_expires_at && <span class="meta"> · {t("ui.offer_until", { time: shortTime(r.offer_expires_at) })}</span>}</li>)}</ol></>}
        <h2>{t("ui.comp")}</h2>
        <input placeholder={t("ui.search_person")} value={search} onInput={(e) => find(e.currentTarget.value)} />
        <input placeholder={t("ui.note")} value={compNote} onInput={(e) => setCompNote(e.currentTarget.value)} />
        <ul class="plain">{found.map((f) => <li><button class="small" disabled={!compNote.trim()} onClick={() => preview("enrolment.comp", { program_id: id, person_id: f.id, note: compNote })}>{f.display_name}</button></li>)}</ul>
        {gone.length > 0 && <><h2>{t("ui.gone")}</h2><ul class="plain">{gone.map((r) => <li class="meta">{r.display_name} · {r.left_reason ? t(`reason.${r.left_reason}` as Key) : ""} · {r.refund_outcome ? t(`ui.outcome_${r.refund_outcome}` as Key) : ""}{r.refund_cents ? ` ${money(r.refund_cents)}` : ""}</li>)}</ul></>}
      </section>
    </main>
  );
}
