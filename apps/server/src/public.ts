// The club's public page, once the club switches it on: where it is and when it's open, its courts and
// prices, its memberships, and its upcoming public events, each on its own page. Plain HTML from the server,
// so search engines and AI readers see all of it without running anything, with schema.org markup for
// the club and its events. Nothing about members is shown; "Join the club" goes to the app's sign-up.
import { Hono, type Context } from "hono";
import { isLang, money, t, type Key, type Lang } from "@kumi/i18n";
import { localDate, planCounts, ruleWhen, type Db } from "@kumi/core";

/** Every value from the database goes through this before it reaches the page. */
const h = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** JSON for a script tag: nothing in it can close the tag. */
const ld = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const fmt = (lang: Lang, tz: string, d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { timeZone: tz, ...o }).format(d);
const weekday = (lang: Lang, w: number) => new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + w)));

const STYLE = `:root{--brand:#0B5A55}*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2321;background:#f6f6f2}
main{max-width:720px;margin:0 auto;padding:16px}header{padding:24px 0 8px}h1{margin:0 0 4px;font-size:28px}h2{font-size:20px;margin:0 0 8px}
section{background:#fff;border:1px solid #e3e3dc;border-radius:12px;padding:16px;margin:12px 0}.meta{color:#5d6662;font-size:14px}a{color:var(--brand)}
.button{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;border-radius:8px;padding:10px 16px;font-weight:600}
table{border-collapse:collapse;width:100%}td{padding:4px 0;vertical-align:top}td+td{text-align:right}ul{padding-left:20px;margin:4px 0}footer{padding:16px 0;font-size:13px;color:#5d6662}`;

