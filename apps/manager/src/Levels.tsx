// Levels: what's waiting for staff (a level brought from another app, a review a player asked for, a level that moved a
// lot), every player's level, what staff changed lately, and scores in dispute. Each one in the queue is answered by
// keeping the level (it leaves the queue) or changing it with a reason (players who asked are told either way); a change
// staff made can be undone from the Changes tab, as from Changes. Beside it, how levels work here.
import { useEffect, useState } from "preact/hooks";
import { Skeleton, api, lang, me, t, usePreview, clubTime, EmptyState } from "@kumi/ui";
import type { Key } from "@kumi/i18n";
import { Pager, Tabs } from "./lists.tsx";
import { ScoreCard, type Score } from "./Scores.tsx";
import { FLAG_TONE, queueItems, type QueueAppClaim, type QueueClaim, type QueueItem, type QueueMove, type QueueRequest } from "./levels_queue.ts";
import { ClaimAnswer } from "./LevelClaim.tsx";

/** What the player's other app showed, as they gave it. */
function shown(c: QueueClaim): string {
  const conf = c.conf.reliability !== undefined ? t("level_import.reliability", { pct: c.conf.reliability }) : c.conf.percent !== undefined ? t("level_import.percent", { pct: c.conf.percent })
    : c.conf.wpr ? t("level_import.wpr_conf", { conf: c.conf.wpr }) : c.conf.matches !== undefined ? t("level_import.matches", { count: c.conf.matches }) : "";
  return conf ? `${c.raw}, ${conf}` : String(c.raw);
}
type Rules = { review_days: number; self_adjust_games: number; self_adjust_max: number; import_line: number };
type Q = { requests: QueueRequest[]; moves: QueueMove[]; claims: QueueAppClaim[]; limit: number; days: number; rules: Rules };
type Player = { person_id: string; name: string; level: string; provisional: boolean; floor: string | null; rated_games: number };
type Players = { total: number; page: number; pages: number; per_page: number; rows: Player[] };
type Change = { id: string; person_id: string; name: string; kind: string; before: string | null; after: string | null; at: string; by: string | null; explanation: string; run_id: string | null; undone: boolean; can_undo: boolean };
const TABS = ["review", "players", "changes", "disputes"] as const;
type TabKey = (typeof TABS)[number];
const tabOfHash = (): TabKey => { const h = location.hash.slice(1); return (TABS as readonly string[]).includes(h) ? h as TabKey : "review"; };

/** A level brought from another app, in the queue: the player, then the claim and its answers (LevelClaim.tsx). */
function AppClaim({ item, preview, day }: { item: Extract<QueueItem, { kind: "app" }>; preview: (a: string, i: unknown) => void; day: (iso: string) => string }) {
  const c = item.c, games = c.rated_games !== null ? t("count.rated_games", { count: c.rated_games }) : null;
  return (
    <li class="card level-item">
      <p><span class={`flag ${FLAG_TONE[item.flag]}`}>{t(`ui.level_flag_${item.flag}` as Key)}</span></p>
      <p><a href={`/people/${c.person_id}/level`}><strong>{c.name}</strong></a> <span class="badge muted">{c.level ?? t("ui.no_level_yet")}</span>
        {c.provisional && <span class="meta"> · {t("ui.person_chip_provisional")}</span>}{games && <span class="meta"> · {games}</span>}</p>
      <ClaimAnswer c={c} preview={preview} day={day} />
    </li>
  );
}

function Answer({ item, preview, day }: { item: QueueItem; preview: (a: string, i: unknown) => void; day: (iso: string) => string }) {
  if (item.kind === "app") return <AppClaim item={item} preview={preview} day={day} />;
  return <OtherAnswer item={item} preview={preview} day={day} />;
}

