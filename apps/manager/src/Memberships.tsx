// Memberships: the plans the club offers, who has one, and giving or ending one. A plan says what it costs
// and how far ahead its members book; member prices are court prices for chosen plans (Settings, Prices).
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, dollars, lang, t, usePreview } from "@kumi/ui";

export type Plan = { id: string; name: string; description: string | null; price_cents: number; period: "month" | "year"; days_ahead: number | null; join_in_app?: boolean;
  max_members?: number | null; starts_on?: string | null; sort: number; members: number };
type Member = { id: string; person_id: string; display_name: string; email: string | null; plan: string; status: string; source: string; started_at: string; current_period_end: string | null;
  cancel_at_period_end: boolean; ended_at: string | null; end_reason: string | null; note: string | null; price_cents: number | null; ends_on: string | null; card_saved: boolean };
type Preview = (action: string, input: unknown) => Promise<void>;

const day = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium" }).format(new Date(iso));
/** A club date ("2026-11-30"), as written here. */
const clubDay = (date: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
/** When it runs until or renews, and how it came: the line under a member's name. */
export function membershipLine(m: { status: string; source: string; started_at: string; ends_on: string | null; cancel_at_period_end: boolean; note: string | null; card_saved?: boolean }) {
  // Joined before its plan starts: when it starts, and whether the card is saved for the first charge.
  if (m.status === "upcoming") return [t("ui.starts_on", { date: clubDay(m.ends_on!) }), t(m.card_saved ? "ui.card_saved" : "ui.no_card_yet"), m.note].filter(Boolean).join(" · ");
  const end = !m.ends_on ? t("ui.no_end_date") : m.source !== "app" ? t("ui.member_until", { date: clubDay(m.ends_on) })
    : m.cancel_at_period_end ? t("ui.cancelled_runs_until", { date: clubDay(m.ends_on) }) : t("ui.renews_on", { date: clubDay(m.ends_on) });
  return [t("ui.member_since", { date: day(m.started_at) }), end, t(`ui.membership_${m.source}` as Key), m.note].filter(Boolean).join(" · ");
}
/** What staff can do with one: stop or restart its renewal (joined in the app), and end it now. */
export function MembershipButtons({ m, send }: { m: { id: string; status: string; source: string; cancel_at_period_end: boolean }; send: Preview }) {
  return <span>
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
              <span class="meta">{membershipLine(m)}</span></span>
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
  const blank = { plan_id: "", name: "", dollars: "", period: "month" as "month" | "year", days_ahead: "", description: "", join_in_app: true, max_members: "", starts_on: "" };
  const [f, setF] = useState(blank);
  const edit = (p: Plan) => setF({ plan_id: p.id, name: p.name, dollars: String(p.price_cents / 100), period: p.period, days_ahead: p.days_ahead ? String(p.days_ahead) : "", description: p.description ?? "", join_in_app: p.join_in_app ?? true,
    max_members: p.max_members ? String(p.max_members) : "", starts_on: p.starts_on ?? "" });
  return (
    <section class="card">
      <h2>{t("ui.plans")}</h2>
      {plans.length === 0 && <p class="meta">{t("ui.no_plans")}</p>}
      <ul class="plain">{plans.map((p) => (
        <li class="row"><span><strong>{p.name}</strong> {planPrice(p)}<br />
          <span class="meta">{[p.days_ahead ? t("ui.plan_window", { count: p.days_ahead }) : null, p.max_members ? t("ui.plan_places_taken", { count: p.members, max: p.max_members }) : t("count.members", { count: p.members }),
            p.starts_on ? t("ui.starts_on", { date: clubDay(p.starts_on) }) : null, p.join_in_app === false ? t("ui.plan_desk_only") : null, p.description].filter(Boolean).join(" · ")}</span></span>
          <span><button type="button" class="small" onClick={() => edit(p)}>{t("ui.change")}</button> <button type="button" class="small" onClick={() => send("membership.plan_remove", { plan_id: p.id })}>{t("ui.stop_offering")}</button></span></li>))}</ul>
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("membership.plan_set", { ...(f.plan_id ? { plan_id: f.plan_id } : {}), name: f.name.trim(), price_cents: Math.round(Number(f.dollars.replace(",", ".")) * 100),
        period: f.period, days_ahead: f.days_ahead ? Number(f.days_ahead) : null, description: f.description.trim() || null, join_in_app: f.join_in_app,
        max_members: f.max_members ? Number(f.max_members) : null, starts_on: f.starts_on || null }); }}>
        <label>{f.plan_id ? t("ui.change_plan") : t("ui.add_plan")}<input required maxLength={60} placeholder={t("ui.plan_name_hint")} value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
        <div class="court-row"><label>{t("ui.plan_dollars")}<input required inputMode="decimal" value={f.dollars} onInput={(e) => setF({ ...f, dollars: e.currentTarget.value })} /></label>
          <label>{t("ui.plan_period")}<select value={f.period} onChange={(e) => setF({ ...f, period: e.currentTarget.value as "month" | "year" })}><option value="month">{t("ui.period_month")}</option><option value="year">{t("ui.period_year")}</option></select></label></div>
        <label>{t("ui.plan_days_ahead")}<input type="number" min={1} max={365} value={f.days_ahead} onInput={(e) => setF({ ...f, days_ahead: e.currentTarget.value })} /></label>
        <label>{t("ui.plan_description")}<input maxLength={300} value={f.description} onInput={(e) => setF({ ...f, description: e.currentTarget.value })} /></label>
        <div class="court-row"><label>{t("ui.plan_max_members")}<input type="number" min={1} value={f.max_members} onInput={(e) => setF({ ...f, max_members: e.currentTarget.value })} /></label>
          <label>{t("ui.plan_start_date")}<input type="date" value={f.starts_on} onInput={(e) => setF({ ...f, starts_on: e.currentTarget.value })} /></label></div>
        <p class="meta">{t("ui.presale_hint")}</p>
        <label class="check"><input type="checkbox" checked={f.join_in_app} onChange={(e) => setF({ ...f, join_in_app: e.currentTarget.checked })} /> {t("ui.plan_join_in_app")}</label>
        <p class="meta">{t("ui.member_prices_hint")}</p>
        <button>{t("ui.preview")}</button> {f.plan_id && <button type="button" class="link" onClick={() => setF(blank)}>{t("ui.cancel")}</button>}
      </form>
    </section>
  );
}

