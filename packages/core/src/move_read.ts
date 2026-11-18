// Reading the files a club exports from CourtReserve or Playbypoint, for the move-in (move_files.ts). Nothing is
// changed here: each reader gives the rows it could use and every line it couldn't, with why.
//
// Neither system publishes the columns of its exports, so the columns are found by the names they most likely use,
// ignoring case, spaces, punctuation and accents, and the preview says these haven't been checked against a real
// file. The names come from what each one does publish (sources read 18 Nov 2026):
//   CourtReserve's member import template (help.courtreserve.com/en/articles/4051118-member-list-import): First Name,
//     Last Name, Email, Member #, Membership Name, Membership Start Date, Membership Next Payment Date, Phone Number;
//   its Members report filters (intercom.help/courtreserve/en/articles/4281605-members-report): Current Membership
//     Status, Membership Types, Account Credit, Amount Due, Marketing Text Status; its exports are Excel (.xlsx);
//   its API's member and membership report records (api.courtreserve.com/swagger/docs/ORGANIZATION): MemberNumber,
//     MembershipName, StartDate, EndDate, NextPaymentDate, Status; the reservation report's ReservationTypeName, Courts,
//     StartTime, EndTime, Players; MarketingConsent.EmailOptedIn, UnsubscribeFromMarketingEmails;
//   its Reservations report (intercom.help/courtreserve/en/articles/11379006-reservations-report) and Event
//     Registrant Detail report (help.courtreserve.com/en/articles/4665671-create-an-event-registrant-detail-report);
//   Playbypoint's Reporting area (help.playbypoint.com/en/articles/15605028-all-players-report: Player, Email, Member;
//     /15958811-memberships-report: Member, Plan, Status, Joined, Current Billing Period Start/End, Paid Through,
//     Termination Date; /16311942-booking-details-report: Court, Start, End, Players, Type;
//     /15811374-program-attendance-report: Player, Program, Session Date, Start Time, Status, Email), each exported as
//     CSV with the columns shown; and a player's "Wallet balance" (/11725341-how-to-add-club-credits-to-a-player).
import { both, type Text } from "@kumi/i18n";
import { parseCsv, type Problem } from "./csv_read.ts";

export const MOVE_SYSTEMS = ["courtreserve", "playbypoint"] as const;
export type MoveSystem = (typeof MOVE_SYSTEMS)[number];
export const MOVE_FILE_KINDS = ["people", "bookings", "programs"] as const;
export type MoveFileKind = (typeof MOVE_FILE_KINDS)[number];

/** Someone a line names: their name, and their email or their id in the old system when it has them. */
export interface MoveWho { name: string; email?: string; ext_id?: string }
/** A line of a people file: a members list, a membership report or a credit list (any of their columns). */
export interface MovePerson extends MoveWho { line: number; phone?: string; news?: true; membership?: { name: string; status?: string; start?: string; until?: string }; credit?: string }
/** A booking on a court: the club's day and time it starts (on that court's clock), and who plays. */
export interface MoveBooking { line: number; ref?: string; court: string; date: string; start: string; minutes: number; type?: string; organiser: MoveWho | null; players: MoveWho[] }
/** Someone signed up to an event, class or program, on a day if the file says which. */
export interface MoveSignup { line: number; event: string; date?: string; start?: string; who: MoveWho }
export type MoveRow = MovePerson | MoveBooking | MoveSignup;
export interface MoveRead { rows: MoveRow[]; problems: Problem[]; columns: { what: string; name: string }[]; fatal?: Text }

/** A column name as compared: lower case, no accents, "#" as "number", only letters and digits ("Member #" is membernumber). */
export const normColumn = (h: string) => h.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/#/g, "number").replace(/[^a-z0-9]/g, "");

