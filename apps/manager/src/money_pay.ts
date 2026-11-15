// What the Money page's "Record payment" runs for something owed: the same record-payment action the Schedule (a
// court) and a program's roster (a place) use, so the preview and confirm, the permission check and the undo are theirs.

/** Something owed, as /staff/money lists it. */
export type OwedThing = { kind: "booking" | "place"; id: string; location_id: string };

/** The action and its input for a payment taken at the desk; null where this person may not take it (a role the club
 *  made without it, or one kept to another location). The server decides either way. */
export function payAction(x: OwedThing, cents: number, method: string, may: (action: string) => boolean, covers: (locationId: string) => boolean) {
  const action = x.kind === "booking" ? "booking.record_payment" : "enrolment.record_payment";
  if (!may(action) || !covers(x.location_id)) return null;
  return { action, input: x.kind === "booking" ? { booking_id: x.id, cents, method } : { enrolment_id: x.id, cents, method } };
}
