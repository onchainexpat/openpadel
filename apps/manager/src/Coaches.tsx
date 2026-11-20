// Coaches: each one's profile (what members see), lesson rates, the hours they give lessons and their time off.
// Front desk and up keep anyone's; a coach sees and keeps their own. Someone becomes a coach by being given
// the coach role on their page.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { amountInput, amountPattern, parseDollars, toMajor, formatLocale, weekOrder } from "@kumi/i18n/format";
import { Skeleton, api, FileInput, dollars, lang, OtherLang, savedIn, t, translationsOf, usePreview } from "@kumi/ui";

type Profile = { bio: string | null; translations?: unknown; level_min: string | null; level_max: string | null; languages: string[]; rates: Record<string, number>; photo: string | null; lessons: boolean; max_players: number };
type Stretch = { location_id: string; weekday: number; starts: string; ends: string };
type Coach = { id: string; name: string; profile: Profile | null; hours: Stretch[]; time_off: { id: string; note: string | null; from: string; to: string }[] };
type Data = { can_edit_all: boolean; lengths: number[]; locations: { id: string; name: string }[]; coaches: Coach[] };
type Preview = (action: string, input: unknown) => void;

/** A picture the browser shrinks to 400 px and re-encodes as JPEG, as base64: the server checks it again. */
async function shrink(file: File): Promise<string> {
  const url = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsDataURL(file); });
  const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("unreadable")); i.src = url; });
  const scale = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.7, 0.5]) {
    const data = canvas.toDataURL("image/jpeg", q).split(",")[1]!;
    if (data.length * 0.75 <= 140_000) return data;
  }
  throw new Error("too big");
}
const dayName = (w: number) => new Intl.DateTimeFormat(formatLocale(lang.value), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));
const dayText = (d: string) => new Intl.DateTimeFormat(formatLocale(lang.value), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
const toCents = (v: string) => parseDollars(v) ?? NaN;

export function Coaches() {
  const [d, setD] = useState<Data | null>(null), [open, setOpen] = useState<string | null>(null);
  const load = () => api<Data>("/staff/coaches").then((x) => { setD(x); if (!x.can_edit_all && x.coaches.length === 1) setOpen(x.coaches[0]!.id); });
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); }, []);
  if (!d) return <Skeleton />;
  const rates = (p: Profile) => Object.entries(p.rates).sort((a, b) => Number(a[0]) - Number(b[0])).map(([m, c]) => t("ui.lesson_rate", { minutes: t("ui.minutes", { count: Number(m) }), price: dollars(c, lang.value) })).join(" · ");
  return (
    <main>
      <h1>{t("ui.coaches_title")}</h1>
      {sheet}
      {!d.coaches.length && <p class="card">{t("ui.no_coaches")}</p>}
      <ul class="changes">{d.coaches.map((c) => (
        <li class="card" key={c.id}>
          <div class="coach-card">
            {c.profile?.photo ? <img class="face" src={c.profile.photo} alt="" /> : <span class="face" aria-hidden="true">{c.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>}
            <div>
              <div class="summary">{c.name}</div>
              <p class="meta">{!c.profile ? t("ui.coach_no_profile") : c.profile.lessons && Object.keys(c.profile.rates).length ? t("ui.lessons_on", { rates: rates(c.profile) }) : t("ui.lessons_off")}</p>
              {open !== c.id && <button class="small" onClick={() => setOpen(c.id)}>{c.profile ? t("ui.edit") : t("ui.make_profile")}</button>}
              {d.can_edit_all && <>{" "}<a href={`/students?coach=${c.id}`}>{t("ui.students")}</a></>}
            </div>
          </div>
          {open === c.id && <CoachEdit key={JSON.stringify(c)} c={c} d={d} preview={preview} />}
        </li>))}</ul>
    </main>
  );
}