// The names each column goes by, most likely first. Where two systems differ, both are here: a file is read by
// whichever it has.
const COLS = {
  name: ["name", "fullname", "membername", "playername", "player", "displayname", "registrant", "registrantname", "participant", "customer", "customername", "nombre",
    // Playbypoint's memberships report names the person "Member" (its players report has a Member yes/no beside "Player").
    "member"],
  first: ["firstname", "first", "givenname", "memberfirstname", "playerfirstname"],
  last: ["lastname", "last", "surname", "familyname", "memberlastname", "playerlastname", "apellido", "apellidos"],
  email: ["email", "emailaddress", "memberemail", "playeremail", "registrantemail", "useremail", "mail", "correo", "correoelectronico"],
  phone: ["phone", "phonenumber", "cellphone", "cellphonenumber", "mobile", "mobilephone", "mobilenumber", "cell", "primaryphone", "telephone", "telefono", "celular"],
  // CourtReserve's "Member #" (its import template and API's MemberNumber); Playbypoint's user id if a report has one.
  ext_id: ["membernumber", "memberno", "memberid", "organizationmemberid", "courtreserveid", "userid", "playerid", "playbypointid", "pbpid", "customerid"],
  // Only a yes counts: a column that says someone opted in to marketing email. "Unsubscribe from marketing emails" is
  // never read: a no there isn't a yes.
  news: ["emailoptedin", "marketingemailoptin", "marketingemailoptedin", "marketingemailstatus", "marketingemails", "marketingconsent", "marketingconsentemail", "emailmarketing",
    "acceptsmarketing", "marketingoptin", "emailoptin", "newsletter", "newsletteroptin", "clubnews", "optedintomarketingemails"],
  membership: ["membershipname", "membership", "membershiptype", "currentmembership", "membershipplan", "plan", "planname", "membershiptypes"],
  status: ["membershipstatus", "currentmembershipstatus", "status"],
  start: ["membershipstartdate", "currentmembershipstartdate", "startdate", "joined", "joineddate", "currentbillingperiodstart"],
  // The last day it's paid for: a paid through or end date, else (below) the day before the next payment.
  until: ["paidthrough", "membershipenddate", "currentmembershipenddate", "enddate", "expirationdate", "expiration", "expires", "expirydate", "validuntil", "currentbillingperiodend"],
  next_payment: ["membershipnextpaymentdate", "nextpaymentdate", "nextpayment", "nextbillingdate", "nextbillingperiodstart", "renewaldate"],
  // Club credit the member holds: CourtReserve's Account Credit, Playbypoint's wallet balance or club credits. Not a
  // plain "Balance" (it can be what they owe), "Amount Due" or a "Balance Forwards or Balance Credits" that mixes both.
  credit: ["accountcredit", "accountcredits", "creditbalance", "credit", "credits", "clubcredit", "clubcredits", "walletbalance", "wallet", "storecredit", "availablecredit"],
  court: ["court", "courts", "courtname", "courtnames", "resource"],
  date: ["date", "reservationdate", "bookingdate", "eventdate", "sessiondate", "day"],
  starts: ["starttime", "start", "startdatetime", "startsat", "from", "time", "begins"],
  ends: ["endtime", "end", "enddatetime", "endsat", "to"],
  minutes: ["duration", "minutes", "durationminutes", "length"],
  type: ["reservationtype", "reservationtypename", "bookingtype", "type"],
  players: ["players", "playernames", "participants", "members", "attendees", "membersplayers"],
  organiser: ["organizer", "organiser", "organizername", "bookedby", "reservedby", "owner", "createdby", "booker"],
  organiser_email: ["organizeremail", "organiseremail", "bookedbyemail", "owneremail"],
  ref: ["reservationid", "reservationnumber", "bookingid", "bookingnumber", "confirmationnumber", "id"],
  event: ["eventname", "event", "program", "programname", "eventtitle", "clinic", "class", "classname", "session", "sessionname"],
  signup_status: ["registrationstatus", "status", "attendancestatus"],
} satisfies Record<string, string[]>;
type Col = keyof typeof COLS;

/** The column each name list finds, by the most likely name first: a file with both "Membership Name" and "Plan" reads
 *  the first. A column already taken by another meaning isn't read twice. */
function columns(head: string[], wanted: Col[]): Record<Col, number> {
  const out = {} as Record<Col, number>, taken = new Set<number>();
  for (const k of wanted) {
    let at = -1;
    for (const n of COLS[k]) { const i = head.findIndex((h, j) => h === n && !taken.has(j)); if (i >= 0) { at = i; break; } }
    out[k] = at;
    if (at >= 0) taken.add(at);
  }
  return out;
}

const YES = new Set(["yes", "y", "true", "si", "x", "1", "subscribed", "optedin", "optin", "accepted", "aceptado"]);
const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAYS = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$|^(lunes|martes|miercoles|jueves|viernes|sabado|domingo|lun|mie|jue|vie|sab|dom)$/;
const pad = (n: number) => String(n).padStart(2, "0");
const realDay = (y: number, m: number, d: number) => { const at = new Date(Date.UTC(y, m - 1, d)); return m >= 1 && m <= 12 && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null; };

