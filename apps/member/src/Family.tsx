// Family: a parent's household (the adults, the juniors they manage, and invite links for another parent),
// an invite link opened by the other parent, and the club's waiver for the member and each junior.
// Loaded only when one of these pages is opened, to keep the app small.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, lang, me, t, usePreview } from "@kumi/ui";
import { loadFamily } from "./ForWhom.tsx";

type Person = { id: string; display_name: string; me?: boolean };
type Junior = Person & { birth_year: number | null; level: number | null; waiver: { version_no: number; accepted_at: string | null } | null };
type Page = { role: "adult" | "member" | "junior" | null; household: { adults: Person[]; members: Person[]; juniors: Junior[]; invites: { id: string; code: string; until: string }[] } | null };

const dayWords = (date: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

export function Family() {
  const [f, setF] = useState<Page | null>(null), [name, setName] = useState(""), [year, setYear] = useState(""), [copied, setCopied] = useState<string | null>(null);
  const [loginFor, setLoginFor] = useState<string | null>(null), [email, setEmail] = useState("");
  const load = () => api<Page>("/my/household").then(setF);
  const { preview, sheet } = usePreview(() => { setName(""); setYear(""); setLoginFor(null); setEmail(""); void load(); void loadFamily(); });
  useEffect(() => { void load(); }, [lang.value]);
  if (!f) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const pid = me.value!.person.id, h = f.household, parent = !h || f.role === "adult";
  const link = (code: string) => `${location.origin}/family/join/${code}`;
  const copy = async (code: string) => { await navigator.clipboard?.writeText(link(code)).catch(() => {}); setCopied(code); };
  const share = (code: string) => navigator.share?.({ title: t("ui.invite_parent"), url: link(code) }).catch(() => {});
  const thisYear = new Date().getFullYear();
  return (
    <main>
      <h1>{t("ui.family_title")}</h1>
      {sheet}
      {!h?.juniors.length && parent && <p class="card">{t("ui.family_none")}</p>}
      {h && <section class="card">
        <h2>{t("ui.family_adults")}</h2>
        <ul class="plain">{[...h.adults, ...h.members].map((a) => <li class="row"><span>{a.display_name}{a.me ? ` (${t("ui.you_label")})` : ""}</span></li>)}</ul>
        {h.juniors.length > 0 && <>
          <h2>{t("ui.family_juniors")}</h2>
          <ul class="plain">{h.juniors.map((j) => (
            <li class="row">
              <span>{j.display_name}{j.birth_year ? <span class="meta"> · {t("ui.junior_born", { year: j.birth_year })}</span> : null}
                {j.level !== null ? <span class="meta"> · {t("ui.junior_level", { level: j.level.toFixed(2) })}</span> : null}
                {j.waiver ? <span class={j.waiver.accepted_at ? "meta" : "badge warn"}> {j.waiver.accepted_at ? t("ui.waiver_ok") : t("ui.waiver_missing")}</span> : null}</span>
              {parent && <span>
                {j.birth_year && thisYear - j.birth_year >= 18 && <button class="small" onClick={() => setLoginFor(j.id)}>{t("ui.give_login")}</button>}{" "}
                <button class="small" onClick={() => preview("household.remove_junior", { person_id: j.id })}>{t("ui.remove")}</button>
              </span>}
            </li>))}</ul>
          {loginFor && <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("household.give_login", { person_id: loginFor, email }); }}>
            <label>{t("ui.give_login_email")} <input type="email" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
            <button class="primary">{t("ui.give_login")}</button>
          </form>}
        </>}
      </section>}
      {parent && <section class="card card-form">
        <h2>{t("ui.add_junior")}</h2>
        <form onSubmit={(e) => { e.preventDefault(); preview("household.add_junior", { person_id: pid, display_name: name, birth_year: Number(year) }); }}>
          <label>{t("ui.junior_name")} <input required maxLength={80} value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
          <label>{t("ui.birth_year")} <input type="number" required min={thisYear - 18} max={thisYear} inputMode="numeric" value={year} onInput={(e) => setYear(e.currentTarget.value)} /></label>
          <button class="primary">{t("ui.add_junior")}</button>
        </form>
      </section>}
      {parent && <section class="card">
        <h2>{t("ui.invite_parent")}</h2>
        <p class="meta">{t("ui.invite_parent_hint")}</p>
        <ul class="plain">{(h?.invites ?? []).map((x) => (
          <li class="row"><span class="meta">{t("ui.invite_until", { date: dayWords(x.until) })}</span>
            <span><button class="small" onClick={() => copy(x.code)}>{copied === x.code ? t("ui.link_copied") : t("ui.copy_invite")}</button>{" "}
              {"share" in navigator && <button class="small" onClick={() => share(x.code)}>{t("ui.share_invite")}</button>}{" "}
              <button class="small" onClick={() => preview("household.withdraw_invite", { invite_id: x.id })}>{t("ui.withdraw_invite")}</button></span></li>))}</ul>
        {!h?.invites.length && <button class="primary" onClick={() => preview("household.invite", { person_id: pid })}>{t("ui.make_invite")}</button>}
      </section>}
      {h && <p><button class="link" onClick={() => preview("household.leave", { person_id: pid })}>{t("ui.leave_family")}</button></p>}
    </main>
  );
}

