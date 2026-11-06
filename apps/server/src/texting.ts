// Registering the club's texting with US carriers through its own Twilio account (`kumi texting plan | apply |
// status`): toll-free first, since it's reviewed in days, has no brand or campaign fees, and suits a club's
// volume. The steps, each done once and recorded (texting_registration.ts in core), so running it again carries
// on where it stopped:
//   1. a toll-free number that can text: the one club.yaml names, or one Kumi buys (only with --yes: it's on
//      the club's bill, about $2.15 a month)
//   2. a Messaging Service with it, sending texts members reply with and delivery reports to this server
//   3. the toll-free verification: the business from club.yaml's texting section, and what Kumi texts and how
//      members say yes, in Kumi's own words (the sample texts are the real ones)
// Then Twilio reviews it (about three business days). The server asks how it's going every hour and the owner
// and managers hear once it's decided; a rejection is explained with its fix, and `apply` sends the corrected
// one (or, once Twilio no longer allows editing, a new one, with --yes). Local numbers (A2P 10DLC) are for
// clubs that text a lot more; they're registered in Twilio's console (docs/setup/accounts/twilio.md).
import { both, t, type Key, type Lang, type Text, formatLocale } from "@kumi/i18n";
import { numberFailures, runAsSystem, textingRegistration, textWords, type Db, type Rejection, type TextingRegistration, type TextingStatus } from "@kumi/core";
import type { TextingDetails } from "./setup.ts";
import { TwilioApi, TwilioApiError, type Form, type TollfreeVerification } from "./twilio_admin.ts";

export type StepId = "use_number" | "buy_number" | "service" | "service_update" | "add_number" | "submit" | "resubmit" | "restart" | "wait" | "approved";
export interface Step { id: StepId; text: Text; costs?: true }
export interface TextingPlan { needs: Text[]; steps: Step[]; registration: TextingRegistration | null }
export interface TextingDeps { db: Db; api: TwilioApi; club: string; details: TextingDetails | undefined; publicUrl: string; memberUrl: string; now?: () => Date }

const VOLUMES = ["10", "100", "1,000", "10,000", "100,000", "250,000", "500,000", "750,000", "1,000,000", "5,000,000"] as const;
/** Twilio's volume steps: the first one at least the club's guess. */
export function volumeStep(monthly: number): string {
  return VOLUMES.find((v) => Number(v.replace(/,/g, "")) >= monthly) ?? "10,000,000+";
}
const STATUS: Record<string, TextingStatus> = { PENDING_REVIEW: "submitted", IN_REVIEW: "in_review", TWILIO_APPROVED: "approved", TWILIO_REJECTED: "rejected" };
const base = (u: string) => u.replace(/\/$/, "");
const record = (db: Db, patch: Record<string, unknown>) => runAsSystem(db, "texting.registration_record", patch, "texting");

/** The texting details with the club's own terms and privacy links (Settings), which Twilio's reviewers open. A
 *  link named only under texting in club.yaml (where they were before the club had its own) still counts. */
export function withClubLinks(d: TextingDetails | undefined, club: { terms_url: string | null; privacy_policy_url: string | null }): TextingDetails | undefined {
  if (!d) return d;
  const terms_url = club.terms_url ?? d.terms_url, privacy_policy_url = club.privacy_policy_url ?? d.privacy_policy_url;
  return { ...d, ...(terms_url ? { terms_url } : {}), ...(privacy_policy_url ? { privacy_policy_url } : {}) };
}

/** What club.yaml's texting section still needs before the verification can go. */
export function textingNeeds(d: TextingDetails | undefined, urls: { publicUrl: string; memberUrl: string }): Text[] {
  const need = (field: string) => both("texting.needs", { field: `texting.${field}`, what: both(`texting.field.${field}` as Key) });
  const out: Text[] = [];
  if (!d) return [both("texting.needs_section")];
  for (const f of ["business_name", "business_type", "website", "address", "contact", "monthly_texts"] as const) if (d[f] === undefined) out.push(need(f));
  if (d.business_type && d.business_type !== "sole_proprietor" && !d.registration_number) out.push(need("registration_number"));
  // Twilio's reviewers open the page showing how members say yes, and Twilio posts replies to this server.
  if (!urls.memberUrl.startsWith("https://") || !urls.publicUrl.startsWith("https://")) out.push(both("texting.needs_https"));
  return out;
}

