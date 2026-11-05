// Writing to members, for front desk and up: messages sent and scheduled (with what came of each), a new
// message to a group, the club's saved groups and tags, and templates. A group is a set of filters and
// means whoever matches when it's used; the count beside the filters says who that is now.
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api, lang, t, usePreview, clubTime, serverNow } from "@kumi/ui";

type Filters = { membership?: string; plan_ids?: string[]; level_min?: number; level_max?: number; tag_ids?: string[]; played_within_days?: number; not_played_days?: number;
  age?: string; lang?: string; program_id?: string; on_date?: string; joined_from?: string; joined_to?: string };
type Template = { id: string; name: string; subject_en: string | null; body_en: string | null; subject_es: string | null; body_es: string | null };
type Options = { languages: string[]; daily_cap: number; plans: { id: string; name: string }[]; programs: { id: string; name: string; first_start: string | null }[];
  tags: { id: string; name: string; people: number }[]; templates: Template[]; segments: { id: string; name: string; filters: Filters }[] };
type Count = { matched: number; recipients: number; left_out: number; via_parents: number; sample: string[]; what: string };
type Sent = { id: string; purpose: "club_news" | "service"; status: "scheduled" | "sent" | "cancelled" | "stopped"; subject: string; body: string; group: string | null; what: string;
  send_at: string; sent_at: string | null; sender: string | null; recipients: number; left_out: number; email_days: number; counts: Record<string, Record<string, number>>; next_email_at: string | null };
type Words = { subject_en: string; body_en: string; subject_es: string; body_es: string };

const when = (iso: string) => clubTime(iso, { dateStyle: "medium", timeStyle: "short" });
const LANGS = [["en", "lang.word_en"], ["es", "lang.word_es"]] as const;
const blankWords: Words = { subject_en: "", body_en: "", subject_es: "", body_es: "" };
const wordsInput = (w: Words) => ({ subject_en: w.subject_en.trim() || null, body_en: w.body_en.trim() || null, subject_es: w.subject_es.trim() || null, body_es: w.body_es.trim() || null });
const useOptions = () => {
  const [o, setO] = useState<Options | null>(null);
  const load = () => api<Options>("/staff/broadcast-options").then(setO);
  useEffect(() => { void load(); }, []);
  return [o, load] as const;
};
function Tabs({ on }: { on: string }) {
  const tabs = [["/messages", "ui.messages_title"], ["/messages/new", "ui.new_message"], ["/groups", "ui.groups_title"], ["/templates", "ui.templates_title"]] as const;
  return <p class="chips">{tabs.map(([href, k]) => <a class={href === on ? "chip on" : "chip"} href={href}>{t(k)}</a>)}</p>;
}

