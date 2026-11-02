import { useEffect, useState } from "preact/hooks";
import { useRoute } from "preact-iso";
import { api, lang, t, ReceiptSheet, type ReceiptView } from "@kumi/ui";

type Row = { id: string; number: string; kind: "payment" | "refund"; total: string; when: string; what: string; more: number };

/** Every receipt the member has: one for each payment that went through and each refund sent. */
export function Receipts() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => { api<Row[]>("/my/receipts").then(setRows).catch(() => setRows([])); }, [lang.value]);
  return (
    <main>
      <h1>{t("ui.receipts_title")}</h1>
      <p class="meta">{t("ui.receipts_hint")}</p>
      {rows?.length === 0 && <p>{t("ui.receipts_none")}</p>}
      <ul class="changes">{(rows ?? []).map((r) => (
        <li class="card" key={r.id}>
          <div class="summary"><a href={`/receipts/${r.id}`}>{r.what}{r.more ? ` ${t("ui.receipt_more", { count: r.more })}` : ""}</a></div>
          <div class="meta">{r.when} · {r.number} · {r.kind === "refund" ? `${t("ui.receipt_refund_tag")} ` : ""}{r.total}</div>
        </li>
      ))}</ul>
    </main>
  );
}

export function ReceiptPage() {
  const { params } = useRoute(), id = params.id!;
  const [r, setR] = useState<ReceiptView | null>(null), [missing, setMissing] = useState(false);
  useEffect(() => { api<ReceiptView>(`/my/receipts/${id}`).then(setR).catch(() => setMissing(true)); }, [id, lang.value]);
  if (missing) return <main class="card"><p>{t("ui.receipts_none")}</p></main>;
  if (!r) return <main class="card"><p>{t("ui.loading")}</p></main>;
  return (
    <main>
      <p class="no-print"><a href="/receipts">{t("ui.receipt_back")}</a></p>
      <ReceiptSheet r={r} />
      <p class="no-print"><button class="primary" onClick={() => window.print()}>{t("ui.receipt_print")}</button></p>
    </main>
  );
}