/** Kumi's description of its texts, and how members say yes, for the verification (English, as Twilio reviews it). */
export function verificationForm(d: TextingDetails, o: { club: string; memberUrl: string; numberSid: string; reference: string }): Form {
  const m = base(o.memberUrl), country = d.address?.country ?? "US";
  const sample = textWords(o.club, t("en", "msg.offered.sms", { name: "Beginner Clinic", when: "Tue, Nov 10, 6:00 PM", until: "Mon, Nov 9, 8:00 PM" }), "en", "/", m);
  const summary = d.use_case_summary ?? t("en", "texting.use_case", { club: o.club });
  return {
    BusinessName: d.business_name, DoingBusinessAs: d.doing_business_as ?? (d.business_name !== o.club ? o.club : undefined),
    BusinessWebsite: d.website, NotificationEmail: d.notification_email ?? d.contact?.email,
    BusinessType: d.business_type?.toUpperCase(),
    ...(d.business_type !== "sole_proprietor" ? { BusinessRegistrationNumber: d.registration_number, BusinessRegistrationAuthority: country === "CA" ? "CBN" : "EIN", BusinessRegistrationCountry: country } : {}),
    BusinessStreetAddress: d.address?.street, BusinessStreetAddress2: d.address?.street2, BusinessCity: d.address?.city, BusinessStateProvinceRegion: d.address?.state,
    BusinessPostalCode: d.address?.postal_code, BusinessCountry: country,
    BusinessContactFirstName: d.contact?.first_name, BusinessContactLastName: d.contact?.last_name, BusinessContactEmail: d.contact?.email, BusinessContactPhone: d.contact?.phone,
    UseCaseCategories: ["ACCOUNT_NOTIFICATIONS", "TWO_FACTOR_AUTHENTICATION"], UseCaseSummary: summary,
    ProductionMessageSample: sample, HelpMessageSample: textWords(o.club, t("en", "sms.help"), "en", "/", m),
    OptInType: "WEB_FORM", OptInImageUrls: [`${m}/public/texts`, ...(d.opt_in_image_urls ?? [])],
    AdditionalInformation: t("en", "texting.opt_in_flow", { consent: t("en", "ui.texts_consent", { club: o.club }), page: `${m}/public/texts` }),
    MessageVolume: volumeStep(d.monthly_texts ?? 1000), PrivacyPolicyUrl: d.privacy_policy_url, TermsAndConditionsUrl: d.terms_url,
    AgeGatedContent: false, TollfreePhoneNumberSid: o.numberSid, ExternalReferenceId: o.reference, CustomerProfileSid: d.customer_profile_sid,
  };
}

