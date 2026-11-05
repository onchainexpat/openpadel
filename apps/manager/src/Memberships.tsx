// Memberships: the plans the club offers, who has one, and giving or ending one. A plan says what it costs
// and how far ahead its members book; member prices are court prices for chosen plans (Settings, Prices).
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { AMOUNT_PATTERN, parseDollars } from "@kumi/i18n/format";
import { api, dollars, lang, mayDo, OtherLang, savedIn, t, translationsOf, usePreview, clubTime, serverNow } from "@kumi/ui";
import { DeskPay } from "./DeskPay.tsx";

export type Plan = { id: string; name: string; description: string | null; translations?: unknown; price_cents: number; period: "month" | "year"; days_ahead: number | null; join_in_app?: boolean;
  max_members?: number | null; starts_on?: string | null; perks_before_start?: boolean; sort: number; members: number;
  program_percent_off?: number | null; program_cents_off?: number | null; included_sessions?: number | null; included_kinds?: string[]; family_size?: number | null; extra_person_cents?: number | null };
/** What a plan gives on programs, for its line in the list. */
const programPerks = (p: Plan) => [p.program_percent_off ? t("ui.plan_programs_percent", { percent: p.program_percent_off }) : p.program_cents_off ? t("ui.plan_programs_amount", { amount: dollars(p.program_cents_off, lang.value) }) : null,
  p.included_sessions ? `${t("ui.plan_included_meta", { count: p.included_sessions, period: t(`ui.period_${p.period}`) })} (${(p.included_kinds ?? []).map((k) => t(`kind.${k}` as Key)).join(", ")})` : null];
type Member = { id: string; person_id: string; display_name: string; email: string | null; plan: string; status: string; source: string; started_at: string; current_period_end: string | null;
  cancel_at_period_end: boolean; ended_at: string | null; end_reason: string | null; note: string | null; price_cents: number | null; ends_on: string | null; card_saved: boolean; paused_until: string | null;
  balance_cents?: number; also_covers?: string[] };
type Preview = (action: string, input: unknown) => Promise<void>;

