// Why a form's details were refused, in plain words for the person who filled it in: never the checker's own text
// ("expected array to have >=1 items") or a field's code name ("court_ids"). A field the apps fill in themselves (an
// id, a flag) gets the general sentence: if that's wrong, the app has a bug, and the person can only try again.
import { both, type Key, type Text } from "@kumi/i18n";

/** What the checker (zod) says about one value, as much of it as the wording needs. */
export interface Issue { code: string; path: readonly PropertyKey[]; origin?: string }

const LABELS: Record<string, Key> = {
  name: "field.name", display_name: "field.name", note: "field.note", reason: "field.reason", email: "field.email",
  phone: "field.phone", minutes: "field.minutes", level: "field.level", weeks: "field.weeks", weekday: "field.weekday",
  opens: "field.hours", closes: "field.hours", message: "field.message", body: "field.message", text: "field.message",
  capacity: "field.capacity", title: "field.title", birth_year: "field.birth_year", code: "field.code", address: "field.address",
  question: "field.question", answer: "field.answer", subject: "field.subject", legal_name: "field.legal_name",
  time_zone: "field.time_zone", default_language: "field.default_language", brand_colour: "field.brand_colour",
};
const DATES = new Set(["starts_at", "ends_at", "date", "on_date", "until_date", "day", "from", "to", "at", "send_at", "starts", "ends"]);
const MONEY = /(_cents|^cents|^amount)$/;
const LISTS = new Set(["array", "set"]);

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let v: unknown = raw;
  for (const p of path) { if (v === null || typeof v !== "object") return undefined; v = (v as Record<PropertyKey, unknown>)[p]; }
  return v;
}

function one(i: Issue, raw: unknown): Text {
  const field = [...i.path].reverse().find((p): p is string => typeof p === "string");
  if (field === "court_ids" || field === "court_id") return both("issue.court");
  if (field && DATES.has(field)) return both("issue.date");
  if (field && MONEY.test(field)) return both("issue.amount");
  const label = field ? LABELS[field] : undefined;
  if (!label) return both("issue.general");
  const f = both(label), v = valueAt(raw, i.path);
  if (v === undefined || v === null || v === "") return both("issue.missing", { field: f });
  switch (i.code) {
    case "too_small": return both(i.origin === "string" ? "issue.too_short" : LISTS.has(i.origin ?? "") ? "issue.pick_one" : "issue.too_low", { field: f });
    case "too_big": return both(i.origin === "string" ? "issue.too_long" : LISTS.has(i.origin ?? "") ? "issue.too_many" : "issue.too_high", { field: f });
    case "invalid_value": return both("issue.choice", { field: f });
    default: return both("issue.wrong", { field: f });
  }
}

/** Up to three plain sentences for what was wrong, each said once. */
export function plainIssues(issues: readonly Issue[], raw: unknown): Text {
  const out: Text[] = [], seen = new Set<string>();
  for (const i of issues) {
    const x = one(i, raw);
    if (seen.has(x.en)) continue;
    seen.add(x.en); out.push(x);
    if (out.length === 3) break;
  }
  if (!out.length) out.push(both("issue.general"));
  return { en: out.map((x) => x.en).join(" "), es: out.map((x) => x.es).join(" ") };
}
