// Memberships: the plans the club offers, who has one, and giving or ending one. A plan says what it costs
// and how far ahead its members book; member prices are court prices for chosen plans (Settings, Prices).
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, dollars, lang, t, usePreview } from "@kumi/ui";

export type Plan = { id: string; name: string; description: string | null; price_cents: number; period: "month" | "year"; days_ahead: number | null; sort: number; members: number };
type Member = { id: string; person_id: string; display_name: string; email: string | null; plan: string; status: string; source: string; started_at: string; current_period_end: string | null;
  cancel_at_period_end: boolean; ended_at: string | null; note: string | null };
type Preview = (action: string, input: unknown) => Promise<void>;

const day = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium" }).format(new Date(iso));
/** The last day of a membership that ends at midnight. */
const lastDay = (iso: string) => day(new Date(new Date(iso).getTime() - 1).toISOString());
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
            <li class="row"><span><a href={`/people/${m.person_id}`}>{m.display_name}</a> <span class="badge">{m.plan}</span><br />
              <span class="meta">{[t("ui.member_since", { date: day(m.started_at) }), m.current_period_end ? t("ui.member_until", { date: lastDay(m.current_period_end) }) : t("ui.no_end_date"),
                t(`ui.membership_${m.source}` as Key), m.note].filter(Boolean).join(" · ")}</span></span>
              <button class="small" onClick={() => preview("membership.end", { membership_id: m.id })}>{t("ui.end_membership")}</button></li>))}</ul>
        )}
        {ended.length > 0 && <>
          <h3>{t("ui.ended_recently")}</h3>
          <ul class="plain">{ended.map((m) => <li class="row"><span><a href={`/people/${m.person_id}`}>{m.display_name}</a> · {m.plan}</span><span class="meta">{t("ui.ended_on", { date: day(m.ended_at!) })}</span></li>)}</ul>
        </>}
      </section>
    </main>
  );
}

function Plans({ plans, send }: { plans: Plan[]; send: Preview }) {
  const blank = { plan_id: "", name: "", dollars: "", period: "month" as "month" | "year", days_ahead: "", description: "" };
  const [f, setF] = useState(blank);
  const edit = (p: Plan) => setF({ plan_id: p.id, name: p.name, dollars: String(p.price_cents / 100), period: p.period, days_ahead: p.days_ahead ? String(p.days_ahead) : "", description: p.description ?? "" });
  return (
    <section class="card">
      <h2>{t("ui.plans")}</h2>
      {plans.length === 0 && <p class="meta">{t("ui.no_plans")}</p>}
      <ul class="plain">{plans.map((p) => (
        <li class="row"><span><strong>{p.name}</strong> {planPrice(p)}<br />
          <span class="meta">{[p.days_ahead ? t("ui.plan_window", { count: p.days_ahead }) : null, t("count.members", { count: p.members }), p.description].filter(Boolean).join(" · ")}</span></span>
          <span><button type="button" class="small" onClick={() => edit(p)}>{t("ui.change")}</button> <button type="button" class="small" onClick={() => send("membership.plan_remove", { plan_id: p.id })}>{t("ui.stop_offering")}</button></span></li>))}</ul>
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("membership.plan_set", { ...(f.plan_id ? { plan_id: f.plan_id } : {}), name: f.name.trim(), price_cents: Math.round(Number(f.dollars.replace(",", ".")) * 100),
        period: f.period, days_ahead: f.days_ahead ? Number(f.days_ahead) : null, description: f.description.trim() || null }); }}>
        <label>{f.plan_id ? t("ui.change_plan") : t("ui.add_plan")}<input required maxLength={60} placeholder={t("ui.plan_name_hint")} value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
        <div class="court-row"><label>{t("ui.plan_dollars")}<input required inputMode="decimal" value={f.dollars} onInput={(e) => setF({ ...f, dollars: e.currentTarget.value })} /></label>
          <label>{t("ui.plan_period")}<select value={f.period} onChange={(e) => setF({ ...f, period: e.currentTarget.value as "month" | "year" })}><option value="month">{t("ui.period_month")}</option><option value="year">{t("ui.period_year")}</option></select></label></div>
        <label>{t("ui.plan_days_ahead")}<input type="number" min={1} max={365} value={f.days_ahead} onInput={(e) => setF({ ...f, days_ahead: e.currentTarget.value })} /></label>
        <label>{t("ui.plan_description")}<input maxLength={300} value={f.description} onInput={(e) => setF({ ...f, description: e.currentTarget.value })} /></label>
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
