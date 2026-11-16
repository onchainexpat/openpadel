// Who's checked in, worked out from what Today and the Schedule already read (kept apart from the pages so it's tested on
// its own): whether a booking counts as checked in, how many of the bookings shown are, and what its button asks for.

export type CheckInRow = { kind: string; id: string; places?: number; checked_in?: number };

/** A booking is checked in once every place still in it is (a booking with no places has nothing to check in). */
export const allIn = (x: CheckInRow) => (x.places ?? 0) > 0 && (x.checked_in ?? 0) >= (x.places ?? 0);

/** "N of M bookings checked in": only bookings with places count. */
export function bookingsIn(items: CheckInRow[]): { count: number; total: number } {
  const b = items.filter((x) => x.kind === "booking" && (x.places ?? 0) > 0);
  return { count: b.filter(allIn).length, total: b.length };
}

/** What the booking's button previews: checking in whoever isn't yet, or, once everyone is, taking it back. */
export const checkInInput = (x: CheckInRow) => ({ booking_id: x.id, ...(allIn(x) ? { checked_in: false } : {}) });
