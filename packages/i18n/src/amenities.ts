// What a club has besides its courts (club.update's amenities): a fixed list, so every club's reads the same and each
// has its words in both languages (`amenity.*` keys in en.ts and es.ts). Shown in this order, on the members' Home
// and the public page. Adding one later is data only: its key here and its words in both languages.

export const AMENITIES = ["parking", "showers", "changing_rooms", "lockers", "cafe", "pro_shop", "racket_rental", "wifi", "step_free", "kids_area"] as const;
export type Amenity = (typeof AMENITIES)[number];
/** The club's amenities that are on the list, in the list's order (a key no longer on it is left out). */
export const amenitiesInOrder = (have: readonly string[] | null | undefined): Amenity[] => AMENITIES.filter((a) => have?.includes(a));
