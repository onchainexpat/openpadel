// Support access (support.ts), from Settings: let someone outside the staff in for a while, to look only or to work
// like a manager, and see everything each one opened and changed. The owner gives it (a manager's request goes to the
// owner) and anyone here can end it early, through the preview like every change.
import { useEffect, useState } from "preact/hooks";
import { api, lang, t, usePreview } from "@kumi/ui";

type Level = "view" | "manager";
type Grant = { id: string; name: string; email: string; reason: string; level: Level; starts_at: string; ends_at: string; ended_at: string | null; first_seen_at: string | null;
  granted_by: string | null; ended_by: string | null; reads: number; changes: number; active: boolean };
type Data = { owner: boolean; default_hours: number; max_hours: number; grants: Grant[] };
type Activity = { reads: { at: string; method: string; path: string; status: number | null }[]; changes: { id: string; action: string; status: string; summary: string | null; at: string }[] };

const when = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
export const levelText = (l: Level) => (l === "view" ? t("msg.support_level_view") : t("msg.support_level_manager"));

export function Support() {
  const [d, setD] = useState<Data | null>(null);
  const load = () => api<Data>("/staff/support").then(setD);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const now = d.grants.filter((g) => g.active), before = d.grants.filter((g) => !g.active);
  return (
    <main>
      <h1>{t("ui.support_title")}</h1>
      <p class="meta">{t("ui.support_intro")}</p>
      <GiveForm d={d} send={preview} />
      {!d.grants.length && <p class="card meta">{t("ui.support_none")}</p>}
      {now.length > 0 && <section class="card"><h2>{t("ui.support_now")}</h2><ul class="plain">
        {now.map((g) => <GrantRow key={g.id} g={g} end={() => preview("support.end", { grant_id: g.id })} />)}</ul></section>}
      {before.length > 0 && <section class="card"><h2>{t("ui.support_past")}</h2><ul class="plain">{before.map((g) => <GrantRow key={g.id} g={g} />)}</ul></section>}
      {sheet}
    </main>
  );
}

function GiveForm({ d, send }: { d: Data; send: (action: string, input: unknown) => Promise<void> }) {
  const [name, setName] = useState(""), [email, setEmail] = useState(""), [reason, setReason] = useState(""), [level, setLevel] = useState<Level>("view");
  const [hours, setHours] = useState(String(d.default_hours));
  const h = Number(hours), ok = name.trim() && /\S+@\S+\.\S+/.test(email.trim()) && reason.trim().length >= 3 && Number.isInteger(h) && h >= 1 && h <= d.max_hours;
  return (
    <section class="card card-form">
      <h2>{t("ui.support_give_title")}</h2>
      <label>{t("ui.support_name")}<input value={name} maxLength={80} onInput={(e) => setName(e.currentTarget.value)} /></label>
      <label>{t("ui.support_email")}<input type="email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
      <label>{t("ui.support_reason")}<input value={reason} maxLength={300} onInput={(e) => setReason(e.currentTarget.value)} /></label>
      <label>{t("ui.support_level")}<select value={level} onChange={(e) => setLevel(e.currentTarget.value as Level)}>
        <option value="view">{t("ui.support_level_view")}</option>
        <option value="manager">{t("ui.support_level_manager")}</option>
      </select></label>
      <label>{t("ui.support_hours", { max: d.max_hours })}<input type="number" min={1} max={d.max_hours} step={1} value={hours} onInput={(e) => setHours(e.currentTarget.value)} /></label>
      {!d.owner && <p class="meta">{t("ui.support_ask")}</p>}
      <button class="primary" disabled={!ok} onClick={() => send("support.grant", { name: name.trim(), email: email.trim(), reason: reason.trim(), level, hours: h })}>{t("ui.preview")}</button>
    </section>
  );
}

function GrantRow({ g, end }: { g: Grant; end?: () => void }) {
  const [a, setA] = useState<Activity | null>(null);
  const open = (e: Event) => { if ((e.currentTarget as HTMLDetailsElement).open && !a) api<Activity>(`/staff/support/${g.id}`).then(setA).catch(() => {}); };
  const status = g.ended_at ? t("ui.support_ended_at", { when: when(g.ended_at) }) : t("ui.support_until", { until: when(g.ends_at) });
  return (
    <li class="row">
      <div>
        <strong>{g.name}</strong> <span class="meta">{g.email}</span>
        <p class="meta">{[levelText(g.level), status, g.first_seen_at ? null : t("ui.support_not_used"), t("ui.support_reads", { count: g.reads }), t("ui.support_changes", { count: g.changes })].filter(Boolean).join(" · ")}</p>
        <p class="meta">{t("ui.support_reason_line", { reason: g.reason })}{g.granted_by && <> · {t("ui.support_given_by", { name: g.granted_by })}</>}</p>
        <details onToggle={open}><summary>{t("ui.support_activity")}</summary>
          {!a ? <p class="meta">{t("ui.loading")}</p> : <>
            <h3>{t("ui.support_changed")}</h3>
            <ul class="plain">{a.changes.map((c) => <li class="meta">{when(c.at)} · {c.summary ?? c.action} · {c.status}</li>)}</ul>
            <h3>{t("ui.support_opened")}</h3>
            <ul class="plain">{a.reads.map((r) => <li class="meta">{when(r.at)} · {r.method} {r.path}{r.status && r.status >= 400 ? ` (${r.status})` : ""}</li>)}</ul>
          </>}
        </details>
      </div>
      {end && <button onClick={end}>{t("ui.support_end")}</button>}
    </li>
  );
}
