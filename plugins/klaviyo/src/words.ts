// What the plugin's card on the club's Connectors page says, in English and Spanish (US and Latin American, with "tú"),
// through plugin.card_put. Each row is one line with no dashes; the card's title ("Klaviyo") comes from the manifest.

export interface Text { en: string; es: string }
export interface Row { label: Text; text: Text }
export interface Card { tone: "ok" | "warn" | "off"; rows: Row[] }

export type Problem = null | "no_key" | "no_list" | "list_missing" | "refused" | "unreachable";

/** "Nov 18, 9:00 AM" and "18 nov, 9:00 a.m.", at the club. */
export function when(ms: number, timeZone: string): Text {
  const f = (locale: string) => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(ms)).replace(/ /g, " ");
  return { en: f("en-US"), es: f("es-US") };
}
const count = (n: number) => ({ en: n.toLocaleString("en-US"), es: n.toLocaleString("es-US") });

const PROBLEM: Record<Exclude<Problem, null>, Text> = {
  no_key: { en: "Waiting for its private API key (KLAVIYO_API_KEY) in the vault", es: "Falta su clave privada de API (KLAVIYO_API_KEY) en la bóveda" },
  no_list: { en: "Waiting for the list's id in the plugin's settings", es: "Falta el id de la lista en la configuración del plugin" },
  list_missing: { en: "Klaviyo has no list with that id: check the plugin's settings", es: "Klaviyo no tiene una lista con ese id: revisa la configuración del plugin" },
  refused: { en: "It refused the key: add a new one in the vault, with access to lists and profiles", es: "Rechazó la clave: agrega una nueva en la bóveda, con acceso a listas y perfiles" },
  unreachable: { en: "Not answering. It keeps trying, and takes off whoever said no as soon as it answers", es: "No responde. Lo sigue intentando, y saca de la lista a quien dijo que no en cuanto responda" },
};

export function cardFor(o: { members: number; listName: string | null; checkedAt: number | null; timeZone: string; problem: Problem; waiting: number; privacyRefused: boolean }): Card {
  const rows: Row[] = [];
  const n = count(o.members), list = o.listName ? { en: ` on ${o.listName}`, es: ` en ${o.listName}` } : { en: "", es: "" };
  rows.push({ label: { en: "On the list", es: "En la lista" },
    text: { en: `${n.en} ${o.members === 1 ? "member" : "members"} who said yes to club news${list.en}`, es: `${n.es} ${o.members === 1 ? "miembro que dijo" : "miembros que dijeron"} que sí a las novedades del club${list.es}` } });
  if (o.checkedAt !== null) {
    const at = when(o.checkedAt, o.timeZone);
    rows.push({ label: { en: "Last full check", es: "Última revisión completa" }, text: { en: at.en, es: at.es } });
  }
  if (o.waiting) {
    const w = count(o.waiting);
    rows.push({ label: { en: "To take off", es: "Por sacar" },
      text: { en: `${w.en} ${o.waiting === 1 ? "member who said no or whose account was deleted, waiting for Klaviyo" : "members who said no or whose accounts were deleted, waiting for Klaviyo"}`,
        es: `${w.es} ${o.waiting === 1 ? "miembro que dijo que no o cuya cuenta se eliminó, esperando a Klaviyo" : "miembros que dijeron que no o cuyas cuentas se eliminaron, esperando a Klaviyo"}` } });
  }
  if (o.problem) rows.push({ label: { en: "Klaviyo", es: "Klaviyo" }, text: PROBLEM[o.problem] });
  if (o.privacyRefused) rows.push({ label: { en: "Deleted accounts", es: "Cuentas eliminadas" },
    text: { en: "Taken off the list, but their profile stays in Klaviyo: give the key Data Privacy access", es: "Salen de la lista, pero su perfil queda en Klaviyo: dale a la clave acceso a Data Privacy" } });
  return { tone: o.problem || o.waiting || o.privacyRefused ? "warn" : "ok", rows };
}
