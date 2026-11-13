// "Coming from": the software a club's staff used before, so the staff app can use the words, menu order and first
// page they already know. Only the names live here, for the server to check a setting against; what each one changes is
// data in the staff app (apps/manager/src/presets.ts), and its words are `preset.*` keys in en.ts and es.ts.
//
// Adding one later is data only: its name here, its object there, and its words in both languages. The database
// keeps any name (no check to migrate), and an unknown one reads as the default.

/** openPadel's own plain words (none), or the words of Playtomic's club manager. */
export const COMING_FROM = ["none", "playtomic"] as const;
export type ComingFrom = (typeof COMING_FROM)[number];
/** Every club before the setting existed saw Playtomic's words (Nov 2026), so that stays the default: nothing changes
 *  for a club until it picks another. */
export const DEFAULT_COMING_FROM: ComingFrom = "playtomic";
export const comingFrom = (v: unknown): ComingFrom => ((COMING_FROM as readonly unknown[]).includes(v) ? v as ComingFrom : DEFAULT_COMING_FROM);