const day = (iso: string) => clubTime(iso, { dateStyle: "medium" });
/** A club date ("2026-11-30"), as written here. */
const clubDay = (date: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
/** When it runs until or renews, and how it came: the line under a member's name. */
export const pausedNow = (m: { paused_until?: string | null }) => Boolean(m.paused_until && new Date(m.paused_until) > new Date(serverNow()));
export function membershipLine(m: { status: string; source: string; started_at: string; ends_on: string | null; cancel_at_period_end: boolean; note: string | null; card_saved?: boolean; paused_until?: string | null;
  price_cents?: number | null; balance_cents?: number }) {
  // Joined before its plan starts: when it starts, and whether the card is saved for the first charge.
  if (m.status === "upcoming") return [t("ui.starts_on", { date: clubDay(m.ends_on!) }), t(m.card_saved ? "ui.card_saved" : "ui.no_card_yet"), m.note].filter(Boolean).join(" · ");
  const end = !m.ends_on ? t("ui.no_end_date") : m.source !== "app" ? t("ui.member_until", { date: clubDay(m.ends_on) })
    : m.cancel_at_period_end ? t("ui.cancelled_runs_until", { date: clubDay(m.ends_on) }) : t("ui.renews_on", { date: clubDay(m.ends_on) });
  const paused = pausedNow(m) ? t("ui.paused_until", { date: day(new Date(new Date(m.paused_until!).getTime() - 1).toISOString()) }) : null;
  // From the desk: given, or paid there for a period (it has a price), and what's still owed there.
  const how = m.source === "desk" && m.price_cents != null ? t("ui.membership_desk_paid") : t(`ui.membership_${m.source}` as Key);
  const owed = m.balance_cents ? t("ui.membership_owed", { amount: dollars(m.balance_cents, lang.value) }) : null;
  return [paused, t("ui.member_since", { date: day(m.started_at) }), end, how, owed, m.note].filter(Boolean).join(" · ");
}
/** Money for it taken at the desk: what's still owed, or the next period (the server says how much, and which). */
export function MembershipDesk({ m, send }: { m: { id: string; due?: { cents: number; next: boolean } | null }; send: Preview }) {
  if (!m.due) return null;
  return <DeskPay owed={m.due.cents} label={m.due.next ? t("ui.next_period_due", { amount: dollars(m.due.cents, lang.value) }) : t("ui.membership_owed", { amount: dollars(m.due.cents, lang.value) })}
    send={(cents, method) => void send("membership.record_payment", { membership_id: m.id, cents, method })} />;
}
/** What staff can do with one: stop or restart its renewal (joined in the app), and end it now. */
export function MembershipButtons({ m, send }: { m: { id: string; status: string; source: string; cancel_at_period_end: boolean; paused_until?: string | null }; send: Preview }) {
  const [pausing, setPausing] = useState(false), [until, setUntil] = useState("");
  return <span>
    {m.status !== "upcoming" && (pausedNow(m)
      ? <button class="small" onClick={() => send("membership.unpause", { membership_id: m.id })}>{t("ui.unpause")}</button>
      : !pausing ? <button class="small" onClick={() => setPausing(true)}>{t("ui.pause")}</button>
        : <form class="court-row" onSubmit={(e) => { e.preventDefault(); void send("membership.pause", { membership_id: m.id, until }); }}>
          <label>{t("ui.pause_until")}<input type="date" required value={until} onInput={(e) => setUntil(e.currentTarget.value)} /></label><button class="small">{t("ui.preview")}</button></form>)}{" "}
    {m.source === "app" && m.status !== "upcoming" && (m.cancel_at_period_end
      ? <button class="small" onClick={() => send("membership.resume", { membership_id: m.id })}>{t("ui.renew_again")}</button>
      : <button class="small" onClick={() => send("membership.cancel", { membership_id: m.id })}>{t("ui.stop_renewing")}</button>)}{" "}
    <button class="small" onClick={() => send("membership.end", { membership_id: m.id })}>{t("ui.end_membership")}</button>
  </span>;
}
export const planPrice = (p: { price_cents: number; period: string }) => t(p.period === "year" ? "ui.price_a_year" : "ui.price_a_month", { amount: dollars(p.price_cents, lang.value) });

export function Memberships() {
  const [d, setD] = useState<{ plans: Plan[]; members: Member[] } | null>(null), [q, setQ] = useState("");
  const load = () => api<{ plans: Plan[]; members: Member[] }>("/staff/memberships").then(setD);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, []);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const live = d.members.filter((m) => m.status !== "ended" && (!q || m.display_name.toLowerCase().includes(q.toLowerCase()))), ended = d.members.filter((m) => m.status === "ended");
  return (
    <main>
      <h1>{t("ui.nav_memberships")}</h1>
      {sheet}
      {/* Keyed, so the forms start empty again after a change. */}
      <Plans key={JSON.stringify(d.plans)} plans={d.plans} send={preview} />
      {d.plans.length > 0 && <GiveMembership key={d.members.length} plans={d.plans} send={preview} />}
      <section class="card">
        <h2>{t("ui.members_now", { count: d.members.filter((m) => m.status !== "ended").length })}</h2>
        {d.members.length > 8 && <label>{t("ui.search_person")}<input type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>}
        {live.length === 0 ? <p class="meta">{t("ui.no_members_yet")}</p> : (
          <ul class="plain">{live.map((m) => (
            <li class="row"><span><a href={`/people/${m.person_id}`}>{m.display_name}</a> <span class="badge">{m.plan}</span>{m.status === "past_due" && <> <span class="badge warn">{t("ui.past_due")}</span></>}<br />
              <span class="meta">{membershipLine(m)}{m.also_covers?.length ? ` · ${t("ui.family_covers_staff", { names: m.also_covers.join(", ") })}` : ""}</span></span>
              <MembershipButtons m={m} send={preview} /></li>))}</ul>
        )}
        {ended.length > 0 && <>
          <h3>{t("ui.ended_recently")}</h3>
          <ul class="plain">{ended.map((m) => <li class="row"><span><a href={`/people/${m.person_id}`}>{m.display_name}</a> · {m.plan}</span>
            <span class="meta">{t("ui.ended_on", { date: day(m.ended_at!) })}{m.end_reason === "not_paid" ? ` · ${t("ui.ended_not_paid")}` : ""}</span></li>)}</ul>
        </>}
      </section>
    </main>
  );
}

