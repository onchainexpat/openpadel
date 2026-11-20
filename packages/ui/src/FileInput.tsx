// A file field whose words are the app's, in the person's language: the browser's own "Choose File / No file chosen"
// follows the browser's language, not the app's. The real input stays in the label (visually hidden), so the keyboard,
// screen readers and the label's click all work as before.
import { useState } from "preact/hooks";
import { t } from "./state.ts";

/** required and describedBy go on the input itself; class on the label (small, for a field beside others). */
export function FileInput({ label, accept, onFile, required, describedBy, class: extra }: { label: string; accept: string; onFile: (f: File | null, input: HTMLInputElement) => void;
  required?: boolean; describedBy?: string; class?: string }) {
  const [name, setName] = useState<string | null>(null);
  return <label class={`file-input${extra ? ` ${extra}` : ""}`}>{label}
    <input class="visually-hidden" type="file" accept={accept} required={required} aria-describedby={describedBy}
      onChange={(e) => { const f = e.currentTarget.files?.[0] ?? null; setName(f?.name ?? null); onFile(f, e.currentTarget); }} />
    <span class="file-input-row"><span class="button" aria-hidden="true">{t("ui.file_choose")}</span><span class="meta">{name ?? t("ui.file_none")}</span></span>
  </label>;
}
