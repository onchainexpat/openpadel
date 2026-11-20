// One icon from the apps' set (icon_paths.ts, a few of Lucide's). It takes the size of the text around it (1em) and
// its colour, so a tab, a button or a chip sizes and paints it. Icons sit beside words, never instead of them, so an
// icon is hidden from screen readers unless it's given a label of its own.
// The shapes come in their own small file, asked for as soon as an app starts, so they don't count against the first
// screen's code: until they arrive (a moment), each icon keeps its place, empty, and nothing on the page moves.
import { h } from "preact";
import { signal } from "@preact/signals";
import type { IconName, IconShape } from "./icon_paths.ts";
import { statusIcon } from "./status_icon.ts";

export type { IconName };

const shapes = signal<Record<IconName, readonly IconShape[]> | null>(null);
let asked = false;
function loadShapes() {
  if (asked || typeof window === "undefined") return;
  asked = true;
  import("./icon_paths.ts").then((m) => { shapes.value = m.ICONS; }, () => { asked = false; });
}
loadShapes();

export function Icon({ name, label, class: extra }: { name: IconName; label?: string; class?: string }) {
  const all = shapes.value;
  if (!all) loadShapes();
  return (
    <svg class={`icon${extra ? ` ${extra}` : ""}`} viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" focusable="false"
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
      {all?.[name].map(([tag, attrs]) => h(tag, attrs))}
    </svg>
  );
}

/** A status's icon (status_icon.ts), or nothing for a status without one. */
export function StatusIcon({ status }: { status: string }) {
  const name = statusIcon(status);
  return name ? <Icon name={name} /> : null;
}
