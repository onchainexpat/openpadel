/** Who a match or program is meant for (migration 123): a label people choose by, never checked against anyone.
 *  Empty is open to all; "mixed pairs" is for events played in pairs. */
export const MATCH_GENDERS = ["mixed", "women", "men"] as const;
export const PROGRAM_GENDERS = [...MATCH_GENDERS, "mixed_pairs"] as const;
