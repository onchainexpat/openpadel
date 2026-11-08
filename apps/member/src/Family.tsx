// Family: a parent's household (the adults, the juniors they manage, and invite links for another parent),
// an invite link opened by the other parent, and the club's waiver for the member and each junior. A parent
// also turns on a login for a kid of 13 or more, sets what they may book on the family card, answers what
// they ask for, and saves that card; a kid with a login sees their own rules and requests here.
// Loaded only when one of these pages is opened, to keep the app small.
import { useEffect, useState } from "preact/hooks";
import { AccountData, api, ApiError, dollars, lang, me, t, usePreview, clubTime, serverNow } from "@kumi/ui";
import { loadFamily } from "./ForWhom.tsx";
import { BringLevel, type L } from "./MyLevel.tsx";
import type { Key } from "@kumi/i18n";
import { isConfirming, PaySheet, useConfirming } from "./Pay.tsx";
import { capFor, fromMajor, toMajor, formatLocale } from "@kumi/i18n/format";

type Person = { id: string; display_name: string; me?: boolean };
type Junior = Person & { birth_year: number | null; level: number | null; waiver: { version_no: number; accepted_at: string | null } | null };
type Page = { role: "adult" | "member" | "junior" | null; household: { adults: Person[]; members: Person[]; juniors: Junior[]; invites: { id: string; code: string; until: string }[] } | null };
type Rules = { open_matches: boolean; courts: boolean; programs: boolean; lessons: boolean; monthly_limit_cents: number; friends: boolean; texts: boolean };
type Kids = { kids: { id: string; own_login: boolean; email: string | null; rules: Rules | null; spent_cents: number }[]; requests: { id: string; name: string; cents: number; what: string }[];
  to_pay: { payment_id: string; name: string; cents: number; what: string }[]; card: { saved_by: string; saved_on: string | null } | null };
const KINDS = ["open_matches", "courts", "programs", "lessons"] as const;
/** A kid can have a login of their own from the year they turn this. */
const KID_AGE = 13;

