// Me: the member's own corner. Their name and plan, their level and club credit, their membership (or the plans to
// join, or switch to, each through the usual preview), the card on file (added, replaced or removed), their family,
// and the rest of their pages: profile and settings, bookings, friends, receipts, their data, and signing out.
// Loaded when it's first opened.
import { useEffect, useState } from "preact/hooks";
import { api, clubTime, club, dollars, lang, me, signOutHere, t, usePreview } from "@kumi/ui";
import { MembershipBody } from "./Membership.tsx";
import { juniors } from "./ForWhom.tsx";
import { confirmPaid, PaySheet } from "./Pay.tsx";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

export function Me() {
  const m = me.value!, c = club.value;
  const [level, setLevel] = useState<{ level: string; provisional: boolean } | null | undefined>(undefined), [credit, setCredit] = useState<number | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  useEffect(() => {
    api<{ rating: { level: string; provisional: boolean } | null }>("/my/level").then((r) => setLevel(r.rating)).catch(() => setLevel(null));
    api<{ cents: number }>("/my/credit").then((r) => setCredit(r.cents)).catch(() => {});
    // A membership from the desk shows here even when the club has no plan to join in the app.
    api<{ membership: { name: string } | null }>("/my/membership").then((r) => setPlan(r.membership?.name ?? null)).catch(() => {});
  }, [lang.value]);
  const rows: [string, string, (boolean | undefined)?][] = [
    ["/profile", t("ui.me_profile_row")],
    ["/places", t("ui.nav_my")],
    ["/friends", t("ui.friends"), !m.kid || m.kid.friends],
    ["/competitions", t("ui.nav_competitions"), c?.competitions],
    ["/lessons", t("ui.nav_lessons"), c?.lessons],
    ["/gift-cards", t("ui.gift_cards_title"), c?.gift_cards],
    ["/passes", t("ui.passes_title"), c?.passes],
    ["/receipts", t("ui.receipts_title")],
    ["/ask", t("ui.ask_title")],
    ["/inbox", t("ui.nav_inbox")],
    ["/chats", t("ui.nav_chats"), c?.players_chat],
    ["/profile", t("ui.me_data_row")],
  ];
  return (
    <main class="me">
      <section class="me-head" aria-labelledby="me-name">
        <span class="monogram" aria-hidden="true">{initials(m.person.display_name)}</span>
        <div>
          <h1 id="me-name">{m.person.display_name}</h1>
          {plan && <span class="pill">{t("ui.home_member_pill", { plan })}</span>}
        </div>
        <a class="button" href="/profile">{t("ui.me_edit_profile")}</a>
      </section>

      <div class="me-tiles">
        <a class="tile" href="/level">
          <span class="tile-label">{t("ui.nav_level")}</span>
          <strong class="tile-value">{level === undefined ? "…" : level ? Number(level.level).toFixed(2) : t("ui.no_level_yet")}</strong>
          {level?.provisional && <span class="meta">{t("ui.provisional")}</span>}
          <span class="tile-more">{t("ui.me_level_more")}</span>
        </a>
        <a class="tile" href="/receipts">
          <span class="tile-label">{t("ui.credit_title")}</span>
          <strong class="tile-value">{credit === null ? "…" : dollars(credit, lang.value)}</strong>
          <span class="tile-more">{t("ui.me_wallet_more")}</span>
        </a>
      </div>

      {(c?.memberships || plan) && <section aria-labelledby="me-membership">
        <h2 id="me-membership">{t(plan ? "ui.me_membership_title" : "ui.me_plans_title")}</h2>
        <MembershipBody embedded onPlan={setPlan} />
      </section>}

      {!m.kid && <CardOnFile />}

      {!m.kid && <section class="card" aria-labelledby="me-family">
        <h2 id="me-family">{t("ui.nav_family")}</h2>
        {juniors.value.length > 0 ? <ul class="plain">{juniors.value.map((j) => <li>{j.display_name}</li>)}</ul> : <p class="meta">{t("ui.me_family_hint")}</p>}
        <p><a class="button" href="/family">{t("ui.me_family_open")}</a></p>
      </section>}
      {m.kid && <p class="card"><a class="tap" href="/family">{t("ui.nav_family")}</a></p>}

      <section class="card list-card" aria-labelledby="me-more">
        <h2 id="me-more">{t("ui.me_more_title")}</h2>
        <ul class="plain">{rows.filter((r) => r.length < 3 || r[2]).map(([href, label]) => <li><a class="tap row-link" href={href}>{label}</a></li>)}</ul>
        <button class="danger" onClick={() => signOutHere()}>{t("ui.sign_out")}</button>
      </section>
    </main>
  );
}

