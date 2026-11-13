// Home: the club at the top (its name, the member's plan, today's hours), what the member has coming up, the ways
// in (book, a match, events, learning), what's on at the club in the next two weeks, asking the club, and the
// club's courts, hours and address. Everything here comes from reads the app already makes, and /my/club (the
// club's public facts). Nothing about another member is shown.
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api, club, clubTime, EmptyState, Illustration, lang, serverNow, t } from "@kumi/ui";
import { formatLocale } from "@kumi/i18n/format";
import { hoursOn, weekLines, clock, type Hours, type Special } from "./hours.ts";
import { comingUp, type Upcoming } from "./home_data.ts";
import type { SoonCounts } from "./whats_on.ts";

type Place = { id: string; name: string; address: string | null; courts: number; kinds: string[]; hours: Hours[]; special: Special[] };
type ClubInfo = { time_zone: string; locations: Place[] };

/** Today in the club's time zone (YYYY-MM-DD). */
const clubToday = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(serverNow()));
const mapLink = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

export function Home() {
  const [info, setInfo] = useState<ClubInfo | null>(null), [plan, setPlan] = useState<string | null>(null);
  const [next, setNext] = useState<Upcoming[] | null>(null), [soon, setSoon] = useState<SoonCounts | null>(null);
  const courts = Boolean(club.value?.court_bookings);
  useEffect(() => {
    api<ClubInfo>("/my/club").then(setInfo).catch(() => {});
    api<{ membership: { name: string } | null }>("/my/membership").then((r) => setPlan(r.membership?.name ?? null)).catch(() => {});
    Promise.all([api<Parameters<typeof comingUp>[0]>("/my/bookings").catch(() => []), api<Parameters<typeof comingUp>[1]>("/my/places").catch(() => [])])
      .then(([b, p]) => setNext(comingUp(b, p, serverNow()))).catch(() => setNext([]));
    // Counts only (the server's): events under Play, clinics and courses under Learn, open matches with a place left.
    api<SoonCounts>("/my/whats-on/counts").then(setSoon).catch(() => {});
  }, [lang.value, courts]);
  const loc = info?.locations[0], locale = formatLocale(lang.value);
  const today = loc && info && info.locations.length === 1 ? hoursOn(clubToday(info.time_zone), loc.hours, loc.special) : null;
  const totalCourts = info?.locations.reduce((n, l) => n + l.courts, 0) ?? 0;
  const name = club.value?.name ?? "";
  return (
    <main class="home">
      <section class="club-head" aria-labelledby="club-name">
        {/* The club has no photo of its own yet: a court drawing, faint, behind its name. */}
        <Illustration name="court" tone="faint" class="club-head-art" />
        {club.value?.logo ? <img class="monogram monogram-logo" src={club.value.logo} alt="" width={56} height={56} />
          : <span class="monogram" aria-hidden="true">{name.trim().charAt(0).toUpperCase()}</span>}
        <div>
          <h1 id="club-name">{name}</h1>
          {plan && <a class="pill" href="/membership">{t("ui.home_member_pill", { plan })}</a>}
          {loc && <p class="meta">{[totalCourts ? t("ui.home_courts", { count: totalCourts }) : null,
            info!.locations.length > 1 ? null : today ? t("ui.home_open_today", { from: clock(today.opens, locale), to: clock(today.closes, locale) }) : t("ui.home_closed_today")].filter(Boolean).join(" · ")}</p>}
        </div>
      </section>

      <section aria-labelledby="next-title">
        <div class="section-head"><h2 id="next-title">{t("ui.home_next_title")}</h2>{next && next.length > 0 && <a class="tap" href="/places">{t("ui.home_see_all")}</a>}</div>
        {!next ? <p class="meta">{t("ui.loading")}</p> : !next.length ? <EmptyState art="no-bookings" size="s">{t("ui.home_next_none")} {courts && <a href="/book">{t("ui.nav_book")}</a>}</EmptyState> : (
          <ul class="rail" aria-labelledby="next-title">{next.map((x) => <li key={x.key}><ActivityCard x={x} /></li>)}</ul>
        )}
      </section>

      <nav class="shortcuts" aria-label={t("ui.home_shortcuts")}>
        {courts && <a href="/book"><Icon d="M3 4.5h18v16.5H3zM8 2.5v4M16 2.5v4M3 10h18" />{t("ui.nav_book")}</a>}
        {courts && <a href="/play"><Icon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.7 5.6c3.2 3.6 3.2 9.2 0 12.8M18.3 5.6c-3.2 3.6-3.2 9.2 0 12.8" />{t("ui.home_join")}</a>}
        <a href="/events"><Icon d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />{t("ui.home_events")}</a>
        <a href="/learn"><Icon d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v16H5.5A1.5 1.5 0 0 0 4 20.5zM4 20.5A1.5 1.5 0 0 0 5.5 22H20" />{t("ui.tab_learn")}</a>
      </nav>

      {soon && <section class="card" aria-labelledby="soon-title">
        <h2 id="soon-title">{t("ui.home_soon_title")}</h2>
        {soon.matches + soon.events + soon.clinics + soon.courses === 0 ? <p class="meta">{t("ui.home_soon_none")}</p> : <div class="tiles">
          {courts && soon.matches > 0 && <a href="/play">{t("count.open_matches", { count: soon.matches })}</a>}
          {soon.events > 0 && <a href="/events">{t("count.events", { count: soon.events })}</a>}
          {soon.clinics > 0 && <a href="/learn">{t("count.clinics", { count: soon.clinics })}</a>}
          {soon.courses > 0 && <a href="/learn?show=courses">{t("count.courses_starting", { count: soon.courses })}</a>}
        </div>}
      </section>}

      <AskBox />

      {info && info.locations.length > 0 && <section class="card" aria-labelledby="club-title">
        <h2 id="club-title">{t("ui.home_club_title")}</h2>
        {info.locations.map((l) => <div class="place">
          {info.locations.length > 1 && <h3>{l.name}</h3>}
          {l.address && <p>{l.address}</p>}
          {l.courts > 0 && <p class="meta">{t("ui.home_courts", { count: l.courts })}{l.kinds.length ? `: ${l.kinds.map((k) => kindName(k)).filter(Boolean).join(" · ")}` : ""}</p>}
          {l.hours.length > 0 && <>
            <h3 class="small-head">{t("ui.hours_title")}</h3>
            <dl class="hours">{weekLines(l.hours, locale, { to: t("ui.to_word"), closed: t("ui.closed") }).map((r) => <><dt>{r.days}</dt><dd>{r.hours}</dd></>)}</dl>
          </>}
          {l.address && <p><a class="button" href={mapLink(l.address)} target="_blank" rel="noopener noreferrer">{t("ui.home_directions")}</a></p>}
        </div>)}
      </section>}
    </main>
  );
}

const kindName = (k: string) => k === "indoor" ? t("ui.kind_indoor") : k === "outdoor" ? t("ui.kind_outdoor") : k === "covered_outdoor" ? t("ui.kind_covered_outdoor") : "";

function Icon({ d }: { d: string }) {
  return <span class="shortcut-icon" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={d} /></svg></span>;
}

/** One thing coming up: the day, what it is, when and where, and where it stands. */
function ActivityCard({ x }: { x: Upcoming }) {
  const at = (o: Intl.DateTimeFormatOptions) => x.tz ? new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: x.tz, ...o }).format(new Date(x.start)) : clubTime(x.start, o);
  const what = x.kind === "lesson" ? t("ui.lesson_with", { coach: x.coach ?? "" }) : x.kind === "match" ? t("ui.open_match_label") : x.kind === "court" ? t("ui.court_booking") : x.name;
  const state = x.state === "waitlist" ? t("ui.on_waitlist", { n: x.position ?? 0 }) : x.state === "offer" ? t("ui.home_offer") : x.state === "held" ? t("ui.being_paid")
    : x.joined ? t("count.joined", { count: x.joined.count, total: x.joined.total }) : x.state === "in" && x.kind === "program" ? t("ui.youre_in") : "";
  return (
    <article class="activity">
      <div class="when-block" aria-hidden="true"><span>{at({ weekday: "short" })}</span><strong>{at({ day: "numeric" })}</strong></div>
      <div class="activity-body">
        <span class="kind">{what}</span>
        <span class="title">{at({ weekday: "long", day: "numeric", month: "short" })}, {at({ hour: "numeric", minute: "2-digit" })}{x.court ? ` · ${x.court}` : ""}</span>
        {x.for_name && <span class="meta">{t("ui.for_name", { name: x.for_name })}</span>}
        {state && <span class="meta">{state}</span>}
        <a class="button" href={x.href}>{t("ui.home_details")}<span class="visually-hidden">: {what}</span></a>
      </div>
    </article>
  );
}

/** Asking the club from Home: the question goes to the Ask page, which shows the club's own answers first. */
function AskBox() {
  const { route } = useLocation();
  const [q, setQ] = useState("");
  return (
    <section class="card ask-box" aria-labelledby="ask-title">
      <h2 id="ask-title">{t("ui.ask_title")}</h2>
      <p class="meta">{t("ui.home_ask_hint")}</p>
      <form onSubmit={(e) => { e.preventDefault(); route(q.trim() ? `/ask?q=${encodeURIComponent(q.trim())}` : "/ask"); }}>
        <label for="home-ask">{t("ui.your_question")}</label>
        <div class="ask-row"><input id="home-ask" value={q} maxLength={2000} onInput={(e) => setQ(e.currentTarget.value)} /><button class="primary">{t("ui.ask_send")}</button></div>
      </form>
    </section>
  );
}
