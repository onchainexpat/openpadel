-- Only the person's own act brings someone deleted here back (playtomic_erased.ts markRejoined): signing up
-- themselves, adding or changing their own address, or the first sign-in that proves the address on an account the
-- desk made for them. The triggers of 105 counted any new person at the address (an import, support access, the
-- desk) and any Playtomic id an import linked, so they go.
DROP TRIGGER IF EXISTS person_playtomic_rejoined ON person;
DROP TRIGGER IF EXISTS external_ref_playtomic_rejoined ON external_ref;
DROP FUNCTION IF EXISTS playtomic_rejoined();
