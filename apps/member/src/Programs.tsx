// The club's programs as members find them. Under Play, Events (/events): open play (socials, Americanos and the
// like), tournaments and leagues. Under Learn: Clinics (/learn), Courses (/learn?show=courses) and Private lessons
// (/lessons). Each has its own page (/events/:id, /learn/:id) with a Join button kept at the bottom, which opens
// the same preview as ever: prices, packs, credit and memberships work as before, and nothing changes before
// Confirm. Only the program's own facts and counts are shown, never who else signed up. Loaded when first opened.
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api, club, clubTime, dollars, EmptyState, lang, me, NewOnly, placesLeft, shortTime, t, usePreview, whyNothingNew, type ProgramCardData } from "@kumi/ui";
import { ForWhom } from "./ForWhom.tsx";
import { LearnSwitch, PlaySwitch } from "./TabBar.tsx";
import { DayStrip, PlacesToggle } from "./DayStrip.tsx";
import { CoachFace, Taken } from "./cards.tsx";
import { Lessons } from "./Lessons.tsx";
import { EVENT_CHIPS, isEvent, onChip, programHasPlace, programOn, weeksOf, type EventChip } from "./whats_on.ts";

type Day = { id: string; starts_at: string; capacity: number; booked: number; offered: number; my_status: string | null; my_offer_until: string | null; my_watch: string | null };
export type Program = ProgramCardData & { kind: string; format: string | null; my_status: string | null; my_offer_until: string | null; my_watch: string | null; dates?: Day[];
  coach: { name: string; photo: string | null } | null; minutes: number | null; sessions: number; last_start: string | null; next_session_id: string | null };

const KINDS = { social: "ui.pk_social", tournament: "ui.pk_tournament", league: "ui.pk_league", clinic: "ui.pk_clinic", course: "ui.pk_course" } as const;
const CHIPS = { all: "ui.chip_all", social: "ui.pk_social", tournament: "ui.pk_tournaments", league: "ui.pk_leagues" } as const;
/** "Open play · Americano", "Tournament", "Course". */
const kindLabel = (p: Program) => [p.kind in KINDS ? t(KINDS[p.kind as keyof typeof KINDS]) : p.kind, p.format ? t(`format.${p.format as "americano"}`) : null].filter(Boolean).join(" · ");
/** What this person pays: included, their member price, or the price. */
const priceText = (p: Program) => p.my_basis === "included" ? t("ui.price_included") : dollars(p.my_price_cents, lang.value);
/** 90 minutes, or 8 hours for a whole day's tournament. */
const lengthText = (m: number) => (m >= 120 && m % 60 === 0 ? t("count.hours", { count: m / 60 }) : t("ui.minutes", { count: m }));
const coachOrClub = (p: Program) => p.coach?.name ?? club.value?.name ?? "";

/** The programs for the member, or (a parent) one of their juniors: their price and where they stand. */
function usePrograms(who: string) {
  const [rows, setRows] = useState<Program[] | null>(null);
  const load = () => api<Program[]>(who === me.value!.person.id ? "/open-programs" : `/open-programs?for=${who}`).then(setRows).catch(() => setRows([]));
  useEffect(() => { void load(); }, [lang.value, who]);
  return { rows, load };
}
const forQuery = (who: string) => (who === me.value!.person.id ? "" : `?for=${who}`);

/** Events, under Play: chips for the kinds, a week of days, and only the ones with places if asked. */
export function Events() {
  const [who, setWho] = useState(me.value!.person.id), { rows } = usePrograms(who);
  const [chip, setChip] = useState<EventChip>("all"), [day, setDay] = useState(""), [places, setPlaces] = useState(false);
  const tz = club.value?.time_zone ?? "UTC", all = (rows ?? []).filter((p) => isEvent(p.kind));
  const shown = all.filter((p) => onChip(p.kind, chip) && programOn(p, day, tz) && (!places || programHasPlace(p)));
  return (
    <main>
      <h1>{t(club.value?.court_bookings ? "ui.nav_play" : "ui.home_events")}</h1>
      <PlaySwitch here="events" />
      <div class="chips scroll" role="group" aria-label={t("ui.event_kinds")}>{EVENT_CHIPS.map((c) =>
        <button type="button" class={c === chip ? "chip on" : "chip"} aria-pressed={c === chip} onClick={() => setChip(c)}>{t(CHIPS[c])}</button>)}</div>
      <DayStrip value={day} onChange={setDay} tz={tz} has={(d) => all.some((p) => onChip(p.kind, chip) && programOn(p, d, tz))} />
      <PlacesToggle value={places} onChange={setPlaces} />
      <ForWhom value={who} onChange={setWho} />
      {!rows ? <p class="meta">{t("ui.loading")}</p> : all.length === 0 ? <p class="card">{t("ui.events_nothing")}</p> : shown.length === 0 && <p class="card">{t("ui.none_this_day")}</p>}
      <ul class="items">{shown.map((p) => <li key={p.id}><ProgramItem p={p} href={`/events/${p.id}${forQuery(who)}`} /></li>)}</ul>
      {/* Links sent before Learn had its own tab named this page for clinics and courses too. */}
      <p><a href="/learn">{t("ui.learn_is_where")}</a></p>
    </main>
  );
}