/** The filters, and who they mean now. */
function FilterForm({ value, onChange, o, purpose, countOnly }: { value: Filters; onChange: (f: Filters) => void; o: Options; purpose?: "club_news" | "service"; countOnly?: boolean }) {
  const f = value, set = (k: keyof Filters, v: unknown) => onChange({ ...f, [k]: v === "" || v === undefined || (Array.isArray(v) && !v.length) ? undefined : v });
  const toggle = (k: "plan_ids" | "tag_ids", id: string) => set(k, (f[k] ?? []).includes(id) ? (f[k] ?? []).filter((x) => x !== id) : [...(f[k] ?? []), id]);
  const num = (v: string) => v === "" ? undefined : Number(v);
  const played = f.played_within_days ? "within" : f.not_played_days ? "not" : "", days = f.played_within_days ?? f.not_played_days ?? 30;
  const [c, setC] = useState<Count | null>(null);
  useEffect(() => {
    const id = setTimeout(() => { api<Count>("/staff/segments/count", { filters: f, purpose }).then(setC).catch(() => setC(null)); }, 300);
    return () => clearTimeout(id);
  }, [JSON.stringify(f), purpose, lang.value]);
  const counted = c && <div class="note" aria-live="polite">
    <p><strong>{t("ui.f_count", { people: t("count.people", { count: c.matched }) })}</strong>: {c.what}</p>
    {purpose && <p>{t("ui.f_reach", { people: t("count.people", { count: c.recipients }) })}</p>}
    {purpose === "club_news" && c.left_out > 0 && <p>{t("ui.f_left_out", { count: c.left_out })}</p>}
    {c.via_parents > 0 && <p>{t("ui.f_via_parents", { count: c.via_parents })}</p>}
    {c.sample.length > 0 && <p class="meta">{t("ui.f_sample", { names: c.sample.join(", ") })}{(purpose ? c.recipients : c.matched) > c.sample.length ? "…" : ""}</p>}
  </div>;
  // A saved group in the message form: who it means now, not its filters to change.
  if (countOnly) return <div class="card-form">{counted}</div>;
  return (
    <div class="card-form">
      <label>{t("ui.f_membership")}<select value={f.membership ?? ""} onChange={(e) => set("membership", e.currentTarget.value)}>
        <option value="">{t("ui.f_anyone")}</option><option value="member">{t("ui.f_member")}</option><option value="not_member">{t("ui.f_not_member")}</option>
        <option value="past_due">{t("ui.f_past_due")}</option><option value="paused">{t("ui.f_paused")}</option><option value="upcoming">{t("ui.f_upcoming")}</option></select></label>
      {o.plans.length > 0 && <fieldset><legend>{t("ui.f_plans")}</legend>{o.plans.map((p) =>
        <label class="check"><input type="checkbox" checked={(f.plan_ids ?? []).includes(p.id)} onChange={() => toggle("plan_ids", p.id)} /> {p.name}</label>)}</fieldset>}
      <label>{t("ui.f_level_from")}<input type="number" min="0" max="7" step="0.25" value={f.level_min ?? ""} onChange={(e) => set("level_min", num(e.currentTarget.value))} /></label>
      <label>{t("ui.f_level_to")}<input type="number" min="0" max="7" step="0.25" value={f.level_max ?? ""} onChange={(e) => set("level_max", num(e.currentTarget.value))} /></label>
      {o.tags.length > 0 && <fieldset><legend>{t("ui.f_tags")}</legend>{o.tags.map((x) =>
        <label class="check"><input type="checkbox" checked={(f.tag_ids ?? []).includes(x.id)} onChange={() => toggle("tag_ids", x.id)} /> {x.name}</label>)}</fieldset>}
      <label>{t("ui.f_played")}<select value={played} onChange={(e) => {
        const v = e.currentTarget.value;
        onChange({ ...f, played_within_days: v === "within" ? days : undefined, not_played_days: v === "not" ? days : undefined });
      }}><option value="">{t("ui.f_anyone")}</option><option value="within">{t("ui.f_played_within")}</option><option value="not">{t("ui.f_not_played")}</option></select></label>
      {played && <label>{t("ui.f_days")}<input type="number" min="1" max="3650" step="1" value={days} onChange={(e) => {
        const n = Math.max(1, Math.round(Number(e.currentTarget.value) || 1));
        onChange({ ...f, ...(played === "within" ? { played_within_days: n } : { not_played_days: n }) });
      }} /></label>}
      <label>{t("ui.f_age")}<select value={f.age ?? ""} onChange={(e) => set("age", e.currentTarget.value)}>
        <option value="">{t("ui.f_anyone")}</option><option value="adult">{t("ui.f_adults")}</option><option value="junior">{t("ui.f_juniors")}</option></select></label>
      <label>{t("ui.f_lang")}<select value={f.lang ?? ""} onChange={(e) => set("lang", e.currentTarget.value)}>
        <option value="">{t("ui.f_anyone")}</option>{LANGS.map(([v, k]) => <option value={v}>{t(k)}</option>)}</select></label>
      <label>{t("ui.f_program")}<select value={f.program_id ?? ""} onChange={(e) => set("program_id", e.currentTarget.value)}>
        <option value="">{t("ui.f_anyone")}</option>{o.programs.map((p) => <option value={p.id}>{p.first_start ? `${p.name} (${when(p.first_start)})` : p.name}</option>)}</select></label>
      <label>{t("ui.f_on_date")}<input type="date" value={f.on_date ?? ""} onChange={(e) => set("on_date", e.currentTarget.value)} /></label>
      <label>{t("ui.f_joined_from")}<input type="date" value={f.joined_from ?? ""} onChange={(e) => set("joined_from", e.currentTarget.value)} /></label>
      <label>{t("ui.f_joined_to")}<input type="date" value={f.joined_to ?? ""} onChange={(e) => set("joined_to", e.currentTarget.value)} /></label>
      {counted}
    </div>
  );
}

