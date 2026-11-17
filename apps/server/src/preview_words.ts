// A preview as the apps show it, in one language: what the plan route gives the staff and members' apps
// (app.ts, POST /actions/:name/plan), and what Ask openPadel hands the same Preview sheet (assistant.ts).
import type { Lang } from "@kumi/i18n";
import type { Plan } from "@kumi/core";

/** The charge, line by line, only to the member whose change it is (or a parent of theirs): staff at the desk see the
 *  summary, as before. The rows, for a change that does several things at once. */
export function previewWords(p: Plan, lang: Lang, personId: string | null) {
  const ch = personId && p.ownerIds?.includes(personId) ? p.charge : undefined;
  const charge = ch ? { lines: ch.lines.map((l) => ({ kind: l.kind, label: l.label[lang], cents: l.cents })), due_cents: ch.due_cents, how: ch.how[lang], when: ch.when?.[lang] ?? null } : undefined;
  return { title: p.title[lang], summary: p.summary[lang], ...(charge ? { charge } : {}),
    ...(p.rows?.length ? { rows: p.rows.map((r) => ({ label: r.label[lang], text: r.text[lang] })) } : {}) };
}
