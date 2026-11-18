// What its cards say, in English and Spanish (US and Latin American, with "tú"), through plugin.card_put: the
// Connectors card (connect, connected to whom, last sent, next send, what's wrong) and the Money card. Each row is one
// line with no dashes; the titles come from the manifest.

export interface Text { en: string; es: string }
export interface Row { label: Text; text: Text }
export interface Card { tone: "ok" | "warn" | "off"; rows: Row[]; link?: { url: string; label: Text } }

/** A club date as each language reads it: "Mon, Nov 16", "lun, 16 nov". */
export function dayWords(ymd: string): Text {
  const d = new Date(`${ymd}T12:00:00Z`);
  const f = (locale: string) => new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(d).replace(/\./g, "");
  return { en: f("en-US"), es: f("es-US") };
}
/** A club time: "6:00 AM", "6:00 a.m.". */
export function timeWords(hhmm: string): Text {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const d = new Date(Date.UTC(2026, 0, 1, h, m));
  const f = (locale: string) => new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(d).replace(/[\u202f\u00a0]/g, " ");
  return { en: f("en-US"), es: f("es-US") };
}
const article = (es: string) => (/^1[:.]/.test(es) ? "la " : "las ") + es;
/** What a provider or organisation name may say on a card: one line, no dashes, not too long. */
export const clean = (s: string, max = 80) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[\u2013\u2014]/g, ",").replace(/\s+/g, " ").trim().slice(0, max);

export type Problem = null | "no_keys" | "no_start" | "reconnect" | "down" | "rate" | "rejected" | "door" | "unbalanced" | "no_accounts" | "stripe" | "stripe_long";

export interface State {
  provider: "xero" | "quickbooks";
  connected: boolean;
  org: string | null;
  missingKeys: string[];
  redirect: string;
  connectUrl: string | null;
  lastSentDay: string | null;
  next: { date: string; time: string } | null;
  problem: Problem;
  detail: string | null;
  suspense: number;
  /** The day held back because the card provider's fees or payouts for it couldn't be read. */
  waitingDay: string | null;
}

const NAME = { xero: "Xero", quickbooks: "QuickBooks" } as const;

function problemRow(s: State): Row | null {
  const p = NAME[s.provider], d = s.detail ? clean(s.detail, 100) : null;
  const wd = s.waitingDay ? dayWords(s.waitingDay) : { en: "a day", es: "un día" };
  const w: Record<Exclude<Problem, null>, Text> = {
    no_keys: { en: `Add ${s.missingKeys.join(" and ")} in the vault`, es: `Agrega ${s.missingKeys.join(" y ")} en la bóveda` },
    no_start: { en: "Set the first day to send in the plugin's settings", es: "Elige el primer día a enviar en la configuración del plugin" },
    reconnect: { en: `${p} asked to be connected again`, es: `${p} pidió que lo conectes otra vez` },
    down: { en: `${p} isn't answering; it tries again soon`, es: `${p} no responde; se vuelve a intentar pronto` },
    rate: { en: `${p} asked to wait; it tries again soon`, es: `${p} pidió esperar; se vuelve a intentar pronto` },
    rejected: { en: `${p} refused a journal${d ? `: ${d}` : ""}`, es: `${p} rechazó un asiento${d ? `: ${d}` : ""}` },
    door: { en: "The club's books couldn't be read; it tries again soon", es: "No se pudieron leer las cuentas del club; se vuelve a intentar pronto" },
    unbalanced: { en: "A day's books didn't balance, so nothing was sent", es: "Las cuentas de un día no cuadraron, así que no se envió nada" },
    no_accounts: { en: "Set the accounts in the plugin's settings", es: "Elige las cuentas en la configuración del plugin" },
    stripe: { en: `Waiting for Stripe to send ${wd.en}`, es: `Esperando que Stripe envíe ${wd.es}` },
    stripe_long: { en: `Stripe hasn't answered for 3 days, so ${wd.en} and the days after wait; nothing is sent without its fees and payouts`,
      es: `Stripe no responde desde hace 3 días, así que ${wd.es} y los días siguientes esperan; nada se envía sin sus comisiones y depósitos` },
  };
  return s.problem ? { label: { en: "Needs a look", es: "Revisa esto" }, text: w[s.problem] } : null;
}

function sentRows(s: State): Row[] {
  const rows: Row[] = [];
  const last = s.lastSentDay ? dayWords(s.lastSentDay) : null;
  rows.push({ label: { en: "Last day sent", es: "Último día enviado" }, text: last ? last : { en: "Nothing sent yet", es: "Aún no se envió nada" } });
  if (s.next) {
    const d = dayWords(s.next.date), t = timeWords(s.next.time);
    rows.push({ label: { en: "Next send", es: "Próximo envío" }, text: { en: `${d.en} at ${t.en}`, es: `${d.es} a ${article(t.es)}` } });
  }
  return rows;
}

export function connectorsCard(s: State): Card {
  const p = NAME[s.provider], rows: Row[] = [];
  if (s.connected && s.problem !== "reconnect") {
    const org = s.org ? clean(s.org) : null;
    rows.push({ label: { en: p, es: p }, text: org ? { en: `Connected to ${org}`, es: `Conectado a ${org}` } : { en: "Connected", es: "Conectado" } });
    rows.push(...sentRows(s));
  } else {
    rows.push({ label: { en: p, es: p }, text: { en: "Not connected yet", es: "Aún no está conectado" } });
    rows.push({ label: { en: "Redirect address", es: "Dirección de retorno" }, text: { en: clean(s.redirect, 200), es: clean(s.redirect, 200) } });
  }
  const pr = problemRow(s);
  if (pr) rows.push(pr);
  const card: Card = { tone: s.problem ? "warn" : s.connected ? "ok" : "off", rows };
  if (s.connectUrl && (!s.connected || s.problem === "reconnect")) card.link = { url: s.connectUrl, label: s.connected ? { en: `Connect ${p} again`, es: `Conectar ${p} otra vez` } : { en: `Connect ${p}`, es: `Conectar ${p}` } };
  return card;
}

export function moneyCard(s: State): Card {
  const p = NAME[s.provider], rows: Row[] = [];
  rows.push({ label: { en: "Sent to", es: "Se envía a" }, text: s.connected ? { en: p, es: p } : { en: `${p}, once it's connected in Connectors`, es: `${p}, cuando esté conectado en Conectores` } });
  if (s.connected) rows.push(...sentRows(s));
  if (s.suspense > 0) rows.push({ label: { en: "Without an account", es: "Sin cuenta" },
    text: s.suspense === 1 ? { en: "1 line went to the account for anything else", es: "1 línea fue a la cuenta para todo lo demás" }
      : { en: `${s.suspense} lines went to the account for anything else`, es: `${s.suspense} líneas fueron a la cuenta para todo lo demás` } });
  const pr = problemRow(s);
  if (pr) rows.push(pr);
  return { tone: s.problem ? "warn" : s.connected ? "ok" : "off", rows };
}
