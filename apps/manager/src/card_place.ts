// Where the Schedule's hover card goes (HoverCard.tsx), apart so the tests can read it.

const GAP = 8;
/** Beside the block, kept inside the window: on its right, or its left when there's no room; level with its top, or
 *  moved up when it would run off the bottom. */
export function placeCard(box: { left: number; right: number; top: number; bottom: number }, w: number, h: number, vw: number, vh: number) {
  let left = box.right + GAP;
  if (left + w > vw - GAP) left = box.left - GAP - w;
  left = Math.max(GAP, Math.min(left, vw - GAP - w));
  let top = box.top;
  if (top + h > vh - GAP) top = box.bottom - h;
  top = Math.max(GAP, Math.min(top, vh - GAP - h));
  return { left, top };
}