/** Learn: clinics (with the week of days), courses, or private lessons with a coach. */
export function Learn() {
  const { query } = useLocation();
  const show = query.show === "courses" ? "course" : "clinic";
  const [who, setWho] = useState(me.value!.person.id), { rows, load } = usePrograms(who);
  const [day, setDay] = useState(""), [places, setPlaces] = useState(false);
  const { preview, sheet } = usePreview(() => { void load(); });
  const tz = club.value?.time_zone ?? "UTC", all = (rows ?? []).filter((p) => p.kind === show);
  const shown = all.filter((p) => (show === "course" || programOn(p, day, tz)) && (!places || programHasPlace(p)));
  return (
    <main>
      <h1>{t("ui.tab_learn")}</h1>
      <LearnSwitch here={show === "course" ? "courses" : "clinics"} />
      {sheet}
      {show === "clinic" && <DayStrip value={day} onChange={setDay} tz={tz} has={(d) => all.some((p) => programOn(p, d, tz))} />}
      <PlacesToggle value={places} onChange={setPlaces} />
      <ForWhom value={who} onChange={setWho} />
      {!rows ? <p class="meta">{t("ui.loading")}</p> : all.length === 0 ? <EmptyState art="no-classes">{t(show === "course" ? "ui.courses_nothing" : "ui.clinics_nothing")}</EmptyState>
        : shown.length === 0 && <p class="card">{t("ui.none_this_day")}</p>}
      <ul class="items">{shown.map((p) => <li key={p.id}><ProgramItem p={p} href={`/learn/${p.id}${forQuery(who)}`}
        join={canJoin(p) ? () => preview("enrolment.join", { program_id: p.id, person_id: who }) : undefined} /></li>)}</ul>
    </main>
  );
}

/** Private lessons, under Learn: the coaches and their times, as the lessons page has always shown them. */
export function LessonsPage() {
  return <Lessons head={<><h1>{t("ui.tab_learn")}</h1><LearnSwitch here="lessons" /></>} />;
}

/** Joining straight from a card: a program taken as a whole that this person isn't in yet. Dates are picked on its page. */
const canJoin = (p: Program) => !p.dates && !p.my_status && !p.my_offer_until && !whyNothingNew(club.value);