function OtherAnswer({ item, preview, day }: { item: Exclude<QueueItem, { kind: "app" }>; preview: (a: string, i: unknown) => void; day: (iso: string) => string }) {
  const [to, setTo] = useState(""), [reason, setReason] = useState("");
  const personId = item.kind === "move" ? item.m.person_id : item.r.person_id, name = item.kind === "move" ? item.m.name : item.r.name;
  const level = item.kind === "move" ? item.m.level.toFixed(2) : item.r.level;
  const claim = item.kind === "claim" ? item.r.claim : null;
  // Why it's here, in the words the data has: what they brought and when, what they asked, how far it moved.
  const evidence = item.kind === "move" ? t("ui.moved_from", { from: item.m.from.toFixed(2), level: item.m.level.toFixed(2), date: day(item.m.since) })
    : item.kind === "claim" ? (claim!.start_level === null ? t("ui.level_import_claim_staff", { shown: shown(claim!), source: t(`level_source.${claim!.platform}` as Key) })
      : t("ui.level_import_claim", { shown: shown(claim!), source: t(`level_source.${claim!.platform}` as Key), level: claim!.start_level.toFixed(2) }))
    : `${t("ui.asked_on", { date: day(item.r.created_at) })}${item.r.note ? `: "${item.r.note}"` : ""}`;
  const more = item.kind === "claim" ? (item.r.sent_by ? t("ui.claimed_on_by", { date: day(item.r.created_at), by: item.r.sent_by }) : t("ui.claimed_on", { date: day(item.r.created_at) })) : null;
  const games = item.kind !== "move" && item.r.rated_games !== null ? t("count.rated_games", { count: item.r.rated_games }) : null;
  return (
    <li class="card level-item">
      <p><span class={`flag ${FLAG_TONE[item.flag]}`}>{t(`ui.level_flag_${item.flag}` as Key)}</span></p>
      <p><a href={`/people/${personId}/level`}><strong>{name}</strong></a> <span class="badge muted">{level ?? t("ui.no_level_yet")}</span>
        {item.kind !== "move" && item.r.provisional && <span class="meta"> · {t("ui.person_chip_provisional")}</span>}{games && <span class="meta"> · {games}</span>}</p>
      <p class="meta">{evidence}{more && <><br />{more}</>}</p>
      <form class="level-answer" onSubmit={(e) => e.preventDefault()}>
        <label>{t("ui.reason_for_them")}<input value={reason} maxLength={300} onInput={(e) => setReason(e.currentTarget.value)} /></label>
        <label>{t("ui.new_level")}<input type="number" step="0.01" min="0" max="7" value={to} onInput={(e) => setTo(e.currentTarget.value)} /></label>
        <p>
          <button type="button" class="small" disabled={!to || reason.trim().length < 3} onClick={() => preview("level.answer_review", { person_id: personId, outcome: "change", level: Number(to), reason: reason.trim() })}>{t("ui.change_level_to")}</button>{" "}
          {claim && <><button type="button" class="small" disabled={claim.start_level === null && !to}
            onClick={() => preview("level.answer_review", { person_id: personId, outcome: "accept", ...(to ? { level: Number(to) } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) })}>{t("ui.accept_import")}</button>{" "}</>}
          <button type="button" class="small" onClick={() => preview("level.answer_review", { person_id: personId, outcome: "keep", ...(reason.trim() ? { reason: reason.trim() } : {}) })}>{t("ui.keep_level")}</button>
        </p>
        <p class="meta">{t("ui.keep_level_help")}</p>
      </form>
    </li>
  );
}

/** Every player with a level, by name, with a search; each opens their level page (to change it, or set a floor). */
function AllPlayers() {
  const [q, setQ] = useState(""), [page, setPage] = useState(1), [d, setD] = useState<Players | null>(null);
  useEffect(() => { const id = setTimeout(() => { api<Players>(`/staff/levels/players?page=${page}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`).then(setD).catch(() => setD(null)); }, q ? 250 : 0); return () => clearTimeout(id); }, [q, page, lang.value]);
  return (
    <section class="card">
      <label>{t("ui.levels_search")}<input type="search" value={q} maxLength={80} onInput={(e) => { setQ(e.currentTarget.value); setPage(1); }} /></label>
      {!d ? <Skeleton shape="rows" rows={6} /> : !d.rows.length ? <p class="meta">{t("ui.levels_no_players")}</p> : <>
        <ul class="plain">{d.rows.map((p) => <li class="row" key={p.person_id}><a href={`/people/${p.person_id}/level`}>{p.name}</a>
          <span class="meta"><strong>{p.level}</strong>{p.provisional ? ` · ${t("ui.person_chip_provisional")}` : ""}{p.floor ? ` · ${t("ui.floor", { floor: p.floor })}` : ""} · {t("count.rated_games", { count: p.rated_games })}</span></li>)}</ul>
        <Pager page={d.page} pages={d.pages} go={setPage} shown={d.rows.length} total={d.total} per={d.per_page} />
      </>}
    </section>
  );
}

/** What a change did, in a line: a level kept on a review, a floor set, a level set (from none, or from one to another). */
const changeText = (c: Change) => c.kind === "kept" ? t("ui.level_change_kept", { name: c.name, level: c.after ?? t("ui.no_level_yet") })
  : c.kind === "floor" ? t("ui.level_change_floor", { name: c.name })
  : t(c.before === null ? "ui.level_change_new" : "ui.level_change_moved", { name: c.name, before: c.before ?? "", after: c.after ?? "" });

/** One change staff made: who, what, when and why (the words the player saw), and Undo while it can be. */
function ChangeRow({ c, preview, day }: { c: Change; preview: (a: string, i: unknown) => void; day: (iso: string) => string }) {
  const what = changeText(c);
  return (
    <li class="row">
      <span><a href={`/people/${c.person_id}/level`}>{what}</a><br /><span class="meta">{[day(c.at), c.by, c.undone ? t("ui.status_undone") : null].filter(Boolean).join(" · ")}</span>
        {c.explanation && <><br /><span class="meta">{c.explanation}</span></>}</span>
      {c.can_undo && c.run_id && <button type="button" class="small" onClick={() => preview("action.undo", { run_id: c.run_id })}>{t("ui.undo")}</button>}
    </li>
  );
}

