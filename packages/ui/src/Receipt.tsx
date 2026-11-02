import { t } from "./state.ts";

/** A receipt as the server gives it, in the reader's language (receipts.ts). */
export type ReceiptView = { id: string; number: string; kind: "payment" | "refund"; club: string; address: string | null; when: string; lines: { what: string; amount: string }[];
  subtotal: string; tax: string | null; total: string; method: string; kid: string | null; original: string | null };

/** One receipt, laid out to print. The staff app shows the same one from a member's page. */
export function ReceiptSheet({ r }: { r: ReceiptView }) {
  const refund = r.kind === "refund";
  return (
    <section class="card receipt">
      <h2>{r.club}</h2>
      {r.address && <p class="meta">{r.address}</p>}
      <p><strong>{t(refund ? "ui.refund_receipt_title" : "ui.receipt_title", { number: r.number })}</strong><br />{r.when}</p>
      {r.kid && <p>{t("ui.receipt_for", { name: r.kid })}</p>}
      {r.original && <p>{t("ui.receipt_original", { number: r.original })}</p>}
      <table>
        <tbody>
          {r.lines.map((l) => <tr><td>{l.what}</td><td class="num">{l.amount}</td></tr>)}
          <tr><td>{t("ui.receipt_subtotal")}</td><td class="num">{r.subtotal}</td></tr>
          {r.tax && <tr><td>{t("ui.receipt_tax")}</td><td class="num">{r.tax}</td></tr>}
          <tr><td><strong>{t(refund ? "ui.receipt_total_refunded" : "ui.receipt_total")}</strong></td><td class="num"><strong>{r.total}</strong></td></tr>
        </tbody>
      </table>
      <p>{t(refund ? "ui.receipt_refunded_to" : "ui.receipt_paid_with")}: {r.method}</p>
    </section>
  );
}
