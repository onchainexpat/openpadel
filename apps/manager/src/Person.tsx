// One person: who they are, their roles (given and taken away here), their sign-ups and their email answer.
import { useEffect, useState } from "preact/hooks";
import type { Key } from "@kumi/i18n";
import { useLocation } from "preact-iso";
import { AccountData, api, club, dollars, emailedNote, lang, coversLocation, mayDo, me, ReceiptSheet, t, usePreview, type ReceiptView, clubTime, serverNow } from "@kumi/ui";
import { WeeklyCourts, type WeeklyCourt } from "@kumi/ui/weekly";
import { GiveMembership, MembershipButtons, MembershipDesk, membershipLine, type Plan } from "./Memberships.tsx";
import { amountStep, capFor, fromMajor, plainAmount, toMajor } from "@kumi/i18n/format";
import { playtomicParts } from "./paid_line.ts";

type Role = { key: string; name?: string | null; location_id: string | null; location_name: string | null };
type P = {
  id: string; display_name: string; email: string | null; locale: string; created_via: string; created_at: string;
  email_problem: { reason: "bounce" | "complaint" | "provider"; since: string; detail: string | null } | null;
  roles: Role[]; places: { id: string; status: string; program_id: string; name: string; first_start: string | null }[];
  /** Whether the reader sees money: without it (a coach's own student, a role covering members only) the server leaves
   *  out what was paid or is owed, prices, refunds, balances and a kid's spending, and the page leaves out their lines and buttons. */
  money?: boolean;
  bookings: { id: string; code: string; kind: string; status: string; court: string; location_id: string | null; starts_at: string; price_cents?: number; organiser: boolean; paid_cents?: number; off_cents?: number; pt_cents?: number;
    refundable?: { payment_id: string; left_cents: number }[] }[];
  failed_refunds: { id: string; amount_cents: number; failure: string | null; created_at: string }[];
  series: WeeklyCourt[];
  to_give_back: { id: string; amount_cents: number; method: string; created_at: string }[];
  credit_cents: number | null;
  consent: { channel: string; purpose: string; granted: boolean }[];
  membership: { id: string; name: string; status: string; source: string; started_at: string; ends_on: string | null; cancel_at_period_end: boolean; note: string | null; card_saved?: boolean; paused_until?: string | null;
    price_cents?: number | null; balance_cents?: number; due?: { cents: number; next: boolean } | null } | null;
  plans: (Omit<Plan, "members"> & { members?: number })[];
  junior: boolean; birth_year: number | null; family_role: "adult" | "member" | "junior" | null;
  family: { id: string; display_name: string; birth_year: number | null; role: "adult" | "member" | "junior" }[];
  waiver: { version_no: number; accepted_on: string | null; accepted_by: string | null } | null;
  kid: { email: string | null; rules: string; spent_cents?: number } | null;
  covered_by: { membership_id: string; payer_id: string; payer: string; plan: string } | null; also_covers: string[];
  redacted_at: string | null;
  tags: { id: string; name: string }[];
  sign_in?: { authenticator: boolean; passkeys: number; recovery_left: number };
  playtomic?: { booking_id: string; starts_at: string; court: string; kind: string; price?: string | null; cancelled: boolean; taken_over_as: string | null; cancelled_here_as?: string | null; others: string[] }[];
};
const STAFF_ROLES = ["manager", "front_desk", "coach", "accountant", "owner"] as const;
/** Who may change someone's email here, as the server decides it (app.ts deskForEmail): front desk and up, or someone whose
 *  only staff roles are the club's own and cover members. A coach isn't offered it. */