/** Another parent's invite link, opened: whose family, the juniors, and one button. */
export function FamilyJoin({ code }: { code: string }) {
  const [inv, setInv] = useState<{ from: string; juniors: string[]; open: boolean; already: boolean } | null>(null), [error, setError] = useState<string | null>(null), [joined, setJoined] = useState(false);
  const load = () => api<NonNullable<typeof inv>>(`/my/household/invites/${encodeURIComponent(code)}`).then(setInv).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  const { preview, sheet } = usePreview(() => { setJoined(true); void loadFamily(); });
  useEffect(() => { void load(); }, [code]);
  if (error) return <main class="card"><p class="error">{error}</p></main>;
  if (!inv) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const names = new Intl.ListFormat(lang.value === "es" ? "es" : "en", { type: "conjunction" }).format(inv.juniors);
  return (
    <main>
      {sheet}
      <section class="card">
        {joined || inv.already ? <p><a href="/family">{t("ui.family_title")}</a></p>
          : !inv.open ? <p>{t("ui.family_invite_closed")}</p>
          : <>
            <h1>{t("ui.family_invite_title", { name: inv.from })}</h1>
            <p>{inv.juniors.length ? t("ui.family_invite_body", { name: inv.from, juniors: names }) : t("ui.family_invite_no_juniors", { name: inv.from })}</p>
            <button class="primary" onClick={() => preview("household.accept_invite", { person_id: me.value!.person.id, code })}>{t("ui.family_invite_accept")}</button>
          </>}
      </section>
    </main>
  );
}

/** The club's waiver: its text, and a button for the member and for each junior who hasn't accepted it. */
export function Waiver() {
  const [w, setW] = useState<{ waiver: { version_no: number; body: string } | null; people: { id: string; display_name: string | null; me: boolean; accepted_at: string | null }[] } | null>(null);
  const load = () => api<NonNullable<typeof w>>("/my/waiver").then(setW);
  const { preview, sheet } = usePreview(() => { void load(); void loadFamily(); });
  useEffect(() => { void load(); }, [lang.value]);
  if (!w) return <main class="card"><p>{t("ui.loading")}</p></main>;
  if (!w.waiver) return <main class="card"><p>{t("ui.waiver_none")}</p></main>;
  const day = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
  return (
    <main>
      {sheet}
      <section class="card">
        <h1>{t("ui.waiver_title")}</h1>
        <p class="meta">{t("ui.waiver_version", { version: w.waiver.version_no })}</p>
        <div class="waiver">{w.waiver.body.split(/\n{2,}/).map((para) => <p>{para}</p>)}</div>
        <ul class="plain">{w.people.map((p) => (
          <li class="row">
            <span>{p.me ? t("ui.for_me") : p.display_name}</span>
            {p.accepted_at ? <span class="meta">{t("ui.waiver_accepted_on", { date: day(p.accepted_at) })}</span>
              : <button class="small primary" onClick={() => preview("waiver.accept", { person_id: p.id })}>{p.me ? t("ui.waiver_accept_me") : t("ui.waiver_accept_for", { name: p.display_name ?? "" })}</button>}
          </li>))}</ul>
      </section>
    </main>
  );
}