/** A day and a time of day from a cell, as a spreadsheet writes them: 2026-11-20, 11/20/2026 (month first unless the
 *  club writes the day first), Nov 20, 2026, Friday, November 20, 2026, with or without a time (6:00 PM, 18:00), or
 *  the number Excel keeps a date as (46346.75 is 20 Nov 2026 at 18:00). A time alone has no day. */
export function readWhen(v: string, dayFirst: boolean): { date?: string; time?: string } | null {
  let s = v.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/(\d)t(\d)/, "$1 $2");
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // A time on its own (0.75 is 18:00), or a date from 1954 to 2119 with its time.
    if (n < 1) return { time: clock(Math.round(n * 1440)) };
    if (n < 20000 || n > 80000) return null;
    const days = Math.floor(n), mins = Math.round((n - days) * 1440), at = new Date(Date.UTC(1899, 11, 30) + days * 86400_000);
    return { date: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`, ...(mins ? { time: clock(mins) } : {}) };
  }
  let time: string | undefined;
  const t = /(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?\s*m\.?\b|\b(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?![\d/.-])/.exec(s);
  if (t) {
    let h = Number(t[1] ?? t[4]);
    const min = Number(t[2] ?? t[5] ?? 0);
    if (t[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (t[3] === "p" ? 12 : 0); }
    if (h > 23 || min > 59) return null;
    time = `${pad(h)}:${pad(min)}`;
    s = (s.slice(0, t.index) + " " + s.slice(t.index + t[0].length)).trim();
  }
  s = s.replace(/[tz]$/, "").replace(/\bat\b|,|\ba las\b/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return time ? { time } : null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let date: string | null = null;
  if (m) date = realDay(Number(m[1]), Number(m[2]), Number(m[3]));
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s))) {
    const [a, b] = [Number(m[1]), Number(m[2])], y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    date = dayFirst ? realDay(y, b, a) : realDay(y, a, b);
  } else {
    // A month by name, in English or Spanish, with or without a weekday: "fri nov 20 2026", "20 de noviembre de 2026".
    const words = s.replace(/\bde\b|\bdel\b/g, " ").split(" ").filter((w) => w && !WEEKDAYS.test(w));
    const month = words.findIndex((w) => MONTHS.includes(w.slice(0, 3)) || MESES.includes(w.slice(0, 3)));
    const nums = words.filter((w) => /^\d{1,4}$/.test(w)).map(Number);
    if (month >= 0 && nums.length === 2) {
      const w = words[month]!.slice(0, 3), mo = (MONTHS.includes(w) ? MONTHS.indexOf(w) : MESES.indexOf(w)) + 1;
      const y = nums.find((n) => n > 31), d = nums.find((n) => n <= 31);
      if (y && d) date = realDay(y, mo, d);
    }
  }
  if (!date) return null;
  return { date, ...(time ? { time } : {}) };
}
const clock = (mins: number) => `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;

/** "Ann Lee; Ben Ross <ben@example.test>, cal@example.test (Organizer)": each person a cell names, and which one the
 *  cell marks as the organiser. */
export function readPeopleCell(v: string): { people: MoveWho[]; organiser: number } {
  const parts = v.split(/[;\n|]+|,(?![^<(]*[>)])/).map((x) => x.trim()).filter(Boolean);
  let organiser = -1;
  const people = parts.map((p, i) => {
    if (/\((organi[sz]er|owner|booker|host)\)|\*$/i.test(p)) organiser = i;
    const mail = /[^\s<>(),;]+@[^\s<>(),;]+\.[^\s<>(),;]+/.exec(p)?.[0]?.toLowerCase();
    const name = p.replace(/<[^>]*>|\([^)]*\)|\*$/g, "").replace(mail ?? "\u0000", "").trim();
    return { name: (name || mail || "").slice(0, 80), ...(mail && EMAIL.test(mail) ? { email: mail.slice(0, 200) } : {}) };
  }).filter((p) => p.name);
  return { people, organiser };
}

