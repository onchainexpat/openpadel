// Saving a passkey, in plain words: for the profile and the second step, both loaded only when they're opened.
import { passkeyFailure, t } from "./state.ts";

/** Why a passkey wasn't saved, in plain words (null: not a passkey failure). */
export function passkeyWords(e: unknown): string | null {
  const f = passkeyFailure(e);
  return !f ? null : f === "InvalidStateError" ? t("ui.passkey_already_here") : f === "NotSupportedError" || f === "SecurityError" ? t("ui.passkey_not_here") : t("ui.passkey_not_saved");
}
/** Whether this device can save a passkey of its own: a phone with no screen lock can't, and the browser just waits. */
export async function canSavePasskey(): Promise<boolean> {
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}
