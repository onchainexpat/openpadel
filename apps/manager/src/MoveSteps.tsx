import { useEffect, useState } from "preact/hooks";
import { Illustration, Skeleton, api, clubMoment, clubTime, dollars, lang, mayDo, me, t, usePreview } from "@kumi/ui";
import type { Key } from "@kumi/i18n";
import { around, MOVE_STEPS, stepMarks, type Step } from "./move_steps.ts";

type Source = "playtomic" | "playbypoint" | "courtreserve" | "spreadsheet";
type Check = { key: string; step: Step; who: "you" | "both"; done: boolean; at: string | null; by: string | null; text: string };
type Seen = { key: string; step: Step; done: boolean; detail: string | null; text: string };
type Row = { what: "members" | "bookings" | "memberships" | "credit"; theirs: number | null; ours: number; money: boolean; result: "match" | "differs" | "not_yet" | "only_ours" };
type Steps = {
  source: Source | null; step: Step; switch_at: string | null; finished_at: string | null; checks: Check[]; seen: Seen[]; practice: boolean;
  connect: { has_keys: boolean; mirror: { last_ok_at: string | null; last_sync_at: string | null; failed: boolean } | null; players_read_at: string | null;
    upload: { file_name: string | null; rows: number; at: string } | null; imports: number; imported_at: string | null };
  review: { people: number; levels: number; linked_courts: number; unlinked_courts: number; players: number; credit_cents: number; credit_people: number; memberships: number;
    wallets_brought_at: string | null; wallets_zeroed_at: string | null };
  practice_run: { compare: Row[]; totals_from: "playtomic" | "file" | null; totals_read_at: string | null; unreadable: number; differences: number | null; checked_at: string;
    last_copy_at: string | null; copy_failed: boolean };
  wrap_up: { people: number; signed_in: number; booked_here: number | null; credit_cents: number; credit_people: number };
  /** From CourtReserve or Playbypoint: the files read, and what came over from them (move_files.ts). */
  files: { uploads: Record<"people" | "bookings" | "programs", { file_name: string | null; rows: number; at: string; lines_left: number } | null>;
    brought: { people_linked: number; credit_cents: number; credit_people: number; memberships: number; bookings: number; places: number } } | null;
};

const SOURCES: Source[] = ["playtomic", "courtreserve", "playbypoint", "spreadsheet"];
/** The sources whose files openPadel reads step by step (MoveFiles.tsx). */
const FILES = (x: Source | null): x is "courtreserve" | "playbypoint" => x === "courtreserve" || x === "playbypoint";

/** Moving in, guided (move_in.ts): five steps from the old system to openPadel, each tying together the pages that
 *  do the work (Customers import, Playtomic, Moving in: wallets and memberships). The step the club is on, its source,
 *  the switch-over time and the items staff tick are the club's, changed by previewed actions (move.*); any step can be
 *  looked at without moving the club to it. The owner and managers. */
