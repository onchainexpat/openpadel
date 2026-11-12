// Over Play's and Learn's lists: any day, or one of the next seven (the club's days, as on Book), and "only ones
// with places". The choice narrows the list below; nothing is fetched again.
import { lang, serverNow, t } from "@kumi/ui";
import { formatLocale } from "@kumi/i18n/format";
import { nextDays } from "./whats_on.ts";

/** "" is any day. `has` marks the days with something on (a dot, and said to screen readers). */
export function DayStrip({ value, onChange, tz, has }: { value: string; onChange: (day: string) => void; tz: string; has: (day: string) => boolean }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(serverNow()));
  const f = (d: string, x: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(formatLocale(lang.value), { timeZone: "UTC", ...x }).format(new Date(`${d}T12:00:00Z`));
  return (
    <div class="days" role="group" aria-label={t("ui.day")}>
      <button type="button" class={value === "" ? "day any on" : "day any"} aria-pressed={value === ""} onClick={() => onChange("")}><strong>{t("ui.any_day")}</strong></button>
      {nextDays(today).map((d) => {
        const on = has(d);
        return <button type="button" class={d === value ? "day on" : "day"} aria-pressed={d === value} onClick={() => onChange(d)}
          aria-label={`${f(d, { weekday: "long", day: "numeric", month: "long" })}${on ? "" : `, ${t("ui.nothing_that_day")}`}`}>
          <span>{f(d, { weekday: "short" })}</span><strong>{f(d, { day: "numeric" })}</strong><span class={on ? "dot" : "dot none"} aria-hidden="true" /></button>;
      })}
    </div>
  );
}

/** "Only ones with places", as a switch. */
export function PlacesToggle({ value, onChange }: { value: boolean; onChange: (on: boolean) => void }) {
  return <label class="check toggle"><input type="checkbox" role="switch" checked={value} onChange={(e) => onChange(e.currentTarget.checked)} /> {t("ui.only_with_places")}</label>;
}
