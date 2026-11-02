import { useEffect, useState } from "preact/hooks";
import { api, lang, me, t, shortTime, usePreview, ProgramCard, placesLeft, type ProgramCardData } from "@kumi/ui";
import { ForWhom } from "./ForWhom.tsx";

type Day = { id: string; starts_at: string; capacity: number; booked: number; offered: number; my_status: string | null; my_offer_until: string | null; my_watch: string | null };
type P = ProgramCardData & { my_status: string | null; my_offer_until: string | null; my_watch: string | null; dates?: Day[] };

export function WhatsOn() {
  const [rows, setRows] = useState<P[] | null>(null), [who, setWho] = useState(me.value!.person.id);
  const [picked, setPicked] = useState<Record<string, string[]>>({});   // signed up per date: the dates ticked, by program
  // For a parent: the programs as one of their juniors would take them (their price, whether they're in).
  const load = () => api<P[]>(who === me.value!.person.id ? "/open-programs" : `/open-programs?for=${who}`).then(setRows);
  const { preview, sheet } = usePreview(() => { setPicked({}); load(); });
  const day = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const tick = (p: string, d: string, on: boolean) => setPicked({ ...picked, [p]: on ? [...(picked[p] ?? []), d] : (picked[p] ?? []).filter((x) => x !== d) });
  useEffect(() => { load(); }, [lang.value, who]);
  return (
    <main>
      <h1>{t("ui.nav_whats_on")}</h1>
      {sheet}
      <ForWhom value={who} onChange={setWho} />
      {rows?.length === 0 && <p>{t("ui.nothing_on")}</p>}
      <ul class="changes">{(rows ?? []).map((p) => (
        <ProgramCard key={p.id} p={p}>
          {p.dates ? <>
            {/* Each date with its own places: tick the ones wanted (a full one goes on its waitlist), or ask to hear when one opens. */}
            <ul class="plain">{p.dates.map((x) => { const left = x.capacity - x.booked - x.offered; return (
              <li>{x.my_offer_until ? <>{day(x.starts_at)} · {t("ui.offer_ends", { time: shortTime(x.my_offer_until) })} · <a href="/places">{t("ui.take_place")}</a></>
                : x.my_status ? <>{day(x.starts_at)} · {x.my_status === "booked" ? t("ui.youre_in") : t("ui.waitlist")}</>
                : <><label class="check"><input type="checkbox" checked={(picked[p.id] ?? []).includes(x.id)} onChange={(e) => tick(p.id, x.id, e.currentTarget.checked)} /> {day(x.starts_at)} · {left > 0 ? t("ui.places_left", { count: left }) : t("ui.date_full")}</label>
                  {left <= 0 && (x.my_watch ? <> <button class="small" onClick={() => preview("program.unwatch", { watch_id: x.my_watch })}>{t("ui.stop_watching")}</button></>
                    : <> <button class="small" onClick={() => preview("program.watch", { program_id: p.id, person_id: who, session_id: x.id })}>{t("ui.watch_place")}</button></>)}</>}</li>); })}</ul>
            {(picked[p.id] ?? []).length > 0 && <button class="primary" onClick={() => preview("enrolment.join_dates", { program_id: p.id, person_id: who, session_ids: picked[p.id] })}>{t("ui.sign_up_dates", { count: picked[p.id]!.length })}</button>}
          </> : p.my_offer_until ? <p class="note">{t("ui.offer_ends", { time: shortTime(p.my_offer_until) })} · <a href="/places">{t("ui.take_place")}</a></p>
            : p.my_status ? <p class="note">{p.my_status === "booked" ? t("ui.youre_in") : t("ui.waitlist")}</p>
            : <>
              <button class="primary" onClick={() => preview("enrolment.join", { program_id: p.id, person_id: who })}>{t("ui.join")}</button>
              {/* Full: besides the waitlist, one message when a place is free to anyone. */}
              {placesLeft(p) <= 0 && (p.my_watch
                ? <p class="note">{t("ui.watching")} <button class="small" onClick={() => preview("program.unwatch", { watch_id: p.my_watch })}>{t("ui.stop_watching")}</button></p>
                : <> <button onClick={() => preview("program.watch", { program_id: p.id, person_id: who })}>{t("ui.watch_place")}</button></>)}
            </>}
        </ProgramCard>
      ))}</ul>
    </main>
  );
}