function page(o: { lang: Lang; title: string; description: string; canonical: string; brand: string; body: string; jsonLd: unknown[]; other: string }) {
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(o.title)}</title><meta name="description" content="${h(o.description)}"><link rel="canonical" href="${h(o.canonical)}">
<link rel="alternate" hreflang="${o.lang === "es" ? "en" : "es"}" href="${h(o.other)}"><meta property="og:title" content="${h(o.title)}"><meta property="og:description" content="${h(o.description)}">
${o.jsonLd.map((x) => `<script type="application/ld+json">${ld(x)}</script>`).join("")}
<style>${STYLE.replace("#0B5A55", /^#[0-9A-Fa-f]{6}$/.test(o.brand) ? o.brand : "#0B5A55")}</style></head><body><main>${o.body}</main></body></html>`;
}

export function publicRoutes(db: Db, lang: (c: Context<any>) => Lang, publicUrl: string) {
  const app = new Hono();
  const base = publicUrl.replace(/\/$/, "");
  const pick = (c: Context<any>): Lang => { const q = c.req.query("lang"); return isLang(q) ? q : lang(c); };
  const club = () => db.selectFrom("club").select(["name", "brand_colour", "time_zone", "currency", "public_page", "about", "sign_up_open"]).executeTakeFirstOrThrow();
  const off = (c: Context<any>) => c.text("Not found", 404);
  const html = (c: Context<any>, body: string) => { c.header("content-type", "text/html; charset=utf-8"); c.header("cache-control", "public, max-age=300"); return c.body(body); };

  /** Upcoming public events: published, open to anyone, with places and the first and last dates. */
  async function events(where?: string) {
    const rows = await db.selectFrom("program").innerJoin("location", "location.id", "program.location_id")
      .select(["program.id", "program.name", "program.kind", "program.format", "program.capacity", "program.price_cents", "program.level_min", "program.level_max", "program.rated",
        "location.name as location", "location.address", "location.time_zone"])
      .select((eb) => [
        eb.selectFrom("enrolment").select((x) => x.fn.countAll<string>().as("n")).whereRef("enrolment.program_id", "=", "program.id").where("enrolment.status", "=", "booked").as("booked"),
        eb.selectFrom("session").select((x) => x.fn.min("starts_at").as("s")).whereRef("session.program_id", "=", "program.id").where("session.status", "!=", "cancelled").as("first"),
        eb.selectFrom("session").select((x) => x.fn.max("ends_at").as("e")).whereRef("session.program_id", "=", "program.id").where("session.status", "!=", "cancelled").as("last"),
      ])
      .where("program.status", "=", "published").where("program.visibility", "=", "public").$if(Boolean(where), (q) => q.where("program.id", "=", where!)).execute();
    return rows.filter((r) => r.first && new Date(r.first as any) > new Date()).sort((a, b) => new Date(a.first as any).getTime() - new Date(b.first as any).getTime())
      .map((r) => ({ ...r, first: new Date(r.first as any), last: new Date(r.last as any), left: Math.max(0, r.capacity - Number(r.booked ?? 0)) }));
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
    `${h(fmt(l, e.time_zone, e.first, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} · ${h(e.location)} · ${e.price_cents ? h(money(e.price_cents, l)) : h(t(l, "pub.free"))} · ${e.left > 0 ? h(t(l, "ui.places_left", { count: e.left })) : h(t(l, "pub.full"))}`;

  app.get("/public", async (c) => {
    const cl = await club();
    if (!cl.public_page) return off(c);
    const l = pick(c), today = localDate(new Date(), cl.time_zone);
    const locations = await db.selectFrom("location").select(["id", "name", "address", "time_zone"]).where("archived_at", "is", null).orderBy("name").execute();
    const courts = await db.selectFrom("court").select(["location_id", "kind"]).where("archived_at", "is", null).where("bookable", "=", true).execute();
    const hours = await db.selectFrom("opening_hours").select(["location_id", "weekday", "opens", "closes"]).execute();
    const special = await db.selectFrom("hours_exception").select(["location_id", "on_date", "opens", "closes", "note"]).where("active", "=", true).where("on_date", ">=", today).orderBy("on_date").limit(20).execute();
    const prices = await db.selectFrom("price_rule").selectAll().where("active", "=", true).orderBy("priority", "desc").orderBy("name").execute();
    const plans = await db.selectFrom("membership_plan").select(["id", "name", "description", "price_cents", "period", "days_ahead", "max_members", "starts_on"]).where("active", "=", true).where("join_in_app", "=", true).orderBy("sort").orderBy("price_cents").execute();
    const counts = await planCounts(db), planName = new Map(plans.map((p) => [p.id, p.name]));
    const coming = (await events()).slice(0, 30);
    const t5 = (x: string | null) => (x ? x.slice(0, 5) : "");
    const where = locations.map((loc) => {
      const mine = courts.filter((x) => x.location_id === loc.id), kinds = [...new Set(mine.map((x) => x.kind))];
      const week = [1, 2, 3, 4, 5, 6, 0].map((w) => { const x = hours.find((y) => y.location_id === loc.id && y.weekday === w); return `<tr><td>${h(weekday(l, w))}</td><td>${x?.opens ? `${t5(x.opens)} - ${t5(x.closes)}` : h(t(l, "ui.closed"))}</td></tr>`; }).join("");
      const days = special.filter((x) => x.location_id === loc.id).map((x) => `<li>${h(fmt(l, "UTC", new Date(`${x.on_date}T12:00:00Z`), { weekday: "short", month: "short", day: "numeric" }))}: ${x.opens ? `${t5(x.opens)} - ${t5(x.closes)}` : h(t(l, "ui.closed"))}${x.note ? ` (${h(x.note)})` : ""}</li>`).join("");
      const list = prices.filter((r) => r.location_id === loc.id).map((r) => `<li>${h(r.name)}: ${h(money(r.cents_per_hour, l))}${h(t(l, "ui.per_hour"))}, ${h(ruleWhen(r)[l])}${r.plan_ids ? ` <span class="meta">(${h(t(l, "pub.members_of", { plans: r.plan_ids.map((id) => planName.get(id)).filter(Boolean).join(", ") }))})</span>` : ""}</li>`).join("");
      return `<section><h2>${h(loc.name)}</h2>${loc.address ? `<p>${h(loc.address)}</p>` : ""}<p class="meta">${h(t(l, "pub.courts", { count: mine.length }))}${kinds.length ? `: ${h(kinds.map((k) => t(l, `ui.kind_${k}` as Key)).join(", "))}` : ""}</p>
<h3>${h(t(l, "ui.hours_title"))}</h3><table>${week}</table>${days ? `<p class="meta">${h(t(l, "ui.special_days"))}</p><ul>${days}</ul>` : ""}
${list ? `<h3>${h(t(l, "ui.prices_title"))}</h3><ul>${list}</ul>` : ""}</section>`;
    }).join("");
    const plansHtml = plans.length ? `<section><h2>${h(t(l, "ui.nav_memberships"))}</h2><ul>${plans.map((p) => {
      const left = p.max_members ? Math.max(0, p.max_members - (counts.get(p.id) ?? 0)) : null, starts = p.starts_on && p.starts_on > today ? p.starts_on : null;
      return `<li><strong>${h(p.name)}</strong>: ${h(t(l, p.period === "year" ? "ui.price_a_year" : "ui.price_a_month", { amount: money(p.price_cents, l) }))}${p.description ? `. ${h(p.description.replace(/\.$/, ""))}` : ""}${p.days_ahead ? `. ${h(t(l, "ui.perk_window", { count: p.days_ahead }))}` : ""}${starts ? `. ${h(t(l, "ui.plan_starts_on", { date: fmt(l, "UTC", new Date(`${starts}T12:00:00Z`), { month: "long", day: "numeric", year: "numeric" }) }))}` : ""}${left !== null ? `. ${h(left ? t(l, "ui.places_left", { count: left }) : t(l, "ui.plan_full"))}` : ""}`.replace(/\.?$/, ".") + "</li>";
    }).join("")}</ul></section>` : "";
    const eventsHtml = `<section><h2>${h(t(l, "pub.coming_up"))}</h2>${coming.length ? `<ul>${coming.map((e) => `<li><a href="/public/events/${h(e.id)}${l === "es" ? "?lang=es" : ""}">${h(e.name)}</a><br><span class="meta">${eventLine(l, e)}</span></li>`).join("")}</ul>` : `<p class="meta">${h(t(l, "pub.no_events"))}</p>`}</section>`;
    const join = cl.sign_up_open ? t(l, "pub.join") : t(l, "pub.sign_in");
    const body = `<header><h1>${h(cl.name)}</h1>${cl.about ? `<p>${h(cl.about)}</p>` : ""}<p><a class="button" href="/">${h(join)}</a> <a href="/public?lang=${l === "es" ? "en" : "es"}">${l === "es" ? "English" : "Español"}</a></p></header>
${where}${plansHtml}${eventsHtml}<footer>${h(t(l, "pub.footer"))}</footer>`;
    const clubLd = { "@context": "https://schema.org", "@type": "SportsActivityLocation", name: cl.name, url: `${base}/public`, ...(cl.about ? { description: cl.about } : {}),
      ...(locations[0]?.address ? { address: locations[0].address } : {}),
      openingHoursSpecification: hours.filter((x) => x.location_id === locations[0]?.id && x.opens).map((x) => ({ "@type": "OpeningHoursSpecification",
        dayOfWeek: `https://schema.org/${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][x.weekday]}`, opens: t5(x.opens), closes: t5(x.closes) === "24:00" ? "23:59" : t5(x.closes) })) };
    return html(c, page({ lang: l, title: cl.name, description: cl.about ?? t(l, "pub.description", { club: cl.name }), canonical: `${base}/public${l === "es" ? "?lang=es" : ""}`,
      other: `${base}/public${l === "es" ? "" : "?lang=es"}`, brand: cl.brand_colour, body, jsonLd: [clubLd, ...coming.map((e) => eventLd(e, cl.name, cl.currency))] }));
  });

  app.get("/public/events/:id", async (c) => {
    const cl = await club();
    if (!cl.public_page) return off(c);
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) return off(c);
    const [e] = await events(id);
    if (!e) return off(c);
    const l = pick(c);
    const sessions = await db.selectFrom("session").select(["starts_at", "ends_at"]).where("program_id", "=", e.id).where("status", "!=", "cancelled").orderBy("starts_at").execute();
    const dates = sessions.map((s) => `<li>${h(fmt(l, e.time_zone, s.starts_at, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }))} - ${h(fmt(l, e.time_zone, s.ends_at, { hour: "numeric", minute: "2-digit" }))}</li>`).join("");
    const levels = e.level_min || e.level_max ? `<p>${h(t(l, "pub.levels", { min: e.level_min ?? "", max: e.level_max ?? "" }))}</p>` : "";
    const body = `<header><p><a href="/public${l === "es" ? "?lang=es" : ""}">${h(cl.name)}</a></p><h1>${h(e.name)}</h1><p class="meta">${eventLine(l, e)}</p></header>
<section><p>${h(t(l, `kind.${e.kind}` as Key))}${e.format ? ` · ${h(e.format)}` : ""}${e.rated ? ` · ${h(t(l, "ui.match_rated"))}` : ""}</p>${levels}<h2>${h(t(l, "pub.dates"))}</h2><ul>${dates}</ul>
<p>${h(e.location)}${e.address ? `, ${h(e.address)}` : ""}</p><p><a class="button" href="/">${h(t(l, "pub.sign_up_event"))}</a></p></section><footer>${h(t(l, "pub.footer"))}</footer>`;
    return html(c, page({ lang: l, title: `${e.name} · ${cl.name}`, description: `${e.name}: ${fmt(l, e.time_zone, e.first, { dateStyle: "long", timeStyle: "short" })}, ${cl.name}`,
      canonical: `${base}/public/events/${e.id}${l === "es" ? "?lang=es" : ""}`, other: `${base}/public/events/${e.id}${l === "es" ? "" : "?lang=es"}`, brand: cl.brand_colour, body, jsonLd: [eventLd(e, cl.name, cl.currency)] }));
  });

  // For search engines: the public pages there are.
  app.get("/public/sitemap.xml", async (c) => {
    const cl = await club();
    if (!cl.public_page) return off(c);
    const urls = [`${base}/public`, ...(await events()).map((e) => `${base}/public/events/${e.id}`)];
    c.header("content-type", "application/xml; charset=utf-8");
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${h(u)}</loc></url>`).join("")}</urlset>\n`);
  });
  return app;
}
