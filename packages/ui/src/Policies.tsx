// The club's own terms and privacy policy, on its own website (Settings): linked where people join, beside the yes
// to texts and on the profile. Nothing shows while the club hasn't set them.
import { club, t } from "./state.ts";

/** The links (each opens in its own tab, so a half-filled form stays), after what joining agrees to on the join form. */
export function PolicyLinks({ join }: { join?: boolean }) {
  const c = club.value, terms = c?.terms_url, privacy = c?.privacy_policy_url;
  if (!c || (!terms && !privacy)) return null;
  return (
    <p class="meta policies">
      {join && `${t("ui.policies_join", { club: c.name })} `}
      {terms && <a href={terms} target="_blank" rel="noopener">{t("ui.club_terms")}</a>}
      {terms && privacy && " · "}
      {privacy && <a href={privacy} target="_blank" rel="noopener">{t("ui.club_privacy")}</a>}
    </p>
  );
}

/** The links the page is showing, which joining agrees to (person.sign_up keeps them). */
export const shownPolicies = () => ({ terms_url: club.value?.terms_url ?? null, privacy_policy_url: club.value?.privacy_policy_url ?? null });
