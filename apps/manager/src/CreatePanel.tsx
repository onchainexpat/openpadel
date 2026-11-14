// + Create's panel over the Schedule: what can be added, by group, as staff from other club software know them. Loaded
// when it's opened, so the Schedule's first screen doesn't carry it.
import type { Key } from "@kumi/i18n";
import { t } from "@kumi/ui";
import { useDrawer } from "./drawer.ts";
import type { Choice } from "./Courts.tsx";

/** The panel + Create opens over the page: what can be added, by group. Nothing is made here: each choice opens its
 *  own form, which previews before anything changes. */
export function CreatePanel({ choices, where, onClose }: { choices: { group: string; items: Choice[] }[]; where: string; onClose: () => void }) {
  const ref = useDrawer<HTMLElement>(true, onClose, true);
  return <>
    <div class="scrim" onClick={onClose} />
    <section ref={ref} class="drawer create-panel" role="dialog" aria-modal="true" aria-labelledby="create-title" aria-describedby="create-help">
      <div class="drawer-head">
        <div><h2 id="create-title">{t("ui.create_title")}</h2><p id="create-help" class="meta">{where ? `${where}. ` : ""}{t("ui.create_help")}</p></div>
        <button type="button" class="icon" onClick={onClose} aria-label={t("ui.close")}>×</button>
      </div>
      {choices.map((x) => <div class="create-group">
        <h3>{t(`ui.create_${x.group}` as Key)}</h3>
        <ul class="create-list">{x.items.map((i) => <li>
          {i.href ? <a class="create-item" href={i.href} onClick={onClose}><span><strong>{t(`ui.create_${i.key}` as Key)}</strong><span class="meta">{t(`ui.create_${i.key}_help` as Key)}</span></span><span aria-hidden="true">›</span></a>
            : <button type="button" class="create-item" onClick={i.go}><span><strong>{t(`ui.create_${i.key}` as Key)}</strong><span class="meta">{t(`ui.create_${i.key}_help` as Key)}</span></span><span aria-hidden="true">›</span></button>}
        </li>)}</ul>
      </div>)}
    </section>
  </>;
}
