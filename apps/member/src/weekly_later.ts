// The first week of a weekly court is paid with the card that pays the later ones: wherever that card is asked for,
// the member reads how many later weeks go on it, what they come to, and when each is charged.
import { lang, t, dollars } from "@kumi/ui";

export interface WeeklyLater { count: number; cents: number; hours: number }

export const weeklyLaterLine = (l: WeeklyLater | null | undefined): string | null =>
  l && l.count > 0 ? t("ui.weekly_first_pay", { count: l.count, total: dollars(l.cents, lang.value), hours: t("count.hours", { count: l.hours }) }) : null;
