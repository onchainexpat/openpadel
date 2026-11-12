import { useEffect, useState } from "preact/hooks";
import { api, club, lang, me, NewOnly, t, shortTime, usePreview, ProgramCard, placesLeft, whyNothingNew, type ProgramCardData, clubTime } from "@kumi/ui";
import { ForWhom } from "./ForWhom.tsx";
import { LEARN_KINDS } from "./home_data.ts";
import { PlaySwitch } from "./TabBar.tsx";

type Day = { id: string; starts_at: string; capacity: number; booked: number; offered: number; my_status: string | null; my_offer_until: string | null; my_watch: string | null };
type P = ProgramCardData & { kind: string; my_status: string | null; my_offer_until: string | null; my_watch: string | null; dates?: Day[] };

/** Events (/events: everything the club runs) and Learn (/learn: its clinics and courses, and private lessons). */
export const Events = () => <WhatsOn />;
export const Learn = () => <WhatsOn learn />;

export function WhatsOn({ learn = false }: { learn?: boolean }) {
  const [rows, setRows] = useState<P[] | null>(null), [who, setWho] = useState(me.value!.person.id);
  const [picked, setPicked] = useState<Record<string, string[]>>({});   // signed up per date: the dates ticked, by program
  // For a parent: the programs as one of their juniors would take them (their price, whether they're in).
  const load = () => api<P[]>(who === me.value!.person.id ? "/open-programs" : `/open-programs?for=${who}`).then((r) => setRows(learn ? r.filter((p) => LEARN_KINDS.includes(p.kind)) : r));
  const { preview, sheet } = usePreview(() => { setPicked({}); load(); });
  const day = (iso: string) => clubTime(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const tick = (p: string, d: string, on: boolean) => setPicked({ ...picked, [p]: on ? [...(picked[p] ?? []), d] : (picked[p] ?? []).filter((x) => x !== d) });
  useEffect(() => { load(); }, [lang.value, who]);
  // Read-only or moved (read_only.ts): nothing new is signed up for, so the dates are listed without boxes to tick.
  const closed = Boolean(whyNothingNew(club.value));
  return (
    <main>
      <h1>{t(learn ? "ui.tab_learn" : "ui.nav_whats_on")}</h1>
      {!learn && <PlaySwitch here="events" />}
      {learn && club.value?.lessons && <p class="card"><a class="tap" href="/lessons">{t("ui.learn_lessons_link")}</a></p>}
      {sheet}
      <ForWhom value={who} onChange={setWho} />
      {rows?.length === 0 && <p>{t(learn ? "ui.learn_nothing" : "ui.nothing_on")}</p>}
      <ul class="changes">{(rows ?? []).map((p) => (
        <ProgramCard key={p.id} p={p}>
          {p.dates ? <>
            {/* Each date with its own places: tick the ones wanted (a full one goes on its waitlist), or ask to hear when one opens. */}
            <ul class="plain">{p.dates.map((x) => { const left = x.capacity - x.booked - x.offered; return (
              <li>{x.my_offer_until ? <>{day(x.starts_at)} · {t("ui.offer_ends", { time: shortTime(x.my_offer_until) })} · <a href="/places">{t("ui.take_place")}</a></>
                : x.my_status ? <>{day(x.starts_at)} · {x.my_status === "booked" ? t("ui.youre_in") : t("ui.waitlist")}</>
                : closed ? <>{day(x.starts_at)} · {left > 0 ? t("ui.places_left", { count: left }) : t("ui.date_full")}</>
                : <><label class="check"><input type="checkbox" checked={(picked[p.id] ?? []).includes(x.id)} onChange={(e) => tick(p.id, x.id, e.currentTarget.checked)} /> {day(x.starts_at)} · {left > 0 ? t("ui.places_left", { count: left }) : t("ui.date_full")}</label>
                  {left <= 0 && (x.my_watch ? <> <button class="small" onClick={() => preview("program.unwatch", { watch_id: x.my_watch })}>{t("ui.stop_watching")}</button></>
                    : <> <button class="small" onClick={() => preview("program.watch", { program_id: p.id, person_id: who, session_id: x.id })}>{t("ui.watch_place")}</button></>)}</>}</li>); })}</ul>
            <NewOnly>{(picked[p.id] ?? []).length > 0 && <button class="primary" onClick={() => preview("enrolment.join_dates", { program_id: p.id, person_id: who, session_ids: picked[p.id] })}>{t("ui.sign_up_dates", { count: picked[p.id]!.length })}</button>}</NewOnly>
          </> : p.my_offer_until ? <p class="note">{t("ui.offer_ends", { time: shortTime(p.my_offer_until) })} · <a href="/places">{t("ui.take_place")}</a></p>
            : p.my_status ? <p class="note">{p.my_status === "booked" ? t("ui.youre_in") : t("ui.waitlist")}</p>
            : <>
              <NewOnly><button class="primary" onClick={() => preview("enrolment.join", { program_id: p.id, person_id: who })}>{t("ui.join")}</button></NewOnly>
              {/* Full: besides the waitlist, one message when a place is free to anyone. */}
              {placesLeft(p) <= 0 && (p.my_watch
                ? <p class="note">{t("ui.watching")} <button class="small" onClick={() => preview("program.unwatch", { watch_id: p.my_watch })}>{t("ui.stop_watching")}</button></p>
                : <NewOnly quiet> <button onClick={() => preview("program.watch", { program_id: p.id, person_id: who })}>{t("ui.watch_place")}</button></NewOnly>)}
            </>}
        </ProgramCard>
      ))}</ul>
    </main>
  );
}