const changesEmails = () => me.value?.areas ? me.value.areas.includes("members") : (me.value?.roles ?? []).some((r) => ["owner", "manager", "front_desk"].includes(r.key));

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
  // Opened at one booking (Reports links to /people/:id#booking-...): once it's on the page, bring it into view.
  const loaded = Boolean(p);
  useEffect(() => { if (loaded && location.hash.startsWith("#booking-")) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" }); }, [loaded, id]);
  if (!p) return <main class="card"><p>{t("ui.loading")}</p></main>;

  const date = (iso: string) => clubTime(iso, { dateStyle: "medium" });
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
        {p.email_problem && <p class="note" role="status">{t(`ui.email_held_${p.email_problem.reason}` as Key, { date: date(p.email_problem.since) })}{p.email_problem.detail ? ` (${p.email_problem.detail})` : ""}{" "}
          {mayDo("person.email_unsuppress") && <button class="small" onClick={() => preview("person.email_unsuppress", { person_id: p.id })}>{t("ui.email_held_clear")}</button>}</p>}
        <p class="meta">{t("ui.joined", { date: date(p.created_at), how: t(`ui.via_${p.created_via}` as Key) })} · {p.locale === "es" ? "Español" : "English"}</p>
        {!p.junior && <p class="meta">{t("ui.club_news_email")}: {news ? t(news.granted ? "ui.consent_yes" : "ui.consent_no") : t("ui.consent_unknown")}</p>}
        {texts && <p class="meta">{t("ui.texts_staff")}: {t(texts.granted ? "ui.consent_yes" : "ui.consent_no")}</p>}
        <p><a href={`/people/${p.id}/level`}>{t("ui.see_level")}</a></p>
      </section>

      {tags && <section class="card">
        <h2>{t("ui.tags_title")}</h2>
        {p.tags.length ? <p class="chips">{p.tags.map((x) => <span class="chip">{x.name} {mayDo("person.untag") && <button class="link" aria-label={t("ui.untag", { tag: x.name })} onClick={() => preview("person.untag", { person_id: p.id, tag_id: x.id })}>×</button>}</span>)}</p>
          : <p class="meta">{t("ui.no_person_tags")}</p>}
        {mayDo("person.tag") && <form class="card-form" onSubmit={(e) => { e.preventDefault(); const known = tags.find((x) => x.name.toLowerCase() === newTag.trim().toLowerCase()); preview("person.tag", known ? { person_id: p.id, tag_id: known.id } : { person_id: p.id, name: newTag.trim() }); }}>
          <label>{t("ui.add_tag")}<input list="club-tags" required maxLength={40} value={newTag} onInput={(e) => setNewTag(e.currentTarget.value)} /></label>
          <datalist id="club-tags">{tags.filter((x) => !p.tags.some((y) => y.id === x.id)).map((x) => <option value={x.name} />)}</datalist>
          <button>{t("ui.preview")}</button>
        </form>}
      </section>}

      <section class="card">
        <h2>{t("ui.person_household")}</h2>
        {p.junior && <p>{t(p.kid ? "ui.person_kid" : "ui.person_junior", { year: p.birth_year ?? "", names: p.family.filter((x) => x.role === "adult").map((x) => x.display_name).join(", ") })}</p>}
        {p.kid && <p class="meta">{t("ui.staff_kid_login", { email: p.kid.email ?? "" })}. {p.kid.rules}</p>}
        {p.family.length > 0 && <ul class="plain">{p.family.map((x) => (
          <li class="row"><a href={`/people/${x.id}`}>{x.display_name}</a><span class="meta">{x.role === "junior" ? `${t("ui.junior_tag")}${x.birth_year ? `, ${t("ui.junior_born", { year: x.birth_year })}` : ""}` : ""}</span></li>))}</ul>}
        <p class="meta">{!p.waiver ? t("ui.waiver_off") : `${t("ui.person_waiver")}: `}{!p.waiver ? null : p.waiver.accepted_on
          ? t("ui.waiver_accepted_by", { version: p.waiver.version_no, date: date(`${p.waiver.accepted_on}T12:00:00Z`), name: p.waiver.accepted_by ?? "" }) : t("ui.waiver_not_accepted", { version: p.waiver.version_no })}</p>
        {!p.junior && p.family_role !== "member" && mayDo("household.add_junior") && <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("household.add_junior", { person_id: p.id, display_name: jName, birth_year: Number(jYear) }); }}>
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
          {p.money !== false && mayDo("membership.record_payment") && <MembershipDesk key={`${p.membership.id}-${p.membership.due?.cents ?? 0}`} m={p.membership} send={preview} />}
        </section>
      ) : p.covered_by ? (
        <section class="card">
          <h2>{t("ui.membership")}</h2>
          <p><a href={`/people/${p.covered_by.payer_id}`}>{t("ui.staff_covered_by", { name: p.covered_by.payer, plan: p.covered_by.plan })}</a></p>
        </section>
      ) : p.plans.length > 0 && (mayDo("membership.grant") || mayDo("membership.sell")) && <GiveMembership key={p.id} plans={p.plans.map((x) => ({ ...x, members: 0 }))} send={preview} person={p} />}

      {!p.junior && <section class="card">
        <h2>{t("ui.person_roles")}</h2>
        {staffRoles.length === 0 ? <p class="meta">{t("role.member")}</p> : (
          <ul class="plain">{staffRoles.map((r) => (
            <li class="row"><span>{r.name ?? t(`role.${r.key}` as Key)}{r.location_name ? ` · ${r.location_name}` : ""}</span>
              {privacy && <button class="small" onClick={() => preview("role.remove", { person_id: p.id, role: r.key, location_id: r.location_id ?? undefined })}>{t("ui.remove")}</button>}</li>
          ))}</ul>
        )}
        {/* Only an owner or a manager gives or takes away roles; the server refuses anyone else, so the form isn't offered. */}
        {privacy && <form class="card-form" onSubmit={(e) => { e.preventDefault(); preview("role.assign", { person_id: p.id, role, location_id: where || undefined }); }}>
          <label>{t("ui.add_role")}<select value={role} onChange={(e) => setRole(e.currentTarget.value)}>{STAFF_ROLES.map((k) => <option value={k}>{t(`role.${k}` as Key)}</option>)}{custom.map((r) => <option value={r.key}>{r.name}</option>)}</select></label>
          <label>{t("ui.location")}<select value={where} onChange={(e) => setWhere(e.currentTarget.value)}><option value="">{t("ui.everywhere")}</option>{locations.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>
          <button>{t("ui.preview")}</button>
        </form>}
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
      <PersonBookings bookings={p.bookings} preview={preview} />
      {p.playtomic && p.playtomic.length > 0 && <PersonPlaytomic rows={p.playtomic} />}
      <WeeklyCourts series={p.series ?? []} preview={preview} staff money={p.money !== false} />
      {p.failed_refunds?.length > 0 && <section class="card">
        <h2>{t("ui.refunds_failed")}</h2>
        <ul class="plain">{p.failed_refunds.map((r) => (
          <li class="row" key={r.id}>
            <span>{dollars(r.amount_cents, lang.value)} · {clubTime(r.created_at, { dateStyle: "medium" })}</span>
            {mayDo("refund.resend") && <button class="small" onClick={() => preview("refund.resend", { refund_id: r.id })}>{t("ui.send_again")}</button>}
          </li>))}</ul>
      </section>}
      {p.to_give_back?.length > 0 && <section class="card">
        <h2>{t("ui.to_give_back")}</h2>
        <ul class="plain">{p.to_give_back.map((r) => (
          <li class="row" key={r.id}>
            <span>{dollars(r.amount_cents, lang.value)} {t(`paid_by.${r.method}` as Key)} · {clubTime(r.created_at, { dateStyle: "medium" })}</span>
            {mayDo("refund.give_back") && <button class="small" onClick={() => preview("refund.give_back", { refund_id: r.id })}>{t("ui.given_back")}</button>}
          </li>))}</ul>
      </section>}
      {(p.credit_cents ?? 0) > 0 && <section class="card">
        <h2>{t("ui.credit_title")}</h2>
        <p>{t("ui.credit_held", { amount: dollars(p.credit_cents!, lang.value) })}</p>
        {mayDo("credit.pay_out") && <form class="inline" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget as HTMLFormElement;
          const cents = fromMajor(Number((f.elements.namedItem("amount") as HTMLInputElement).value));
          preview("credit.pay_out", { person_id: p.id, cents, method: (f.elements.namedItem("method") as HTMLSelectElement).value }); }}>
          <input name="amount" type="number" min={amountStep()} step={amountStep()} max={plainAmount(p.credit_cents!)} defaultValue={plainAmount(p.credit_cents!)} aria-label={t("ui.amount")} />
          <select name="method" aria-label={t("ui.pay_out_how")}><option value="cash">{t("paid_by.cash")}</option><option value="other">{t("paid_by.other")}</option></select>
          <button class="small">{t("ui.credit_pay_out")}</button></form>}
      </section>}
      {club.value?.gift_cards && mayDo("gift_card.sell") && <section class="card">
        <h2>{t("action.gift_card.sell")}</h2>
        <form class="inline" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget as HTMLFormElement;
          preview("gift_card.sell", { person_id: p.id, cents: fromMajor(Number((f.elements.namedItem("amount") as HTMLInputElement).value)), method: (f.elements.namedItem("method") as HTMLSelectElement).value,
            for_name: (f.elements.namedItem("for") as HTMLInputElement).value || undefined }); }}>
          <input name="amount" type="number" min="1" step="1" defaultValue={String(toMajor(capFor(5000)))} aria-label={t("ui.gift_card_amount")} />
          <input name="for" maxLength={80} placeholder={t("ui.gift_card_for")} aria-label={t("ui.gift_card_for")} />
          <select name="method" aria-label={t("ui.desk_taken_how")}><option value="cash">{t("paid_by.cash")}</option><option value="terminal">{t("paid_by.terminal")}</option><option value="other">{t("paid_by.other")}</option></select>
          <button class="small">{t("action.gift_card.sell")}</button></form>
      </section>}
      {(mayDo("pass.sell") || mayDo("pass.refund")) && <PersonPasses personId={p.id} preview={preview} key={`passes-${p.id}-${String(sheet ? 1 : 0)}`} />}
      <PersonReceipts personId={p.id} preview={preview} />
      {privacy && <PersonAssistants personId={p.id} preview={preview} key={`${p.id}-${String(sheet ? 1 : 0)}`} />}
      {!p.junior && p.id !== me.value?.person.id && (staffRoles.length === 0 || owner) && changesEmails() && <ChangeEmail personId={p.id} name={p.display_name} onDone={load} />}
      {privacy && <AccountData personId={p.id} self={p.id === me.value?.person.id} onDeleted={() => route("/people")} />}
      {sheet}
    </main>
  );
}