/** A file's rows: a CSV's text or an Excel sheet's cells. */
export function readMoveFile(kind: MoveFileKind, input: { csv?: string; cells?: string[][] }, o: { dayFirst: boolean }): MoveRead {
  // Lines keep their place (a blank one too), so a line number is the one the spreadsheet shows.
  const all = (input.cells ?? parseCsv(input.csv ?? "")).map((r) => r.map((c) => String(c ?? "")));
  const filled = all.filter((r) => r.some((c) => c.trim())).length;
  if (filled < 2) return { rows: [], problems: [], columns: [], fatal: both(filled ? "csv.empty" : "csv.no_header") };
  // A report can start with a title line or two (the club's name, the dates it covers): the header is the first line
  // that names a column this kind of file needs.
  const need: Col[] = kind === "people" ? ["name", "first", "email"] : kind === "bookings" ? ["court"] : ["event"];
  const at = all.slice(0, 8).findIndex((r) => { const h = r.map(normColumn); return need.some((k) => COLS[k].some((n) => h.includes(n))); });
  if (at < 0) return { rows: [], problems: [], columns: [], fatal: both(kind === "people" ? "csv.no_name_column" : kind === "bookings" ? "move.file_no_court_column" : "move.file_no_event_column") };
  const raw = all[at]!, head = raw.map(normColumn), body = all.slice(at + 1).map((r) => (r.some((c) => c.trim()) ? r : [])), first = at + 2;
  if (kind === "people") return readPeople(raw, head, body, first, o);
  if (kind === "bookings") return readBookings(raw, head, body, first, o);
  return readSignups(raw, head, body, first, o);
}

