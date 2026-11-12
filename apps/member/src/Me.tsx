// Me: the member's own corner. Their name and plan, their level and club credit, their membership (or the plans to
// join, each through the usual preview), how the card on file is used, their family, and the rest of their pages:
// profile and settings, bookings, friends, receipts, their data, and signing out. Loaded when it's first opened.
import { useEffect, useState } from "preact/hooks";
import { api, club, dollars, lang, me, signOutHere, t } from "@kumi/ui";
import { MembershipBody } from "./Membership.tsx";
import { juniors } from "./ForWhom.tsx";

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

      {!m.kid && <section class="card" aria-labelledby="me-card">
        <h2 id="me-card">{t("ui.me_card_title")}</h2>
        <p class="meta">{t("ui.me_card_explain")}</p>
        {juniors.value.length > 0 && <p><a href="/family">{t("ui.family_card")}</a></p>}
      </section>}

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
