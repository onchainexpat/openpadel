// A file field whose words are the app's, in the person's language: the browser's own "Choose File / No file chosen"
// follows the browser's language, not the app's. The real input stays in the label (visually hidden), so the keyboard,
// screen readers and the label's click all work as before.
import { useState } from "preact/hooks";
import { t } from "./state.ts";

export function FileInput({ label, accept, onFile }: { label: string; accept: string; onFile: (f: File | null, input: HTMLInputElement) => void }) {
  const [name, setName] = useState<string | null>(null);
  return <label class="file-input">{label}
    <input class="visually-hidden" type="file" accept={accept} onChange={(e) => { const f = e.currentTarget.files?.[0] ?? null; setName(f?.name ?? null); onFile(f, e.currentTarget); }} />
    <span class="file-input-row"><span class="button" aria-hidden="true">{t("ui.file_choose")}</span><span class="meta">{name ?? t("ui.file_none")}</span></span>
  </label>;
}