function Plans({ plans, send }: { plans: Plan[]; send: Preview }) {
  const blank = { plan_id: "", name: "", dollars: "", period: "month" as "month" | "year", days_ahead: "", description: "", join_in_app: true, max_members: "", starts_on: "", perks_before_start: true,
    discount: "none" as "none" | "percent" | "dollars", off: "", included: "", kinds: ["clinic", "social"], family: "", extra: "", name_tr: "", description_tr: "" };
  const [f, setF] = useState(blank);
  const edit = (p: Plan) => setF({ plan_id: p.id, name: p.name, dollars: String(p.price_cents / 100), period: p.period, days_ahead: p.days_ahead ? String(p.days_ahead) : "", description: p.description ?? "", join_in_app: p.join_in_app ?? true,
    max_members: p.max_members ? String(p.max_members) : "", starts_on: p.starts_on ?? "", perks_before_start: p.perks_before_start ?? true,
    discount: p.program_percent_off ? "percent" : p.program_cents_off ? "dollars" : "none", off: p.program_percent_off ? String(p.program_percent_off) : p.program_cents_off ? String(p.program_cents_off / 100) : "",
    included: p.included_sessions ? String(p.included_sessions) : "", kinds: p.included_kinds ?? ["clinic", "social"],
    family: p.family_size ? String(p.family_size) : "", extra: p.extra_person_cents != null ? String(p.extra_person_cents / 100) : "",
    name_tr: savedIn(p.translations, "name"), description_tr: savedIn(p.translations, "description") });
  return (
    <section class="card">
      <h2>{t("ui.plans")}</h2>
      {plans.length === 0 && <p class="meta">{t("ui.no_plans")}</p>}
      <ul class="plain">{plans.map((p) => (
        <li class="row"><span><strong>{p.name}</strong> {planPrice(p)}<br />
          <span class="meta">{[p.days_ahead ? t("ui.plan_window", { count: p.days_ahead }) : null, p.max_members ? t("ui.plan_places_taken", { count: p.members, max: p.max_members }) : t("count.members", { count: p.members }),
            p.starts_on ? t("ui.starts_on", { date: clubDay(p.starts_on) }) : null, p.family_size ? t("ui.plan_family_meta", { count: p.family_size }) : null, ...programPerks(p), p.join_in_app === false ? t("ui.plan_desk_only") : null, p.description].filter(Boolean).join(" · ")}</span></span>
          <span><button type="button" class="small" onClick={() => edit(p)}>{t("ui.change")}</button> <button type="button" class="small" onClick={() => send("membership.plan_remove", { plan_id: p.id })}>{t("ui.stop_offering")}</button></span></li>))}</ul>
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("membership.plan_set", { ...(f.plan_id ? { plan_id: f.plan_id } : {}), name: f.name.trim(), price_cents: parseDollars(f.dollars) ?? NaN,
        period: f.period, days_ahead: f.days_ahead ? Number(f.days_ahead) : null, description: f.description.trim() || null, join_in_app: f.join_in_app,
        max_members: f.max_members ? Number(f.max_members) : null, starts_on: f.starts_on || null, ...(f.starts_on ? { perks_before_start: f.perks_before_start } : {}),
        program_percent_off: f.discount === "percent" && f.off ? Math.round(Number(f.off)) : null,
        program_cents_off: f.discount === "dollars" && f.off ? parseDollars(f.off) ?? NaN : null,
        included_sessions: f.included ? Number(f.included) : null, ...(f.kinds.length ? { included_kinds: f.kinds } : {}),
        family_size: f.family ? Number(f.family) : null, extra_person_cents: f.family && f.extra !== "" ? parseDollars(f.extra) ?? NaN : null,
        translations: translationsOf({ name: f.name_tr, description: f.description_tr }) }); }}>
        <label>{f.plan_id ? t("ui.change_plan") : t("ui.add_plan")}<input required maxLength={60} placeholder={t("ui.plan_name_hint")} value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
        <OtherLang value={f.name_tr} onInput={(v) => setF({ ...f, name_tr: v })} source={f.name} maxLength={60} />
        <div class="court-row"><label>{t("ui.plan_dollars")}<input required inputMode="decimal" pattern={AMOUNT_PATTERN} title={t("ui.amount_format")} value={f.dollars} onInput={(e) => setF({ ...f, dollars: e.currentTarget.value })} /></label>
          <label>{t("ui.plan_period")}<select value={f.period} onChange={(e) => setF({ ...f, period: e.currentTarget.value as "month" | "year" })}><option value="month">{t("ui.period_month")}</option><option value="year">{t("ui.period_year")}</option></select></label></div>
        <label>{t("ui.plan_days_ahead")}<input type="number" min={1} max={365} value={f.days_ahead} onInput={(e) => setF({ ...f, days_ahead: e.currentTarget.value })} /></label>
        <label>{t("ui.plan_description")}<input maxLength={300} value={f.description} onInput={(e) => setF({ ...f, description: e.currentTarget.value })} /></label>
        <OtherLang value={f.description_tr} onInput={(v) => setF({ ...f, description_tr: v })} source={f.description} maxLength={300} />
        <div class="court-row"><label>{t("ui.plan_max_members")}<input type="number" min={1} value={f.max_members} onInput={(e) => setF({ ...f, max_members: e.currentTarget.value })} /></label>
          <label>{t("ui.plan_start_date")}<input type="date" value={f.starts_on} onInput={(e) => setF({ ...f, starts_on: e.currentTarget.value })} /></label></div>
        <p class="meta">{t("ui.presale_hint")}</p>
        {f.starts_on && <label class="check"><input type="checkbox" checked={f.perks_before_start} onChange={(e) => setF({ ...f, perks_before_start: e.currentTarget.checked })} /> {t("ui.plan_perks_before_start")}</label>}
        <label class="check"><input type="checkbox" checked={f.join_in_app} onChange={(e) => setF({ ...f, join_in_app: e.currentTarget.checked })} /> {t("ui.plan_join_in_app")}</label>
        <div class="court-row"><label>{t("ui.plan_family_size")}<input type="number" min={2} max={12} value={f.family} onInput={(e) => setF({ ...f, family: e.currentTarget.value })} /></label>
          {f.family && <label>{t("ui.plan_extra_person")}<input inputMode="decimal" pattern={AMOUNT_PATTERN} title={t("ui.amount_format")} value={f.extra} onInput={(e) => setF({ ...f, extra: e.currentTarget.value })} /></label>}</div>
        <fieldset><legend>{t("ui.plan_program_perks")}</legend>
          <div class="court-row"><label>{t("ui.discount")}<select value={f.discount} onChange={(e) => setF({ ...f, discount: e.currentTarget.value as typeof f.discount })}>
            {(["none", "percent", "dollars"] as const).map((k) => <option value={k}>{t(`ui.discount_${k}`)}</option>)}</select></label>
            {f.discount !== "none" && <label>{t("ui.discount_amount")} ({f.discount === "percent" ? "%" : "$"})<input required inputMode="decimal" pattern={AMOUNT_PATTERN} title={t("ui.amount_format")} value={f.off} onInput={(e) => setF({ ...f, off: e.currentTarget.value })} /></label>}</div>
          <label>{t("ui.plan_included_sessions")}<input type="number" min={1} max={100} value={f.included} onInput={(e) => setF({ ...f, included: e.currentTarget.value })} /></label>
          {f.included && <div role="group" aria-label={t("ui.plan_included_kinds")}><span class="meta">{t("ui.plan_included_kinds")}</span>{["clinic", "social", "tournament"].map((k) => <label class="check">
            <input type="checkbox" checked={f.kinds.includes(k)} onChange={(e) => setF({ ...f, kinds: e.currentTarget.checked ? [...f.kinds, k] : f.kinds.filter((x) => x !== k) })} /> {t(`kind.${k}` as Key)}</label>)}</div>}
        </fieldset>
        <p class="meta">{t("ui.member_prices_hint")}</p>
        <button>{t("ui.preview")}</button> {f.plan_id && <button type="button" class="link" onClick={() => setF(blank)}>{t("ui.cancel")}</button>}
      </form>
    </section>
  );
}

