// One person: who they are, their roles (given and taken away here), their sign-ups and their email answer.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { useLocation } from "preact-iso";
import { AccountData, api, dollars, lang, me, ReceiptSheet, t, usePreview, type ReceiptView } from "@kumi/ui";
import { GiveMembership, MembershipButtons, membershipLine, type Plan } from "./Memberships.tsx";

type Role = { key: string; name?: string | null; location_id: string | null; location_name: string | null };
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
  tags: { id: string; name: string }[];
  sign_in?: { authenticator: boolean; passkeys: number; recovery_left: number };
};
const STAFF_ROLES = ["manager", "front_desk", "coach", "accountant", "owner"] as const;

export function Person({ id }: { id: string }) {
  const [p, setP] = useState<P | null>(null), [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [role, setRole] = useState<string>("front_desk"), [where, setWhere] = useState(""), [jName, setJName] = useState(""), [jYear, setJYear] = useState("");
  // Tags: the club's own words for a member ("league A"); a new one is made by typing it.
  const [tags, setTags] = useState<{ id: string; name: string }[] | null>(null), [newTag, setNewTag] = useState("");
  // The club's own roles, offered alongside the built-in ones.
  const [custom, setCustom] = useState<{ key: string; name: string }[]>([]);
  const { route } = useLocation();
  const load = () => api<P>(`/staff/people/${id}`).then((x) => { setP(x); setNewTag(""); });
  const { preview, sheet } = usePreview(load);
  useEffect(() => { load(); api<{ id: string; name: string }[]>("/staff/locations").then(setLocations); api<{ id: string; name: string }[]>("/staff/tags").then(setTags).catch(() => setTags(null));
    api<{ key: string; name: string; system: boolean }[]>("/staff/roles").then((r) => setCustom(r.filter((x) => !x.system))).catch(() => setCustom([])); }, [id]);
  if (!p) return <main class="card"><p>{t("ui.loading")}</p></main>;

  const date = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium" }).format(new Date(iso));
  const news = p.consent.find((c) => c.channel === "email" && c.purpose === "club_news"), texts = p.consent.find((c) => c.channel === "sms" && c.purpose === "account");
  const staffRoles = p.roles.filter((r) => r.key !== "member");
  // A deleted account: nothing left to show or change.
  if (p.redacted_at) return <main><h1>{p.display_name}</h1><section class="card"><p>{t("ui.data_deleted_for")}</p></section></main>;
  // Owners (and managers, asking the owner) copy or delete someone's data when they ask.
  const privacy = (me.value?.roles ?? []).some((r) => r.key === "owner" || r.key === "manager");
  // Only the owner starts someone's second sign-in step over (a lost phone), and never their own.
  const owner = (me.value?.roles ?? []).some((r) => r.key === "owner") && me.value?.person.id !== p.id;
  return (
    <main>
      <h1>{p.display_name}</h1>
      <section class="card">
        <p>{p.email ?? t("ui.no_email")}</p>
        <p class="meta">{t("ui.joined", { date: date(p.created_at), how: t(`ui.via_${p.created_via}` as Key) })} · {p.locale === "es" ? "Español" : "English"}</p>
        {!p.junior && <p class="meta">{t("ui.club_news_email")}: {news ? t(news.granted ? "ui.consent_yes" : "ui.consent_no") : t("ui.consent_unknown")}</p>}
        {texts && <p class="meta">{t("ui.texts_staff")}: {t(texts.granted ? "ui.consent_yes" : "ui.consent_no")}</p>}
        <p><a href={`/people/${p.id}/level`}>{t("ui.see_level")}</a></p>
      </section>

      {tags && <section class="card">
        <h2>{t("ui.tags_title")}</h2>
        {p.tags.length ? <p class="chips">{p.tags.map((x) => <span class="chip">{x.name} <button class="link" aria-label={t("ui.untag", { tag: x.name })} onClick={() => preview("person.untag", { person_id: p.id, tag_id: x.id })}>×</button></span>)}</p>
          : <p class="meta">{t("ui.no_person_tags")}</p>}
        <form class="card-form" onSubmit={(e) => { e.preventDefault(); const known = tags.find((x) => x.name.toLowerCase() === newTag.trim().toLowerCase()); preview("person.tag", known ? { person_id: p.id, tag_id: known.id } : { person_id: p.id, name: newTag.trim() }); }}>
          <label>{t("ui.add_tag")}<input list="club-tags" required maxLength={40} value={newTag} onInput={(e) => setNewTag(e.currentTarget.value)} /></label>
          <datalist id="club-tags">{tags.filter((x) => !p.tags.some((y) => y.id === x.id)).map((x) => <option value={x.name} />)}</datalist>
          <button>{t("ui.preview")}</button>
        </form>
      </section>}

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
            <li class="row"><span>{r.name ?? t(`role.${r.key}` as Key)}{r.location_name ? ` · ${r.location_name}` : ""}</span>
              <button class="small" onClick={() => preview("role.remove", { person_id: p.id, role: r.key, location_id: r.location_id ?? undefined })}>{t("ui.remove")}</button></li>
          ))}</ul>
        )}
        <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("role.assign", { person_id: p.id, role, location_id: where || undefined }); }}>
          <label>{t("ui.add_role")}<select value={role} onChange={(e) => setRole(e.currentTarget.value)}>{STAFF_ROLES.map((k) => <option value={k}>{t(`role.${k}` as Key)}</option>)}{custom.map((r) => <option value={r.key}>{r.name}</option>)}</select></label>
          <label>{t("ui.location")}<select value={where} onChange={(e) => setWhere(e.currentTarget.value)}><option value="">{t("ui.everywhere")}</option>{locations.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>
          <button>{t("ui.preview")}</button>
        </form>
      </section>}

      {owner && p.sign_in && (p.sign_in.authenticator || p.sign_in.passkeys > 0 || p.sign_in.recovery_left > 0) && <section class="card">
        <h2>{t("ui.two_step_title")}</h2>
        <p class="meta">{[p.sign_in.authenticator ? t("ui.authenticator_on") : t("ui.authenticator_off"), t("ui.person_passkeys", { count: p.sign_in.passkeys }), t("ui.recovery_left", { count: p.sign_in.recovery_left })].join(" · ")}</p>
        <button onClick={() => preview("person.reset_sign_in", { person_id: p.id })}>{t("ui.reset_sign_in")}</button>
      </section>}

      <section class="card">
        <h2>{t("ui.person_places")}</h2>
        {p.places.length === 0 ? <p class="meta">{t("ui.person_no_places")}</p> : (
          <ul class="plain">{p.places.map((x) => (
            <li class="row"><a href={`/programs/${x.program_id}`}>{x.name}</a><span class="meta">{[x.first_start && date(x.first_start), t(`ui.place_${x.status}` as Key)].filter(Boolean).join(" · ")}</span></li>
          ))}</ul>
        )}
      </section>
      <PersonReceipts personId={p.id} preview={preview} />
      {privacy && <PersonAssistants personId={p.id} preview={preview} key={`${p.id}-${String(sheet ? 1 : 0)}`} />}
      {!p.junior && p.id !== me.value?.person.id && (staffRoles.length === 0 || owner) && <ChangeEmail personId={p.id} name={p.display_name} onDone={load} />}
      {privacy && <AccountData personId={p.id} self={p.id === me.value?.person.id} onDeleted={() => route("/people")} />}
      {sheet}
    </main>
  );
}

