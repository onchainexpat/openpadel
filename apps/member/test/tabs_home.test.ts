// The members' app's tabs and Home: which tab each page is under (old addresses from emails and texts included),
// what Home counts and lists, the club's hours, and Book's start times with the taken ones kept to strike through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tabOf, tabsFor } from "../src/tabs.ts";
import { comingUp, soonCounts } from "../src/home_data.ts";
import { hoursOn, weekLines } from "../src/hours.ts";
import { startTimes } from "../src/book_times.ts";

test("five tabs with court bookings; without them no Book, and Play opens the events", () => {
  assert.deepEqual(tabsFor({ court_bookings: true }).map((x) => x.href), ["/", "/book", "/play", "/learn", "/account"]);
  assert.deepEqual(tabsFor({ court_bookings: false }).map((x) => x.href), ["/", "/events", "/learn", "/account"]);
  // Me is never /me: that address is the server's.
  assert.ok(!tabsFor(null).some((x) => x.href === "/me"));
});

test("every page the app has is under a tab", () => {
  const cases: [string, string][] = [["/", "home"], ["/ask", "home"], ["/ask/abc", "home"], ["/inbox", "home"], ["/nowhere", "home"],
    ["/book", "book"], ["/join/AB12", "book"], ["/play", "play"], ["/match/1", "play"], ["/events", "play"], ["/competitions", "play"], ["/tournaments", "play"],
    ["/take/x", "play"], ["/chats/booking/1", "play"], ["/friends", "play"], ["/friend/x", "play"], ["/learn", "learn"], ["/lessons", "learn"],
    ["/account", "me"], ["/profile", "me"], ["/membership", "me"], ["/level", "me"], ["/family", "me"], ["/family/join/x", "me"], ["/waiver", "me"],
    ["/receipts/1", "me"], ["/gift-cards", "me"], ["/passes", "me"], ["/places?paid=1", "me"]];
  for (const [path, tab] of cases) assert.equal(tabOf(path), tab, path);
  // /membership-plans and /bookings are the server's, but the start of a name never counts: /books isn't Book.
  assert.equal(tabOf("/books"), "home");
});

test("every old address still has its page, and the new ones are routed", () => {
  const app = readFileSync(join(import.meta.dirname, "../src/App.tsx"), "utf8");
  for (const p of ["/", "/events", "/learn", "/account", "/places", "/competitions", "/gift-cards", "/passes", "/level", "/inbox", "/book", "/join/:code", "/membership",
    "/play", "/match/:id", "/friends", "/friend/:code", "/take/:code", "/lessons", "/family", "/family/join/:code", "/waiver", "/ask", "/ask/:id", "/receipts", "/receipts/:id",
    "/chats", "/chats/:kind/:id", "/profile"]) assert.ok(app.includes(`<Route path="${p}" `), p);
  assert.match(app, /<TabBar \/>/);
});

test("Home lists my coming bookings and places, soonest first, each with where to see it", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const b = (id: string, start: string, more: object = {}) => ({ id, kind: "court", status: "confirmed", pay_mode: "whole", players: 4, start, end: new Date(Date.parse(start) + 5400_000).toISOString(),
    court: "Court 1", time_zone: "UTC", coach: null, open_match_id: null, joined: 1, for_name: null, ...more });
  const list = comingUp([
    b("past", "2026-11-10T10:00:00Z"),
    b("m", "2026-11-13T18:00:00Z", { open_match_id: "m", pay_mode: "split", joined: 3 }),
    b("c", "2026-11-12T18:00:00Z"),
    b("l", "2026-11-14T18:00:00Z", { kind: "lesson", coach: "Dani", status: "held" }),
  ], [{ id: "p", status: "waitlisted", waitlist_position: 2, name: "Clinic", first_start: "2026-11-12T09:00:00Z", offer_expires_at: null, for_name: "Mia" }], now);
  assert.deepEqual(list.map((x) => x.key), ["pp", "bc", "bm", "bl"]);
  assert.deepEqual(list.map((x) => x.href), ["/places", "/match/c", "/match/m", "/places"]);
  assert.equal(list[0]!.state, "waitlist"); assert.equal(list[0]!.for_name, "Mia");
  assert.deepEqual(list[2]!.joined, { count: 3, total: 4 }); assert.equal(list[2]!.kind, "match");
  assert.equal(list[3]!.state, "held"); assert.equal(list[3]!.kind, "lesson");
});

test("Home counts the next 14 days: matches with a place left, events, clinics and courses", () => {
  const now = Date.parse("2026-11-11T12:00:00Z"), day = (n: number) => new Date(now + n * 86_400_000).toISOString();
  const m = (start: string, more: object = {}) => ({ start, open: true, cancelled: false, listed: true, spots_left: 1, is_match: true, ...more });
  const c = soonCounts(
    [{ kind: "clinic", first_start: day(1) }, { kind: "clinic", first_start: day(20) }, { kind: "course", first_start: day(3) }, { kind: "social", first_start: day(2) },
      { kind: "tournament", first_start: day(13) }, { kind: "league", first_start: null }],
    [m(day(1)), m(day(2), { spots_left: 0 }), m(day(3), { cancelled: true }), m(day(15)), m(day(4), { is_match: false })], now);
  assert.deepEqual(c, { matches: 1, events: 2, clinics: 1, courses: 1 });
});

test("the club's week reads in lines, and today's hours take a special day first", () => {
  const week = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "07:00", closes: "22:00" })).concat([{ weekday: 6, opens: "08:00", closes: "20:00" }, { weekday: 0, opens: null, closes: null } as any]);
  assert.deepEqual(weekLines(week, "en-US", { to: "to", closed: "Closed" }).map((r) => ({ ...r, hours: r.hours.replace(/\s/g, " ") })), [{ days: "Mon to Fri", hours: "7:00 AM to 10:00 PM" }, { days: "Sat", hours: "8:00 AM to 8:00 PM" }, { days: "Sun", hours: "Closed" }]);
  assert.deepEqual(hoursOn("2026-11-11", week, []), { opens: "07:00", closes: "22:00" });   // a Wednesday
  assert.equal(hoursOn("2026-11-15", week, []), null);                                       // a Sunday
  assert.deepEqual(hoursOn("2026-11-11", week, [{ on_date: "2026-11-11", opens: "10:00", closes: "14:00" }]), { opens: "10:00", closes: "14:00" });
  assert.equal(hoursOn("2026-11-12", week, [{ on_date: "2026-11-12", opens: null, closes: null }]), null);
});

test("Book shows every half hour from opening, taken ones too, and none already gone", () => {
  const free = { open: { opens: "2026-11-12T08:00:00.000Z", closes: "2026-11-12T11:00:00.000Z" },
    courts: [{ starts: ["2026-11-12T09:00:00.000Z"] }, { starts: ["2026-11-12T09:30:00.000Z", "2026-11-12T09:15:00.000Z"] }] };
  const all = startTimes(free, 90, Date.parse("2026-11-12T08:10:00Z"));
  // 08:00 has gone; 08:30 to 09:30 by the half hour (10:00 would end after closing), and a court's own 09:15.
  assert.deepEqual(all, ["2026-11-12T08:30:00.000Z", "2026-11-12T09:00:00.000Z", "2026-11-12T09:15:00.000Z", "2026-11-12T09:30:00.000Z"]);
  assert.deepEqual(startTimes({ open: null, courts: [] }, 60, 0), []);
});
