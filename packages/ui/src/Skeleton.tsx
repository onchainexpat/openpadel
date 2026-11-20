// What a page or a list shows while its data loads: grey shapes where the words will be, in the shape of what's
// coming, with a soft shimmer (none when less motion is asked for). Screen readers hear "Loading" and the region is
// marked busy. The shapes wait a moment (DELAY) before they show, so a quick answer never flashes them.
import { useEffect, useState } from "preact/hooks";
import { t } from "./state.ts";

/** How long the shapes wait before they show. */
export const SKELETON_DELAY_MS = 150;

/** page: a page's title over a card of rows (a whole page loading). rows: rows of a list, in a card or list that's
 *  already there. card: one card, its heading and a few lines. line: one line of text, inside a sentence or a cell. */
export type SkeletonShape = "page" | "rows" | "card" | "line";

// A bar where a line of words will be; styles.css varies the rows' widths so they read as words.
const Bar = ({ k }: { k: "title" | "head" | "text" | "meta" }) => <span class={`skel-bar skel-${k}`} />;
const Rows = ({ n }: { n: number }) => <>{Array.from({ length: n }, () => <span class="skel-row"><Bar k="text" /><Bar k="meta" /></span>)}</>;

export function Skeleton({ shape = "page", rows = 4, class: extra }: { shape?: SkeletonShape; rows?: number; class?: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const id = setTimeout(() => setShown(true), SKELETON_DELAY_MS); return () => clearTimeout(id); }, []);
  const cls = `skel skel-${shape}${shown ? " skel-shown" : ""}${extra ? ` ${extra}` : ""}`;
  const words = <span class="visually-hidden" role="status">{t("ui.loading")}</span>;
  if (shape === "line") return <span class={cls} aria-busy="true">{words}{shown && <Bar k="text" />}</span>;
  if (shape === "page") return (
    <main class={cls} aria-busy="true">{words}
      {shown && <><Bar k="title" /><div class="card"><Rows n={rows} /></div></>}
    </main>);
  if (shape === "card") return (
    <section class={`card ${cls}`} aria-busy="true">{words}
      {shown && <><Bar k="head" /><Rows n={Math.min(rows, 3)} /></>}
    </section>);
  return <div class={cls} aria-busy="true">{words}{shown && <Rows n={rows} />}</div>;
}
