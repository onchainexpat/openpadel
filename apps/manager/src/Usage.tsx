// The club's monthly meter (usage.ts): what AI, texts and email cost this month by kind, against the cap the
// owner sets and what's allowed over it, and the months before. Owners and managers see it; the owner changes the
// cap (a manager's change goes to the owner to approve), through the preview like everything else.
import { useEffect, useState } from "preact/hooks";
import { api, dollars, lang, me, t, usePreview, clubTime } from "@kumi/ui";
import { fromMajor, plainAmount } from "@kumi/i18n/format";

type Kind = "ai_decisions" | "ai_drafts" | "texts" | "email";
type Line = { count: number; input_tokens: number; output_tokens: number; segments: number; cents: number };
type U = { month: string; cap_cents: number; over_cents: number; limit_cents: number; spent_cents: number; share: number | null; state: "ok" | "near" | "over" | "paused"; resets: string;
  kinds: Record<Kind, Line>; history: { month: string; cents: number; kinds: Record<Kind, number> }[] };
const KINDS: Kind[] = ["ai_decisions", "ai_drafts", "texts", "email"];

export function Usage() {
  const [d, setD] = useState<{ usage: U | null } | null>(null);
  const load = () => api<{ usage: U | null }>("/staff/usage").then(setD);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const u = d.usage;
  if (!u) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const usd = (cents: number) => dollars(cents, lang.value), loc = lang.value === "es" ? "es-US" : "en-US";
  const monthName = (m: string) => new Intl.DateTimeFormat(loc, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}T12:00:00Z`));
  const day = clubTime(u.resets, { day: "numeric", month: "long" });
  const share = u.share === null ? 100 : Math.round(u.share * 100);
  return (
    <main>
      <h1>{t("ui.usage_title")}</h1>
      <section class="card">
        <h2>{monthName(u.month)}</h2>
        <p>{t("ui.usage_month", { spent: usd(u.spent_cents), cap: usd(u.cap_cents), share })}</p>
        <meter style={{ width: "100%" }} min={0} max={Math.max(u.cap_cents, 1)} low={u.cap_cents * 0.8} high={u.cap_cents} optimum={0} value={u.spent_cents} aria-label={t("ui.usage_title")} />
        {u.state === "near" && <p class="note" role="status">{t("ui.usage_state_near")}</p>}
        {u.state === "over" && <p class="note" role="status">{t("ui.usage_state_over", { limit: usd(u.limit_cents) })}</p>}
        {u.state === "paused" && <p class="note" role="status">{t("ui.usage_state_paused", { resets: day })}</p>}
        <ul class="plain">{KINDS.map((k) => (
          <li><strong>{t(`ui.usage_${k}`)}</strong> <span class="meta">{t(`ui.usage_${k}_count`, { count: k === "texts" ? u.kinds[k].segments : u.kinds[k].count })} · {usd(u.kinds[k].cents)}</span></li>))}</ul>
        <p class="meta">{t("ui.usage_intro")}</p>
      </section>
      <CapForm key={`${u.cap_cents}:${u.over_cents}`} u={u} send={preview} />
      {u.history.length > 0 && <section class="card"><h2>{t("ui.usage_history")}</h2><ul class="plain">
        {u.history.map((m) => <li>{monthName(m.month)} <span class="meta">· {usd(m.cents)}</span></li>)}
      </ul></section>}
      {sheet}
    </main>
  );
}

/** The cap and what's allowed over it, in dollars. */
function CapForm({ u, send }: { u: U; send: (action: string, input: unknown) => Promise<void> }) {
  const owner = me.value?.roles.some((r) => r.key === "owner"), support = Boolean(me.value?.support);
  const [cap, setCap] = useState(plainAmount(u.cap_cents)), [over, setOver] = useState(plainAmount(u.over_cents));
  const cents = (s: string) => fromMajor(Number(s)), ok = (s: string) => s.trim() !== "" && Number.isFinite(Number(s)) && Number(s) >= 0;
  const changed = ok(cap) && ok(over) && (cents(cap) !== u.cap_cents || cents(over) !== u.over_cents);
  // Support access never changes the cap, nor asks to: it's told so, with nothing to fill in.
  if (support) return <section class="card"><h2>{t("ui.usage_cap_title")}</h2><p class="meta">{t("ui.usage_cap_support")}</p></section>;
  return (
    <section class="card card-form">
      <h2>{t("ui.usage_cap_title")}</h2>
      <label>{t("ui.usage_cap")}<input type="number" min={0} step={1} value={cap} onInput={(e) => setCap(e.currentTarget.value)} /></label>
      <label>{t("ui.usage_over")}<input type="number" min={0} step={1} value={over} onInput={(e) => setOver(e.currentTarget.value)} /></label>
      {!owner && <p class="meta">{t("ui.usage_cap_ask")}</p>}
      <button class="primary" disabled={!changed} onClick={() => send("club.usage_cap_set", { cap_cents: cents(cap), ...(cents(over) !== u.over_cents ? { over_cents: cents(over) } : {}) })}>{t("ui.preview")}</button>
    </section>
  );
}
