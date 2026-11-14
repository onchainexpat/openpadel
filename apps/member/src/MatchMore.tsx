// A match's page, beyond its facts (Play.tsx): the teams card (fair teams and as joined, each side's chance to win,
// the organiser's choice) and About this match. Loaded with the match's page, so their words stay off the first screen.
import { dollars, lang, me, t } from "@kumi/ui";
import { formatLocale } from "@kumi/i18n/format";
import { initials } from "./whats_on.ts";
import type { Match, Side } from "./Play.tsx";

/** The teams card: two teams and each side's chance to win. The organiser uses the fair teams or keeps them as joined
 *  (the usual preview); either way two players who came together stay together. With three in, the teams if I join. */
export function Teams({ m, preview }: { m: Match; preview: (a: string, i: unknown) => Promise<void> }) {
  const mt = m.match_teams!, pid = me.value!.person.id, shown = mt.pick === "joined" ? mt.joined : mt.fair;
  const who = (p: Side["a"][number]) => `${p.name}${p.person_id === pid ? ` (${t("ui.you_label")})` : ""}`;
  const names = (x: Side["a"]) => x.map((p) => p.name).join(" & ");
  const team = (x: Side["a"]) => <ul class="plain team">{x.map((p) => <li><span class={p.person_id === pid ? "avatar me" : "avatar"} aria-hidden="true">{initials(p.name)}</span><span>{who(p)}{p.level !== null ? <span class="meta"> {p.level.toFixed(2)}</span> : null}</span></li>)}</ul>;
  return (
    <section class={mt.pick ? "card teams-card chosen" : "card teams-card"} aria-labelledby="teams-title">
      <div class="section-head"><h2 id="teams-title">{t(mt.if_join ? "ui.teams_if_join" : mt.pick ? "ui.teams_title" : "ui.teams_suggested")}</h2>
        {Math.abs(shown.a_chance - 50) <= 5 && <span class="tag fit-great">{t("ui.teams_even")}</span>}</div>
      <div class="teams">{team(shown.a)}<span class="vs" aria-hidden="true">{t("ui.versus")}</span>{team(shown.b)}</div>
      <p class="chance"><span class="meta">{t("ui.chance_to_win")}</span><strong>{shown.a_chance}%</strong><strong>{shown.b_chance}%</strong></p>
      <div class="odds" aria-hidden="true"><span style={{ width: `${shown.a_chance}%` }} /></div>
      <p class="meta">{mt.same ? t("ui.teams_same") : mt.pick !== "joined" ? t("ui.teams_as_joined_odds", { a: names(mt.joined.a), b: names(mt.joined.b), x: mt.joined.a_chance, y: mt.joined.b_chance }) : ""} {t("ui.teams_pairs_rule")}</p>
      {mt.can_pick && !mt.same && <div class="seg-buttons" role="group" aria-labelledby="teams-title">
        <button type="button" class={mt.pick !== "joined" ? "on" : undefined} aria-pressed={mt.pick === "fair"} onClick={() => preview("booking.set_teams", { booking_id: m.id, teams: "fair" })}>{t("ui.teams_use")}</button>
        <button type="button" class={mt.pick === "joined" ? "on" : undefined} aria-pressed={mt.pick === "joined"} onClick={() => preview("booking.set_teams", { booking_id: m.id, teams: "joined" })}>{t("ui.teams_keep_joined")}</button>
      </div>}
      {!mt.can_pick && mt.pick && <p class="meta">{t(mt.pick === "joined" ? "ui.teams_picked_joined" : "ui.teams_picked_fair")}</p>}
    </section>
  );
}

/** About this match: one place each, who can join, what a place costs and when it's charged, what happens if it
 *  doesn't fill, and what comes back to someone who can't make it late. Each line from the match's own facts. */
export function AboutMatch({ m }: { m: Match }) {
  const time = new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: m.time_zone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(m.full_by));
  const p = { min: Number(m.level_min).toFixed(2), max: Number(m.level_max).toFixed(2) };
  return (
    <section class="card" aria-labelledby="about-match">
      <h2 id="about-match">{t("ui.about_match")}</h2>
      <ul class="about-list">
        <li>{t("ui.about_one_place")}</li>
        <li>{t(m.outside_band === "closed" ? "ui.about_levels_closed" : "ui.about_levels_ask", p)}</li>
        <li>{t("ui.about_money", { price: dollars(m.share_cents, lang.value), time })}</li>
        {m.late && <li>{t("ui.about_late", m.late)}</li>}
      </ul>
    </section>
  );
}
