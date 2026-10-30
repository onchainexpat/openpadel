// The club's settings: its details and branding, whether people can join by themselves, and its locations
// and courts. Every change goes through the preview, like everything else; only what changed is sent.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { api, club as clubSignal, t, usePreview, type Club } from "@kumi/ui";

type Court = { id: string; location_id: string; name: string; kind: string; bookable: boolean; sort: number };
type Loc = { id: string; name: string; address: string | null; time_zone: string; courts: Court[] };
type ClubRow = { name: string; legal_name: string | null; time_zone: string; languages: string[]; default_language: string; brand_colour: string; sign_up_open: boolean };
type S = { club: ClubRow; locations: Loc[] };
type Preview = (action: string, input: unknown) => Promise<void>;

const KINDS = ["indoor", "covered_outdoor", "outdoor"] as const;
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico", "America/Mexico_City", "Europe/Madrid"];
/** Only the fields that changed, so the preview names just those. */
function diff<T extends Record<string, unknown>>(before: T, after: T): Partial<T> {
  return Object.fromEntries(Object.entries(after).filter(([k, v]) => JSON.stringify(before[k] ?? null) !== JSON.stringify(v ?? null))) as Partial<T>;
}

export function Settings() {
  const [s, setS] = useState<S | null>(null), [note, setNote] = useState<string | null>(null);
  const load = async () => {
    setS(await api<S>("/staff/settings"));
    const c = await api<Club>("/club");   // a new name or colour shows straight away
    clubSignal.value = c; document.documentElement.style.setProperty("--brand", c.brand_colour);
  };
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, []);
  if (!s) return <main class="card"><p>{t("ui.loading")}</p></main>;
  // Send a change only if there is one.
  const send: Preview = async (action, input) => {
    const { court_id, location_id, ...rest } = input as Record<string, unknown>;
    if (!Object.keys(rest).length && action.endsWith(".update")) { setNote(t("error.nothing_changed")); return; }
    setNote(null); await preview(action, input);
  };
  return (
    <main>
      <h1>{t("ui.settings_title")}</h1>
      <ClubForm key={JSON.stringify(s.club)} c={s.club} send={send} />
      {s.locations.map((l) => <LocationCard key={JSON.stringify(l)} l={l} send={send} />)}
      <NewLocation tz={s.club.time_zone} send={send} />
      {note && <p class="note" role="status">{note}</p>}
      {sheet}
    </main>
  );
}

function ClubForm({ c, send }: { c: ClubRow; send: Preview }) {
  const start = { ...c, legal_name: c.legal_name ?? "" };
  const [f, setF] = useState(start);
  const set = (k: keyof ClubRow, v: unknown) => setF({ ...f, [k]: v });
  const toggleLang = (l: string, on: boolean) => set("languages", on ? [...new Set([...f.languages, l])].sort() : f.languages.filter((x) => x !== l));
  return (
    <form class="card card-form" onSubmit={(e) => { e.preventDefault(); send("club.update", diff(start, f)); }}>
      <h2>{t("ui.club_details")}</h2>
      <label>{t("ui.name")}<input required value={f.name} onInput={(e) => set("name", e.currentTarget.value)} /></label>
      <label>{t("ui.legal_name")}<input value={f.legal_name} onInput={(e) => set("legal_name", e.currentTarget.value)} /></label>
      <label>{t("ui.brand_color")}<input type="color" value={f.brand_colour} onInput={(e) => set("brand_colour", e.currentTarget.value)} /></label>
      <label>{t("ui.time_zone")}<input list="zones" required value={f.time_zone} onInput={(e) => set("time_zone", e.currentTarget.value)} /></label>
      <datalist id="zones">{ZONES.map((z) => <option value={z} />)}</datalist>
      <fieldset>
        <legend>{t("ui.languages")}</legend>
        {["en", "es"].map((l) => <label class="check"><input type="checkbox" checked={f.languages.includes(l)} onChange={(e) => toggleLang(l, e.currentTarget.checked)} /> {l === "es" ? "Español" : "English"}</label>)}
      </fieldset>
      <label>{t("ui.default_language")}<select value={f.default_language} onChange={(e) => set("default_language", e.currentTarget.value)}>
        {f.languages.map((l) => <option value={l}>{l === "es" ? "Español" : "English"}</option>)}</select></label>
      <label class="check"><input type="checkbox" checked={f.sign_up_open} onChange={(e) => set("sign_up_open", e.currentTarget.checked)} /> {t("ui.sign_up_open")}</label>
      <button class="primary">{t("ui.preview")}</button>
    </form>
  );
}

