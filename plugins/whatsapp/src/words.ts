// What its card on Connectors says, in English and Spanish (US and Latin American, with "tú"), through plugin.card_put.
// Each row is one line with no dashes; the title comes from the manifest.

export interface Text { en: string; es: string }
export interface Row { label: Text; text: Text }
export interface Card { tone: "ok" | "warn" | "off"; rows: Row[]; link?: { url: string; label: Text } }

export type Problem = null | "keys" | "down" | "template" | "door";

export interface State {
  missingKeys: string[];
  counts: { sent: number; delivered: number; failed: number; replies: number };
  waiting: number;
  problem: Problem;
  /** The template that Meta refused, with its language, for "template". */
  detail: string | null;
  number: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** What a detail from Meta may say on a card: one line, no dashes, not too long. */
export const clean = (s: string, max = 120) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[\u2013\u2014]/g, ",").replace(/\s+/g, " ").trim().slice(0, max);

export function connectorsCard(s: State): Card {
  const rows: Row[] = [];
  if (s.missingKeys.length) {
    rows.push({ label: { en: "Needs", es: "Falta" }, text: { en: `Keys in the vault: ${s.missingKeys.join(", ")}`, es: `Claves en la bóveda: ${s.missingKeys.join(", ")}` } });
    return { tone: "warn", rows, link: META_LINK };
  }
  if (s.number) rows.push({ label: { en: "Number", es: "Número" }, text: { en: s.number, es: s.number } });
  rows.push({ label: { en: "Today", es: "Hoy" }, text: {
    en: `${plural(s.counts.sent, "message sent", "messages sent")}, ${s.counts.delivered} delivered, ${s.counts.failed} not delivered`,
    es: `${plural(s.counts.sent, "mensaje enviado", "mensajes enviados")}, ${s.counts.delivered} ${s.counts.delivered === 1 ? "entregado" : "entregados"}, ${s.counts.failed} sin entregar` } });
  rows.push({ label: { en: "Replies today", es: "Respuestas hoy" }, text: { en: String(s.counts.replies), es: String(s.counts.replies) } });
  if (s.waiting) rows.push({ label: { en: "Waiting", es: "En espera" }, text: { en: plural(s.waiting, "message", "messages"), es: plural(s.waiting, "mensaje", "mensajes") } });
  const problem: Record<Exclude<Problem, null>, Text> = {
    keys: { en: "Meta refused the club's access token or number id. Add new ones in the vault.", es: "Meta rechazó el token de acceso o el id del número del club. Agrega unos nuevos en la bóveda." },
    down: { en: "Meta isn't answering. Messages wait and are tried again.", es: "Meta no responde. Los mensajes esperan y se vuelven a intentar." },
    template: { en: `Meta doesn't have an approved template: ${clean(s.detail ?? "")}`, es: `Meta no tiene una plantilla aprobada: ${clean(s.detail ?? "")}` },
    door: { en: "The club's door isn't answering. Reports wait and are tried again.", es: "La puerta del club no responde. Los avisos esperan y se vuelven a intentar." },
  };
  if (s.problem) rows.push({ label: { en: "Needs a look", es: "Revisar" }, text: problem[s.problem] });
  return { tone: s.problem ? "warn" : "ok", rows, link: META_LINK };
}

const META_LINK = { url: "https://business.facebook.com/wa/manage/home/", label: { en: "Open WhatsApp Manager", es: "Abrir WhatsApp Manager" } };
