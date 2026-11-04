// Money taken at the desk for something (a membership, a program place): how much, all that's owed to start with or
// part of it, and how it was paid (cash, the club's own card reader, another way). The preview says the rest.
import { useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { t } from "@kumi/ui";

export function DeskPay({ owed, label, send, onCancel }: { owed: number; label: string; send: (cents: number, method: string) => void; onCancel?: () => void }) {
  const [f, setF] = useState({ dollars: (owed / 100).toFixed(2), method: "cash" });
  return (
    <form class="court-row" onSubmit={(e) => { e.preventDefault(); send(Math.round(Number(f.dollars.replace(",", ".")) * 100), f.method); }}>
      <span class="meta">{label}</span>
      <label>{t("ui.amount_paid")}<input required inputMode="decimal" value={f.dollars} onInput={(e) => setF({ ...f, dollars: e.currentTarget.value })} /></label>
      <label>{t("ui.paid_how")}<select value={f.method} onChange={(e) => setF({ ...f, method: e.currentTarget.value })}>{["cash", "terminal", "other"].map((k) => <option value={k}>{t(`paid_by.${k}` as Key)}</option>)}</select></label>
      <button class="small">{t("ui.record_payment")}</button>
      {onCancel && <button type="button" class="small secondary" onClick={onCancel}>{t("ui.cancel")}</button>}
    </form>
  );
}