/** Their court bookings and lessons: the desk cancels one (the club's rule, everything back or nothing back) or
 *  refunds part of a card payment on one that stays (leaving and refunding are separate decisions). */
/** Paid in Playtomic, and what the organiser still owes here (time added here), both said; null when not paid there. */
function ptLine(b: P["bookings"][number]): string | null {
  if (b.price_cents === undefined || b.paid_cents === undefined) return null;
  const owed = b.organiser && b.status !== "cancelled" ? b.price_cents - b.paid_cents - (b.off_cents ?? 0) : 0;
  return playtomicParts({ paid: b.paid_cents, pt: b.pt_cents ?? 0, owed })?.map((x) => t(x.key, { amount: dollars(x.cents, lang.value) })).join(" · ") ?? null;
}
function PersonBookings({ bookings, preview }: { bookings: P["bookings"]; preview: (action: string, input: unknown) => Promise<void> | void }) {
  const when = (iso: string) => clubTime(iso, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <section class="card">
      <h2>{t("ui.person_bookings")}</h2>
      {bookings.length === 0 ? <p class="meta">{t("ui.person_no_bookings")}</p> : (
        <ul class="plain">{bookings.map((b) => {
          const upcoming = b.status !== "cancelled" && new Date(b.starts_at).getTime() > serverNow();
          return (
            <li class="row" key={b.id} id={`booking-${b.id}`}>
              <span>{when(b.starts_at)} · {b.court} · {b.code}</span>
              <span class="meta">{[b.status === "cancelled" ? t("ui.status_cancelled") : null, b.paid_cents && b.off_cents ? t("ui.paid_by_them_off", { amount: dollars(b.paid_cents, lang.value), off: dollars(b.off_cents, lang.value) }) : b.paid_cents && ptLine(b) ? ptLine(b)
                : b.paid_cents ? t("ui.paid_by_them", { amount: dollars(b.paid_cents, lang.value) }) : null].filter(Boolean).join(" · ")}</span>
              {upcoming && mayDo("booking.cancel") && coversLocation(b.location_id) && <form class="inline" onSubmit={(e) => { e.preventDefault(); preview("booking.cancel", { booking_id: b.id, refund: ((e.currentTarget as HTMLFormElement).elements.namedItem("refund") as HTMLSelectElement).value }); }}>
                <select name="refund" aria-label={t("ui.refund")}><option value="rule">{t("ui.refund_by_rule")}</option><option value="full">{t("ui.refund_everything")}</option><option value="none">{t("ui.refund_nothing")}</option><option value="credit">{t("ui.refund_as_credit")}</option></select>
                <button class="small">{t("ui.cancel_booking")}</button></form>}
              {b.status !== "cancelled" && mayDo("booking.refund") && coversLocation(b.location_id) && (b.refundable ?? []).map((r) => (
                <form class="inline" key={r.payment_id} onSubmit={(e) => { e.preventDefault(); const v = Number(((e.currentTarget as HTMLFormElement).elements.namedItem("amount") as HTMLInputElement).value);
                  preview("booking.refund", { booking_id: b.id, payment_id: r.payment_id, cents: fromMajor(v) }); }}>
                  <label>{t("ui.refund_up_to", { amount: dollars(r.left_cents, lang.value) })} <input name="amount" type="number" min={amountStep()} step={amountStep()} max={plainAmount(r.left_cents)} value={plainAmount(r.left_cents)} /></label>
                  <button class="small">{t("ui.refund")}</button></form>))}
            </li>);
        })}</ul>
      )}
    </section>
  );
}

