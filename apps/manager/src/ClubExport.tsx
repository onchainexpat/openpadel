// The owner's "Download everything" (club_exit.ts, export_routes.ts): confirm it like any change, then the file
// is made and its passphrase shown, once, beside the download. The passphrase isn't kept anywhere. Beside it, the
// owner's "we're moving" (club.moved): turned on before the download, only the new server talks to members.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, club, t, type Club } from "@kumi/ui";

type Made = { passphrase: string; name: string; bytes: number; download: string; minutes: number };

export function ClubExport() {
  const [pending, setPending] = useState<{ runId: string; summary: string } | null>(null), [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false), [making, setMaking] = useState(false), [error, setError] = useState<string | null>(null);
  const guard = async (f: () => Promise<void>) => { setBusy(true); setError(null); try { await f(); } catch (e) { setError(e instanceof ApiError ? e.message : (e as Error).message); } finally { setBusy(false); } };
  const [moving, setMoving] = useState(false), [to, setTo] = useState("");
  const ask = () => guard(async () => {
    setMade(null); setMoving(false);
    const p = await api<{ run_id: string; summary: string }>("/actions/club.export/plan", {});
    setPending({ runId: p.run_id, summary: p.summary });
  });
  const move = (on: boolean) => guard(async () => {
    setMade(null); setMoving(true);
    const p = await api<{ run_id: string; summary: string }>("/actions/club.moved/plan", { on, ...(on && to.trim() ? { to: to.trim() } : {}) });
    setPending({ runId: p.run_id, summary: p.summary });
  });
  const confirm = () => guard(async () => {
    const runId = pending!.runId;
    await api(`/runs/${runId}/apply`, {}, { "idempotency-key": runId });
    setPending(null);
    if (moving) { club.value = await api<Club>("/club"); return; }
    setMaking(true);
    try { setMade(await api<Made>(`/staff/export/${runId}`, {})); } finally { setMaking(false); }
  });
  // Opened from the staff app's notice of the day the club's Kumi ends (/settings#download-everything).
  const here = useRef<HTMLElement>(null);
  useEffect(() => { if (location.hash === "#download-everything") here.current?.scrollIntoView(); }, []);
  return (
    <section class="card" id="download-everything" ref={here}>
      <h2>{t("ui.export_title")}</h2>
      <p class="meta">{t("ui.export_help")}</p>
      {!made && <button disabled={busy} onClick={ask}>{t("ui.export_start")}</button>}
      {pending && <div class="sheet" role="dialog" aria-modal="true"><p>{pending.summary}</p>
        <button class="primary" disabled={busy} onClick={confirm}>{t("ui.confirm")}</button> <button disabled={busy} onClick={() => setPending(null)}>{t("ui.cancel")}</button></div>}
      {making && <p class="meta" role="status">{t("ui.export_making")}</p>}
      {made && <div class="sheet" role="status">
        <p>{t("ui.export_passphrase")}</p>
        <p><code>{made.passphrase}</code></p>
        <p><a class="button primary" href={made.download} download={made.name}>{t("ui.export_download", { mb: (made.bytes / 1048576).toFixed(1) })}</a></p>
        <p class="meta">{t("ui.export_until", { minutes: made.minutes })}</p>
      </div>}
      <h3>{t("ui.moved_title")}</h3>
      <p class="meta">{t(club.value?.moved ? "ui.moved_is_on" : "ui.moved_help")}</p>
      {!club.value?.moved && <label>{t("ui.moved_to_label")} <input type="url" value={to} onInput={(e) => setTo(e.currentTarget.value)} placeholder="https://" /></label>}
      <button disabled={busy} onClick={() => move(!club.value?.moved)}>{t(club.value?.moved ? "ui.moved_off" : "ui.moved_on")}</button>
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}
