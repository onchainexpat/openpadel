# Assets

- `illustrations/`: openPadel's own line drawings (see the README there).
- `playtomic-mark.webp`: Playtomic's mark (their logo, 48 px, from their own artwork; Playtomic's trademark, not
  covered by this repository's licence). Used only to say where a booking came from: the Schedule's mark on a booking
  copied from Playtomic, in the block's corner, the legend and the hover card (`apps/manager/src/ImportedMark.tsx`),
  always named "Imported from Playtomic". It is drawn as a CSS background and never inlined, so it loads only when
  such a booking is on the page.