function CoachEdit({ c, d, preview }: { c: Coach; d: Data; preview: Preview }) {
  const p = c.profile;
  const lengths = [...new Set([...d.lengths, ...Object.keys(p?.rates ?? {}).map(Number)])].sort((a, b) => a - b);
  const [f, setF] = useState({ bio: p?.bio ?? "", bio_tr: savedIn(p?.translations, "bio"), lmin: p?.level_min ?? "", lmax: p?.level_max ?? "", languages: p?.languages ?? ["en"], lessons: p?.lessons ?? true, players: p?.max_players ?? 4,
    rates: Object.fromEntries(lengths.map((m) => [m, p?.rates[String(m)] !== undefined ? amountInput(p.rates[String(m)]!) : ""])) as Record<number, string> });
  const [loc, setLoc] = useState(d.locations[0]?.id ?? ""), [photoError, setPhotoError] = useState(false);
  const [hours, setHours] = useState<Stretch[]>(c.hours);
  const [off, setOff] = useState({ from: "", to: "", note: "" });
  const save = (e: Event) => {
    e.preventDefault();
    preview("coach.set_profile", { person_id: c.id, bio: f.bio.trim() || null, level_min: f.lmin === "" ? null : Number(f.lmin), level_max: f.lmax === "" ? null : Number(f.lmax), languages: f.languages,
      rates: lengths.filter((m) => f.rates[m]!.trim() !== "").map((m) => ({ minutes: m, cents: toCents(f.rates[m]!) })), lessons: f.lessons, max_players: f.players,
      translations: translationsOf({ bio: f.bio_tr }) });
  };
  const photo = async (file: File | undefined) => {
    if (!file) return;
    setPhotoError(false);
    try { preview("coach.set_photo", { person_id: c.id, photo: await shrink(file) }); } catch { setPhotoError(true); }
  };
  const here = hours.filter((h) => h.location_id === loc);
  const setStretch = (h: Stretch, patch: Partial<Stretch>) => setHours(hours.map((x) => (x === h ? { ...x, ...patch } : x)));
  return (
    <div>
      <form class="card-form" onSubmit={save}>
        <label>{t("ui.coach_bio")}<textarea maxLength={600} value={f.bio} onInput={(e) => setF({ ...f, bio: e.currentTarget.value })} /></label>
        <OtherLang value={f.bio_tr} onInput={(v) => setF({ ...f, bio_tr: v })} source={f.bio} multiline rows={3} maxLength={600} />
        <fieldset><legend>{t("ui.coach_levels_taught")}</legend><div class="court-row">
          <label>{t("ui.from")}<input type="number" min={0.5} max={7} step={0.25} value={f.lmin} onInput={(e) => setF({ ...f, lmin: e.currentTarget.value })} /></label>
          <label>{t("ui.to")}<input type="number" min={0.5} max={7} step={0.25} value={f.lmax} onInput={(e) => setF({ ...f, lmax: e.currentTarget.value })} /></label></div></fieldset>
        <fieldset><legend>{t("ui.coach_langs")}</legend>{["en", "es"].map((x) => <label class="check"><input type="checkbox" checked={f.languages.includes(x)}
          onChange={(e) => setF({ ...f, languages: e.currentTarget.checked ? [...f.languages, x] : f.languages.filter((y) => y !== x) })} /> {t(`ui.lang_${x}` as Key)}</label>)}</fieldset>
        <fieldset><legend>{t("ui.lesson_rates")}</legend><div class="court-row">{lengths.map((m) =>
          <label>{t("ui.minutes", { count: m })}<input inputMode="decimal" pattern={amountPattern()} title={t("ui.amount_format")} value={f.rates[m]} onInput={(e) => setF({ ...f, rates: { ...f.rates, [m]: e.currentTarget.value } })} /></label>)}</div></fieldset>
        <label class="check"><input type="checkbox" checked={f.lessons} onChange={(e) => setF({ ...f, lessons: e.currentTarget.checked })} /> {t("ui.takes_lessons")}</label>
        <label>{t("ui.max_players")}<select value={f.players} onChange={(e) => setF({ ...f, players: Number(e.currentTarget.value) })}>{[1, 2, 3, 4].map((n) => <option value={n}>{n}</option>)}</select></label>
        <button class="primary">{t("ui.preview")}</button>
      </form>
      {p && <>
        <h2>{t("ui.photo")}</h2>
        <FileInput class="small" label={t("ui.change_photo")} accept="image/jpeg,image/png,image/webp" onFile={(f) => photo(f ?? undefined)} />
        {p.photo && <> <button class="small" onClick={() => preview("coach.set_photo", { person_id: c.id, photo: null })}>{t("ui.remove_photo")}</button></>}
        {photoError && <p class="error">{t("ui.photo_failed")}</p>}

        <h2>{t("ui.lesson_hours")}</h2>
        {d.locations.length > 1 && <label>{t("ui.location")}<select value={loc} onChange={(e) => setLoc(e.currentTarget.value)}>{d.locations.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>}
        <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("coach.set_hours", { person_id: c.id, location_id: loc, stretches: here.map(({ weekday, starts, ends }) => ({ weekday, starts, ends })) }); }}>
          {weekOrder().map((w) => <div>
            <strong>{dayName(w)}</strong>
            {here.filter((h) => h.weekday === w).map((h) => <div class="court-row">
              <label>{t("ui.from")}<input type="time" required value={h.starts} onInput={(e) => setStretch(h, { starts: e.currentTarget.value })} /></label>
              <label>{t("ui.to")}<input type="time" required value={h.ends} onInput={(e) => setStretch(h, { ends: e.currentTarget.value })} /></label>
              <button type="button" class="small" onClick={() => setHours(hours.filter((x) => x !== h))}>{t("ui.remove")}</button></div>)}
            <button type="button" class="link" onClick={() => setHours([...hours, { location_id: loc, weekday: w, starts: "09:00", ends: "12:00" }])}>{t("ui.add_stretch")}</button>
          </div>)}
          <button class="primary">{t("ui.preview_hours")}</button>
        </form>

        <h2>{t("ui.time_off")}</h2>
        {!c.time_off.length ? <p class="meta">{t("ui.no_time_off")}</p> : <ul class="plain">{c.time_off.map((o) => <li class="row"><span>{t("ui.time_off_line", { from: dayText(o.from), to: dayText(o.to) })}{o.note ? ` · ${o.note}` : ""}</span>
          <button class="small" onClick={() => preview("coach.time_off_remove", { time_off_id: o.id })}>{t("ui.remove")}</button></li>)}</ul>}
        <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("coach.time_off_add", { person_id: c.id, from: off.from, to: off.to || off.from, ...(off.note.trim() ? { note: off.note.trim() } : {}) }); }}>
          <div class="court-row"><label>{t("ui.from")}<input type="date" required value={off.from} onInput={(e) => setOff({ ...off, from: e.currentTarget.value })} /></label>
            <label>{t("ui.to")}<input type="date" value={off.to} onInput={(e) => setOff({ ...off, to: e.currentTarget.value })} /></label></div>
          <label>{t("ui.note")}<input value={off.note} maxLength={200} onInput={(e) => setOff({ ...off, note: e.currentTarget.value })} /></label>
          <button class="primary">{t("ui.add_time_off")}</button>
        </form>
      </>}
    </div>
  );
}
