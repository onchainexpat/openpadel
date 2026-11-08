// A booking taken over from Playtomic (playtomic_archive.ts) and paid there: the desk's court detail and a person's page
// say so, and, when time was added here (or it moved somewhere dearer), what's still owed here too, as My places says
// "Paid $40.00 of $60.00". Saying only one of the two read as either all paid or none of it.
export type Part = { key: "ui.paid_in_playtomic" | "ui.unpaid_amount"; cents: number };

/** What they paid, all in Playtomic, then what's still owed here, if anything. Null when what they paid wasn't paid
 *  there (the usual lines say it). */
export function playtomicParts(x: { paid: number; pt: number; owed: number }): Part[] | null {
  if (!(x.pt > 0 && x.pt >= x.paid)) return null;
  return [{ key: "ui.paid_in_playtomic", cents: x.paid }, ...(x.owed > 0 ? [{ key: "ui.unpaid_amount" as const, cents: x.owed }] : [])];
}
