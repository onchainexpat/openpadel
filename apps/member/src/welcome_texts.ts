// The welcome's yes to texts (Welcome.tsx): offered when the club sends texts, to someone who hasn't said yes (a kid
// only once their parents allow it), never ticked for them, and asked of the server only when they ticked it and
// their number is confirmed. The same consent.texts change, with the same words, as Profile's.
export type TextsState = { on: boolean; phone: string | null; waiting_code_for: string | null; answer: boolean | null; kid: { allowed: boolean } | null; form: { version: string; words: string } };

export const offerTexts = (s: TextsState | null): boolean => Boolean(s?.on && s.answer !== true && !(s.kid && !s.kid.allowed));

/** The consent.texts input to preview at Continue, or null: nothing is asked (and nothing recorded) unless ticked. */
export function textsConsent(ticked: boolean, s: TextsState | null, personId: string, device: string) {
  if (!ticked || !s || !offerTexts(s) || !s.phone) return null;
  return { person_id: personId, granted: true, form_version: s.form.version, app: "member" as const, device: device.slice(0, 300) };
}
