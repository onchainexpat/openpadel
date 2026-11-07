// Text people typed, made safe to show: no control or invisible formatting characters (bidi overrides that turn
// "exe.gnp" into "png.exe", zero-width spaces), new lines kept where they're allowed. What stays is only what draws
// something or joins what does: the zero-width joiner between emoji (a family is built with it), the zero-width
// non-joiner between letters (Persian needs it), a variation selector right after an emoji or a keycap, the tag
// letters of a subdivision flag (England's). Characters drawn as nothing (Hangul fillers, the blank Braille cell)
// go, and marks stacked on one letter stop at three, so "zalgo" text can't cover the lines around it.
import * as z from "zod/mini";
import { sql } from "kysely";
import type { Db } from "./db.ts";

const CONTROL = /[\p{Cc}\p{Cf}]/u, MARK = /\p{M}/u, PICTO = /\p{Extended_Pictographic}/u, LETTER = /[\p{L}\p{M}]/u, KEYCAP = /^[0-9#*]$/;
/** Drawn as nothing though they're letters or symbols: the Hangul fillers and the blank Braille cell. */
const FILLERS = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x2800]);
const ZWJ = 0x200d, ZWNJ = 0x200c, VS15 = 0xfe0e, VS16 = 0xfe0f, BLACK_FLAG = 0x1f3f4;
const isSelector = (c: number) => (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef);
const isTag = (c: number) => c >= 0xe0020 && c <= 0xe007f;
const isSkinTone = (c: number) => c >= 0x1f3fb && c <= 0x1f3ff;
/** Marks one letter may carry (Vietnamese and the Indic scripts need two or three). */
export const MAX_MARKS = 3;

/** The last thing kept ends an emoji (past its selector and skin tone), so a joiner after it can join another. */
function endsEmoji(out: string[]): boolean {
  for (let i = out.length - 1; i >= 0; i--) {
    const c = out[i]!.codePointAt(0)!;
    if (c === VS16 || isSkinTone(c)) continue;
    return PICTO.test(out[i]!);
  }
  return false;
}

function clean(s: string, newLines: boolean): string {
  const cps = [...s], out: string[] = [];
  let marks = 0, inFlag = false;
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!, c = ch.codePointAt(0)!, prev = out[out.length - 1], next = cps[i + 1];
    if (ch === "\n" && newLines) { out.push(ch); marks = 0; inFlag = false; continue; }
    if (FILLERS.has(c)) continue;
    if (isTag(c)) { if (inFlag) out.push(ch); continue; }
    if (c === ZWJ) { if (endsEmoji(out) && next && PICTO.test(next)) out.push(ch); continue; }
    if (c === ZWNJ) { if (prev && LETTER.test(prev) && next && LETTER.test(next)) out.push(ch); continue; }
    if (isSelector(c)) { if ((c === VS15 || c === VS16) && prev && (PICTO.test(prev) || KEYCAP.test(prev))) out.push(ch); continue; }
    if (CONTROL.test(ch)) continue;
    if (MARK.test(ch)) { if (++marks <= MAX_MARKS) out.push(ch); continue; }
    marks = 0; inFlag = c === BLACK_FLAG;
    out.push(ch);
  }
  return out.join("");
}

/** A message's words: new lines kept (three or more become two), everything invisible removed. */
export function plainText(s: string): string {
  return clean(s.replace(/\r\n?/g, "\n"), true).replace(/\n{3,}/g, "\n\n").trim();
}
/** A name on one line. Empty when nothing in it draws: show "A player" (or the like) for it. */
export function plainName(s: string): string {
  return clean(s, false).replace(/\s+/g, " ").trim();
}
/** Something in it can be seen: more than spaces, joiners, selectors and marks with nothing to sit on. */
export function visible(s: string): boolean {
  return /[^\s\p{M}‌‍︎️\u{e0020}-\u{e007f}]/u.test(s);
}
/** A name someone is known by (signing up, their profile, staff adding or importing people, a junior, a support
 *  person): made plain, and refused when nothing in it can be seen, so nobody posts as a blank. */
export const nameInput = (max = 80) => z.string().check(z.overwrite(plainName), z.minLength(1), z.maxLength(max),
  z.refine(visible, { message: "A name needs at least one letter, number or other character you can see" }));
/** The start of a message, for a notification. */
export function shortText(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim(), chars = [...one];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : one;
}

/** What people typed before 0.3.0 made it plain as it's saved (names, a gift card's who-for and message): made plain
 *  now, so a control character (a terminal's escape) or a bidi override saved then can't reach a screen, an email, a
 *  download or the operator's terminal. As the server starts; once it's done there's nothing left to change. A name
 *  with nothing left that draws is stored empty, which the apps show as "A player". */
export async function plainStoredText(db: Db): Promise<{ names: number; giftCards: number }> {
  let names = 0, giftCards = 0;
  for (const p of await db.selectFrom("person").select(["id", "display_name"]).execute()) {
    const clean = plainName(p.display_name);
    if (clean === p.display_name) continue;
    await db.updateTable("person").set({ display_name: visible(clean) ? clean : "", version: sql`version + 1` }).where("id", "=", p.id).where("display_name", "=", p.display_name).execute();
    names++;
  }
  for (const g of await db.selectFrom("gift_card").select(["id", "for_name", "message"]).where((w) => w.or([w("for_name", "is not", null), w("message", "is not", null)])).execute()) {
    const forName = g.for_name === null ? null : plainName(g.for_name) || null, message = g.message === null ? null : plainText(g.message) || null;
    if (forName === g.for_name && message === g.message) continue;
    await db.updateTable("gift_card").set({ for_name: forName, message, version: sql`version + 1` }).where("id", "=", g.id).execute();
    giftCards++;
  }
  return { names, giftCards };
}