/** A program's card: kind, name, when (and how long), level, coach or club, places taken, and this person's price. */
function ProgramItem({ p, href, join }: { p: Program; href: string; join?: () => void }) {
  const left = placesLeft(p), full = !p.dates && left <= 0, weeks = weeksOf(p.first_start, p.last_start);
  const when = p.first_start ? clubTime(p.first_start, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : t("ui.dates_to_come");
  return (
    <div class={p.my_status === "booked" ? "item mine" : "item"}>
      <span class="item-top">
        <span class="item-kind">{kindLabel(p)}{p.my_status && <span class="tag on">{t(p.my_status === "booked" ? "ui.youre_in" : "ui.waitlist")}</span>}</span>
        <span class="item-price">{priceText(p)}{p.kind === "course" && p.my_basis !== "included" && <small> {t("ui.total")}</small>}</span>
      </span>
      <a class="item-title item-link" href={href}>{p.name}</a>
      <span class="item-when">{p.dates ? t("ui.dates_count", { count: p.dates.length }) : p.kind === "course" && p.sessions > 1
        ? t("ui.course_when", { weeks: t("count.weeks", { count: weeks }), first: when }) : when}{p.minutes ? ` · ${lengthText(p.minutes)}` : ""}</span>
      {p.level_min && p.level_max && <span class="tags"><span class="tag">{t("ui.level_band", { min: p.level_min, max: p.level_max })}</span></span>}
      <span class="item-foot">
        {p.dates ? <span class="count">{t("ui.per_date_short")}</span> : full ? <span class="tag warn">{t("ui.full")}</span> : <Taken taken={p.booked + p.offered} total={p.capacity} />}
        <span class="item-org">{p.coach && <CoachFace name={p.coach.name} photo={p.coach.photo} />}{p.coach ? p.coach.name : t("ui.by_name", { name: coachOrClub(p) })}</span>
      </span>
      {join && <NewOnly quiet><button class={full ? "item-join" : "item-join primary"} onClick={join}>{t(full ? "ui.join_waitlist" : "ui.join")}<span class="visually-hidden">: {p.name}</span></button></NewOnly>}
    </div>
  );
}

/** One program's page: the facts, who runs it, the places, the dates (signed up per date), the chat once in, and Join. */
export function ProgramPage({ id }: { id: string }) {
  const { path, query, route } = useLocation();
  const [who, setWho] = useState(query.for && query.for !== me.value!.person.id ? query.for : me.value!.person.id), { rows, load } = usePrograms(who);
  const [picked, setPicked] = useState<string[]>([]);
  const { preview, sheet } = usePreview(() => { setPicked([]); void load(); });
  const learn = path.startsWith("/learn");
  const p = rows?.find((x) => x.id === id);
  // Under the tab it belongs to: a clinic or course linked as /events/... (the place-open email) moves on to /learn/..., and back.
  useEffect(() => { if (p && learn === isEvent(p.kind)) route(`${learn ? "/events" : "/learn"}/${id}${forQuery(who)}`, true); }, [p?.id, learn]);
  const back = learn ? (p?.kind === "course" ? "/learn?show=courses" : "/learn") : "/events";
  if (!rows) return <main class="card"><p>{t("ui.loading")}</p></main>;
  if (!p) return <main><p class="card">{t("ui.program_gone")} <a href={back}>{t(learn ? "ui.tab_learn" : "ui.home_events")}</a></p></main>;
  const closed = Boolean(whyNothingNew(club.value)), left = placesLeft(p), full = !p.dates && left <= 0, need = p.min_players !== null ? p.min_players - p.booked : 0;
  const long = (iso: string) => clubTime(iso, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
  const day = (iso: string) => clubTime(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const tick = (d: string, on: boolean) => setPicked(on ? [...picked, d] : picked.filter((x) => x !== d));
  const weeks = weeksOf(p.first_start, p.last_start), price = priceText(p);
  const bar = !closed && !p.my_status && !p.my_offer_until && (p.dates ? picked.length > 0 : true);
  return (
    <main class={bar ? "has-bar" : undefined}>
      <p><a href={back}>{t("ui.back_to", { page: t(learn ? (p.kind === "course" ? "ui.learn_courses" : "ui.learn_clinics") : "ui.home_events") })}</a></p>
      {sheet}
      <p class="item-kind">{kindLabel(p)}</p>
      <h1>{p.name}</h1>
      <p><strong>{p.dates ? t("ui.per_date_note") : p.first_start ? long(p.first_start) : t("ui.dates_to_come")}</strong>
        {!p.dates && p.sessions > 1 && <><br /><span class="meta">{t("ui.sessions_weeks", { sessions: t("count.dates", { count: p.sessions }), weeks: t("count.weeks", { count: weeks }) })}{p.last_start ? `, ${t("ui.last_date", { when: day(p.last_start) })}` : ""}</span></>}</p>
      <ForWhom value={who} onChange={(x) => { setWho(x); setPicked([]); }} />
      <section class="card">
        <dl class="facts">
          <div><dt>{t("ui.fact_level")}</dt><dd>{p.level_min && p.level_max ? `${p.level_min}-${p.level_max}` : t("ui.all_levels")}</dd></div>
          <div><dt>{t("ui.fact_price")}</dt><dd>{price}{p.kind === "course" && p.my_basis !== "included" && <small> {t("ui.total")}</small>}</dd></div>
          <div><dt>{t("ui.fact_places")}</dt><dd>{p.dates ? t("ui.per_date_short") : full ? t("ui.full") : `${p.booked + p.offered}/${p.capacity}`}</dd></div>
        </dl>
        {p.my_basis === "member" && <p class="meta">{t("ui.your_member_price", { amount: dollars(p.my_price_cents, lang.value) })}</p>}
        {p.my_basis === "included" && p.included && <p class="meta">{t("ui.your_included", { n: p.included.n, of: p.included.of })}</p>}
        {p.my_basis === "full" && p.members_cents !== null && <p class="meta">{t("ui.members_price", { amount: dollars(p.members_cents, lang.value) })}</p>}
        {!p.dates && <>
          <progress class="fill" max={p.capacity} value={Math.min(p.capacity, p.booked + p.offered)} aria-label={t("ui.n_places_taken", { taken: p.booked + p.offered, total: p.capacity })} />
          <p class="meta">{left > 0 ? t("ui.places_left", { count: left }) : t("ui.full_waitlist")}{p.min_players !== null ? ` · ${t("ui.runs_with_min", { count: p.min_players })}` : ""}{need > 0 ? ` · ${t("ui.needs_more", { count: need })}` : ""}</p>
        </>}
        <h2 class="small-head">{t(p.coach ? "ui.coach_title" : "ui.organiser_title")}</h2>
        <p class="org">{p.coach ? <><CoachFace name={p.coach.name} photo={p.coach.photo} size="big" /><span>{p.coach.name}</span></> : <span>{club.value?.name}</span>}</p>
        <h2 class="small-head">{t("ui.about")}</h2>
        <ul class="plain">
          {p.minutes && <li>{t(p.sessions > 1 ? "ui.each_session_length" : "ui.length_is", { length: lengthText(p.minutes) })}</li>}
          <li>{t(p.rated ? "ui.rated_label" : "ui.friendly_label")}</li>
          <li>{t("ui.refund_rule", { hours: p.refund_window_hours })}</li>
        </ul>
        {/* The chat is the member's own: not offered on a junior's page (juniors have no chats). */}
        {p.my_status === "booked" && who === me.value!.person.id && club.value?.players_chat && p.next_session_id && <p><a class="button" href={`/chats/session/${p.next_session_id}`}>{t("ui.chat_open")}</a></p>}
      </section>

      {p.dates ? <section class="card">
        <h2>{t("ui.choose_dates")}</h2>
        {/* Each date with its own places: tick the ones wanted (a full one goes on its waitlist), or ask to hear when one opens. */}
        <ul class="plain dates">{p.dates.map((x) => { const free = x.capacity - x.booked - x.offered; return (
          <li>{x.my_offer_until ? <>{day(x.starts_at)} · {t("ui.offer_ends", { time: shortTime(x.my_offer_until) })} · <a href="/places">{t("ui.take_place")}</a></>
            : x.my_status ? <>{day(x.starts_at)} · {x.my_status === "booked" ? t("ui.youre_in") : t("ui.waitlist")}</>
            : closed ? <>{day(x.starts_at)} · {free > 0 ? t("ui.places_left", { count: free }) : t("ui.date_full")}</>
            : <><label class="check"><input type="checkbox" checked={picked.includes(x.id)} onChange={(e) => tick(x.id, e.currentTarget.checked)} /> {day(x.starts_at)} · {free > 0 ? t("ui.places_left", { count: free }) : t("ui.date_full")}</label>
              {free <= 0 && (x.my_watch ? <> <button class="small" onClick={() => preview("program.unwatch", { watch_id: x.my_watch })}>{t("ui.stop_watching")}</button></>
                : <> <button class="small" onClick={() => preview("program.watch", { program_id: p.id, person_id: who, session_id: x.id })}>{t("ui.watch_place")}</button></>)}</>}</li>); })}</ul>
      </section> : p.my_offer_until ? <p class="note">{t("ui.offer_ends", { time: shortTime(p.my_offer_until) })} · <a href="/places">{t("ui.take_place")}</a></p>
        : p.my_status ? <p class="note">{p.my_status === "booked" ? t("ui.youre_in") : t("ui.waitlist")} · <a href="/places">{t("ui.see_my_bookings")}</a></p>
        : full && (p.my_watch
          ? <p class="note">{t("ui.watching")} <button class="small" onClick={() => preview("program.unwatch", { watch_id: p.my_watch })}>{t("ui.stop_watching")}</button></p>
          : <NewOnly quiet><p><button onClick={() => preview("program.watch", { program_id: p.id, person_id: who })}>{t("ui.watch_place")}</button></p></NewOnly>)}

      {/* Join, at the bottom of the screen above the tabs: the same preview as ever. */}
      {bar && <div class="book-bar">
        <span class="book-bar-what"><strong>{p.name}</strong><span>{p.dates ? t("ui.dates_picked", { count: picked.length }) : full ? t("ui.full_waitlist") : price}</span></span>
        {p.dates ? <NewOnly><button class="primary" onClick={() => preview("enrolment.join_dates", { program_id: p.id, person_id: who, session_ids: picked })}>{t("ui.sign_up_dates", { count: picked.length })}</button></NewOnly>
          : <NewOnly><button class="primary" onClick={() => preview("enrolment.join", { program_id: p.id, person_id: who })}>{t(full ? "ui.join_waitlist" : "ui.join")}</button></NewOnly>}
      </div>}
    </main>
  );
}