function LocationCard({ l, send }: { l: Loc; send: Preview }) {
  const start = { name: l.name, address: l.address ?? "", time_zone: l.time_zone };
  const [f, setF] = useState(start), [court, setCourt] = useState({ name: "", kind: "indoor" });
  return (
    <section class="card">
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("location.update", { location_id: l.id, ...diff(start, f) }); }}>
        <h2>{l.name}</h2>
        <label>{t("ui.name")}<input required value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
        <label>{t("ui.address")}<input value={f.address} onInput={(e) => setF({ ...f, address: e.currentTarget.value })} /></label>
        <label>{t("ui.time_zone")}<input list="zones" required value={f.time_zone} onInput={(e) => setF({ ...f, time_zone: e.currentTarget.value })} /></label>
        <button>{t("ui.preview")}</button>
      </form>
      <h3>{t("ui.courts")}</h3>
      <ul class="plain">{l.courts.map((c) => <CourtRow key={JSON.stringify(c)} c={c} send={send} />)}</ul>
      <form class="card-form" onSubmit={(e) => { e.preventDefault(); send("court.create", { location_id: l.id, name: court.name, kind: court.kind }); }}>
        <label>{t("ui.add_court")}<input required placeholder={t("ui.name")} value={court.name} onInput={(e) => setCourt({ ...court, name: e.currentTarget.value })} /></label>
        <select value={court.kind} onChange={(e) => setCourt({ ...court, kind: e.currentTarget.value })}>{KINDS.map((k) => <option value={k}>{t(`ui.kind_${k}` as Key)}</option>)}</select>
        <button>{t("ui.preview")}</button>
      </form>
    </section>
  );
}

function CourtRow({ c, send }: { c: Court; send: Preview }) {
  const start = { name: c.name, kind: c.kind };
  const [f, setF] = useState(start);
  return (
    <li>
      <form class="court-row" onSubmit={(e) => { e.preventDefault(); send("court.update", { court_id: c.id, ...diff(start, f) }); }}>
        <input required aria-label={t("ui.name")} value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} />
        <select aria-label={t("ui.court_kind")} value={f.kind} onChange={(e) => setF({ ...f, kind: e.currentTarget.value })}>{KINDS.map((k) => <option value={k}>{t(`ui.kind_${k}` as Key)}</option>)}</select>
        <button class="small">{t("ui.save")}</button>
        <button type="button" class="small" onClick={() => send("court.archive", { court_id: c.id })}>{t("ui.archive")}</button>
      </form>
    </li>
  );
}

function NewLocation({ tz, send }: { tz: string; send: Preview }) {
  const [open, setOpen] = useState(false), [f, setF] = useState({ name: "", address: "", time_zone: tz });
  if (!open) return <button onClick={() => setOpen(true)}>{t("ui.add_location")}</button>;
  return (
    <form class="card card-form" onSubmit={(e) => { e.preventDefault(); send("location.create", { name: f.name, time_zone: f.time_zone, address: f.address || undefined }); }}>
      <h2>{t("ui.add_location")}</h2>
      <label>{t("ui.name")}<input required value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></label>
      <label>{t("ui.address")}<input value={f.address} onInput={(e) => setF({ ...f, address: e.currentTarget.value })} /></label>
      <label>{t("ui.time_zone")}<input list="zones" required value={f.time_zone} onInput={(e) => setF({ ...f, time_zone: e.currentTarget.value })} /></label>
      <button class="primary">{t("ui.preview")}</button>
    </form>
  );
}