export function MoveSteps() {
  const [s, setS] = useState<Steps | null>(null), [failed, setFailed] = useState<string | null>(null), [view, setView] = useState<Step | null>(null), [when, setWhen] = useState("");
  const load = () => api<Steps>("/staff/move-in/steps").then((x) => { setS(x); setFailed(null); }).catch((e: Error) => setFailed(e.message));
  const { preview, sheet } = usePreview(() => { setView(null); return load(); });
  useEffect(() => { load(); }, [lang.value]);
  const allowed = me.value?.can ? mayDo("move.step") : (me.value?.roles ?? []).some((r) => r.key === "owner" || r.key === "manager");
  if (!allowed) return <main class="card"><p>{t("ui.not_for_your_role")}</p></main>;
  if (failed) return <main class="card"><p class="error" role="alert">{failed}</p></main>;
  if (!s) return <Skeleton />;
  const fmt = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
  const shown = view ?? s.step, at = MOVE_STEPS.indexOf(s.step), from = t(`move.from_${s.source ?? "spreadsheet"}` as Key);
  const go = (step: Step) => preview("move.step", { step });
  const { back, next, nextMoves } = around(shown, s.step);
  const tick = (c: Check) => preview("move.check", { item: c.key, done: !c.done });
  const items = (step: Step) => {
    const seen = s.seen.filter((x) => x.step === step), mine = s.checks.filter((x) => x.step === step);
    const done = seen.filter((x) => x.done).length + mine.filter((x) => x.done).length, all = seen.length + mine.length;
    return <>
      <p class="meta" role="status">{t("ui.moving_done_of", { done, all })}</p>
      <ul class="plain move-checks">
        {seen.map((x) => <li class={x.done ? "done" : ""}><span class="move-mark" aria-hidden="true">{x.done ? "✓" : ""}</span>
          <span>{x.text} <span class="flag info">{t("ui.moving_who_openpadel")}</span>{x.detail && <span class="meta"> {x.detail}</span>}
            <span class="sr-only">{x.done ? t("ui.moving_done") : t("ui.moving_not_done")}</span></span></li>)}
        {mine.map((x) => <li class={x.done ? "done" : ""}><label class="check"><input type="checkbox" checked={x.done} onChange={(e) => { e.currentTarget.checked = x.done; tick(x); }} />
          <span>{x.text} <span class={x.who === "you" ? "flag warn" : "flag"}>{t(x.who === "you" ? "ui.moving_who_you" : "ui.moving_who_both")}</span>
            {x.done && x.at && <span class="meta"> {t("ui.moving_ticked", { who: x.by ?? "-", when: fmt(x.at) })}</span>}</span></label></li>)}
      </ul>
    </>;
  };
  const nav = (nextLabel?: string) => (
    <div class="page-actions">
      {back && <button type="button" onClick={() => setView(back)}>{t("ui.moving_back_to", { step: t(`move.step_${back}` as Key) })}</button>}
      {/* Looking at a step the club isn't on yet: moving the club there is a change of its own, previewed. */}
      {shown !== s.step && <button type="button" onClick={() => go(shown)}>{t("ui.moving_make_current", { step: t(`move.step_${shown}` as Key) })}</button>}
      {next && <button type="button" class="primary" disabled={!s.source} onClick={() => (nextMoves ? go(next) : setView(next))}>
        {nextLabel ?? t("ui.moving_go_on", { step: t(`move.step_${next}` as Key) })}</button>}
    </div>);
  const result = (r: Row) => r.result === "match" ? <span class="flag">{t("ui.moving_match")}</span> : r.result === "not_yet" ? <span class="flag info">{t("ui.moving_not_yet")}</span>
    : r.result === "only_ours" ? <span class="meta">-</span> : <span class="flag warn">{t("ui.moving_differs")}</span>;
  const num = (r: Row, n: number | null) => n === null ? "-" : r.money ? dollars(n, lang.value) : String(n);

  return (
    <main>
      <div class="page-head">
        <div><h1>{t("ui.moving_title")}</h1><p class="meta">{t("ui.moving_intro")}</p></div>
        <div class="chips">
          <span class="count-chip">{t("ui.moving_read_only")}</span>
          {s.finished_at ? <span class="count-chip">{t("ui.moving_finished_on", { when: fmt(s.finished_at) })}</span>
            : <span class="count-chip">{t("ui.moving_step_of", { n: at + 1 })}</span>}
        </div>
      </div>
      {sheet}
      <ol class="move-steps" aria-label={t("ui.moving_steps")}>
        {stepMarks(s.step, Boolean(s.finished_at)).map((x) => (
          <li class={x.state}>
            <button type="button" aria-current={x.step === s.step ? "step" : undefined} aria-pressed={x.step === shown} onClick={() => setView(x.step)}>
              <span class="move-dot" aria-hidden="true">{x.mark}</span> {t(`move.step_${x.step}` as Key)}</button></li>))}
      </ol>

      {shown === "connect" && <>
        <section class="card">
          {!s.source && <Illustration name="moving-in" size="s" class="move-art" />}
          <h2>{t("ui.moving_where")}</h2>
          <div class="move-sources" role="radiogroup" aria-label={t("ui.moving_where")}>
            {SOURCES.map((x) => <button type="button" role="radio" aria-checked={s.source === x} class={s.source === x ? "move-source on" : "move-source"}
              onClick={() => s.source !== x && preview("move.source", { source: x })}>
              <strong>{t(`ui.moving_source_${x}` as Key)}</strong><span class="meta">{t(`ui.moving_source_${x}_how` as Key)}</span></button>)}
          </div>
        </section>
        {s.source && <section class="card">
          <h2>{t("ui.moving_what_comes", { from })}</h2>
          {(["comes", "file", "never"] as const).map((g) => <>
            <h3>{t(`ui.moving_group_${g}` as Key)}</h3>
            <ul>{t(`ui.moving_${s.source}_${g}` as Key).split("\n").map((line) => <li>{line}</li>)}</ul></>)}
          {FILES(s.source) && <p class="note">{t(`ui.moving_${s.source}_unverified` as Key)}</p>}
        </section>}
        {s.source === "playtomic" && <section class="card">
          <h2>{t("ui.moving_keys")}</h2>
          <p class="meta">{t("ui.moving_keys_help")}</p>
          <ul class="plain">{["KUMI_PLAYTOMIC_CLIENT_ID", "KUMI_PLAYTOMIC_SECRET", "KUMI_PLAYTOMIC_TENANT_ID"].map((name) =>
            <li class="row"><code>{name}</code><span class={s.connect.has_keys ? "flag" : "flag warn"}>{t(s.connect.has_keys ? "ui.moving_key_there" : "ui.moving_key_missing")}</span></li>)}</ul>
          <p>{!s.connect.mirror ? t("ui.mirror_off") : s.connect.mirror.failed ? t("ui.mirror_failed", { when: fmt(s.connect.mirror.last_sync_at!) }) : t("ui.mirror_ok", { when: fmt(s.connect.mirror.last_sync_at!) })}</p>
          <div class="page-actions"><button type="button" onClick={load}>{t("ui.moving_check_again")}</button><a class="button" href="/playtomic">{t("ui.moving_open_playtomic")}</a></div>
        </section>}
        {s.source && <section class="card">
          <h2>{t("ui.moving_files")}</h2>
          <p class="meta">{t(`ui.moving_files_${s.source}` as Key)}</p>
          {s.connect.imports > 0 && <p>{t("count.moving_imports", { count: s.connect.imports })}{s.connect.imported_at && ` ${t("ui.moving_last_at", { when: fmt(s.connect.imported_at) })}`}</p>}
          {s.source === "playtomic" && s.connect.upload && <p>{t("ui.movein_upload_read", { name: s.connect.upload.file_name ?? "CSV", when: fmt(s.connect.upload.at), by: "-", players: t("count.movein_rows", { count: s.connect.upload.rows }) })}</p>}
          {FILES(s.source) && s.files && (["people", "bookings", "programs"] as const).map((k) => s.files!.uploads[k] &&
            <p>{t("ui.move_files_read", { name: s.files!.uploads[k]!.file_name ?? "CSV", when: fmt(s.files!.uploads[k]!.at), by: "-", rows: t("count.move_rows", { count: s.files!.uploads[k]!.rows }) })}</p>)}
          <div class="page-actions">
            {FILES(s.source) ? <a class="button primary" href={`/settings/moving-in/${s.source}`}>{t("ui.move_files_open", { from })}</a>
              : <a class="button" href="/people?import=1">{t("ui.moving_import_members")}</a>}
            {/* Playbypoint's users list still brings levels (NPRP) in through Customers' import. */}
            {s.source === "playbypoint" && <a class="button" href="/people?import=playbypoint">{t("ui.moving_import_members")}</a>}
            {s.source === "playtomic" && <a class="button" href="/playtomic/move-in">{t("ui.movein_link")}</a>}
          </div>
        </section>}
        <section class="card">
          <h2>{t("ui.moving_safe")}</h2>
          <ul>{t("ui.moving_safe_list").split("\n").map((line) => <li>{line}</li>)}</ul>
          {nav()}
        </section>
      </>}

      {shown === "review" && <section class="card">
        <h2>{t("ui.moving_ready")}</h2>
        <ul class="plain move-list">
          <li class="row"><span>{t("count.moving_people", { count: s.review.people })}</span><a href="/people">{t("ui.moving_see")}</a></li>
          <li class="row"><span>{t("count.moving_levels", { count: s.review.levels })}</span><a href="/levels">{t("ui.moving_see")}</a></li>
          {s.source === "playtomic" && <>
            <li class="row"><span>{t("count.moving_courts_linked", { count: s.review.linked_courts })}{s.review.unlinked_courts > 0 && <> <span class="flag warn">{t("count.moving_courts_unlinked", { count: s.review.unlinked_courts })}</span></>}</span>
              <a href="/playtomic">{t("ui.moving_see")}</a></li>
            <li class="row"><span>{t("count.moving_players_read", { count: s.review.players })}</span><a href="/playtomic/move-in">{t("ui.moving_see")}</a></li>
            <li class="row"><span>{s.review.wallets_brought_at ? t("ui.movein_credit_so_far", { amount: dollars(s.review.credit_cents, lang.value), people: t("count.people", { count: s.review.credit_people }) }) : t("ui.moving_credit_not_yet")}</span>
              <a href="/playtomic/move-in">{t("ui.moving_see")}</a></li>
            <li class="row"><span>{t("count.movein_kept", { count: s.review.memberships })}</span><a href="/playtomic/move-in">{t("ui.moving_see")}</a></li>
          </>}
          {FILES(s.source) && s.files && <>
            <li class="row"><span>{t("count.movein_kept", { count: s.files.brought.memberships })}</span><a href={`/settings/moving-in/${s.source}`}>{t("ui.moving_see")}</a></li>
            <li class="row"><span>{t("ui.movein_credit_so_far", { amount: dollars(s.files.brought.credit_cents, lang.value), people: t("count.people", { count: s.files.brought.credit_people }) })}</span>
              <a href={`/settings/moving-in/${s.source}`}>{t("ui.moving_see")}</a></li>
            <li class="row"><span>{t("count.move_files_bookings", { count: s.files.brought.bookings })}</span><a href="/bookings">{t("ui.moving_see")}</a></li>
            <li class="row"><span>{t("count.move_files_places", { count: s.files.brought.places })}</span><a href="/programs">{t("ui.moving_see")}</a></li>
          </>}
        </ul>
        <h3>{t("ui.moving_group_never")}</h3>
        <ul>{t(`ui.moving_${s.source ?? "spreadsheet"}_never` as Key).split("\n").map((line) => <li>{line}</li>)}</ul>
        {nav()}
      </section>}

      {shown === "practice" && <>
        <section class="card">
          <p><span class={s.practice ? "flag" : "flag warn"}>{t(s.practice ? "ui.moving_practice_on" : "ui.moving_practice_off")}</span></p>
          <p class="meta">{t(s.practice ? "ui.moving_practice_on_help" : "ui.moving_practice_off_help")}</p>
        </section>
        <section class="card">
          <h2>{t("ui.moving_match_title")}</h2>
          <p class="meta">{t("ui.moving_checked_at", { when: fmt(s.practice_run.checked_at) })} <button type="button" class="link" onClick={load}>{t("ui.moving_check_now")}</button></p>
          <div class="table-scroll"><table class="stack">
            <thead><tr><th>{t("ui.moving_what")}</th><th>{from}</th><th>{t("ui.moving_here")}</th><th>{t("ui.moving_result")}</th></tr></thead>
            <tbody>{s.practice_run.compare.map((r) => <tr><th scope="row">{t(`ui.moving_row_${r.what}` as Key)}</th><td>{num(r, r.theirs)}</td><td>{num(r, r.ours)}</td><td>{result(r)}</td></tr>)}</tbody>
          </table></div>
          {s.practice_run.totals_from && s.practice_run.totals_read_at && <p class="meta">{t(s.practice_run.totals_from === "file" ? "ui.moving_totals_file" : "ui.moving_totals_playtomic", { when: fmt(s.practice_run.totals_read_at) })}</p>}
          {s.practice_run.unreadable > 0 && <p class="meta">{t("count.moving_unreadable", { count: s.practice_run.unreadable })}</p>}
          {s.review.wallets_zeroed_at && <p class="meta">{t("ui.moving_credit_zeroed")}</p>}
          {s.practice_run.differences !== null && <p>{s.practice_run.differences ? t("count.moving_differences", { count: s.practice_run.differences }) : t("ui.moving_no_differences")} <a href="/playtomic">{t("ui.moving_see")}</a></p>}
          {s.source === "playtomic" && <p class="meta">{!s.practice_run.last_copy_at ? t("ui.mirror_off") : s.practice_run.copy_failed ? t("ui.moving_copy_failed") : t("ui.moving_last_copy", { when: fmt(s.practice_run.last_copy_at) })}</p>}
          {nav(t("ui.moving_plan_switch"))}
        </section>
      </>}

      {shown === "switch" && <>
        <section class="card">
          <h2>{t("ui.moving_switch_time")}</h2>
          <p>{s.switch_at ? fmt(s.switch_at) : t("ui.moving_switch_none")}</p>
          <p class="meta">{t("ui.moving_switch_help")}</p>
          <form class="row" onSubmit={(e) => { e.preventDefault(); const m = clubMoment(when); if (m) preview("move.switch_at", { at: m }); }}>
            <label>{t("ui.moving_switch_pick")}<input type="datetime-local" required value={when} onInput={(e) => setWhen(e.currentTarget.value)} /></label>
            <button>{t("ui.preview")}</button>
            {s.switch_at && <button type="button" onClick={() => preview("move.switch_at", { at: null })}>{t("ui.moving_switch_clear")}</button>}
          </form>
        </section>
        <section class="card">
          <h2>{t("ui.moving_switch_list")}</h2>
          <p class="meta">{t("ui.moving_switch_list_help", { from })}</p>
          {items("switch")}
          <p class="meta">{t("ui.moving_no_invite")}</p>
          {nav()}
        </section>
      </>}

      {shown === "wrap_up" && <>
        <section class="card">
          <dl class="money-figures">
            <div><dt>{t("ui.moving_tile_signed_in")}</dt><dd>{t("ui.moving_of", { n: s.wrap_up.signed_in, all: s.wrap_up.people })}</dd></div>
            {s.wrap_up.booked_here !== null && <div><dt>{t("ui.moving_tile_booked")}</dt><dd>{s.wrap_up.booked_here}</dd></div>}
            {s.source === "playtomic" && <div><dt>{t("ui.moving_tile_credit")}</dt><dd>{dollars(s.wrap_up.credit_cents, lang.value)}</dd></div>}
            {FILES(s.source) && s.files && <div><dt>{t("ui.moving_tile_credit")}</dt><dd>{dollars(s.files.brought.credit_cents, lang.value)}</dd></div>}
          </dl>
        </section>
        <section class="card">
          <h2>{t("ui.moving_left")}</h2>
          {items("wrap_up")}
          {s.source === "playtomic" && <p class="meta">{t("ui.moving_archive")}</p>}
          <div class="page-actions">
            <button type="button" onClick={() => setView("switch")}>{t("ui.moving_back_to", { step: t("move.step_switch") })}</button>
            {s.step !== "wrap_up" && <button type="button" onClick={() => go("wrap_up")}>{t("ui.moving_make_current", { step: t("move.step_wrap_up") })}</button>}
            {s.finished_at ? <p class="note">{t("ui.moving_finished_on", { when: fmt(s.finished_at) })}</p>
              : <button type="button" class="primary" disabled={s.step !== "wrap_up"} onClick={() => preview("move.finish", {})}>{t("ui.moving_finish")}</button>}
          </div>
        </section>
      </>}
    </main>
  );
}
