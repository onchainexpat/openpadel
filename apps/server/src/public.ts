// The club's public page, once the club switches it on: where it is and when it's open, its courts and
// prices, its memberships, and its upcoming public events, each on its own page. Plain HTML from the server,
// so search engines and AI readers see all of it without running anything, with schema.org markup for
// the club and its events. Nothing about members is shown; "Join the club" goes to the app's sign-up.
import { sql } from "kysely";
import { Hono, type Context } from "hono";
import { isLang, money, t, type Key, type Lang } from "@kumi/i18n";
import { competitionView, coachPhoto, factIn, inLang, lessonCoaches, trSql, localDate, membersFrom, planCounts, ruleWhen, searchFacts, TEXTS_FORM, type Db } from "@kumi/core";

/** Every value from the database goes through this before it reaches the page. */
const h = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** JSON for a script tag: nothing in it can close the tag. */
const ld = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const fmt = (lang: Lang, tz: string, d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { timeZone: tz, ...o }).format(d);
const weekday = (lang: Lang, w: number) => new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));

const STYLE = `:root{--brand:#0B5A55}*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2321;background:#f6f6f2}
main{max-width:720px;margin:0 auto;padding:16px}header{padding:24px 0 8px}h1{margin:0 0 4px;font-size:28px}h2{font-size:20px;margin:0 0 8px}
section{background:#fff;border:1px solid #e3e3dc;border-radius:12px;padding:16px;margin:12px 0}.meta{color:#5d6662;font-size:14px}a{color:var(--brand)}
.coach{display:flex;gap:12px;align-items:flex-start;margin:0 0 12px}.coach img{width:72px;height:72px;border-radius:50%;object-fit:cover;flex:none}
.button{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;border-radius:8px;padding:10px 16px;font-weight:600}
table{border-collapse:collapse;width:100%}td{padding:4px 0;vertical-align:top}td+td{text-align:right}ul{padding-left:20px;margin:4px 0}footer{padding:16px 0;font-size:13px;color:#5d6662}`;

