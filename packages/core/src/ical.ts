// iCalendar (RFC 5545), only the part Kumi needs: events in UTC, text escaped, long lines folded. Used for a
// member's booking ("add to my calendar") and a coach's calendar link, which calendars subscribe to.

export interface IcsEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  location?: string;
  description?: string;
  /** A cancelled event stays in a feed as CANCELLED, so calendars that already have it drop it. */
  status?: "CONFIRMED" | "CANCELLED";
  /** Goes up each time the event changes, so a calendar takes the newer copy. */
  sequence?: number;
}

/** 20261202T170000Z */
export const icsTime = (d: Date) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** TEXT values (3.3.11): backslash, semicolon and comma are escaped, and a line break becomes \n. */
export const icsText = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\r\n|\r|\n/g, "\\n");

/** Lines are at most 75 octets; a longer one goes on with CRLF and a space (3.1), never inside a character. */
export function icsFold(line: string): string {
  const out: string[] = [];
  let cur = "", size = 0, limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (size + n > limit) { out.push(cur); cur = ""; size = 0; limit = 74; }   // the space starting the next line counts
    cur += ch; size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** A whole calendar. `name` and `refreshMinutes` are for a subscribed feed. */
export function icsCalendar(o: { prodId: string; events: IcsEvent[]; name?: string; refreshMinutes?: number; now?: Date }): string {
  const stamp = icsTime(o.now ?? new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${o.prodId}`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  if (o.name) lines.push(`X-WR-CALNAME:${icsText(o.name)}`);
  if (o.refreshMinutes) lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${o.refreshMinutes}M`, `X-PUBLISHED-TTL:PT${o.refreshMinutes}M`);
  for (const e of o.events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${stamp}`, `DTSTART:${icsTime(e.start)}`, `DTEND:${icsTime(e.end)}`);
    if (e.sequence !== undefined) lines.push(`SEQUENCE:${e.sequence}`);
    if (e.status) lines.push(`STATUS:${e.status}`);
    lines.push(`SUMMARY:${icsText(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}
