import { useEffect, useState } from "preact/hooks";
import { api, lang, me, t, shortTime, usePreview, ProgramCard, placesLeft, type ProgramCardData } from "@kumi/ui";
import { ForWhom } from "./ForWhom.tsx";

type P = ProgramCardData & { my_status: string | null; my_offer_until: string | null; my_watch: string | null };

export function WhatsOn() {
  const [rows, setRows] = useState<P[] | null>(null), [who, setWho] = useState(me.value!.person.id);
  // For a parent: the programs as one of their juniors would take them (their price, whether they're in).
  const load = () => api<P[]>(who === me.value!.person.id ? "/open-programs" : `/open-programs?for=${who}`).then(setRows);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, [lang.value, who]);
  return (
    <main>
      <h1>{t("ui.nav_whats_on")}</h1>
      {sheet}
      <ForWhom value={who} onChange={setWho} />
      {rows?.length === 0 && <p>{t("ui.nothing_on")}</p>}
      <ul class="changes">{(rows ?? []).map((p) => (
        <ProgramCard key={p.id} p={p}>
          {p.my_offer_until ? <p class="note">{t("ui.offer_ends", { time: shortTime(p.my_offer_until) })} · <a href="/places">{t("ui.take_place")}</a></p>
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