function page(o: { lang: Lang; title: string; description: string; canonical: string; brand: string; body: string; jsonLd: unknown[]; other: string }) {
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(o.title)}</title><meta name="description" content="${h(o.description)}"><link rel="canonical" href="${h(o.canonical)}">
<link rel="alternate" hreflang="${o.lang === "es" ? "en" : "es"}" href="${h(o.other)}"><meta property="og:title" content="${h(o.title)}"><meta property="og:description" content="${h(o.description)}">
${o.jsonLd.map((x) => `<script type="application/ld+json">${ld(x)}</script>`).join("")}
<style>${STYLE.replace("#0B5A55", /^#[0-9A-Fa-f]{6}$/.test(o.brand) ? o.brand : "#0B5A55")}</style></head><body><main>${o.body}</main></body></html>`;
}

/** `memberUrl`: the members' app's address (addresses.ts), which the pages, the sitemap and search engines name as theirs. */
export function publicRoutes(db: Db, lang: (c: Context<any>) => Lang, memberUrl: string) {
  const app = new Hono();
  const base = memberUrl.replace(/\/$/, "");
  const pick = (c: Context<any>): Lang => { const q = c.req.query("lang"); return isLang(q) ? q : lang(c); };
  const club = () => db.selectFrom("club").select(["name", "brand_colour", "time_zone", "currency", "public_page", "about", "translations", "sign_up_open", "terms_url", "privacy_policy_url"]).executeTakeFirstOrThrow();
  /** The club's own terms and privacy policy, when it has set them (Settings): at the foot of each page, and beside
   *  the yes to texts on the texts page, as in the app. */
  type Links = { terms_url: string | null; privacy_policy_url: string | null };
  const policies = (l: Lang, cl: Links) => [cl.terms_url && `<a href="${h(cl.terms_url)}">${h(t(l, "ui.club_terms"))}</a>`,
    cl.privacy_policy_url && `<a href="${h(cl.privacy_policy_url)}">${h(t(l, "ui.club_privacy"))}</a>`].filter(Boolean).join(" · ");
  const footer = (l: Lang, cl: Links) => `<footer>${policies(l, cl) ? `<p>${policies(l, cl)}</p>` : ""}${h(t(l, "pub.footer"))}</footer>`;
  const off = (c: Context<any>) => c.text("Not found", 404);
  const html = (c: Context<any>, body: string) => { c.header("content-type", "text/html; charset=utf-8"); c.header("cache-control", "public, max-age=300"); return c.body(body); };

  /** Upcoming public events: published, open to anyone, with places and the first and last dates. */
  async function events(where: string | undefined, lang: Lang) {
    const rows = await db.selectFrom("program").innerJoin("location", "location.id", "program.location_id")
      .select(["program.id", trSql("program", "name", lang).as("name"), "program.kind", "program.format", "program.capacity", "program.price_cents", "program.member_price_cents", "program.level_min", "program.level_max", "program.rated",
        "program.sign_up", "location.name as location", "location.address", "location.time_zone"])
      .select((eb) => [
        eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.program_id", "=", "program.id").where("enrolment.status", "=", "booked").as("booked"),
        eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").where("session.status", "!=", "cancelled").as("first"),
        eb.selectFrom("session").select((x) => x.fn.max("ends_at").as("e")).whereRef("session.program_id", "=", "program.id").where("session.status", "!=", "cancelled").as("last"),
        eb.selectFrom("competition").select("competition.status").whereRef("competition.program_id", "=", "program.id").where("competition.status", "!=", "void").as("drawn"),
      ])
      .where("program.status", "=", "published").where("program.visibility", "=", "public").$if(Boolean(where), (q) => q.where("program.id", "=", where!)).execute();
    const members = await membersFrom(db, rows);   // what members pay, when it's less
    const now = new Date(), next = await nextDates(rows.filter((r) => r.sign_up === "per_session").map((r) => r.id), now);
    // Signed up per date: listed from its next date, with that date's places (each date fills on its own).
    return rows.map((r) => r.sign_up === "per_session" && next.has(r.id) ? { ...r, first: next.get(r.id)!.starts_at, booked: next.get(r.id)!.booked, capacity: next.get(r.id)!.capacity } : r)
      // A drawn tournament or league stays up for its results: until its last date, or until it's finished, whichever is later.
      .filter((r) => (r.first && new Date(r.first as any) > now) || (r.drawn && ((r.last && new Date(r.last as any) > now) || r.drawn !== "finished"))).sort((a, b) => new Date(a.first as any).getTime() - new Date(b.first as any).getTime())
      .map((r) => ({ ...r, first: new Date(r.first as any), last: new Date(r.last as any), left: Math.max(0, r.capacity - Number(r.booked ?? 0)), members_cents: members.get(r.id) ?? null }));
  }
  /** Each per-date program's next date still to come: when, its places and how many have one. */
  async function nextDates(ids: string[], now: Date) {
    const out = new Map<string, { starts_at: Date; capacity: number; booked: number }>();
    if (!ids.length) return out;
    const rows = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id")
      .select(["session.program_id", "session.starts_at", sql<number>`coalesce(session.capacity_override, program.capacity)`.as("capacity")])
      .select((eb) => eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.session_id", "=", "session.id").where("enrolment.status", "=", "booked").as("booked"))
      .where("session.program_id", "in", ids).where("session.status", "!=", "cancelled").where("session.starts_at", ">", now).orderBy("session.starts_at").execute();
    for (const r of rows) if (!out.has(r.program_id)) out.set(r.program_id, { starts_at: r.starts_at, capacity: Number(r.capacity), booked: Number(r.booked ?? 0) });
    return out;
  }
  const eventLd = (e: Awaited<ReturnType<typeof events>>[number], clubName: string, currency: string) => ({
    "@context": "https://schema.org", "@type": "SportsEvent", name: e.name, sport: "Padel", startDate: e.first.toISOString(), endDate: e.last.toISOString(),
    eventStatus: "https://schema.org/EventScheduled", eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: { "@type": "Place", name: `${clubName}, ${e.location}`, address: e.address ?? e.location },
    organizer: { "@type": "SportsOrganization", name: clubName, url: `${base}/public` },
    offers: { "@type": "Offer", price: (e.price_cents / 100).toFixed(2), priceCurrency: currency, availability: e.left > 0 ? "https://schema.org/InStock" : "https://schema.org/SoldOut", url: `${base}/public/events/${e.id}` },
    url: `${base}/public/events/${e.id}`,
  });
  const eventLine = (l: Lang, e: Awaited<ReturnType<typeof events>>[number]) =>
    `${h(fmt(l, e.time_zone, e.first, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} · ${h(e.location)} · ${e.price_cents ? h(money(e.price_cents, l)) : h(t(l, "pub.free"))}${e.members_cents !== null ? ` (${h(t(l, "ui.members_price", { amount: money(e.members_cents, l) }))})` : ""} · ${e.left > 0 ? h(t(l, "ui.places_left", { count: e.left })) : h(t(l, "pub.full"))}`;

  app.get("/public", async (c) => {
    const cl = await club();
    if (!cl.public_page) return off(c);
    const l = pick(c), today = localDate(new Date(), cl.time_zone);
    const locations = await db.selectFrom("location").select(["id", "name", "address", "time_zone"]).where("archived_at", "is", null).orderBy("name").execute();
    const courts = await db.selectFrom("court").select(["location_id", "kind"]).where("archived_at", "is", null).where("bookable", "=", true).execute();
    const hours = await db.selectFrom("opening_hours").select(["location_id", "weekday", "opens", "closes"]).execute();
    const special = await db.selectFrom("hours_exception").select(["location_id", "on_date", "opens", "closes", "note"]).where("active", "=", true).where("on_date", ">=", today).orderBy("on_date").limit(20).execute();
    const prices = await db.selectFrom("price_rule").selectAll().where("active", "=", true).orderBy("priority", "desc").orderBy("name").execute();
    const plans = await db.selectFrom("membership_plan").select(["id", trSql("membership_plan", "name", l).as("name"), trSql("membership_plan", "description", l).as("description"), "price_cents", "period", "days_ahead", "max_members", "starts_on",
      "program_percent_off", "program_cents_off", "included_sessions", "included_kinds"]).where("active", "=", true).where("join_in_app", "=", true).orderBy("sort").orderBy("price_cents").execute();
    const counts = await planCounts(db), planName = new Map(plans.map((p) => [p.id, p.name]));
    const coming = (await events(undefined, l)).slice(0, 30);
    const t5 = (x: string | null) => (x ? x.slice(0, 5) : "");
    const where = locations.map((loc) => {
      const mine = courts.filter((x) => x.location_id === loc.id), kinds = [...new Set(mine.map((x) => x.kind))];
      const week = [1, 2, 3, 4, 5, 6, 0].map((w) => { const x = hours.find((y) => y.location_id === loc.id && y.weekday === w); return `<tr><td>${h(weekday(l, w))}</td><td>${x?.opens ? `${t5(x.opens)} - ${t5(x.closes)}` : h(t(l, "ui.closed"))}</td></tr>`; }).join("");
      const days = special.filter((x) => x.location_id === loc.id).map((x) => `<li>${h(fmt(l, "UTC", new Date(`${x.on_date}T12:00:00Z`), { weekday: "short", month: "short", day: "numeric" }))}: ${x.opens ? `${t5(x.opens)} - ${t5(x.closes)}` : h(t(l, "ui.closed"))}${x.note ? ` (${h(x.note)})` : ""}</li>`).join("");
      const list = prices.filter((r) => r.location_id === loc.id).map((r) => `<li>${h(inLang(r.name, r.translations, "name", l))}: ${h(money(r.cents_per_hour, l))}${h(t(l, "ui.per_hour"))}, ${h(ruleWhen(r)[l])}${r.plan_ids ? ` <span class="meta">(${h(t(l, "pub.members_of", { plans: r.plan_ids.map((id) => planName.get(id)).filter(Boolean).join(", ") }))})</span>` : ""}</li>`).join("");
      return `<section><h2>${h(loc.name)}</h2>${loc.address ? `<p>${h(loc.address)}</p>` : ""}<p class="meta">${h(t(l, "pub.courts", { count: mine.length }))}${kinds.length ? `: ${h(kinds.map((k) => t(l, `ui.kind_${k}` as Key)).join(", "))}` : ""}</p>
<h3>${h(t(l, "ui.hours_title"))}</h3><table>${week}</table>${days ? `<p class="meta">${h(t(l, "ui.special_days"))}</p><ul>${days}</ul>` : ""}
${list ? `<h3>${h(t(l, "ui.prices_title"))}</h3><ul>${list}</ul>` : ""}</section>`;
    }).join("");
    const plansHtml = plans.length ? `<section><h2>${h(t(l, "ui.nav_memberships"))}</h2><ul>${plans.map((p) => {
      const left = p.max_members ? Math.max(0, p.max_members - (counts.get(p.id) ?? 0)) : null, starts = p.starts_on && p.starts_on > today ? p.starts_on : null;
      return `<li><strong>${h(p.name)}</strong>: ${h(t(l, p.period === "year" ? "ui.price_a_year" : "ui.price_a_month", { amount: money(p.price_cents, l) }))}${p.description ? `. ${h(p.description.replace(/\.$/, ""))}` : ""}${p.days_ahead ? `. ${h(t(l, "ui.perk_window", { count: p.days_ahead }))}` : ""}${p.program_percent_off ? `. ${h(t(l, "ui.perk_program_percent", { percent: p.program_percent_off }))}` : p.program_cents_off ? `. ${h(t(l, "ui.perk_program_cents", { amount: money(p.program_cents_off, l) }))}` : ""}${p.included_sessions ? `. ${h(t(l, "ui.perk_included", { count: p.included_sessions, period: t(l, `ui.period_${p.period}`), kinds: p.included_kinds.map((k) => t(l, `kind.${k}` as Key)).join(", ") }))}` : ""}${starts ? `. ${h(t(l, "ui.plan_starts_on", { date: fmt(l, "UTC", new Date(`${starts}T12:00:00Z`), { month: "long", day: "numeric", year: "numeric" }) }))}` : ""}${left !== null ? `. ${h(left ? t(l, "ui.places_left", { count: left }) : t(l, "ui.plan_full"))}` : ""}`.replace(/\.?$/, ".") + "</li>";
    }).join("")}</ul></section>` : "";
    // The coaches, with what members see in the app: never their contact details.
    const coaches = (await lessonCoaches(db)).map((x) => ({ ...x, bio: inLang(x.bio, x.translations, "bio", l) })).filter((x) => x.bio || (x.lessons && Object.keys(x.rates).length));
    const coachesHtml = coaches.length ? `<section><h2>${h(t(l, "pub.coaches"))}</h2>${coaches.map((x) => {
      const rates = x.lessons ? Object.entries(x.rates).map(([m, c]) => [Number(m), c] as const).sort((a, b) => a[0] - b[0]).map(([m, c]) => t(l, "pub.lesson_rate", { minutes: t(l, "ui.minutes", { count: m }), price: money(c, l) })).join(", ") : "";
      const levels = x.level_min && x.level_max ? t(l, "pub.coach_levels", { min: x.level_min, max: x.level_max }) : "";
      const langs = x.languages.map((g) => t(l, `ui.lang_${g}` as Key)).join(", ");
      return `<div class="coach">${x.photo_id ? `<img src="/public/photos/${h(x.photo_id)}" alt="${h(x.name)}" loading="lazy">` : ""}<div><strong>${h(x.name)}</strong>${x.bio ? `<br>${h(x.bio)}` : ""}<br><span class="meta">${h([levels, langs, rates ? t(l, "pub.private_lessons", { rates }) : ""].filter(Boolean).join(" · "))}</span></div></div>`;
    }).join("")}</section>` : "";
    // The club's common questions it marked public, in the page's language, with FAQ markup for search engines.
    const faq = (await searchFacts(db, "", { publicOnly: true })).map((f) => factIn(f, l));
    const faqHtml = faq.length ? `<section><h2>${h(t(l, "pub.faq"))}</h2>${faq.map((f) => `<h3>${h(f.question)}</h3><p>${h(f.answer).replace(/\n/g, "<br>")}</p>`).join("")}</section>` : "";
    const faqLd = faq.length ? [{ "@context": "https://schema.org", "@type": "FAQPage", inLanguage: l, mainEntity: faq.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })) }] : [];
    const eventsHtml = `<section><h2>${h(t(l, "pub.coming_up"))}</h2>${coming.length ? `<ul>${coming.map((e) => `<li><a href="/public/events/${h(e.id)}${l === "es" ? "?lang=es" : ""}">${h(e.name)}</a><br><span class="meta">${eventLine(l, e)}</span></li>`).join("")}</ul>` : `<p class="meta">${h(t(l, "pub.no_events"))}</p>`}</section>`;
    const join = cl.sign_up_open ? t(l, "pub.join") : t(l, "pub.sign_in");
    const about = inLang(cl.about, cl.translations, "about", l);
    const body = `<header><h1>${h(cl.name)}</h1>${about ? `<p>${h(about)}</p>` : ""}<p><a class="button" href="/">${h(join)}</a> <a href="/public?lang=${l === "es" ? "en" : "es"}">${l === "es" ? "English" : "Español"}</a></p></header>
${where}${plansHtml}${coachesHtml}${eventsHtml}${faqHtml}${footer(l, cl)}`;
    const clubLd = { "@context": "https://schema.org", "@type": "SportsActivityLocation", name: cl.name, url: `${base}/public`, ...(about ? { description: about } : {}),
      ...(locations[0]?.address ? { address: locations[0].address } : {}),
      openingHoursSpecification: hours.filter((x) => x.location_id === locations[0]?.id && x.opens).map((x) => ({ "@type": "OpeningHoursSpecification",
        dayOfWeek: `https://schema.org/${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][x.weekday]}`, opens: t5(x.opens), closes: t5(x.closes) === "24:00" ? "23:59" : t5(x.closes) })) };
    return html(c, page({ lang: l, title: cl.name, description: about ?? t(l, "pub.description", { club: cl.name }), canonical: `${base}/public${l === "es" ? "?lang=es" : ""}`,
      other: `${base}/public${l === "es" ? "" : "?lang=es"}`, brand: cl.brand_colour, body, jsonLd: [clubLd, ...coming.map((e) => eventLd(e, cl.name, cl.currency)), ...faqLd] }));
  });

  async function drawHtml(l: Lang, programId: string, tz: string) {
    const shown = (await db.selectFrom("program").select("public_names").where("id", "=", programId).executeTakeFirst())?.public_names ?? false;
    const v = await competitionView(db, programId, { public: { names: shown, lang: l } });
    if (!v.competition) return "";
    const tables = v.tables.map((tb) => `<h3>${h(tb.group === null ? t(l, "pub.table") : t(l, "pub.group", { n: tb.group }))}</h3><table><tbody>${tb.rows.map((r, k) =>
      `<tr><td>${k + 1}</td><td>${h(r.name)}</td><td>${r.won}-${r.lost}</td>${tb.group === null ? `<td>${r.points}</td>` : ""}</tr>`).join("")}</tbody></table>`).join("");
    const line = (f: (typeof v.fixtures)[number]) => `<li>${h(f.a)} ${f.score ? `<strong>${h(f.score)}</strong>` : f.walkover ? h(t(l, "pub.walkover")) : "-"} ${h(f.b)}${
      !f.score && !f.walkover && f.starts_at ? ` <span class="meta">${h(f.court ?? "")}, ${h(fmt(l, tz, f.starts_at, { weekday: "short", hour: "numeric", minute: "2-digit" }))}</span>` : ""}</li>`;
    const byeLine = (f: (typeof v.fixtures)[number]) => f.status === "bye" || f.a === "bye" || f.b === "bye";
    const ko = v.fixtures.filter((f) => f.stage === "knockout" && !byeLine(f));
    const rounds = [...new Set(ko.map((f) => f.round))].map((r) => `<h3>${h(t(l, "ui.round", { n: r }))}</h3><ul>${ko.filter((f) => f.round === r).map(line).join("")}</ul>`).join("");
    const rest = v.fixtures.filter((f) => f.stage !== "knockout" && !byeLine(f));
    return `<section><h2>${h(t(l, "pub.draw"))}</h2>${tables}${rest.length ? `<ul>${rest.map(line).join("")}</ul>` : ""}${rounds ? `<h2>${h(t(l, "pub.knockout"))}</h2>${rounds}` : ""}</section>`;
  }

  app.get("/public/events/:id", async (c) => {
    const cl = await club();
    if (!cl.public_page) return off(c);
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) return off(c);
    const l = pick(c);
    const [e] = await events(id, l);
    if (!e) return off(c);
    const sessions = await db.selectFrom("session").innerJoin("program", "program.id", "session.program_id")
      .select(["session.starts_at", "session.ends_at", sql<number>`coalesce(session.capacity_override, program.capacity)`.as("capacity")])
      .select((eb) => eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.session_id", "=", "session.id").where("enrolment.status", "=", "booked").as("booked"))
      .where("session.program_id", "=", e.id).where("session.status", "!=", "cancelled").orderBy("session.starts_at").execute();
    // Signed up per date: each date still to come says its own places, since each fills on its own.
    const now = new Date(), perDate = e.sign_up === "per_session";
    const places = (s: (typeof sessions)[number]) => { const left = Math.max(0, Number(s.capacity) - Number(s.booked ?? 0)); return ` · ${h(left > 0 ? t(l, "ui.places_left", { count: left }) : t(l, "pub.full"))}`; };
    const dates = sessions.map((s) => `<li>${h(fmt(l, e.time_zone, s.starts_at, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }))} - ${h(fmt(l, e.time_zone, s.ends_at, { hour: "numeric", minute: "2-digit" }))}${perDate && s.starts_at > now ? places(s) : ""}</li>`).join("");
    const levels = e.level_min || e.level_max ? `<p>${h(t(l, "pub.levels", { min: e.level_min ?? "", max: e.level_max ?? "" }))}</p>` : "";
    // A tournament or league once drawn: the tables and matches, with scores as they come in (and no more sign-ups:
    // a place taken after the draw could never enter it).
    const draw = e.kind === "tournament" || e.kind === "league" ? await drawHtml(l, e.id, e.time_zone) : "";
    const body = `<header><p><a href="/public${l === "es" ? "?lang=es" : ""}">${h(cl.name)}</a></p><h1>${h(e.name)}</h1><p class="meta">${eventLine(l, e)}</p></header>
<section><p>${h(t(l, `kind.${e.kind}` as Key))}${e.format ? ` · ${h(e.format)}` : ""}${e.rated ? ` · ${h(t(l, "ui.match_rated"))}` : ""}</p>${levels}<h2>${h(t(l, "pub.dates"))}</h2><ul>${dates}</ul>
<p>${h(e.location)}${e.address ? `, ${h(e.address)}` : ""}</p>${draw ? `<p>${h(t(l, "pub.entries_closed"))}</p>` : `<p><a class="button" href="/">${h(t(l, "pub.sign_up_event"))}</a></p>`}</section>${draw}${footer(l, cl)}`;
    return html(c, page({ lang: l, title: `${e.name} · ${cl.name}`, description: `${e.name}: ${fmt(l, e.time_zone, e.first, { dateStyle: "long", timeStyle: "short" })}, ${cl.name}`,
      canonical: `${base}/public/events/${e.id}${l === "es" ? "?lang=es" : ""}`, other: `${base}/public/events/${e.id}${l === "es" ? "" : "?lang=es"}`, brand: cl.brand_colour, body, jsonLd: [eventLd(e, cl.name, cl.currency)] }));
  });

  // A coach's photo: for this page and the apps, whether or not the page is on (a coach's face is on their
  // profile in the app too). Only photos on an active coach's profile; the type is the one checked when it was added.
  app.get("/public/photos/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) return off(c);
    const p = await coachPhoto(db, id);
    if (!p) return off(c);
    c.header("content-type", p.content_type); c.header("x-content-type-options", "nosniff"); c.header("cache-control", "public, max-age=86400, immutable");
    c.header("content-security-policy", "default-src 'none'"); c.header("content-disposition", "inline");
    return c.body(new Uint8Array(p.bytes));
  });

  // How members say yes to texts, with the exact words they tick: what the carriers' reviewers open when the club
  // registers its texting (texting.ts), so it's there whether or not the club's public page is on. Nothing
  // about any member; the form is shown, not working.
  app.get("/public/texts", async (c) => {
    const cl = await club(), l = pick(c);
    const steps = (["pub.texts_step1", "pub.texts_step2", "pub.texts_step3"] as const).map((k) => `<li>${h(t(l, k))}</li>`).join("");
    const what = (["pub.texts_what1", "pub.texts_what2", "pub.texts_what3"] as const).map((k) => `<li>${h(t(l, k))}</li>`).join("");
    const body = `<header><h1>${h(t(l, "pub.texts_title", { club: cl.name }))}</h1><p class="meta">${h(t(l, "pub.texts_intro", { club: cl.name }))}</p></header>
<section><h2>${h(t(l, "pub.texts_how"))}</h2><ol>${steps}</ol>
<p><label><input type="checkbox" disabled> ${h(t(l, "ui.texts_consent", { club: cl.name }))}</label></p>${policies(l, cl) ? `<p class="meta">${policies(l, cl)}</p>` : ""}<p class="meta">${h(t(l, "pub.texts_version", { version: TEXTS_FORM }))}</p></section>
<section><h2>${h(t(l, "pub.texts_what"))}</h2><ul>${what}</ul><p>${h(t(l, "pub.texts_never"))}</p></section>
<section><p>${h(t(l, "pub.texts_stop"))}</p><p>${h(t(l, "pub.texts_privacy", { club: cl.name }))}</p></section>${footer(l, cl)}`;
    return html(c, page({ lang: l, title: t(l, "pub.texts_title", { club: cl.name }), description: t(l, "pub.texts_intro", { club: cl.name }), canonical: `${base}/public/texts${l === "es" ? "?lang=es" : ""}`,
      other: `${base}/public/texts${l === "es" ? "" : "?lang=es"}`, brand: cl.brand_colour, body, jsonLd: [] }));
  });

  // For search engines: the public pages there are.
  app.get("/public/sitemap.xml", async (c) => {
    const cl = await club();
    if (!cl.public_page) return off(c);
    const urls = [`${base}/public`, ...(await events(undefined, "en")).map((e) => `${base}/public/events/${e.id}`)];
    c.header("content-type", "application/xml; charset=utf-8");
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${h(u)}</loc></url>`).join("")}</urlset>\n`);
  });
  return app;
}