export function Messages() {
  const [rows, setRows] = useState<Sent[] | null>(null);
  const load = () => api<Sent[]>("/staff/broadcasts").then(setRows);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { void load(); }, [lang.value]);
  return (
    <main>
      <h1>{t("ui.messages_title")}</h1>
      <Tabs on="/messages" />
      {sheet}
      {!rows ? <p>{t("ui.loading")}</p> : !rows.length ? <section class="card"><p class="meta">{t("ui.no_messages")}</p></section> : rows.map((b) => {
        const email = b.counts.email ?? {}, waiting = email.waiting ?? 0;
        return <section class="card" key={b.id}>
          <p><strong>{b.subject}</strong> <span class={b.purpose === "service" ? "badge warn" : "badge"}>{t(b.purpose === "club_news" ? "ui.badge_club_news" : "ui.badge_service")}</span></p>
          <p class="meta">{b.status === "scheduled" ? t("ui.bc_scheduled", { when: when(b.send_at) }) : b.status === "cancelled" ? t("ui.bc_cancelled") : t(b.status === "stopped" ? "ui.bc_stopped" : "ui.bc_sent", { when: when(b.sent_at ?? b.send_at) })}
            {b.sender ? ` · ${t("ui.bc_by", { name: b.sender })}` : ""}</p>
          <p class="meta">{b.group ? `${b.group}: ${b.what}` : b.what}</p>
          {(b.status === "sent" || b.status === "stopped") && <p class="meta">
            {t("ui.bc_reached", { people: t("count.people", { count: b.recipients }) })}{b.left_out ? ` · ${t("ui.bc_left_out", { count: b.left_out })}` : ""}<br />
            {t("ui.bc_email_counts", { sent: email.sent ?? 0, waiting, dropped: email.dropped ?? 0, failed: email.failed ?? 0 })}{b.email_days > 1 ? ` · ${t("ui.bc_spread", { days: b.email_days })}` : ""}</p>}
          <details><summary>{t("ui.bc_words")}</summary><p class="pre">{b.body}</p></details>
          {b.status === "scheduled" && <button class="small" onClick={() => preview("broadcast.cancel", { broadcast_id: b.id })}>{t("ui.bc_cancel")}</button>}
          {/* Emails held for later (the daily cap, or quiet hours) can still be stopped; ones going out now can't, really. */}
          {b.status === "sent" && waiting > 0 && b.next_email_at && new Date(b.next_email_at).getTime() > serverNow() + 2 * 60_000 &&
            <><p class="meta">{t("ui.bc_next_email", { when: when(b.next_email_at) })}</p><button class="small" onClick={() => preview("broadcast.cancel", { broadcast_id: b.id })}>{t("ui.bc_stop")}</button></>}
        </section>;
      })}
    </main>
  );
}

export function Compose() {
  const [o] = useOptions(), { route } = useLocation();
  const [purpose, setPurpose] = useState<"club_news" | "service">("club_news"), [how, setHow] = useState<"saved" | "build">("build");
  const [segment, setSegment] = useState(""), [filters, setFilters] = useState<Filters>({}), [w, setW] = useState<Words>(blankWords);
  const [later, setLater] = useState(false), [at, setAt] = useState("");
  const { preview, sheet } = usePreview(() => route("/messages"));
  if (!o) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const use = (id: string) => { const x = o.templates.find((y) => y.id === id); if (x) setW({ subject_en: x.subject_en ?? "", body_en: x.body_en ?? "", subject_es: x.subject_es ?? "", body_es: x.body_es ?? "" }); };
  const langs = LANGS.filter(([l]) => o.languages.includes(l));
  const send = (e: Event) => {
    e.preventDefault();
    preview("broadcast.send", { purpose, ...(how === "saved" && segment ? { segment_id: segment } : { filters }), ...wordsInput(w), ...(later && at ? { send_at: new Date(at).toISOString() } : {}) });
  };
  return (
    <main>
      <h1>{t("ui.new_message")}</h1>
      <Tabs on="/messages/new" />
      {sheet}
      <form class="card card-form" onSubmit={send}>
        <fieldset><legend>{t("ui.purpose_label")}</legend>
          <label class="check"><input type="radio" name="purpose" checked={purpose === "club_news"} onChange={() => setPurpose("club_news")} /> {t("ui.purpose_news_label")}</label>
          <label class="check"><input type="radio" name="purpose" checked={purpose === "service"} onChange={() => setPurpose("service")} /> {t("ui.purpose_service_label")}</label>
        </fieldset>
        <fieldset><legend>{t("ui.group_label")}</legend>
          {o.segments.length > 0 && <label class="check"><input type="radio" name="how" checked={how === "saved"} onChange={() => setHow("saved")} /> {t("ui.group_saved")}</label>}
          <label class="check"><input type="radio" name="how" checked={how === "build"} onChange={() => setHow("build")} /> {t("ui.group_build")}</label>
          {how === "saved" && <label>{t("ui.choose_group")}<select value={segment} onChange={(e) => setSegment(e.currentTarget.value)}><option value="">{t("ui.choose_group")}</option>
            {o.segments.map((s) => <option value={s.id}>{s.name}</option>)}</select></label>}
          {how === "saved" && segment && <FilterForm key={segment} value={o.segments.find((s) => s.id === segment)!.filters} onChange={() => {}} o={o} purpose={purpose} countOnly />}
          {how === "build" && <FilterForm value={filters} onChange={setFilters} o={o} purpose={purpose} />}
        </fieldset>
        {o.templates.length > 0 && <label>{t("ui.from_template")}<select onChange={(e) => use(e.currentTarget.value)}><option value="">{t("ui.no_template")}</option>
          {o.templates.map((x) => <option value={x.id}>{x.name}</option>)}</select></label>}
        {langs.map(([l, k]) => <>
          <label>{t("ui.subject_in", { lang: t(k) })}<input maxLength={150} value={w[`subject_${l}`]} onInput={(e) => setW({ ...w, [`subject_${l}`]: e.currentTarget.value })} /></label>
          <label>{t("ui.message_in", { lang: t(k) })}<textarea rows={6} maxLength={5000} value={w[`body_${l}`]} onInput={(e) => setW({ ...w, [`body_${l}`]: e.currentTarget.value })} /></label>
        </>)}
        <p class="meta">{t("ui.placeholders_help")}</p>
        <fieldset><legend>{t("ui.send_when")}</legend>
          <label class="check"><input type="radio" name="when" checked={!later} onChange={() => setLater(false)} /> {t("ui.send_now")}</label>
          <label class="check"><input type="radio" name="when" checked={later} onChange={() => setLater(true)} /> {t("ui.send_later")}</label>
          {later && <label>{t("ui.send_at")}<input type="datetime-local" value={at} onInput={(e) => setAt(e.currentTarget.value)} /></label>}
        </fieldset>
        <button class="primary" disabled={(how === "saved" && !segment) || (later && !at)}>{t("ui.preview")}</button>
      </form>
    </main>
  );
}

