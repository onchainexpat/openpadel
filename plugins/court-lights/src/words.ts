// What the court's tile says, in English and Spanish (US and Latin American, with "tú"), through plugin.card_put. Each
// row is one line with no dashes; the card's title ("Lights", "Luces") comes from the manifest.

export interface Text { en: string; es: string }
export interface Row { label: Text; text: Text }
export interface Card { tone: "ok" | "warn" | "off"; rows: Row[] }

/** A time at the club, as each language reads it: "9:30 PM", "9:30 p.m.". */
export function clock(ms: number, timeZone: string): Text {
  const f = (locale: string) => new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(ms)).replace(/ /g, " ");
  return { en: f("en-US"), es: f("es-US") };
}
/** "las 9:30 p.m.", but "la 1:15 p.m.". */
const article = (es: string) => (/^1[:.]/.test(es) ? "la " : "las ") + es;
/** Within the next day, or it isn't said. */
const DAY_MS = 24 * 3600_000;

export type HaProblem = null | "unreachable" | "refused" | "no_token" | "no_address";

export function cardFor(o: { on: boolean; until: number | null; next: number | null; now: number; timeZone: string; entities: string[]; problem: HaProblem }): Card {
  const rows: Row[] = [];
  if (o.on) {
    const until = o.until !== null && o.until - o.now < DAY_MS ? clock(o.until, o.timeZone) : null;
    rows.push({ label: { en: "Now", es: "Ahora" }, text: until ? { en: `On until ${until.en}`, es: `Encendidas hasta ${article(until.es)}` } : { en: "On", es: "Encendidas" } });
  } else {
    rows.push({ label: { en: "Now", es: "Ahora" }, text: { en: "Off", es: "Apagadas" } });
    if (o.next !== null && o.next - o.now < DAY_MS) {
      const at = clock(o.next, o.timeZone);
      rows.push({ label: { en: "Next", es: "Próximo" }, text: { en: `On at ${at.en} for the next booking`, es: `Se encienden a ${article(at.es)} para la próxima reserva` } });
    }
  }
  const problem: Record<Exclude<HaProblem, null>, Text> = {
    unreachable: { en: "Not answering, so the lights may not follow bookings", es: "No responde, así que las luces podrían no seguir las reservas" },
    refused: { en: "It refused the access token: add a new one in the vault", es: "Rechazó el token de acceso: agrega uno nuevo en la bóveda" },
    no_token: { en: "Waiting for its access token (HA_TOKEN) in the vault", es: "Falta su token de acceso (HA_TOKEN) en la bóveda" },
    no_address: { en: "Waiting for its address in the plugin's settings", es: "Falta su dirección en la configuración del plugin" },
  };
  if (o.problem) rows.push({ label: { en: "Home Assistant", es: "Home Assistant" }, text: problem[o.problem] });
  if (o.entities.length) { const e = o.entities.join(", ").slice(0, 120); rows.push({ label: { en: "In Home Assistant", es: "En Home Assistant" }, text: { en: e, es: e } }); }
  return { tone: o.problem ? "warn" : o.on ? "ok" : "off", rows };
}