const dayWords = (date: string) => new Intl.DateTimeFormat(formatLocale(lang.value), { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const usd = (cents: number) => dollars(cents, lang.value);

export function Family() {
  return me.value?.kid ? <KidHome /> : <ParentFamily />;
}

function ParentFamily() {
  const [f, setF] = useState<Page | null>(null), [name, setName] = useState(""), [year, setYear] = useState(""), [copied, setCopied] = useState<string | null>(null);
  const [loginFor, setLoginFor] = useState<string | null>(null), [email, setEmail] = useState("");
  const [k, setK] = useState<Kids | null>(null), [kidLoginFor, setKidLoginFor] = useState<string | null>(null), [rulesFor, setRulesFor] = useState<string | null>(null);
  // A junior's data: downloaded, or their account deleted (only by a parent who alone manages them; the server says).
  const [dataFor, setDataFor] = useState<string | null>(null);
  // A junior's level: where it stands, and one brought from another app while they're new here.
  const [levelFor, setLevelFor] = useState<string | null>(null);
  const [paying, setPaying] = useState<{ id: string; cents: number; name: string } | "card" | null>(null), [note, setNote] = useState<string | null>(null), [provider, setProvider] = useState("test");
  const loadKids = () => api<Kids>("/my/kids").then(setK);
  const load = () => Promise.all([api<Page>("/my/household").then(setF), loadKids()]);
  const { preview, sheet } = usePreview(() => { setName(""); setYear(""); setLoginFor(null); setKidLoginFor(null); setRulesFor(null); setEmail(""); void load(); void loadFamily(); });
  useEffect(() => { void load(); }, [lang.value]);
  useEffect(() => { api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {}); }, []);
  useConfirming((k?.to_pay ?? []).map((p) => p.payment_id), loadKids);
  /** A parent's yes: done there and then, and paid on the family card. */
  const approve = async (id: string) => {
    setNote(null);
    try {
      const r = await api<{ outcome: "done" | "failed"; paid?: "paid" | "parent" | null; message?: string }>(`/my/kids/requests/${id}/approve`, {});
      setNote(r.outcome === "failed" ? r.message ?? "" : r.paid === "parent" ? t("ui.kid_approved_parent") : t("ui.kid_approved_done"));
    } catch (e) { setNote(e instanceof ApiError ? e.message : String(e)); }
    void loadKids();
  };
  if (!f) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const pid = me.value!.person.id, h = f.household, parent = !h || f.role === "adult";
  const kidOf = (id: string) => k?.kids.find((x) => x.id === id);
  const link = (code: string) => `${location.origin}/family/join/${code}`;
  const copy = async (code: string) => { await navigator.clipboard?.writeText(link(code)).catch(() => {}); setCopied(code); };
  const share = (code: string) => navigator.share?.({ title: t("ui.invite_parent"), url: link(code) }).catch(() => {});
  const thisYear = new Date(serverNow()).getFullYear();
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
            <li><div class="row">
              <span>{j.display_name}{j.birth_year ? <span class="meta"> · {t("ui.junior_born", { year: j.birth_year })}</span> : null}
                {j.level !== null ? <span class="meta"> · {t("ui.junior_level", { level: j.level.toFixed(2) })}</span> : null}
                {j.waiver ? <span class={j.waiver.accepted_at ? "meta" : "badge warn"}> {j.waiver.accepted_at ? t("ui.waiver_ok") : t("ui.waiver_missing")}</span> : null}</span>
              {parent && <span>
                {j.birth_year && thisYear - j.birth_year >= 18 && <button class="small" onClick={() => setLoginFor(j.id)}>{t("ui.give_login")}</button>}{" "}
                {j.birth_year && thisYear - j.birth_year >= KID_AGE && thisYear - j.birth_year < 18 && !kidOf(j.id)?.own_login
                  && <button class="small" onClick={() => setKidLoginFor(j.id)}>{t("ui.kid_login_turn_on")}</button>}{" "}
                {kidOf(j.id)?.own_login && <><button class="small" onClick={() => setRulesFor(rulesFor === j.id ? null : j.id)}>{t("ui.kid_rules_button")}</button>{" "}
                  <button class="small" onClick={() => preview("kid.remove_login", { person_id: j.id })}>{t("ui.kid_login_off")}</button>{" "}</>}
                <button class="small" onClick={() => preview("household.remove_junior", { person_id: j.id })}>{t("ui.remove")}</button>{" "}
                <button class="small" onClick={() => setLevelFor(levelFor === j.id ? null : j.id)}>{t("ui.junior_level_button")}</button>{" "}
                <button class="small" onClick={() => setDataFor(dataFor === j.id ? null : j.id)}>{t("ui.junior_data")}</button>
              </span>}
              </div>
              {kidOf(j.id)?.own_login && <div class="meta">{t("ui.kid_has_login", { email: kidOf(j.id)!.email ?? "" })} · {t("ui.kid_spent", { spent: usd(kidOf(j.id)!.spent_cents), limit: usd(kidOf(j.id)!.rules!.monthly_limit_cents) })}</div>}
              {levelFor === j.id && <JuniorLevel id={j.id} name={j.display_name} onChanged={() => void load()} />}
              {dataFor === j.id && <AccountData personId={j.id} self={false} onDeleted={() => { setDataFor(null); void load(); }} />}
              {rulesFor === j.id && kidOf(j.id)?.rules && <KidRules id={j.id} name={j.display_name} rules={kidOf(j.id)!.rules!} send={preview} />}
            </li>))}</ul>
          {loginFor && <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("household.give_login", { person_id: loginFor, email }); }}>
            <label>{t("ui.give_login_email")} <input type="email" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
            <button class="primary">{t("ui.give_login")}</button>
          </form>}
          {kidLoginFor && <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("kid.give_login", { person_id: kidLoginFor, email }); }}>
            <label>{t("ui.kid_login_email")} <input type="email" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
            <button class="primary">{t("ui.kid_login_turn_on")}</button>
          </form>}
        </>}
      </section>}
      {note && <p class="note" role="status" onClick={() => setNote(null)}>{note}</p>}
      {k && k.requests.length > 0 && <section class="card">
        <h2>{t("ui.kid_requests")}</h2>
        <ul class="plain">{k.requests.map((r) => (
          <li class="row"><span>{r.name}: {r.what}</span>
            <span><button class="small primary" onClick={() => approve(r.id)}>{r.cents ? t("ui.kid_request_yes_amount", { amount: usd(r.cents) }) : t("ui.kid_request_yes")}</button>{" "}
              <button class="small" onClick={() => preview("kid.decline_request", { request_id: r.id })}>{t("ui.kid_request_no")}</button></span></li>))}</ul>
      </section>}
      {k && k.to_pay.length > 0 && <section class="card">
        <h2>{t("ui.kid_to_pay")}</h2>
        <ul class="plain">{k.to_pay.map((p) => (
          <li class="row"><span>{p.name}: {p.what}</span>
            {isConfirming(p.payment_id) ? <span class="meta" role="status">{t("ui.paid_confirming")}</span>
              : <button class="small primary" onClick={() => setPaying({ id: p.payment_id, cents: p.cents, name: p.what })}>{t("ui.pay_now", { amount: usd(p.cents) })}</button>}</li>))}</ul>
      </section>}
      {parent && h && h.juniors.length > 0 && <section class="card">
        <h2>{t("ui.family_card")}</h2>
        <p class="meta">{k?.card ? t("ui.family_card_saved", { name: k.card.saved_by, date: k.card.saved_on ? dayWords(k.card.saved_on) : "" }) : t("ui.family_card_none")}</p>
        <button class={k?.card ? "small" : "primary"} onClick={() => setPaying("card")}>{k?.card ? t("ui.family_card_replace") : t("ui.family_card_save")}</button>
        {k?.card && <>{" "}<button class="small" onClick={() => preview("family_card.remove", { person_id: pid })}>{t("ui.family_card_remove")}</button></>}
      </section>}
      {paying && <PaySheet {...(paying === "card" ? { familyCard: true } : { paymentId: paying.id })} amountCents={paying === "card" ? 0 : paying.cents} name={paying === "card" ? "" : paying.name}
        onClose={() => setPaying(null)} onPaid={() => { setPaying(null); void loadKids(); }} />}
      {paying && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => {
        await api(paying === "card" ? "/dev/family/card" : `/dev/payments/${paying.id}/settle`, {}); setPaying(null); void loadKids(); }}>{t(paying === "card" ? "ui.save_card_test" : "ui.pay_test")}</button></p>}
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

