// Passes (passes.ts): the ones the club sells, to buy by card in the sheet, and yours, with the uses left. A pass is
// spent in the pay sheet ("Pay with ..."), before the card form opens.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, clubTime, dollars, lang, me, t } from "@kumi/ui";
import { PaySheet } from "./Pay.tsx";

type Product = { id: string; name: string; covers: "programs" | "courts" | "lessons"; uses: number; price_cents: number; max_minutes: number | null; valid_days: number | null };
type Mine = { id: string; name: string; covers: "programs" | "courts" | "lessons"; uses: number; uses_left: number; expires_at: string | null; status: "active" | "refunded"; max_minutes: number | null };

const covers = (x: { covers: "programs" | "courts" | "lessons"; max_minutes: number | null }) =>
  x.covers === "programs" ? t("ui.pass_covers_programs") : `${t(x.covers === "lessons" ? "ui.pass_covers_lessons" : "ui.pass_covers_courts")}${x.max_minutes ? `, ${t("ui.pass_up_to", { minutes: String(x.max_minutes) })}` : ""}`;

export function Passes() {
  const [data, setData] = useState<{ mine: Mine[]; on_sale: Product[] } | null>(null), [paying, setPaying] = useState<{ id: string; cents: number; name: string } | null>(null), [error, setError] = useState<string | null>(null);
  const load = async () => setData(await api<{ mine: Mine[]; on_sale: Product[] }>("/my/passes").catch(() => ({ mine: [], on_sale: [] })));
  useEffect(() => { void load(); }, []);
  const buy = async (p: Product) => {
    setError(null);
    try {
      const plan = await api<{ run_id: string }>("/actions/pass.buy/plan", { person_id: me.value?.person.id, product_id: p.id });
      const r = await api<{ result?: { payment_id: string } }>(`/runs/${plan.run_id}/apply`, {}, { "idempotency-key": plan.run_id });
      if (r.result) setPaying({ id: r.result.payment_id, cents: p.price_cents, name: p.name });
    } catch (x) { setError(x instanceof ApiError ? x.message : String(x)); }
  };
  return (
    <main>
      <h1>{t("ui.passes_title")}</h1>
      <p class="meta">{t("ui.passes_hint")}</p>
      {data && data.mine.length > 0 && <section class="card"><h2>{t("ui.pass_yours")}</h2>
        <ul class="plain">{data.mine.map((x) => <li key={x.id} class="row">
          <span><strong>{x.name}</strong> · {covers(x)}</span>
          <span>{x.status === "refunded" ? t("ui.pass_refunded") : t("ui.pass_uses_left", { left: String(x.uses_left), uses: String(x.uses) })}
            {x.expires_at && x.status === "active" ? ` · ${t("ui.pass_use_by", { date: clubTime(x.expires_at, { dateStyle: "medium" }) })}` : ""}</span>
        </li>)}</ul></section>}
      <section class="card"><h2>{t("ui.pass_for_sale")}</h2>
        {data && data.on_sale.length === 0 && <p class="meta">{t("ui.pass_none_on_sale")}</p>}
        <ul class="plain">{(data?.on_sale ?? []).map((p) => <li key={p.id} class="row">
          <span><strong>{p.name}</strong> · {t("ui.pass_uses_left", { left: String(p.uses), uses: String(p.uses) })} · {covers(p)}</span>
          <button class="primary" onClick={() => void buy(p)}>{t("ui.pass_buy", { price: dollars(p.price_cents, lang.value) })}</button>
        </li>)}</ul>
        {error && <p class="error" role="alert">{error}</p>}
      </section>
      {paying && <PaySheet paymentId={paying.id} amountCents={paying.cents} name={paying.name} onClose={() => { setPaying(null); void load(); }} onPaid={() => { setPaying(null); void load(); }} />}
    </main>
  );
}