// Rejection codes Twilio documents for toll-free verification, and what fixes each. Kept as data: Twilio adds
// codes (2025), and anything not here shows Twilio's own words.
const FIXES: Record<number, string> = { 30445: "texting.fix.business", 30446: "texting.fix.opt_in", 30447: "texting.fix.not_ported", 30489: "texting.fix.website", 30485: "texting.fix.website" };
/** Why Twilio said no, each with what to do about it. */
export function explainRejection(reasons: Rejection[] | null): Text[] {
  return (reasons ?? []).map((r) => r.code && FIXES[r.code] ? both("texting.reject.known", { reason: r.reason, code: r.code, fix: both(FIXES[r.code] as Key) })
    : both("texting.reject.other", { reason: r.reason || "?", code: r.code ?? "?" }));
}
/** Twilio's reasons in one shape (it has used a single reason, a list, and codes in two places). */
function reasonsOf(v: TollfreeVerification): Rejection[] {
  const list = (v.rejection_reasons ?? []).map((r) => ({ reason: r.reason ?? "", code: r.code ?? r.error_code ?? null })).filter((r) => r.reason || r.code);
  return list.length ? list : v.rejection_reason || v.error_code ? [{ reason: v.rejection_reason ?? "", code: v.error_code ?? null }] : [];
}
const fromVerification = (v: TollfreeVerification, now: Date) => ({
  verification_sid: v.sid, twilio_status: v.status, status: STATUS[v.status] ?? "submitted", rejection: v.status === "TWILIO_REJECTED" ? reasonsOf(v) : null,
  edit_allowed: v.edit_allowed ?? null, edit_expires_at: v.edit_expiration ?? null, checked_at: now.toISOString() });

/** What `apply` would do next, and what's missing for it. Reads Twilio, changes nothing. */
export async function textingPlan(d: TextingDeps): Promise<TextingPlan> {
  const reg = await textingRegistration(d.db), now = (d.now ?? (() => new Date()))();
  const needs = textingNeeds(d.details, d);
  const steps: Step[] = [];
  const number = reg?.phone_number ?? d.details?.number ?? null;
  if (!reg?.phone_number_sid) steps.push(d.details?.number ? { id: "use_number", text: both("texting.step.use_number", { number: d.details.number }) } : { id: "buy_number", text: both("texting.step.buy_number"), costs: true });
  const service = reg?.messaging_service_sid ? await d.api.getService(reg.messaging_service_sid) : null;
  const inbound = `${base(d.publicUrl)}/webhooks/twilio/sms`;
  if (!service) steps.push({ id: "service", text: both("texting.step.service", { name: serviceName(d.club), url: base(d.publicUrl) }) });
  else if (service.inbound_request_url !== inbound) steps.push({ id: "service_update", text: both("texting.step.service_update", { url: base(d.publicUrl) }) });
  if (!service || !reg?.phone_number_sid || !(await d.api.serviceNumbers(service.sid)).includes(reg.phone_number_sid))
    steps.push({ id: "add_number", text: both("texting.step.add_number", { number: number ?? both("texting.the_number") }) });
  const business = { business: d.details?.business_name ?? "?", website: d.details?.website ?? "?", volume: volumeStep(d.details?.monthly_texts ?? 1000) };
  if (!reg?.verification_sid) steps.push({ id: "submit", text: both("texting.step.submit", business) }, { id: "wait", text: both("texting.step.wait") });
  else if (reg.status === "approved") steps.push({ id: "approved", text: both("texting.status.approved", { number: number ?? "" }) });
  else if (reg.status === "rejected") {
    const editable = reg.edit_allowed && (!reg.edit_expires_at || reg.edit_expires_at > now);
    steps.push(editable ? { id: "resubmit", text: both("texting.step.resubmit") } : { id: "restart", text: both("texting.step.restart") }, { id: "wait", text: both("texting.step.wait") });
  } else steps.push({ id: "wait", text: both("texting.step.wait") });
  return { needs, steps, registration: reg };
}
const serviceName = (club: string) => `${club} texts (Kumi)`.slice(0, 64);

export type ApplyResult = { done: Text[]; stopped: null | "needs" | "needs_yes"; plan: TextingPlan };
/** Do the next steps, in order, recording each as it's done; stops before anything that costs money or starts
 *  the review over unless `yes`, and before the verification while club.yaml is missing something. */