/** How levels work here, from the numbers the club's rules run on (the same ones the server uses). */
function HowLevelsWork({ q }: { q: Q }) {
  const r = q.rules;
  const rules = [
    ["ui.level_rule_rated_k", "ui.level_rule_rated", {}], ["ui.level_rule_friendly_k", "ui.level_rule_friendly", {}], ["ui.level_rule_new_k", "ui.level_rule_new", {}],
    ["ui.level_rule_self_k", "ui.level_rule_self", { max: r.self_adjust_max.toFixed(2), games: r.self_adjust_games }],
    ["ui.level_rule_review_k", "ui.level_rule_review", { days: r.review_days }], ["ui.level_rule_moves_k", "ui.level_rule_moves", { limit: q.limit.toFixed(2), days: q.days }],
    ["ui.level_rule_floor_k", "ui.level_rule_floor", {}], ["ui.level_rule_import_k", "ui.level_rule_import", { games: r.self_adjust_games, line: r.import_line.toFixed(2) }],
    ["ui.level_rule_changes_k", "ui.level_rule_changes", {}],
  ] as const;
  return (
    <section class="card">
      <h2>{t("ui.level_rules_title")}</h2>
      <dl class="level-rules">{rules.map(([k, w, v]) => <div><dt>{t(k)}</dt><dd>{t(w, v)}</dd></div>)}</dl>
    </section>
  );
}

export function Levels() {
  const [q, setQ] = useState<Q | null>(null), [changes, setChanges] = useState<Change[] | null>(null), [disputes, setDisputes] = useState<Score[] | null>(null);
  const loadChanges = () => api<Change[]>("/staff/levels/changes").then(setChanges).catch(() => setChanges(null));
  const loadDisputes = () => api<Score[]>("/staff/scores").then((r) => setDisputes(r.filter((s) => s.status === "disputed"))).catch(() => setDisputes(null));
  const load = () => { void loadChanges(); void loadDisputes(); return api<Q>("/staff/levels").then(setQ); };
  const { preview, sheet } = usePreview(load);
  useEffect(() => { void load(); }, [lang.value]);
  const [tab, setTabNow] = useState<TabKey>(() => tabOfHash());
  useEffect(() => { const on = () => setTabNow(tabOfHash()); addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, []);
  const setTab = (k: string) => { setTabNow(k as TabKey); history.replaceState(history.state, "", `${location.pathname}${location.search}#${k}`); };
  if (!q) return <Skeleton />;
  const day = (iso: string) => clubTime(iso, { dateStyle: "medium" });
  const items = queueItems(q);
  const areas = me.value?.areas ?? null, programs = areas ? areas.includes("programs") : true;
  const tabs: [string, string][] = [["review", t("count.levels_review", { count: items.length })], ["players", t("ui.levels_tab_players")], ["changes", t("ui.levels_tab_changes")],
    ["disputes", disputes?.length ? t("count.levels_disputes", { count: disputes.length }) : t("ui.levels_tab_disputes")]];
  return (
    <main>
      <div class="page-head">
        <div><h1>{t("ui.nav_levels")}</h1><p class="meta">{t("ui.levels_lead")}</p></div>
        <p class="page-actions">
          {programs && <a class="button small" href="/programs">{t("ui.levels_level_group")}</a>}{" "}
          <button type="button" class="small primary" onClick={() => setTab("players")}>{t("ui.levels_change_one")}</button>
        </p>
      </div>
      {sheet}
      <div class="levels-layout">
        <div>
          <Tabs label={t("ui.nav_levels")} tabs={tabs} on={tab} pick={setTab} id="levels" />
          <div role="tabpanel" tabIndex={0} id={`levels-panel-${tab}`} aria-labelledby={`levels-tab-${tab}`} class="tab-panel">
            {tab === "review" && (!items.length ? <EmptyState art="all-done" size="s" class="meta">{t("ui.queue_empty")}</EmptyState>
              : <ul class="plain">{items.map((x) => <Answer key={x.key} item={x} preview={preview} day={day} />)}</ul>)}
            {tab === "players" && <AllPlayers />}
            {tab === "changes" && <section class="card">{!changes ? <Skeleton shape="rows" /> : !changes.length ? <p class="meta">{t("ui.level_changes_none")}</p>
              : <ul class="plain">{changes.map((c) => <ChangeRow key={c.id} c={c} preview={preview} day={day} />)}</ul>}</section>}
            {tab === "disputes" && (!disputes ? <Skeleton shape="card" /> : !disputes.length ? <p class="card meta">{t("ui.levels_no_disputes")}</p>
              : <>{disputes.map((s) => <ScoreCard key={s.id} s={s} send={preview} />)}<p class="meta">{t("ui.levels_disputes_help")}</p></>)}
          </div>
        </div>
        <aside>
          <HowLevelsWork q={q} />
          {changes && changes.length > 0 && <section class="card">
            <h2>{t("ui.level_recent_title")}</h2>
            <ul class="plain">{changes.slice(0, 5).map((c) => <li><span class="meta">{[day(c.at), c.by].filter(Boolean).join(" · ")}</span><br />
              {changeText(c)}</li>)}</ul>
            <p><button type="button" class="link" onClick={() => setTab("changes")}>{t("ui.level_recent_all")}</button></p>
          </section>}
        </aside>
      </div>
    </main>
  );
}
