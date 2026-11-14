// The places a desk form names (a court booking, a private lesson, an open match): read as bookings.ts and lessons.ts
// load, so kept apart from both (each imports the other's functions).
import * as z from "zod/mini";

/** One place on a court booked at the desk: a member (found by name, phone or email), a guest's name, or left open
 *  (the organiser shares the booking's link). `paid`: its part was paid at the desk just now. */
export const deskPlace = z.object({ person_id: z.optional(z.uuid()), guest_name: z.optional(z.string().check(z.minLength(1), z.maxLength(80))), paid: z.optional(z.boolean()) });
export type DeskPlace = z.infer<typeof deskPlace>;
/** How the desk was paid for the places marked paid (desk_pay.ts DESK_METHODS, written out: it's read as this file loads). */
export const deskMethod = z.enum(["cash", "terminal", "other"]);
export const placeFilled = (p: DeskPlace) => Boolean(p.person_id || p.guest_name);