export async function applyTexting(d: TextingDeps, o: { yes: boolean; reason?: string }): Promise<ApplyResult> {
  const plan = await textingPlan(d), done: Text[] = [], now = () => (d.now ?? (() => new Date()))();
  for (const s of plan.steps) {
    if ((s.costs || s.id === "restart") && !o.yes) return { done, stopped: "needs_yes", plan: await textingPlan(d) };
    if ((s.id === "submit" || s.id === "resubmit" || s.id === "restart") && plan.needs.length) return { done, stopped: "needs", plan: await textingPlan(d) };
    const reg = await textingRegistration(d.db);
    switch (s.id) {
      case "use_number": {
        const n = await d.api.findNumber(d.details!.number!);
        if (!n) throw new TextingError(both("texting.error.not_in_account", { number: d.details!.number! }));
        if (!n.sms) throw new TextingError(both("texting.error.cant_text", { number: n.phone_number }));
        await record(d.db, { phone_number: n.phone_number, phone_number_sid: n.sid, bought: false, status: "started" });
        break;
      }
      case "buy_number": {
        const [first] = await d.api.searchTollFree(1);
        if (!first) throw new TextingError(both("texting.error.none_free"));
        const n = await d.api.buyNumber(first, serviceName(d.club));
        await record(d.db, { phone_number: n.phone_number, phone_number_sid: n.sid, bought: true, status: "started" });
        break;
      }
      case "service": {
        const svc = await d.api.createService(serviceName(d.club), `${base(d.publicUrl)}/webhooks/twilio/sms`, `${base(d.publicUrl)}/webhooks/twilio/status`);
        await record(d.db, { messaging_service_sid: svc.sid });
        break;
      }
      case "service_update": await d.api.updateService(reg!.messaging_service_sid!, `${base(d.publicUrl)}/webhooks/twilio/sms`, `${base(d.publicUrl)}/webhooks/twilio/status`); break;
      case "add_number": await d.api.addNumberToService(reg!.messaging_service_sid!, reg!.phone_number_sid!); break;
      case "submit": {
        // One made in Twilio's console already for this number: carry on with it rather than send a second.
        const [existing] = await d.api.verificationsFor(reg!.phone_number_sid!);
        const v = existing ?? await d.api.createVerification(verificationForm(d.details!, { club: d.club, memberUrl: d.memberUrl, numberSid: reg!.phone_number_sid!, reference: reg!.id }));
        await record(d.db, { ...fromVerification(v, now()), ...(existing ? {} : { submitted: submittedCopy(d, reg!), submitted_at: now().toISOString() }) });
        break;
      }
      case "resubmit": {
        const { TollfreePhoneNumberSid: _pn, ExternalReferenceId: _ref, CustomerProfileSid: _bu, ...form } = verificationForm(d.details!, { club: d.club, memberUrl: d.memberUrl, numberSid: reg!.phone_number_sid!, reference: reg!.id });
        const v = await d.api.updateVerification(reg!.verification_sid!, { ...form, EditReason: o.reason ?? t("en", "texting.edit_reason") });
        await record(d.db, { ...fromVerification(v, now()), status: STATUS[v.status] === "rejected" ? "rejected" : "submitted", submitted: submittedCopy(d, reg!), submitted_at: now().toISOString() });
        break;
      }
      case "restart": {
        await d.api.deleteVerification(reg!.verification_sid!).catch((e) => { if (!(e instanceof TwilioApiError && e.status === 404)) throw e; });
        const v = await d.api.createVerification(verificationForm(d.details!, { club: d.club, memberUrl: d.memberUrl, numberSid: reg!.phone_number_sid!, reference: reg!.id }));
        await record(d.db, { ...fromVerification(v, now()), submitted: submittedCopy(d, reg!), submitted_at: now().toISOString() });
        break;
      }
      case "wait": case "approved": continue;
    }
    done.push(s.text);
  }
  return { done, stopped: null, plan: await textingPlan(d) };
}
const submittedCopy = (d: TextingDeps, reg: { phone_number_sid: string | null; id: string }) =>
  verificationForm(d.details!, { club: d.club, memberUrl: d.memberUrl, numberSid: reg.phone_number_sid!, reference: reg.id });

/** Ask Twilio how the review is going and record it (the owner and managers hear once it's decided). Returns
 *  the status, or null when there's nothing to ask about. */