export function Groups() {
  const [o, reload] = useOptions();
  const [list, setList] = useState<{ id: string; name: string; filters: Filters; what: string; people: number }[] | null>(null);
  const [filters, setFilters] = useState<Filters>({}), [name, setName] = useState(""), [editing, setEditing] = useState<string | null>(null), [tag, setTag] = useState(""), [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const load = () => { void reload(); api<typeof list>("/staff/segments").then((x) => { setList(x); setEditing(null); setRenaming(null); }); };
  const { preview, sheet } = usePreview(() => { setName(""); setTag(""); setFilters({}); load(); });
  useEffect(() => { load(); }, [lang.value]);
  if (!o || !list) return <main class="card"><p>{t("ui.loading")}</p></main>;
  return (
    <main>
      <h1>{t("ui.groups_title")}</h1>
      <Tabs on="/groups" />
      <p class="meta">{t("ui.groups_help")}</p>
      {sheet}
      <section class="card">
        {!list.length ? <p class="meta">{t("ui.no_groups")}</p> : <ul class="plain">{list.map((s) => <li key={s.id}>
          <p><strong>{s.name}</strong> <span class="meta">{t("count.people", { count: s.people })}</span></p>
          <p class="meta">{s.what}</p>
          <p><a class="small" href={`/people?segment=${s.id}`}>{t("ui.see_people")}</a>{" "}
            <button class="small" onClick={() => setEditing(editing === s.id ? null : s.id)}>{t("ui.edit")}</button>{" "}
            <button class="small" onClick={() => preview("segment.update", { segment_id: s.id, active: false })}>{t("ui.remove")}</button></p>
          {editing === s.id && <EditGroup start={s} o={o} onSend={(n, f) => preview("segment.update", { segment_id: s.id, name: n, filters: f })} />}
        </li>)}</ul>}
      </section>
      <section class="card">
        <h2>{t("ui.new_group")}</h2>
        <FilterForm value={filters} onChange={setFilters} o={o} />
        <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("segment.save", { name: name.trim(), filters }); }}>
          <label>{t("ui.group_name")}<input required maxLength={60} value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
          <button class="primary">{t("ui.save_group")}</button>
        </form>
      </section>
      <section class="card">
        <h2>{t("ui.tags_title")}</h2>
        <p class="meta">{t("ui.tags_help")}</p>
        {!o.tags.length ? <p class="meta">{t("ui.no_tags")}</p> : <ul class="plain">{o.tags.map((x) => <li key={x.id} class="row">
          <span>{x.name} <span class="meta">{t("count.people", { count: x.people })}</span></span>
          <span><button class="small" onClick={() => setRenaming(renaming?.id === x.id ? null : { id: x.id, name: x.name })}>{t("ui.rename")}</button>{" "}
            <button class="small" onClick={() => preview("tag.update", { tag_id: x.id, active: false })}>{t("ui.retire_tag")}</button></span>
          {renaming?.id === x.id && <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("tag.update", { tag_id: x.id, name: renaming.name.trim() }); }}>
            <label>{t("ui.tag_name")}<input required maxLength={40} value={renaming.name} onInput={(e) => setRenaming({ id: x.id, name: e.currentTarget.value })} /></label>
            <button class="primary">{t("ui.preview")}</button></form>}
        </li>)}</ul>}
        <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("tag.create", { name: tag.trim() }); }}>
          <label>{t("ui.new_tag")}<input required maxLength={40} value={tag} onInput={(e) => setTag(e.currentTarget.value)} /></label>
          <button>{t("ui.preview")}</button>
        </form>
      </section>
    </main>
  );
}
function EditGroup({ start, o, onSend }: { start: { name: string; filters: Filters }; o: Options; onSend: (name: string, f: Filters) => void }) {
  const [name, setName] = useState(start.name), [f, setF] = useState<Filters>(start.filters);
  return (
    <form class="card-form" onSubmit={(e) => { e.preventDefault(); onSend(name.trim(), f); }}>
      <label>{t("ui.group_name")}<input required maxLength={60} value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
      <FilterForm value={f} onChange={setF} o={o} />
      <button class="primary">{t("ui.preview")}</button>
    </form>
  );
}