type ReceiptRow = { id: string; number: string; kind: "payment" | "refund"; total: string; when: string; what: string; more: number };
/** Their receipts, for whoever takes or sees the club's money (the server says who): open one to print it, or
 *  email it to them again. Nothing shows for anyone else. */
function PersonReceipts({ personId, preview }: { personId: string; preview: (action: string, input: unknown) => Promise<void> | void }) {
  const [rows, setRows] = useState<ReceiptRow[] | null>(null), [open, setOpen] = useState<ReceiptView | null>(null);
  useEffect(() => { api<ReceiptRow[]>(`/staff/receipts?person_id=${personId}`).then(setRows).catch(() => setRows(null)); setOpen(null); }, [personId, lang.value]);
  if (!rows) return null;
  const show = (id: string) => api<ReceiptView>(`/staff/receipts/${id}`).then(setOpen);
  return (
    <section class="card">
      <h2>{t("ui.receipts_title")}</h2>
      {rows.length === 0 ? <p class="meta">{t("ui.receipts_none")}</p> : (
        <ul class="plain">{rows.map((r) => (
          <li class="row"><button class="link" onClick={() => show(r.id)}>{r.number}</button>
            <span class="meta">{[r.when, `${r.what}${r.more ? ` ${t("ui.receipt_more", { count: r.more })}` : ""}`, `${r.kind === "refund" ? `${t("ui.receipt_refund_tag")} ` : ""}${r.total}`].join(" · ")}</span>
            <button class="small" onClick={() => preview("receipt.resend", { receipt_id: r.id })}>{t("ui.receipt_resend")}</button></li>
        ))}</ul>
      )}
      {open && <><ReceiptSheet r={open} /><p class="no-print"><button onClick={() => window.print()}>{t("ui.receipt_print")}</button></p></>}
    </section>
  );
}