type CardInfo = { card: { brand: string; last4: string; exp_month: number | null; exp_year: number | null } | null;
  uses: { membership: { name: string; on: string | null } | null; kids: string[] | null; deadlines: number; next_deadline: string | null; weekly: number } };
const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay" };
const brandName = (b: string) => BRANDS[b.toLowerCase()] ?? b.charAt(0).toUpperCase() + b.slice(1);
const shortDay = (iso: string) => clubTime(iso, { weekday: "short", day: "numeric", month: "short" });

/** The card on file: the one card everything later goes on (a court's unpaid parts at the deadline, renewals, the
 *  family card), what relies on it now, and adding, replacing or removing it. Adding or replacing is Stripe's card form
 *  saving a card (nothing charged or held); removing goes through the preview, which says what relied on it first. */
function CardOnFile() {
  const [d, setD] = useState<CardInfo | null | undefined>(undefined), [adding, setAdding] = useState(false), [note, setNote] = useState<string | null>(null);
  const [provider, setProvider] = useState("test");
  const load = () => api<CardInfo>("/my/card").then(setD).catch(() => setD(null));
  const { preview, sheet } = usePreview(() => void load());
  useEffect(() => {
    void load(); api<{ provider: string }>("/payments/config").then((c) => setProvider(c.provider)).catch(() => {});
    // Back from a bank's own check while saving the card: see whether it was saved.
    const back = new URLSearchParams(location.search).get("card");
    if (back) { history.replaceState(null, "", "/account"); confirmPaid("", 8, `/my/card/${encodeURIComponent(back)}/check`).then((ok) => { if (ok) setNote(t("ui.card_saved")); void load(); }); }
  }, [lang.value]);
  const saved = () => { setAdding(false); setNote(t("ui.card_saved")); void load(); };
  const c = d?.card, u = d?.uses;
  const uses = u ? [u.membership?.on && t("ui.card_pays_membership", { name: u.membership.name, date: shortDay(u.membership.on) }),
    u.kids && (u.kids.length ? t("ui.card_pays_kids", { names: u.kids.join(", ") }) : t("ui.card_pays_family")),
    u.deadlines > 0 && t("ui.card_pays_deadlines", { count: u.deadlines }), u.weekly > 0 && t("ui.card_pays_weekly", { count: u.weekly })].filter(Boolean) : [];
  return (
    <section class="card" aria-labelledby="me-card">
      <h2 id="me-card">{t("ui.me_card_title")}</h2>
      <p class="meta">{t("ui.card_on_file_explain")}</p>
      {sheet}
      {adding && <PaySheet cardOnFile replace={Boolean(c)} amountCents={0} name="" onClose={() => setAdding(false)} onPaid={saved} />}
      {adding && provider === "test" && import.meta.env.DEV && <p><button class="primary" onClick={async () => { await api("/dev/card", {}); saved(); }}>{t("ui.save_card_test")}</button></p>}
      {note && <p class="note" role="status">{note}</p>}
      {d === undefined ? <p class="meta">{t("ui.loading")}</p> : c ? <>
        <div class="card-on-file">
          <span class="card-chip" aria-hidden="true">{t("ui.card_chip")}</span>
          <span class="card-what"><strong>{c.last4 ? t("ui.card_ending", { brand: brandName(c.brand), last4: c.last4 }) : t("ui.me_card_title")}</strong>
            <span class="meta">{[c.exp_month && c.exp_year ? t("ui.card_expires", { date: `${String(c.exp_month).padStart(2, "0")}/${String(c.exp_year).slice(-2)}` }) : null, t("ui.card_used_for")].filter(Boolean).join(" · ")}</span></span>
          <span class="tag on">{t("ui.card_default")}</span>
        </div>
        {uses.length > 0 && <ul class="card-uses meta">{uses.map((x) => <li>{x}</li>)}</ul>}
        <p class="card-actions"><button onClick={() => { setNote(null); setAdding(true); }}>{t("ui.card_replace")}</button>{" "}
          <button onClick={() => { setNote(null); void preview("card.remove", { person_id: me.value!.person.id }); }}>{t("ui.card_remove")}</button></p>
      </> : <>
        <p class="meta">{t("ui.card_none")}</p>
        <p><button class="primary" onClick={() => { setNote(null); setAdding(true); }}>{t("ui.card_add")}</button></p>
      </>}
      {juniors.value.length > 0 && <p><a href="/family">{t("ui.family_card")}</a></p>}
    </section>
  );
}