/** Their bookings in the club's copy of Playtomic (kept from the first read, moving-from-playtomic.md), read only. */
function PersonPlaytomic({ rows }: { rows: NonNullable<P["playtomic"]> }) {
  const when = (iso: string) => clubTime(iso, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <section class="card">
      <h2>{t("ui.person_playtomic")}</h2>
      <p class="meta">{t("ui.person_playtomic_help")}</p>
      <ul class="plain">{rows.map((b) => (
        <li class="row" key={b.booking_id}>
          <span>{when(b.starts_at)} · {b.court} · {b.kind}</span>
          <span class="meta">{[b.price, b.cancelled ? t("ui.person_playtomic_cancelled") : null, b.taken_over_as ? t("ui.person_playtomic_taken", { code: b.taken_over_as }) : b.cancelled_here_as ? t("ui.person_playtomic_taken_cancelled", { code: b.cancelled_here_as }) : null,
            b.others.length ? t("ui.person_playtomic_with", { names: b.others.join(", ") }) : null].filter(Boolean).join(" · ")}</span>
        </li>))}</ul>
    </section>
  );
}

type ReceiptRow = { id: string; number: string; kind: "payment" | "refund"; total: string; when: string; what: string; more: number; for_name: string | null; paid_by: string | null };
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
            <span class="meta">{[r.when, `${r.what}${r.more ? ` ${t("ui.receipt_more", { count: r.more })}` : ""}`,
              ...(r.for_name ? [t("ui.receipt_row_for", { name: r.for_name })] : []), ...(r.paid_by ? [t("ui.receipt_paid_by", { name: r.paid_by })] : []),
              `${r.kind === "refund" ? `${t("ui.receipt_refund_tag")} ` : ""}${r.total}`].join(" · ")}</span>
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
      <ul class="plain">{list.map((a) => <li class="row"><span><strong>{a.name}</strong><br /><span class="meta">{t("ui.assistant_connected", { when: clubTime(a.connected_at, { dateStyle: "medium" }) })}. {t("ui.assistant_spent", { spent: dollars(a.spent_cents, lang.value), cap: dollars(a.weekly_cap_cents, lang.value) })}</span></span>
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
        <p class="meta">{emailedNote(t("ui.staff_email_code_sent", { name, email }))}</p>
        <label>{t("ui.code")}<input inputMode="numeric" autoComplete="one-time-code" required maxLength={8} value={code} onInput={(e) => setCode(e.currentTarget.value)} /></label>
        <button>{t("ui.confirm")}</button>
      </form>}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}