/** Give someone a membership: found by name here, or the person already chosen (their page). */
export function GiveMembership({ plans, send, person }: { plans: Plan[]; send: Preview; person?: { id: string; display_name: string } }) {
  const [who, setWho] = useState(person ?? null), [q, setQ] = useState(""), [found, setFound] = useState<{ id: string; display_name: string; email: string | null }[]>([]);
  const [f, setF] = useState({ plan_id: plans[0]?.id ?? "", until: "", note: "", paid: false, dollars: "", method: "cash" });
  const find = async (v: string) => { setQ(v); setFound(v.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(v)}`) : []); };
  const chosen = plans.find((p) => p.id === f.plan_id), note = f.note.trim() ? { note: f.note.trim() } : {};
  // Paid at the desk: one period, for the plan's price unless only part is paid now.
  const cents = f.dollars ? parseDollars(f.dollars) ?? NaN : chosen?.price_cents ?? 0;
  return (
    <form class="card card-form" onSubmit={(e) => { e.preventDefault(); f.paid ? send("membership.sell", { person_id: who!.id, plan_id: f.plan_id, cents, method: f.method, ...note })
      : send("membership.grant", { person_id: who!.id, plan_id: f.plan_id, until: f.until || null, ...note }); }}>
      <h2>{t("ui.give_membership")}</h2>
      {!person && (who ? <p>{who.display_name} <button type="button" class="link" onClick={() => setWho(null)}>{t("ui.change")}</button></p> : <>
        <label>{t("ui.search_person")}<input type="search" value={q} onInput={(e) => find(e.currentTarget.value)} /></label>
        {found.length > 0 && <ul class="plain">{found.slice(0, 6).map((p) => <li class="row"><span>{p.display_name}<span class="meta"> {p.email ?? ""}</span></span><button type="button" class="small" onClick={() => { setWho(p); setFound([]); setQ(""); }}>{t("ui.choose")}</button></li>)}</ul>}
      </>)}
      <label>{t("ui.plan")}<select value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: e.currentTarget.value })}>{plans.map((p) => <option value={p.id}>{p.name} · {planPrice(p)}</option>)}</select></label>
      {mayDo("membership.sell") && <label>{t("ui.membership_how")}<select value={f.paid ? "paid" : "given"} onChange={(e) => setF({ ...f, paid: e.currentTarget.value === "paid", dollars: "" })}>
        <option value="given">{t("ui.membership_given")}</option><option value="paid">{t("ui.membership_paid_desk")}</option></select></label>}
      {f.paid ? <div class="court-row">
        <label>{t("ui.amount_paid")}<input inputMode="decimal" pattern={AMOUNT_PATTERN} title={t("ui.amount_format")} placeholder={chosen ? (chosen.price_cents / 100).toFixed(2) : ""} value={f.dollars} onInput={(e) => setF({ ...f, dollars: e.currentTarget.value })} /></label>
        <label>{t("ui.paid_how")}<select value={f.method} onChange={(e) => setF({ ...f, method: e.currentTarget.value })}>{["cash", "terminal", "other"].map((k) => <option value={k}>{t(`paid_by.${k}` as Key)}</option>)}</select></label>
      </div> : <label>{t("ui.membership_until")}<input type="date" value={f.until} onInput={(e) => setF({ ...f, until: e.currentTarget.value })} /></label>}
      <label>{t("ui.membership_note")}<input maxLength={200} placeholder={t("ui.membership_note_hint")} value={f.note} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} /></label>
      <p class="meta">{t(f.paid ? "ui.sell_membership_hint" : "ui.give_membership_hint")}</p>
      <button class="primary" disabled={!who || !f.plan_id}>{t("ui.preview")}</button>
    </form>
  );
}
