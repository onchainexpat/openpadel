// An address the app doesn't have (an old link, a typo): said plainly, with the oops drawing and the way back to the
// start, rather than a blank page or a jump somewhere the person didn't ask for.
import { Illustration } from "./Illustration.tsx";
import { t } from "./state.ts";

export function NotFound() {
  return (
    <main class="card empty not-found">
      <Illustration name="oops" size="s" />
      <h1>{t("ui.not_found_title")}</h1>
      <p class="meta">{t("ui.not_found_body")}</p>
      <p><a class="button primary" href="/">{t("ui.not_found_home")}</a></p>
    </main>
  );
}
