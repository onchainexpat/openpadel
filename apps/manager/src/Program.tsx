import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { AMOUNT_PATTERN, parseDollars } from "@kumi/i18n/format";
import { api, lang, mayDo, OtherLang, savedIn, t, shortTime, translationsOf, clubTime, serverNow, clubMoment } from "@kumi/ui";
import { usePreview, dollars, ProgramCard, type ProgramCardData } from "@kumi/ui";
import { DeskPay } from "./DeskPay.tsx";

type Person = { id: string; person_id: string; display_name: string; status: string; waitlist_position: number | null; paid_by: string; paid_cents: number; price_cents: number; level: string | null; price_basis: string;
  comp_note: string | null; left_how: string | null; left_reason: string | null; refund_outcome: string | null; refund_cents: number | null; offer_expires_at: string | null; session_id: string | null };
type Data = { program: any; decide_hours: number; coaches: { id: string; name: string }[]; roster: Person[];
  sessions: { id: string; starts_at: string; ends_at: string; status: string; courts: string[]; has_draw: boolean; coach_id: string | null; places: number; booked: number }[] };
type Court = { id: string; name: string };
type Preview = { card: ProgramCardData; dates: { id: string; starts_at: string; ends_at: string; courts: string[]; coach: string | null }[]; blocks: string[]; warnings: string[] };
type Scope = "this" | "following" | "all";
/** A change to dates: which ones, and only the fields given change. */
type DateEdit = { session: string; scope: Scope; when: string; time: string; minutes: string; courts: string[]; coach: string; capacity: string };
type DateCancel = { session: string; scope: Scope; refund: "rule" | "full" | "none"; note: string };