/** Give someone a membership: found by name here, or the person already chosen (their page). */
export function GiveMembership({ plans, send, person }: { plans: Plan[]; send: Preview; person?: { id: string; display_name: string } }) {
  const [who, setWho] = useState(person ?? null), [q, setQ] = useState(""), [found, setFound] = useState<{ id: string; display_name: string; email: string | null }[]>([]);
  const [f, setF] = useState({ plan_id: plans[0]?.id ?? "", until: "", note: "" });
  const find = async (v: string) => { setQ(v); setFound(v.length > 1 ? await api(`/staff/people?q=${encodeURIComponent(v)}`) : []); };
  return (
    <form class="card card-form" onSubmit={(e) => { e.preventDefault(); send("membership.grant", { person_id: who!.id, plan_id: f.plan_id, until: f.until || null, ...(f.note.trim() ? { note: f.note.trim() } : {}) }); }}>
      <h2>{t("ui.give_membership")}</h2>
      {!person && (who ? <p>{who.display_name} <button type="button" class="link" onClick={() => setWho(null)}>{t("ui.change")}</button></p> : <>
        <label>{t("ui.search_person")}<input type="search" value={q} onInput={(e) => find(e.currentTarget.value)} /></label>
        {found.length > 0 && <ul class="plain">{found.slice(0, 6).map((p) => <li class="row"><span>{p.display_name}<span class="meta"> {p.email ?? ""}</span></span><button type="button" class="small" onClick={() => { setWho(p); setFound([]); setQ(""); }}>{t("ui.choose")}</button></li>)}</ul>}
      </>)}
      <label>{t("ui.plan")}<select value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: e.currentTarget.value })}>{plans.map((p) => <option value={p.id}>{p.name} · {planPrice(p)}</option>)}</select></label>
      <label>{t("ui.membership_until")}<input type="date" value={f.until} onInput={(e) => setF({ ...f, until: e.currentTarget.value })} /></label>
      <label>{t("ui.membership_note")}<input maxLength={200} placeholder={t("ui.membership_note_hint")} value={f.note} onInput={(e) => setF({ ...f, note: e.currentTarget.value })} /></label>
      <p class="meta">{t("ui.give_membership_hint")}</p>
      <button class="primary" disabled={!who || !f.plan_id}>{t("ui.preview")}</button>
    </form>
  );
}
