// One person: who they are, their roles (given and taken away here), their sign-ups and their email answer.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { useLocation } from "preact-iso";
import { AccountData, api, lang, me, t, usePreview } from "@kumi/ui";
import { GiveMembership, MembershipButtons, membershipLine, type Plan } from "./Memberships.tsx";

type Role = { key: string; location_id: string | null; location_name: string | null };
type P = {
  id: string; display_name: string; email: string | null; locale: string; created_via: string; created_at: string;
  roles: Role[]; places: { id: string; status: string; program_id: string; name: string; first_start: string | null }[];
  consent: { channel: string; purpose: string; granted: boolean }[];
  membership: { id: string; name: string; status: string; source: string; started_at: string; ends_on: string | null; cancel_at_period_end: boolean; note: string | null; card_saved?: boolean; paused_until?: string | null } | null;
  plans: (Omit<Plan, "members"> & { members?: number })[];
  junior: boolean; birth_year: number | null; family_role: "adult" | "member" | "junior" | null;
  family: { id: string; display_name: string; birth_year: number | null; role: "adult" | "member" | "junior" }[];
  waiver: { version_no: number; accepted_on: string | null; accepted_by: string | null } | null;
  kid: { email: string | null; rules: string; spent_cents: number } | null;
  covered_by: { membership_id: string; payer_id: string; payer: string; plan: string } | null; also_covers: string[];
  redacted_at: string | null;
};
const STAFF_ROLES = ["manager", "front_desk", "coach", "accountant", "owner"] as const;