export function Templates() {
  const [o, reload] = useOptions();
  const [editing, setEditing] = useState<string | null>(null), [key, setKey] = useState(0);
  const { preview, sheet } = usePreview(() => { setEditing(null); setKey((k) => k + 1); void reload(); });
  if (!o) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const langs = LANGS.filter(([l]) => o.languages.includes(l));
  const form = (id: string | null, start: { name: string } & Words) => <TemplateForm key={`${id ?? "new"}-${key}`} start={start} langs={langs}
    onSend={(name, w) => preview(id ? "template.update" : "template.save", { ...(id ? { template_id: id } : {}), name, ...wordsInput(w) })} />;
  return (
    <main>
      <h1>{t("ui.templates_title")}</h1>
      <Tabs on="/templates" />
      {sheet}
      <section class="card">
        {!o.templates.length ? <p class="meta">{t("ui.no_templates")}</p> : <ul class="plain">{o.templates.map((x) => <li key={x.id}>
          <p><strong>{x.name}</strong></p>
          <p class="meta">{(lang.value === "es" ? x.subject_es ?? x.subject_en : x.subject_en ?? x.subject_es) ?? ""}</p>
          <p><button class="small" onClick={() => setEditing(editing === x.id ? null : x.id)}>{t("ui.edit")}</button>{" "}
            <button class="small" onClick={() => preview("template.update", { template_id: x.id, active: false })}>{t("ui.remove")}</button></p>
          {editing === x.id && form(x.id, { name: x.name, subject_en: x.subject_en ?? "", body_en: x.body_en ?? "", subject_es: x.subject_es ?? "", body_es: x.body_es ?? "" })}
        </li>)}</ul>}
      </section>
      <section class="card">
        <h2>{t("ui.new_template")}</h2>
        {form(null, { name: "", ...blankWords })}
      </section>
    </main>
  );
}
function TemplateForm({ start, langs, onSend }: { start: { name: string } & Words; langs: readonly (readonly ["en" | "es", "lang.word_en" | "lang.word_es"])[]; onSend: (name: string, w: Words) => void }) {
  const [name, setName] = useState(start.name), [w, setW] = useState<Words>(start);
  return (
    <form class="card-form" onSubmit={(e) => { e.preventDefault(); onSend(name.trim(), w); }}>
      <label>{t("ui.template_name")}<input required maxLength={60} value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
      {langs.map(([l, k]) => <>
        <label>{t("ui.subject_in", { lang: t(k) })}<input maxLength={150} value={w[`subject_${l}`]} onInput={(e) => setW({ ...w, [`subject_${l}`]: e.currentTarget.value })} /></label>
        <label>{t("ui.message_in", { lang: t(k) })}<textarea rows={5} maxLength={5000} value={w[`body_${l}`]} onInput={(e) => setW({ ...w, [`body_${l}`]: e.currentTarget.value })} /></label>
      </>)}
      <p class="meta">{t("ui.placeholders_help")}</p>
      <button class="primary">{t("ui.preview")}</button>
    </form>
  );
}