export async function refreshTexting(db: Db, api: TwilioApi, now = new Date()): Promise<TextingStatus | null> {
  const reg = await textingRegistration(db);
  if (!reg?.verification_sid || reg.status === "approved") return reg?.status ?? null;
  const v = await api.getVerification(reg.verification_sid);
  // Recorded only when something moved, so a review that takes days isn't a change every hour.
  const got = fromVerification(v, now), same = reg.twilio_status === v.status && reg.edit_allowed === got.edit_allowed
    && (reg.edit_expires_at?.toISOString() ?? null) === (got.edit_expires_at ? new Date(got.edit_expires_at).toISOString() : null);
  if (!same) await record(db, got);
  return STATUS[v.status] ?? "submitted";
}

/** Once approved, the club's number can still stop working: Twilio withdraws the approval, the number leaves the
 *  account, or Twilio refuses texts because of the number itself. Checked hourly (main.ts); null while there's
 *  no approved registration to check. */
export async function checkTextingNumber(db: Db, api: TwilioApi, now = new Date()): Promise<{ ok: true } | { ok: false; error: string; words: Text } | null> {
  const reg = await textingRegistration(db);
  if (reg?.status !== "approved") return null;
  if (reg.verification_sid) {
    const v = await api.getVerification(reg.verification_sid);
    if (v.status !== "TWILIO_APPROVED") {
      await record(db, fromVerification(v, now));
      return { ok: false, error: `the verification is ${v.status}`, words: both("ops.why_number_status", { status: v.status }) };
    }
  }
  if (reg.phone_number && !(await api.findNumber(reg.phone_number)))
    return { ok: false, error: `${reg.phone_number} isn't in the account`, words: both("ops.why_number_gone", { number: reg.phone_number }) };
  const refused = await numberFailures(db, now);
  if (refused) return { ok: false, error: `${refused} texts refused for the number`, words: both("ops.why_number_refused", { count: refused }) };
  return { ok: true };
}

/** Where it stands, in words: the status, and for a rejection why and what to do. */
export function textingStatusText(reg: TextingRegistration | null, lang: Lang, tz: string): string[] {
  if (!reg) return [t(lang, "texting.status.none")];
  const number = reg.phone_number ?? "";
  const day = (d: Date) => new Intl.DateTimeFormat(formatLocale(lang), { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(d);
  switch (reg.status) {
    case "started": return [t(lang, "texting.status.started", { number })];
    case "submitted": return [t(lang, "texting.status.submitted", { number, date: reg.submitted_at ? day(reg.submitted_at) : "" })];
    case "in_review": return [t(lang, "texting.status.in_review", { number })];
    case "approved": return [t(lang, "texting.status.approved", { number })];
    case "rejected": {
      const editable = reg.edit_allowed && (!reg.edit_expires_at || reg.edit_expires_at > new Date());
      return [t(lang, "texting.status.rejected", { number }), ...explainRejection(reg.rejection).map((x) => `  - ${x[lang]}`),
        editable && reg.edit_expires_at ? t(lang, "texting.status.edit_until", { date: day(reg.edit_expires_at) }) : t(lang, editable ? "texting.status.edit" : "texting.status.no_edit")];
    }
  }
}

/** A step Twilio couldn't do, said for a person. */
export class TextingError extends Error {
  readonly text: Text;
  constructor(text: Text) { super(text.en); this.text = text; }
}
/** Twilio's refusal, for a person: test credentials and a refused token are the common ones. */
export function twilioProblem(e: unknown): Text {
  if (e instanceof TextingError) return e.text;
  if (e instanceof TwilioApiError) {
    if (e.code === 20008) return both("texting.error.test_credentials");
    if (e.status === 401 || e.code === 20003) return both("texting.error.refused");
    return both("texting.error.twilio", { error: `${e.code ?? e.status}: ${e.message}` });
  }
  return both("texting.error.twilio", { error: (e as Error).message });
}