export function Person({ id }: { id: string }) {
  const [p, setP] = useState<P | null>(null), [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [role, setRole] = useState<string>("front_desk"), [where, setWhere] = useState(""), [jName, setJName] = useState(""), [jYear, setJYear] = useState("");
  const { route } = useLocation();
  const load = () => api<P>(`/staff/people/${id}`).then(setP);
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); api<{ id: string; name: string }[]>("/staff/locations").then(setLocations); }, [id]);
  if (!p) return <main class="card"><p>{t("ui.loading")}</p></main>;

  const date = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium" }).format(new Date(iso));
  const news = p.consent.find((c) => c.channel === "email" && c.purpose === "club_news");
  const staffRoles = p.roles.filter((r) => r.key !== "member");
  // A deleted account: nothing left to show or change.
  if (p.redacted_at) return <main><h1>{p.display_name}</h1><section class="card"><p>{t("ui.data_deleted_for")}</p></section></main>;
  // Owners (and managers, asking the owner) copy or delete someone's data when they ask.
  const privacy = (me.value?.roles ?? []).some((r) => r.key === "owner" || r.key === "manager");
  return (
    <main>
      <h1>{p.display_name}</h1>
      <section class="card">
        <p>{p.email ?? t("ui.no_email")}</p>
        <p class="meta">{t("ui.joined", { date: date(p.created_at), how: t(`ui.via_${p.created_via}` as Key) })} · {p.locale === "es" ? "Español" : "English"}</p>
        {!p.junior && <p class="meta">{t("ui.club_news_email")}: {news ? t(news.granted ? "ui.consent_yes" : "ui.consent_no") : t("ui.consent_unknown")}</p>}
        <p><a href={`/people/${p.id}/level`}>{t("ui.see_level")}</a></p>
      </section>

      <section class="card">
        <h2>{t("ui.person_household")}</h2>
        {p.junior && <p>{t(p.kid ? "ui.person_kid" : "ui.person_junior", { year: p.birth_year ?? "", names: p.family.filter((x) => x.role === "adult").map((x) => x.display_name).join(", ") })}</p>}
        {p.kid && <p class="meta">{t("ui.staff_kid_login", { email: p.kid.email ?? "" })}. {p.kid.rules}</p>}
        {p.family.length > 0 && <ul class="plain">{p.family.map((x) => (
          <li class="row"><a href={`/people/${x.id}`}>{x.display_name}</a><span class="meta">{x.role === "junior" ? `${t("ui.junior_tag")}${x.birth_year ? `, ${t("ui.junior_born", { year: x.birth_year })}` : ""}` : ""}</span></li>))}</ul>}
        <p class="meta">{!p.waiver ? t("ui.waiver_off") : `${t("ui.person_waiver")}: `}{!p.waiver ? null : p.waiver.accepted_on
          ? t("ui.waiver_accepted_by", { version: p.waiver.version_no, date: date(`${p.waiver.accepted_on}T12:00:00Z`), name: p.waiver.accepted_by ?? "" }) : t("ui.waiver_not_accepted", { version: p.waiver.version_no })}</p>
        {!p.junior && p.family_role !== "member" && <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("household.add_junior", { person_id: p.id, display_name: jName, birth_year: Number(jYear) }); }}>
          <label>{t("ui.junior_name")}<input required maxLength={80} value={jName} onInput={(e) => setJName(e.currentTarget.value)} /></label>
          <label>{t("ui.birth_year")}<input type="number" required inputMode="numeric" value={jYear} onInput={(e) => setJYear(e.currentTarget.value)} /></label>
          <button>{t("ui.add_junior")}</button>
        </form>}
      </section>

      {p.membership ? (
        <section class="card">
          <h2>{t("ui.membership")}</h2>
          <p><strong>{p.membership.name}</strong> {p.membership.status === "past_due" && <span class="badge">{t("ui.past_due")}</span>}</p>
          <p class="meta">{membershipLine(p.membership)}</p>
          {p.also_covers.length > 0 && <p class="meta">{t("ui.family_covers_staff", { names: p.also_covers.join(", ") })}</p>}
          <MembershipButtons m={p.membership} send={preview} />
        </section>
      ) : p.covered_by ? (
        <section class="card">
          <h2>{t("ui.membership")}</h2>
          <p><a href={`/people/${p.covered_by.payer_id}`}>{t("ui.staff_covered_by", { name: p.covered_by.payer, plan: p.covered_by.plan })}</a></p>
        </section>
      ) : p.plans.length > 0 && <GiveMembership key={p.id} plans={p.plans.map((x) => ({ ...x, members: 0 }))} send={preview} person={p} />}

      {!p.junior && <section class="card">
        <h2>{t("ui.person_roles")}</h2>
        {staffRoles.length === 0 ? <p class="meta">{t("role.member")}</p> : (
          <ul class="plain">{staffRoles.map((r) => (
            <li class="row"><span>{t(`role.${r.key}` as Key)}{r.location_name ? ` · ${r.location_name}` : ""}</span>
              <button class="small" onClick={() => preview("role.remove", { person_id: p.id, role: r.key, location_id: r.location_id ?? undefined })}>{t("ui.remove")}</button></li>
          ))}</ul>
        )}
        <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("role.assign", { person_id: p.id, role, location_id: where || undefined }); }}>
          <label>{t("ui.add_role")}<select value={role} onChange={(e) => setRole(e.currentTarget.value)}>{STAFF_ROLES.map((k) => <option value={k}>{t(`role.${k}` as Key)}</option>)}</select></label>
          <label>{t("ui.location")}<select value={where} onChange={(e) => setWhere(e.currentTarget.value)}><option value="">{t("ui.everywhere")}</option>{locations.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>
          <button>{t("ui.preview")}</button>
        </form>
      </section>}

      <section class="card">
        <h2>{t("ui.person_places")}</h2>
        {p.places.length === 0 ? <p class="meta">{t("ui.person_no_places")}</p> : (
          <ul class="plain">{p.places.map((x) => (
            <li class="row"><a href={`/programs/${x.program_id}`}>{x.name}</a><span class="meta">{[x.first_start && date(x.first_start), t(`ui.place_${x.status}` as Key)].filter(Boolean).join(" · ")}</span></li>
          ))}</ul>
        )}
      </section>
      {privacy && <AccountData personId={p.id} self={p.id === me.value?.person.id} onDeleted={() => route("/people")} />}
      {sheet}
    </main>
  );
}