/** What a kid may book on the family card on their own, as a parent sets it. */
function KidRules({ id, name, rules, send }: { id: string; name: string; rules: Rules; send: (action: string, input: unknown) => void }) {
  const [r, setR] = useState(rules), [limit, setLimit] = useState(String(toMajor(rules.monthly_limit_cents)));
  const box = (key: keyof Rules, label: string) =>
    <label class="check"><input type="checkbox" checked={Boolean(r[key])} onChange={(e) => setR({ ...r, [key]: e.currentTarget.checked })} /> {label}</label>;
  return (
    <form class="card-form" onSubmit={(e) => { e.preventDefault();
      send("kid.set_rules", { person_id: id, open_matches: r.open_matches, courts: r.courts, programs: r.programs, lessons: r.lessons, friends: r.friends, texts: r.texts, monthly_limit_cents: fromMajor(Number(limit)) }); }}>
      <p><strong>{t("ui.kid_rules", { name })}</strong></p>
      {box("open_matches", t("ui.kid_open_matches"))}
      {box("courts", t("ui.kid_courts"))}
      {box("programs", t("ui.kid_programs"))}
      {box("lessons", t("ui.kid_lessons"))}
      <label>{t("ui.kid_limit")} <input type="number" required min={0} max={toMajor(capFor(100_000))} step="1" inputMode="numeric" value={limit} onInput={(e) => setLimit(e.currentTarget.value)} /></label>
      {box("friends", t("ui.kid_friends"))}
      {box("texts", t("ui.kid_texts"))}
      <button class="primary">{t("ui.kid_save_rules")}</button>
    </form>
  );
}

