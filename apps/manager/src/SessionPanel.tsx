// A program date picked on the Schedule: its places and who's waiting, its level and price, the dates of its series,
// and who's coming with how each place stands, with three things to do: check everyone in (once it starts, as the
// roster does), message its players (a service message to everyone with a place on it, previewed like any other),
// and open the program to edit the series. The server decides what each reader sees (reads.ts): names for those who
// read people and a coach on their own date, how each place was paid only for money readers, and nothing at all for a
// role that runs courts without programs (the side panel then says only what the grid says).
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { formatLocale } from "@kumi/i18n/format";
import { api, club, dollars, lang, mayDo, t } from "@kumi/ui";

type Pay = "paid" | "pass" | "credit" | "membership" | "free" | "unpaid";
type Panel = { money: boolean; session: { id: string; program_id: string; name: string; start: string; cancelled: boolean };
  places: number; booked: number; waiting: number; level_min: string | null; level_max: string | null; price_cents?: number; member_price_cents?: number | null;
  series: { first: string | null; last: string | null; dates: number }; marking: { open: boolean; until: string };
  players: { person_id: string; name: string; came: boolean | null; pay?: Pay; waitlist?: number }[] };

export function SessionPanel({ sessionId, tz, preview, stamp }: { sessionId: string; tz: string; preview: (action: string, input: unknown) => Promise<void>; stamp?: string }) {
  const [d, setD] = useState<Panel | null | false>(null), [writing, setWriting] = useState(false);
  useEffect(() => { setD(null); api<Panel>(`/staff/sessions/${sessionId}/panel`).then(setD).catch(() => setD(false)); }, [sessionId, stamp, lang.value]);
  // A role that doesn't read programs (or another coach's date): nothing more than the grid already says.
  if (d === false) return null;
  if (!d) return <p class="meta">{t("ui.loading")}</p>;
  const day = (iso: string) => new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: tz, day: "numeric", month: "short" }).format(new Date(iso));
  const coming = d.players.filter((p) => p.waitlist === undefined);
  const notIn = coming.filter((p) => p.came !== true);
  const status = (p: Panel["players"][number]) => p.waitlist !== undefined ? <span class="meta">{t("ui.pay_waitlist", { n: p.waitlist })}</span>
    : p.pay ? <span class={p.pay === "unpaid" ? "pay-no" : "pay-ok"}>{t(`ui.pay_${p.pay}` as Key)}</span> : null;
  return (
    <div class="sp">
      <dl class="sp-facts">
        <dt>{t("ui.players_title")}</dt><dd>{t("ui.sp_places_taken", { booked: d.booked, places: d.places })}{d.waiting > 0 && ` · ${t("ui.waitlist_count", { count: d.waiting })}`}</dd>
        {d.money && d.price_cents !== undefined && <><dt>{t("ui.sp_price")}</dt><dd>{dollars(d.price_cents, lang.value)}
          {d.member_price_cents != null && d.member_price_cents < d.price_cents ? ` · ${t("ui.sp_member_price", { amount: dollars(d.member_price_cents, lang.value) })}` : ""}</dd></>}
        {(d.level_min || d.level_max) && <><dt>{t("ui.level")}</dt><dd>{t("ui.sp_level_band", { from: Number(d.level_min ?? 0).toFixed(2), to: Number(d.level_max ?? 7).toFixed(2) })}</dd></>}
        {d.series.first && d.series.last && d.series.dates > 1 && <><dt>{t("ui.sp_series")}</dt><dd>{t("ui.sp_series_span", { count: d.series.dates, from: day(d.series.first), to: day(d.series.last) })}</dd></>}
      </dl>
      {d.players.length === 0 ? <p class="meta">{t("ui.no_players_session")}</p> : <ul class="plain sp-roster">{d.players.map((p) => (
        <li class="row"><span>{p.name}{p.came === true ? <span class="meta"> · {t("ui.came")}</span> : p.came === false ? <span class="meta"> · {t("ui.not_came")}</span> : null}</span>{status(p)}</li>))}</ul>}
      <div class="chips">
        {mayDo("attendance.mark") && !d.session.cancelled && d.marking.open && notIn.length > 0 &&
          <button class="small" onClick={() => preview("attendance.mark", { session_id: d.session.id, marks: notIn.map((p) => ({ person_id: p.person_id, came: true })) })}>{t("ui.sp_check_in_all")}</button>}
        {mayDo("broadcast.send") && !d.session.cancelled && coming.length > 0 && <button class="small" aria-expanded={writing} onClick={() => setWriting(!writing)}>{t("ui.sp_message")}</button>}
        {(mayDo("series.edit") || mayDo("program.set_prices")) && <a class="small" href={`/programs/${d.session.program_id}`}>{t("ui.sp_edit_series")}</a>}
      </div>
      {mayDo("attendance.mark") && !d.session.cancelled && !d.marking.open && coming.length > 0 && <p class="meta">{t("ui.sp_check_in_later")}</p>}
      {writing && <Message sessionId={d.session.id} preview={preview} />}
    </div>
  );
}

/** A service message to this date's players, in each of the club's languages: the preview says who it reaches (juniors
 *  through their parents), and it goes the way every message goes (consent, quiet hours, practice mode). */
function Message({ sessionId, preview }: { sessionId: string; preview: (action: string, input: unknown) => Promise<void> }) {
  const langs = (["en", "es"] as const).filter((l) => (club.value?.languages ?? ["en"]).includes(l));
  const [w, setW] = useState<Record<string, string>>({});
  const send = (e: Event) => {
    e.preventDefault();
    const words = Object.fromEntries(langs.flatMap((l) => [[`subject_${l}`, (w[`subject_${l}`] ?? "").trim() || null], [`body_${l}`, (w[`body_${l}`] ?? "").trim() || null]]));
    void preview("broadcast.send", { purpose: "service", filters: { session_id: sessionId }, ...words });
  };
  return (
    <form class="card-form" onSubmit={send}>
      <p class="meta">{t("ui.sp_message_help")}</p>
      {langs.map((l) => <>
        <label>{t("ui.subject_in", { lang: t(l === "en" ? "lang.word_en" : "lang.word_es") })}<input maxLength={150} value={w[`subject_${l}`] ?? ""} onInput={(e) => setW({ ...w, [`subject_${l}`]: e.currentTarget.value })} /></label>
        <label>{t("ui.message_in", { lang: t(l === "en" ? "lang.word_en" : "lang.word_es") })}<textarea rows={4} maxLength={5000} value={w[`body_${l}`] ?? ""} onInput={(e) => setW({ ...w, [`body_${l}`]: e.currentTarget.value })} /></label>
      </>)}
      <button class="primary" disabled={langs.some((l) => !(w[`subject_${l}`] ?? "").trim() || !(w[`body_${l}`] ?? "").trim())}>{t("ui.preview")}</button>
    </form>
  );
}
