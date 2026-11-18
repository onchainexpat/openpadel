// A level a player brought from another app (core/level_claims.ts), as staff and coaches answer it: what the app showed
// and the start it converts to, who sent it and when, their profile link and screenshot if they gave them, and three
// answers, each previewed first: confirm it as seen (a surer start), start them at another level, or turn it down. The
// player reads the reason. Used in the Levels queue and on a person's level page.
import { useState } from "preact/hooks";
import { t } from "@kumi/ui";
import type { Key } from "@kumi/i18n";

export type StaffClaim = { id: string; platform: string; shown: string; start_level: number | null; status: string; created_at: string; profile_url: string | null;
  proof: "none" | "kept" | "deleted"; sent_by?: string | null; is_start?: boolean; answer?: string | null };

export function ClaimAnswer({ c, preview, day, open = true }: { c: StaffClaim; preview: (a: string, i: unknown) => void; day: (iso: string) => string; open?: boolean }) {
  const [to, setTo] = useState(""), [reason, setReason] = useState(""), [look, setLook] = useState(false);
  const source = t(`level_source.${c.platform}` as Key);
  const answerable = open && (c.status === "waiting" || c.status === "standing" || c.status === "confirmed");
  return (
    <div class="level-claim">
      <p class="meta">{c.start_level === null ? t("ui.level_import_claim_staff", { shown: c.shown, source }) : t("ui.level_import_claim", { shown: c.shown, source, level: c.start_level.toFixed(2) })}
        <br />{c.sent_by ? t("ui.claimed_on_by", { date: day(c.created_at), by: c.sent_by }) : t("ui.claimed_on", { date: day(c.created_at) })}
        {c.status === "standing" && <> · {t("ui.claim_counts_word")}</>}
        {c.is_start && <> · <strong>{t("ui.claim_is_start")}</strong></>}
        {c.answer && <><br />{t("ui.claim_answer", { answer: c.answer })}</>}</p>
      <p>
        {c.profile_url && <><a href={c.profile_url} target="_blank" rel="noopener noreferrer nofollow">{t("ui.claim_profile")}</a>{" "}</>}
        {c.proof === "kept" && <button type="button" class="link" aria-expanded={look} onClick={() => setLook(!look)}>{t("ui.claim_view_proof")}</button>}
        {c.proof === "deleted" && <span class="meta">{t("ui.claim_proof.deleted")}</span>}
      </p>
      {look && c.proof === "kept" && <img class="level-proof" src={`/staff/levels/claims/${encodeURIComponent(c.id)}/proof`} alt={t("ui.claim_view_proof")} loading="lazy" />}
      {answerable && <form class="level-answer" onSubmit={(e) => e.preventDefault()}>
        <label>{t("ui.reason_for_them")}<input value={reason} maxLength={300} onInput={(e) => setReason(e.currentTarget.value)} /></label>
        <label>{t("ui.new_level")}<input type="number" step="0.01" min="0" max="7" value={to} onInput={(e) => setTo(e.currentTarget.value)} /></label>
        <p>
          {c.status !== "confirmed" && <><button type="button" class="small" disabled={c.start_level === null && !to}
            onClick={() => preview("level.answer_claim", { claim_id: c.id, outcome: "confirm", ...(c.start_level === null && to ? { level: Number(to) } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) })}>{t("ui.confirm_claim")}</button>{" "}</>}
          <button type="button" class="small" disabled={!to || reason.trim().length < 3}
            onClick={() => preview("level.answer_claim", { claim_id: c.id, outcome: "change", level: Number(to), reason: reason.trim() })}>{t("ui.change_claim")}</button>{" "}
          <button type="button" class="small" disabled={reason.trim().length < 3}
            onClick={() => preview("level.answer_claim", { claim_id: c.id, outcome: "reject", reason: reason.trim() })}>{t("ui.reject_claim")}</button>
        </p>
      </form>}
    </div>
  );
}