/** A kid's own family page: what they can book on their own, this month's spending, and their requests. */
function KidHome() {
  type Mine = { rules: Rules; spent_cents: number; parents: string[]; card: boolean; requests: { id: string; cents: number; status: string; what: string; error: string | null }[] };
  const [k, setK] = useState<Mine | null>(null);
  const load = () => api<{ kid: Mine | null }>("/my/kid").then((r) => setK(r.kid));
  const { preview, sheet } = usePreview(() => void load());
  useEffect(() => { void load(); }, [lang.value]);
  if (!k) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const words = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${lang.value === "es" ? "y" : "and"} ${xs[xs.length - 1]}`;
  const kinds = KINDS.filter((x) => k.rules[x]).map((x) => t(`kid.kind.${x}`));
  return (
    <main>
      <h1>{t("ui.family_title")}</h1>
      {sheet}
      <section class="card">
        <p>{t("ui.kid_family", { names: words(k.parents) })}</p>
        <p>{t("ui.kid_can_book", { kinds: kinds.length ? words(kinds) : t("kid.nothing"), limit: usd(k.rules.monthly_limit_cents), spent: usd(k.spent_cents) })}</p>
        <p class="meta">{t("ui.kid_needs_ok")}</p>
      </section>
      {k.requests.length > 0 && <section class="card">
        <h2>{t("ui.kid_my_requests")}</h2>
        <ul class="plain">{k.requests.map((r) => (
          <li class="row"><span>{r.what}<span class="meta"> · {t(`ui.kid_status_${r.status}` as any)}{r.error ? `: ${r.error}` : ""}</span></span>
            {r.status === "asked" && <button class="small" onClick={() => preview("kid.withdraw_request", { request_id: r.id })}>{t("ui.kid_withdraw")}</button>}</li>))}</ul>
      </section>}
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
  const [w, setW] = useState<{ waiver: { version_no: number; body: string } | null; people: { id: string; display_name: string | null; me: boolean; by_parent?: boolean; accepted_at: string | null }[] } | null>(null);
  const load = () => api<NonNullable<typeof w>>("/my/waiver").then(setW);
  const { preview, sheet } = usePreview(() => { void load(); void loadFamily(); });
  useEffect(() => { void load(); }, [lang.value]);
  if (!w) return <main class="card"><p>{t("ui.loading")}</p></main>;
  if (!w.waiver) return <main class="card"><p>{t("ui.waiver_none")}</p></main>;
  const day = (iso: string) => clubTime(iso, { day: "numeric", month: "long", year: "numeric" });
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
              : p.by_parent ? <span class="meta">{t("ui.waiver_parent_accepts")}</span>
              : <button class="small primary" onClick={() => preview("waiver.accept", { person_id: p.id })}>{p.me ? t("ui.waiver_accept_me") : t("ui.waiver_accept_for", { name: p.display_name ?? "" })}</button>}
          </li>))}</ul>
      </section>
    </main>
  );
}

/** A junior's level as a parent sees it on Family: where it stands, and a level from another app brought (or taken
 *  away) for them while they're new here, as a player does on My level. */
function JuniorLevel({ id, name, onChanged }: { id: string; name: string; onChanged?: () => void }) {
  const [d, setD] = useState<L | null>(null);
  const load = () => api<L>(`/my/level?for=${encodeURIComponent(id)}`).then(setD);
  const { preview, sheet } = usePreview(() => { void load(); onChanged?.(); });
  useEffect(() => { void load(); }, [id, lang.value]);
  if (!d) return <p class="meta">{t("ui.loading")}</p>;
  const rv = d.review, day = (iso: string) => clubTime(iso, { dateStyle: "long" });
  return (
    <section class="card">
      <h2>{t("ui.junior_level_title", { name })}</h2>
      {sheet}
      {d.rating ? <><p class="big">{d.rating.level}</p>
          <p class="meta">{t("ui.rated_games", { count: d.rating.rated_games })}{d.rating.provisional ? ` · ${t("ui.provisional")}` : ""}</p></>
        : <p class="meta">{t("ui.level_not_yet_for")}</p>}
      {d.import && <><h3>{t("ui.level_started_from_for", { name })}</h3><p>{d.import.explanation}</p>
        {d.can_remove && <button class="small" onClick={() => preview("level.remove_import", { person_id: id })}>{t("ui.remove_import")}</button>}</>}
      {rv.open?.kind === "import" && rv.open.claim && <p class="meta">{t("ui.level_import_waiting_for", { name, source: t(`level_source.${rv.open.claim.platform}` as Key), date: day(rv.open.created_at) })}</p>}
      {d.can_claim && !d.import && !rv.open && <BringLevel d={d} name={name} send={(input) => preview("level.claim", { person_id: id, ...input })} />}
    </section>
  );
}