/** A person's passes (passes.ts), with a manager's refund of the unused uses, and the desk selling one of the
 *  club's passes for its price. */
function PersonPasses({ personId, preview }: { personId: string; preview: (action: string, input: unknown) => Promise<void> | void }) {
  type Product = { id: string; name: string; price_cents: number; uses: number; on_sale: boolean };
  type Pass = { id: string; name: string; uses: number; uses_left: number; status: string; expires_at: string | null };
  const [products, setProducts] = useState<Product[]>([]), [mine, setMine] = useState<Pass[]>([]);
  useEffect(() => {
    api<{ products: Product[] }>("/staff/passes").then((r) => setProducts(r.products.filter((x) => x.on_sale))).catch(() => setProducts([]));
    api<Pass[]>(`/staff/people/${personId}/passes`).then(setMine).catch(() => setMine([]));
  }, [personId]);
  if (products.length === 0 && mine.length === 0) return null;
  return <section class="card">
    <h2>{t("ui.passes_title")}</h2>
    {mine.length > 0 && <ul class="plain">{mine.map((x) => <li class="row" key={x.id}>
      <span>{x.name} · {x.status === "refunded" ? t("ui.pass_refunded") : t("ui.pass_uses_left", { left: String(x.uses_left), uses: String(x.uses) })}</span>
      {x.status === "active" && x.uses_left > 0 && mayDo("pass.refund") && <button class="small" onClick={() => preview("pass.refund", { pass_id: x.id })}>{t("ui.pass_refund")}</button>}
    </li>)}</ul>}
    {products.length > 0 && mayDo("pass.sell") && <form class="inline" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget as HTMLFormElement;
      const product = products.find((x) => x.id === (f.elements.namedItem("product") as HTMLSelectElement).value)!;
      preview("pass.sell", { person_id: personId, product_id: product.id, cents: product.price_cents, method: (f.elements.namedItem("method") as HTMLSelectElement).value }); }}>
      <select name="product" aria-label={t("ui.pass_sell")}>{products.map((x) => <option value={x.id} key={x.id}>{x.name} · {dollars(x.price_cents, lang.value)}</option>)}</select>
      <select name="method" aria-label={t("ui.desk_taken_how")}><option value="cash">{t("paid_by.cash")}</option><option value="terminal">{t("paid_by.terminal")}</option><option value="other">{t("paid_by.other")}</option></select>
      <button class="small">{t("ui.pass_sell")}</button></form>}
  </section>;
}
