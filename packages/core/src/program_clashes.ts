// What stands in the way of a program's dates, and what only overlaps them. Two things can't hold one court
// at one time (the database refuses it), but staff should hear what's in the way, and why, before trying:
// a booking, a block or another program on the court; the coach teaching, in a lesson or on time off. Other
// programs at the same time for the same players are only a warning.
import { sql } from "kysely";
import { both, dateTime, type Text } from "@kumi/i18n";
import type { Db, Trx } from "./db.ts";
import { atLocal, localParts } from "./clock.ts";
import { isClubBlock } from "./playtomic.ts";
import { coachBusy } from "./lessons.ts";

/** One date as it would be: when, on which courts, and who runs it. */
export interface DateSlot { start: Date; end: Date; courtIds: string[]; coachId: string | null }
/** Something in the way (blocks) or only worth knowing (a warning), in both languages. */
export interface Clash { blocks: boolean; kind: "court" | "coach_busy" | "coach_off" | "program"; text: Text }

const when = (d: Date, tz: string): Text => ({ en: dateTime(d, "en", tz), es: dateTime(d, "es", tz) });

/** Every clash for these dates. `skipSessions`: the dates being changed, whose own court time and coach
 *  don't count against them. */
export async function dateClashes(db: Db | Trx, o: { programId: string; locationId: string; levelMin: string | number | null; levelMax: string | number | null;
  slots: DateSlot[]; skipSessions: string[]; now: Date; tz: string }): Promise<Clash[]> {
  const out: Clash[] = [], skip = o.skipSessions.length ? o.skipSessions : ["00000000-0000-0000-0000-000000000000"];
  const coachNames = new Map<string, string>();
  const coachName = async (id: string) => {
    if (!coachNames.has(id)) coachNames.set(id, (await db.selectFrom("person").select("display_name").where("id", "=", id).executeTakeFirst())?.display_name ?? "");
    return coachNames.get(id)!;
  };
  const warned = new Set<string>();
  for (const s of o.slots) {
    const range = sql`tstzrange(${s.start}, ${s.end})`, at = when(s.start, o.tz);
    if (s.courtIds.length) {
      const rows = await db.selectFrom("court_time").innerJoin("court", "court.id", "court_time.court_id")
        .leftJoin("booking", "booking.id", "court_time.booking_id").leftJoin("session", "session.id", "court_time.session_id").leftJoin("program", "program.id", "session.program_id")
        .leftJoin("mirror_booking", "mirror_booking.court_time_id", "court_time.id")
        .select(["court_time.kind", "court.name as court", "booking.code", "program.name as program", "mirror_booking.ref", "mirror_booking.booking_type", sql<boolean>`${range} @> court_time.during`.as("inside")])
        .where("court_time.court_id", "in", s.courtIds).where("court_time.active", "=", true).where(sql<boolean>`court_time.during && ${range}`)
        .where((eb) => eb.or([eb("court_time.session_id", "is", null), eb("court_time.session_id", "not in", skip)])).orderBy("court.name").execute();
      for (const r of rows) {
        // A Playtomic block the club made for this very event lies inside it: the event takes it over.
        if (r.kind === "mirror" && r.ref && r.inside && isClubBlock(r.booking_type)) continue;
        const p = { court: r.court, when: at };
        const text = r.kind === "booking" ? both("clash.court_booking", { ...p, code: r.code ?? "" }) : r.kind === "session" ? both("clash.court_program", { ...p, program: r.program ?? "" })
          : r.kind === "hold" ? both("clash.court_hold", p) : r.kind === "mirror" ? both("clash.court_mirror", p) : both("clash.court_block", p);
        out.push({ blocks: true, kind: "court", text });
      }
    }
    if (s.coachId) {
      const coach = await coachName(s.coachId);
      const busy = (await coachBusy(db, s.coachId, s.start, s.end, o.now)).filter((b) => b.kind === "lesson" || !o.skipSessions.includes(b.id));
      if (busy.length) out.push({ blocks: true, kind: "coach_busy", text: both("clash.coach_busy", { coach, when: at }) });
      const off = await db.selectFrom("coach_time_off").select("id").where("coach_id", "=", s.coachId).where("active", "=", true).where(sql<boolean>`during && ${range}`).executeTakeFirst();
      if (off) out.push({ blocks: true, kind: "coach_off", text: both("clash.coach_off", { coach, when: at }) });
    }
    // Other programs here at the same time, for players at the same level (or with no level set): a warning.
    const others = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id")
      .select(["program.id", "program.name", "program.level_min", "program.level_max", "session.starts_at"])
      .where("session.status", "!=", "cancelled").where("program.status", "!=", "cancelled").where("program.id", "!=", o.programId).where("program.location_id", "=", o.locationId)
      .where("session.id", "not in", skip).where("session.starts_at", "<", s.end).where("session.ends_at", ">", s.start).execute();
    for (const p of others) {
      if (warned.has(p.id) || !levelsMeet(o.levelMin, o.levelMax, p.level_min, p.level_max)) continue;
      warned.add(p.id);
      out.push({ blocks: false, kind: "program", text: both("clash.program", { program: p.name, when: when(new Date(p.starts_at), o.tz) }) });
    }
  }
  return out;
}

/** Whether two level bands share players: they overlap, or either is open to all. */
function levelsMeet(aMin: string | number | null, aMax: string | number | null, bMin: string | number | null, bMax: string | number | null) {
  if (aMin === null || aMax === null || bMin === null || bMax === null) return true;
  return Number(aMin) <= Number(bMax) && Number(bMin) <= Number(aMax);
}

/** Clashes as one sentence each, joined: what an error or a plan shows. */
export function clashList(clashes: Clash[]): Text {
  return { en: clashes.map((c) => c.text.en).join(" "), es: clashes.map((c) => c.text.es).join(" ") };
}

/** A date repeated each week at the same club time (across clock changes): `count` dates from `start`. */
export function weekly(start: Date, end: Date, count: number, tz: string): { start: Date; end: Date }[] {
  const p = localParts(start, tz), length = end.getTime() - start.getTime();
  return Array.from({ length: count }, (_, k) => {
    const s = k === 0 ? start : atLocal(p.y, p.m, p.d + 7 * k, p.h, tz, p.min);
    return { start: s, end: new Date(s.getTime() + length) };
  });
}