export function Program({ id }: { id: string }) {
  const [d, setD] = useState<Data | null>(null), [courts, setCourts] = useState<Court[]>([]);
  const [removing, setRemoving] = useState<Person | null>(null), [reason, setReason] = useState("late_cancel");
  const [paying, setPaying] = useState<Person | null>(null);   // a place paid at the desk: how much, and how
  const [override, setOverride] = useState(false), [outcome, setOutcome] = useState("full"), [amount, setAmount] = useState(0), [why, setWhy] = useState("");
  const [date, setDate] = useState({ starts: "", ends: "", courts: [] as string[], coach: "", weeks: 1 });
  const [edit, setEdit] = useState<DateEdit | null>(null), [cancelling, setCancelling] = useState<DateCancel | null>(null);
  const [ending, setEnding] = useState<{ refund: "rule" | "full" | "none"; note: string } | null>(null);
  const [minimum, setMinimum] = useState<{ min: string; hours: string } | null>(null), [look, setLook] = useState<Preview | null>(null);
  const [pricing, setPricing] = useState<{ price: string; member: string } | null>(null);
  // Its name, and its name in the club's other language.
  const [naming, setNaming] = useState<{ name: string; tr: string } | null>(null);
  const [day, setDay] = useState<string | null>(null);   // signed up per date: whose roster is shown
  const [adding, setAdding] = useState(false), [search, setSearch] = useState(""), [found, setFound] = useState<{ id: string; display_name: string }[]>([]), [compNote, setCompNote] = useState("");
  const load = () => api<Data>(`/staff/programs/${id}`).then((x) => {
    setD(x); api<Court[]>(`/staff/courts?location_id=${x.program.location_id}`).then(setCourts);
    // A draft: the card as members will see it, its dates, and anything in the way, before publishing.
    if (x.program.status === "draft") api<Preview>(`/staff/programs/${id}/preview`).then(setLook); else setLook(null);
  });
  const { preview, sheet } = usePreview(() => { setRemoving(null); setAdding(false); setPricing(null); setNaming(null); setEdit(null); setCancelling(null); setEnding(null); setMinimum(null); load(); });
  useEffect(() => { load(); }, [id]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const p = d.program, money = (c: number) => dollars(c, lang.value);
  const when = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
  // Signed up per date: the roster is one date's (the one picked, else the next one still to come).
  const byDate = p.sign_up === "per_session";
  const shown = byDate ? (day ?? d.sessions.find((s) => s.status !== "cancelled" && new Date(s.starts_at) > new Date(serverNow()))?.id ?? d.sessions[0]?.id ?? null) : null;
  const roster = byDate ? d.roster.filter((r) => r.session_id === shown) : d.roster;
  const onDate = shown ? { session_id: shown } : {};
  const booked = roster.filter((r) => r.status === "booked"), waiting = roster.filter((r) => r.status === "waitlisted"), gone = roster.filter((r) => r.status === "cancelled");

  const remove = (e: Event) => {
    e.preventDefault();
    preview("enrolment.remove", { enrolment_id: removing!.id, reason, ...(override ? { refund: { outcome, cents: Math.round(amount * 100), note: why } } : {}) });
  };
  const addDate = (e: Event) => { e.preventDefault(); preview("session.add", { program_id: id, starts_at: clubMoment(date.starts), ends_at: clubMoment(date.ends), court_ids: date.courts,
    ...(date.coach ? { coach_id: date.coach } : {}), ...(date.weeks > 1 ? { weeks: date.weeks } : {}) }); };
  const editDates = (e: Event) => {
    e.preventDefault();
    const x = edit!;
    preview("series.edit", { session_id: x.session, scope: x.scope, ...(x.scope === "this" && x.when ? { starts_at: clubMoment(x.when) } : x.time ? { start_time: x.time } : {}),
      ...(x.minutes ? { minutes: Number(x.minutes) } : {}), ...(x.courts.length ? { court_ids: x.courts } : {}), ...(x.coach === "" ? {} : { coach_id: x.coach === "none" ? null : x.coach }),
      ...(x.capacity ? { capacity: Number(x.capacity) } : {}) });
  };
  const scopePick = (value: Scope, onPick: (v: Scope) => void) => <label>{t("ui.scope")}<select value={value} onChange={(e) => onPick(e.currentTarget.value as Scope)}>
    {(["this", "following", "all"] as const).map((k) => <option value={k}>{t(`ui.scope_${k}` as Key)}</option>)}</select></label>;
  const refundPick = (value: string, onPick: (v: "rule" | "full" | "none") => void) => <label>{t("ui.dates_refund_choice")}<select value={value} onChange={(e) => onPick(e.currentTarget.value as "rule" | "full" | "none")}>
    <option value="rule">{t("ui.refund_rule_dates")}</option><option value="full">{t("ui.refund_everything")}</option><option value="none">{t("ui.refund_nothing")}</option></select></label>;
  const upcoming = (s: { starts_at: string; status: string }) => s.status !== "cancelled" && new Date(s.starts_at) > new Date(serverNow());
  // Who runs a date: one of the coaches, or nobody named.
  const coachPick = (value: string, onPick: (v: string) => void) => <select aria-label={t("ui.coach")} value={value} onChange={(e) => onPick(e.currentTarget.value)}>
    <option value="">{t("ui.no_coach")}</option>{d.coaches.map((c) => <option value={c.id}>{c.name}</option>)}</select>;
  const find = async (q: string) => { setSearch(q); setFound(q.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(q)}`) : []); };

  return (
    <main>
      <h1>{p.name} {!naming && <button class="small" onClick={() => setNaming({ name: p.name, tr: savedIn(p.translations, "name") })}>{t("ui.rename")}</button>}</h1>
      {naming && <form class="card card-form" onSubmit={(e) => { e.preventDefault(); preview("program.set_name", { program_id: id, name: naming.name.trim(), translations: translationsOf({ name: naming.tr }) }); }}>
        <label>{t("ui.name")}<input required maxLength={120} value={naming.name} onInput={(e) => setNaming({ ...naming, name: e.currentTarget.value })} /></label>
        <OtherLang value={naming.tr} onInput={(v) => setNaming({ ...naming, tr: v })} source={naming.name} maxLength={120} />
        <button class="primary">{t("ui.preview")}</button> <button type="button" onClick={() => setNaming(null)}>{t("ui.cancel")}</button>
      </form>}
      <p class="meta">{t(`kind.${p.kind}` as Key)} · {byDate ? t("ui.per_date_label") : t("ui.places_taken", { booked: booked.length, capacity: p.capacity })} · {money(p.price_cents)}{p.member_price_cents !== null ? ` (${t("ui.members_pay", { amount: money(p.member_price_cents) })})` : ""} · {t(`ui.status_${p.status}` as Key)}{" "}
        {!pricing && <button class="small" onClick={() => setPricing({ price: String(p.price_cents / 100), member: p.member_price_cents === null ? "" : String(p.member_price_cents / 100) })}>{t("ui.change_prices")}</button>}</p>
      {pricing && <form class="card card-form" onSubmit={(e) => { e.preventDefault(); preview("program.set_prices", { program_id: id, price_cents: parseDollars(pricing.price) ?? NaN,
        member_price_cents: pricing.member.trim() ? parseDollars(pricing.member) ?? NaN : null }); }}>
        <label>{t("ui.price")}<input required inputMode="decimal" pattern={AMOUNT_PATTERN} title={t("ui.amount_format")} value={pricing.price} onInput={(e) => setPricing({ ...pricing, price: e.currentTarget.value })} /></label>
        <label>{t("ui.member_price_optional")}<input inputMode="decimal" pattern={AMOUNT_PATTERN} title={t("ui.amount_format")} value={pricing.member} onInput={(e) => setPricing({ ...pricing, member: e.currentTarget.value })} /></label>
        {d.roster.some((r) => r.status !== "cancelled") && <p class="meta">{t("ui.member_price_note")}</p>}
        <button class="primary">{t("ui.preview")}</button> <button type="button" onClick={() => setPricing(null)}>{t("ui.cancel")}</button>
      </form>}
      {/* How people sign up: only before anyone has (clinics and socials can go date by date). */}
      {d.roster.length === 0 && p.status !== "cancelled" && (p.kind === "clinic" || p.kind === "social" || byDate) && <p><button class="small" onClick={() => preview("program.set_sign_up", { program_id: id, sign_up: byDate ? "whole_program" : "per_session" })}>
        {t(byDate ? "ui.make_whole" : "ui.make_per_date")}</button></p>}
      {p.status !== "cancelled" && <p class="meta">{p.min_players ? t("ui.min_to_run", { min: p.min_players, hours: t("count.hours", { count: p.decide_hours ?? d.decide_hours }) }) : t("ui.no_min")}
        {p.min_decided_at && p.status === "published" ? ` · ${t("ui.min_decided_runs")}` : ""}{" "}
        {!minimum && <button class="small" onClick={() => setMinimum({ min: p.min_players ? String(p.min_players) : "", hours: p.decide_hours ? String(p.decide_hours) : "" })}>{t("ui.change")}</button>}</p>}
      {minimum && <form class="card card-form" onSubmit={(e) => { e.preventDefault(); preview("program.set_minimum", { program_id: id, min_players: minimum.min.trim() ? Number(minimum.min) : null, decide_hours: minimum.hours.trim() ? Number(minimum.hours) : null }); }}>
        <label>{t("ui.min_players")}<input type="number" min="1" max={p.capacity} value={minimum.min} onInput={(e) => setMinimum({ ...minimum, min: e.currentTarget.value })} /></label>
        <label>{t("ui.decide_hours")}<input type="number" min="1" max="336" value={minimum.hours} onInput={(e) => setMinimum({ ...minimum, hours: e.currentTarget.value })} /></label>
        <button class="primary">{t("ui.preview")}</button> <button type="button" onClick={() => setMinimum(null)}>{t("ui.cancel")}</button>
      </form>}
      {look && <section class="card">
        <h2>{t("ui.members_will_see")}</h2>
        <ul class="changes"><ProgramCard p={look.card} /></ul>
        {look.dates.length > 0 && <ul class="plain">{look.dates.map((x) => <li class="meta">{when(x.starts_at)} · {x.courts.join(", ")}{x.coach ? ` · ${x.coach}` : ""}</li>)}</ul>}
        {look.blocks.length > 0 && <div class="error"><strong>{t("ui.publish_blocked")}</strong> {look.blocks.join(" ")}</div>}
        {look.warnings.length > 0 && <p class="meta">{t("ui.worth_knowing")} {look.warnings.join(" ")}</p>}
        <button class="primary" disabled={look.blocks.length > 0} onClick={() => preview("program.publish", { program_id: id })}>{t("ui.publish")}</button>
      </section>}
      {sheet}
      {(p.kind === "tournament" || p.kind === "league") && <p><a class="button" href={`/programs/${id}/competition`}>{t("ui.open_competition")}</a></p>}

      <section class="card">
        <h2>{t("ui.dates")}</h2>
        {d.sessions.map((s) => <p>{when(s.starts_at)}{s.courts.length ? ` · ${s.courts.join(", ")}` : ""}
          {byDate && s.status !== "cancelled" && <> · <button class={s.id === shown ? "small primary" : "small"} onClick={() => setDay(s.id)}>{t("ui.date_roster", { booked: s.booked, places: s.places })}</button></>} {p.format && <a href={`/sessions/${s.id}`}>{t("ui.open_night")}</a>}
          {s.status !== "cancelled" && <> <a href={`/roster/session/${s.id}`}>{t("ui.students")}</a></>}
          {s.status !== "cancelled" && new Date(s.starts_at) <= new Date(serverNow()) && <> <a href={`/sessions/${s.id}/levels`}>{t("ui.set_levels")}</a></>}
          {s.status !== "cancelled" && d.coaches.length > 0 && <> {coachPick(s.coach_id ?? "", (v) => preview("session.set_coach", { session_id: s.id, coach_id: v || null }))}</>}
          {s.status === "cancelled" && <span class="meta"> · {t("ui.status_cancelled")}</span>}
          {upcoming(s) && p.status !== "cancelled" && <> <button class="small" onClick={() => { setCancelling(null); setEdit({ session: s.id, scope: "this", when: "", time: "", minutes: "", courts: [], coach: "", capacity: "" }); }}>{t("ui.change_date")}</button>
            {" "}<button class="small" onClick={() => { setEdit(null); setCancelling({ session: s.id, scope: "this", refund: "rule", note: "" }); }}>{t("ui.cancel_date")}</button></>}</p>)}
        {edit && <form class="card sheet" onSubmit={editDates}>
          {scopePick(edit.scope, (v) => setEdit({ ...edit, scope: v }))}
          {edit.scope === "this" && <label>{t("ui.new_date_time")}<input type="datetime-local" value={edit.when} onInput={(e) => setEdit({ ...edit, when: e.currentTarget.value })} /></label>}
          {!(edit.scope === "this" && edit.when) && <label>{t("ui.start_time")}<input type="time" value={edit.time} onInput={(e) => setEdit({ ...edit, time: e.currentTarget.value })} /></label>}
          <label>{t("ui.length_minutes")}<input type="number" min="15" max="720" step="15" value={edit.minutes} onInput={(e) => setEdit({ ...edit, minutes: e.currentTarget.value })} /></label>
          <fieldset><legend>{t("ui.courts_keep")}</legend>{courts.map((c) => <label class="check"><input type="checkbox" checked={edit.courts.includes(c.id)} onChange={(e) => setEdit({ ...edit, courts: e.currentTarget.checked ? [...edit.courts, c.id] : edit.courts.filter((x) => x !== c.id) })} /> {c.name}</label>)}</fieldset>
          {d.coaches.length > 0 && <label>{t("ui.coach")}<select value={edit.coach} onChange={(e) => setEdit({ ...edit, coach: e.currentTarget.value })}>
            <option value="">{t("ui.coach_keep")}</option><option value="none">{t("ui.no_coach")}</option>{d.coaches.map((c) => <option value={c.id}>{c.name}</option>)}</select></label>}
          <label>{t(byDate ? "ui.places_each" : "ui.places_all")}<input type="number" min="1" value={edit.capacity} placeholder={String(p.capacity)} onInput={(e) => setEdit({ ...edit, capacity: e.currentTarget.value })} /></label>
          <button class="primary">{t("ui.preview")}</button> <button type="button" onClick={() => setEdit(null)}>{t("ui.cancel")}</button>
        </form>}
        {cancelling && <form class="card sheet" onSubmit={(e) => { e.preventDefault(); preview("series.cancel", { session_id: cancelling.session, scope: cancelling.scope, refund: cancelling.refund, ...(cancelling.note.trim() ? { note: cancelling.note.trim() } : {}) }); }}>
          {scopePick(cancelling.scope, (v) => setCancelling({ ...cancelling, scope: v }))}
          {refundPick(cancelling.refund, (v) => setCancelling({ ...cancelling, refund: v }))}
          <label>{t("ui.note")}<input value={cancelling.note} onInput={(e) => setCancelling({ ...cancelling, note: e.currentTarget.value })} /></label>
          <button class="primary">{t("ui.preview")}</button> <button type="button" onClick={() => setCancelling(null)}>{t("ui.back")}</button>
        </form>}
        {!adding ? <button onClick={() => setAdding(true)}>{t("ui.add_date")}</button> : <form onSubmit={addDate}>
          <label>{t("ui.starts")}<input type="datetime-local" required value={date.starts} onInput={(e) => setDate({ ...date, starts: e.currentTarget.value })} /></label>
          <label>{t("ui.ends")}<input type="datetime-local" required value={date.ends} onInput={(e) => setDate({ ...date, ends: e.currentTarget.value })} /></label>
          <fieldset><legend>{t("ui.courts")}</legend>{courts.map((c) => <label class="check"><input type="checkbox" checked={date.courts.includes(c.id)} onChange={(e) => setDate({ ...date, courts: e.currentTarget.checked ? [...date.courts, c.id] : date.courts.filter((x) => x !== c.id) })} /> {c.name}</label>)}</fieldset>
          {d.coaches.length > 0 && <label>{t("ui.coach")}{coachPick(date.coach, (v) => setDate({ ...date, coach: v }))}</label>}
          <label>{t("ui.weeks")}<input type="number" min="1" max="52" value={date.weeks} onInput={(e) => setDate({ ...date, weeks: Math.max(1, Math.min(52, Number(e.currentTarget.value) || 1)) })} /></label>
          {!date.courts.length && <p class="meta">{t("issue.court")}</p>}
          <button class="primary" disabled={!date.courts.length}>{t("ui.preview")}</button> <button type="button" onClick={() => setAdding(false)}>{t("ui.cancel")}</button>
        </form>}
      </section>

      <section class="card">
        <h2>{t("ui.roster")}{byDate && shown ? `: ${when(d.sessions.find((s) => s.id === shown)!.starts_at)}` : ""}</h2>
        <ul class="plain">{booked.map((r) => (
          <li class="row"><div><a href={`/people/${r.person_id}/level`}>{r.display_name}</a>{r.level && <span class="meta"> · {t("ui.level")} {r.level}</span>}
            <span class="meta"> · {r.paid_by === "comp" ? t("ui.comped", { note: r.comp_note ?? "" }) : r.price_basis === "included" ? t("ui.included_place") : r.paid_cents > 0 ? t("ui.paid", { amount: money(r.paid_cents) }) : t("ui.unpaid")}</span></div>
            <span>{r.paid_by !== "comp" && r.price_cents > r.paid_cents && mayDo("enrolment.record_payment") && <><button class="small" onClick={() => { setPaying(r); setRemoving(null); }}>{t("ui.record_payment")}</button>{" "}</>}
            <button class="small" onClick={() => { setRemoving(r); setPaying(null); setOverride(false); setReason("late_cancel"); }}>{t("ui.remove")}</button></span></li>))}</ul>
        {paying && (
          <div class="card sheet">
            <p><strong>{paying.display_name}</strong></p>
            <DeskPay key={paying.id} owed={paying.price_cents - paying.paid_cents} label={t("ui.place_owed", { amount: money(paying.price_cents - paying.paid_cents) })} onCancel={() => setPaying(null)}
              send={(cents, method) => { const id = paying.id; setPaying(null); preview("enrolment.record_payment", { enrolment_id: id, cents, method }); }} />
          </div>
        )}
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
        {waiting.length > 0 && <><h2>{t("ui.waitlist")}</h2><ol>{waiting.map((r) => <li>{r.display_name}{r.offer_expires_at && <span class="meta"> · {t("ui.offer_until", { time: shortTime(r.offer_expires_at) })}</span>}
          {" "}<button class="small" onClick={() => preview("enrolment.comp", { program_id: id, person_id: r.person_id, note: compNote.trim() || t("ui.comp_waitlist_note"), ...onDate })}>{t("ui.give_place_now")}</button></li>)}</ol></>}
        {byDate && p.status === "published" && mayDo("enrolment.join_dates") && <SignUpDates programId={id} sessions={d.sessions} when={when} preview={preview} />}
        <h2>{t(byDate ? "ui.give_place_date" : "ui.comp")}</h2>
        <input placeholder={t("ui.search_person")} value={search} onInput={(e) => find(e.currentTarget.value)} />
        <input placeholder={t("ui.note")} value={compNote} onInput={(e) => setCompNote(e.currentTarget.value)} />
        <ul class="plain">{found.map((f) => <li><button class="small" disabled={!compNote.trim()} onClick={() => preview("enrolment.comp", { program_id: id, person_id: f.id, note: compNote, ...onDate })}>{f.display_name}</button></li>)}</ul>
        {gone.length > 0 && <><h2>{t("ui.gone")}</h2><ul class="plain">{gone.map((r) => <li class="meta">{r.display_name} · {r.left_reason ? t(`reason.${r.left_reason}` as Key) : ""} · {r.refund_outcome ? t(`ui.outcome_${r.refund_outcome}` as Key) : ""}{r.refund_cents ? ` ${money(r.refund_cents)}` : ""}</li>)}</ul></>}
      </section>

      {p.status !== "cancelled" && <section class="card">
        {!ending ? <button onClick={() => setEnding({ refund: "rule", note: "" })}>{t("ui.cancel_program")}</button>
          : <form onSubmit={(e) => { e.preventDefault(); preview("program.cancel", { program_id: id, refund: ending.refund, ...(ending.note.trim() ? { note: ending.note.trim() } : {}) }); }}>
            {refundPick(ending.refund, (v) => setEnding({ ...ending, refund: v }))}
            <label>{t("ui.note")}<input value={ending.note} onInput={(e) => setEnding({ ...ending, note: e.currentTarget.value })} /></label>
            <button class="primary">{t("ui.preview")}</button> <button type="button" onClick={() => setEnding(null)}>{t("ui.cancel")}</button>
          </form>}
      </section>}
    </main>
  );
}

/** Signed up date by date: the desk signs a member up for one or several dates in one go. A date with room is a place,
 *  a full one the waitlist; the member pays what's owed by card in the app, and hears once with every date and the
 *  amount. A place at no charge is "give a place" below. */
function SignUpDates({ programId, sessions, when, preview }: { programId: string; sessions: Data["sessions"]; when: (iso: string) => string; preview: (action: string, input: unknown) => Promise<void> }) {
  const [q, setQ] = useState(""), [found, setFound] = useState<{ id: string; display_name: string }[]>([]);
  const [who, setWho] = useState<{ id: string; display_name: string } | null>(null), [picked, setPicked] = useState<string[]>([]);
  const ahead = sessions.filter((s) => s.status !== "cancelled" && new Date(s.starts_at) > new Date(serverNow()));
  const find = async (v: string) => { setQ(v); setFound(v.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(v)}`) : []); };
  if (!ahead.length) return null;
  return (
    <form class="card-form" onSubmit={(e) => { e.preventDefault(); void preview("enrolment.join_dates", { program_id: programId, person_id: who!.id, session_ids: picked }); }}>
      <h2>{t("ui.desk_sign_up_dates")}</h2>
      {who ? <p>{who.display_name} <button type="button" class="link" onClick={() => setWho(null)}>{t("ui.change")}</button></p> : <>
        <label>{t("ui.search_person")}<input type="search" value={q} onInput={(e) => find(e.currentTarget.value)} /></label>
        {found.length > 0 && <ul class="plain">{found.slice(0, 6).map((f) => <li class="row"><span>{f.display_name}</span>
          <button type="button" class="small" onClick={() => { setWho(f); setFound([]); setQ(""); }}>{t("ui.choose")}</button></li>)}</ul>}
      </>}
      <fieldset><legend>{t("ui.dates")}</legend>{ahead.map((s) => <label class="check"><input type="checkbox" checked={picked.includes(s.id)}
        onChange={(e) => setPicked(e.currentTarget.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} /> {when(s.starts_at)} · {t("ui.date_roster", { booked: s.booked, places: s.places })}</label>)}</fieldset>
      <p class="meta">{t("ui.desk_sign_up_dates_hint")}</p>
      <button class="primary" disabled={!who || !picked.length}>{t("ui.preview")}</button>
    </form>
  );
}
