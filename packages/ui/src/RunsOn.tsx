// "Runs on Kumi": shown only when Kumi's hosted service runs the install (/club says hosted). A club running
// openPadel itself shows no product name to anyone but its staff.
import { HOSTED_URL } from "@kumi/i18n/format";
import { club, t } from "./state.ts";

export function RunsOn() {
  if (!club.value?.hosted) return null;
  return <p class="meta runs-on"><a href={HOSTED_URL} target="_blank" rel="noopener">{t("ui.runs_on")}</a></p>;
}