type Assistant = { id: string; name: string; weekly_cap_cents: number; spent_cents: number; connected_at: string };
/** Someone's connected assistants, for the owner and managers: what each spent this week, and disconnecting
 *  one (its access ends at once). Hidden when there are none. */
function PersonAssistants({ personId, preview }: { personId: string; preview: (action: string, input: unknown) => Promise<void> | void }) {
  const [list, setList] = useState<Assistant[] | null>(null);
  useEffect(() => { api<Assistant[]>(`/staff/people/${personId}/assistants`).then(setList).catch(() => setList(null)); }, [personId]);
  if (!list?.length) return null;
  return (
    <section class="card">
      <h2>{t("ui.assistants_title")}</h2>
      <ul class="plain">{list.map((a) => <li class="row"><span><strong>{a.name}</strong><br /><span class="meta">{t("ui.assistant_connected", { when: new Date(a.connected_at).toLocaleDateString() })}. {t("ui.assistant_spent", { spent: dollars(a.spent_cents, lang.value), cap: dollars(a.weekly_cap_cents, lang.value) })}</span></span>
        <button class="small" onClick={() => preview("assistant.disconnect", { grant_id: a.id })}>{t("ui.assistant_disconnect")}</button></li>)}</ul>
    </section>
  );
}

/** Changing a member's email for them at the desk: a code goes to the new address, the member reads it out,
 *  and the old address is told (with its link to put it back). The server says who may. */
function ChangeEmail({ personId, name, onDone }: { personId: string; name: string; onDone: () => void }) {
  const [email, setEmail] = useState(""), [code, setCode] = useState(""), [sent, setSent] = useState(false), [error, setError] = useState(""), [open, setOpen] = useState(false);
  const send = async (e: Event) => { e.preventDefault(); setError(""); try { await api(`/staff/people/${personId}/email/start`, { email }); setSent(true); } catch (x) { setError((x as Error).message); } };
  const check = async (e: Event) => { e.preventDefault(); setError(""); try { await api(`/staff/people/${personId}/email/verify`, { code }); setOpen(false); setSent(false); setEmail(""); setCode(""); onDone(); } catch (x) { setError((x as Error).message); } };
  if (!open) return <section class="card"><button class="small" onClick={() => setOpen(true)}>{t("ui.staff_change_email")}</button></section>;
  return (
    <section class="card">
      <h2>{t("ui.staff_change_email")}</h2>
      {!sent ? <form class="card-form" onSubmit={send}>
        <label>{t("ui.staff_new_email")}<input type="email" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
        <button>{t("ui.staff_send_code")}</button> <button type="button" class="secondary" onClick={() => setOpen(false)}>{t("ui.cancel")}</button>
      </form> : <form class="card-form" onSubmit={check}>
        <p class="meta">{t("ui.staff_email_code_sent", { name, email })}</p>
        <label>{t("ui.code")}<input inputMode="numeric" autoComplete="one-time-code" required maxLength={8} value={code} onInput={(e) => setCode(e.currentTarget.value)} /></label>
        <button>{t("ui.confirm")}</button>
      </form>}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}