const used = (raw: string[], c: Record<string, number>) => Object.entries(c).filter(([, i]) => i >= 0).map(([what, i]) => ({ what, name: (raw[i] ?? "").trim().slice(0, 120) }));
const getter = (r: string[]) => (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
function whoOf(get: (i: number) => string, c: Record<Col, number>): MoveWho | null {
  const given = c.first >= 0 ? c.first : c.last >= 0 ? c.name : -1;
  const name = (given >= 0 ? [get(given), get(c.last)].filter(Boolean).join(" ") : get(c.name)).replace(/\s+/g, " ");
  const mail = get(c.email).toLowerCase(), id = get(c.ext_id);
  if (!name && !mail && !id) return null;
  return { name: (name || mail || id).slice(0, 80), ...(mail && EMAIL.test(mail) ? { email: mail.slice(0, 200) } : {}), ...(id ? { ext_id: id.slice(0, 64) } : {}) };
}

function readPeople(raw: string[], head: string[], body: string[][], first: number, o: { dayFirst: boolean }): MoveRead {
  const c = columns(head, ["email", "first", "last", "name", "ext_id", "phone", "news", "membership", "start", "until", "next_payment", "status", "credit"]);
  const rows: MovePerson[] = [], problems: Problem[] = [];
  const alsoUntil = COLS.until.map((n) => head.indexOf(n)).filter((i) => i >= 0 && i !== c.until && !Object.values(c).includes(i));
  const day = (v: string, line: number) => {
    if (!v) return undefined;
    const w = readWhen(v, o.dayFirst);
    if (!w?.date) { problems.push({ line, text: both("csv.bad_day", { line, day: v.slice(0, 40) }) }); return null; }
    return w.date;
  };
  body.forEach((r, k) => {
    const line = first + k, get = getter(r), who = whoOf(get, c);
    if (!who) return;
    if (get(c.email) && !who.email) return problems.push({ line, text: both("csv.bad_email", { line, email: get(c.email).slice(0, 80) }) });
    if (!who.email && !who.ext_id) return problems.push({ line, text: both("move.line_no_one", { line, name: who.name }) });
    const row: MovePerson = { line, ...who };
    if (get(c.phone)) row.phone = get(c.phone).slice(0, 40);
    if (YES.has(normColumn(get(c.news)))) row.news = true;
    if (get(c.membership)) {
      // The first of the end dates the line fills in (a paid through date, else its period's end).
      const untilCell = [c.until, ...alsoUntil].map(get).find(Boolean) ?? "";
      const start = day(get(c.start), line), until = day(untilCell, line), next = day(get(c.next_payment), line);
      if (start !== null && until !== null && next !== null) {
        // Paid until the day before the next payment is due, when there's no end or paid-through date.
        const last = until ?? (next ? new Date(Date.parse(`${next}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10) : undefined);
        row.membership = { name: get(c.membership).slice(0, 120), ...(get(c.status) ? { status: normColumn(get(c.status)).slice(0, 40) } : {}), ...(start ? { start } : {}), ...(last ? { until: last } : {}) };
      }
    }
    if (get(c.credit)) row.credit = get(c.credit).slice(0, 40);
    rows.push(row);
  });
  return { rows, problems, columns: used(raw, c), ...(rows.length ? {} : { fatal: both("csv.empty") }) };
}

function readBookings(raw: string[], head: string[], body: string[][], first: number, o: { dayFirst: boolean }): MoveRead {
  const c = columns(head, ["court", "date", "starts", "ends", "minutes", "type", "organiser", "organiser_email", "players", "ref", "signup_status", "email", "first", "last", "name", "ext_id"]);
  const rows: MoveBooking[] = [], problems: Problem[] = [];
  body.forEach((r, k) => {
    const line = first + k, get = getter(r);
    const court = get(c.court);
    if (!court && !get(c.starts)) return;
    if (/cancel|anulad/.test(normColumn(get(c.signup_status)))) return problems.push({ line, text: both("move.line_cancelled", { line }) });
    const d = readWhen(get(c.date), o.dayFirst), s = readWhen(get(c.starts), o.dayFirst), e = readWhen(get(c.ends), o.dayFirst);
    const date = s?.date ?? d?.date, start = s?.time ?? d?.time;
    if (!court) return problems.push({ line, text: both("move.line_no_court", { line }) });
    if (!date || !start) return problems.push({ line, text: both("move.line_bad_time", { line, time: [get(c.date), get(c.starts)].filter(Boolean).join(" ").slice(0, 60) }) });
    // How long: to its end time (past midnight is the next day), or the minutes it says.
    let minutes = 0;
    if (e?.time) {
      const end = Date.parse(`${e.date ?? date}T${e.time}:00Z`), begin = Date.parse(`${date}T${start}:00Z`);
      minutes = Math.round((end - begin) / 60_000);
      if (!e.date && minutes <= 0) minutes += 1440;
    } else if (/^\d+(\.\d+)?$/.test(get(c.minutes))) minutes = Math.round(Number(get(c.minutes)) * (Number(get(c.minutes)) <= 6 ? 60 : 1));
    if (minutes <= 0 || minutes > 600) return problems.push({ line, text: both("move.line_bad_length", { line }) });
    const cell = readPeopleCell(get(c.players));
    // The organiser: its own column, else the one the players cell marks, else a person's columns on the line, else the first player.
    const own = get(c.organiser) ? readPeopleCell(get(c.organiser)).people[0] ?? null : whoOf(get, c);
    let organiser: MoveWho | null = own ? { ...own, ...(get(c.organiser_email) && EMAIL.test(get(c.organiser_email).toLowerCase()) ? { email: get(c.organiser_email).toLowerCase() } : {}) } : null;
    let players = cell.people;
    if (!organiser && players.length) { const i = cell.organiser >= 0 ? cell.organiser : 0; organiser = players[i]!; players = players.filter((_, j) => j !== i); }
    const same = (a: MoveWho, b: MoveWho) => (a.email && a.email === b.email) || normColumn(a.name) === normColumn(b.name);
    players = players.filter((p) => !(organiser && same(p, organiser)));
    rows.push({ line, ...(get(c.ref) ? { ref: get(c.ref).slice(0, 64) } : {}), court: court.slice(0, 80), date, start, minutes, ...(get(c.type) ? { type: get(c.type).slice(0, 80) } : {}),
      organiser, players: players.slice(0, 12) });
  });
  return { rows, problems, columns: used(raw, c), ...(rows.length ? {} : { fatal: both("move.file_no_bookings") }) };
}

function readSignups(raw: string[], head: string[], body: string[][], first: number, o: { dayFirst: boolean }): MoveRead {
  const c = columns(head, ["event", "date", "starts", "signup_status", "email", "first", "last", "name", "ext_id"]);
  const rows: MoveSignup[] = [], problems: Problem[] = [];
  body.forEach((r, k) => {
    const line = first + k, get = getter(r), event = get(c.event), who = whoOf(get, c);
    if (!event && !who) return;
    if (/cancel|withdr|waitlist|anulad|espera|removed|refunded/.test(normColumn(get(c.signup_status)))) return problems.push({ line, text: both("move.line_not_signed_up", { line, status: get(c.signup_status).slice(0, 40) }) });
    if (!event) return problems.push({ line, text: both("move.line_no_event", { line }) });
    if (!who || (!who.email && !who.ext_id && !who.name)) return problems.push({ line, text: both("move.line_no_one", { line, name: who?.name ?? "-" }) });
    const d = readWhen(get(c.date), o.dayFirst), s = readWhen(get(c.starts), o.dayFirst);
    if (get(c.date) && !d?.date && !s?.date) return problems.push({ line, text: both("move.line_bad_time", { line, time: get(c.date).slice(0, 60) }) });
    const date = d?.date ?? s?.date, start = s?.time ?? d?.time;
    rows.push({ line, event: event.slice(0, 120), ...(date ? { date } : {}), ...(start ? { start } : {}), who });
  });
  return { rows, problems, columns: used(raw, c), ...(rows.length ? {} : { fatal: both("move.file_no_signups") }) };
}
