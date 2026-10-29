import { useEffect, useState } from "preact/hooks";
import { api, lang, t } from "@kumi/ui";

type L = { rating: { level: string; provisional: boolean; floor: string | null; rated_games: number } | null; events: { at: string; explanation: string }[] };

export function MyLevel() {
  const [d, setD] = useState<L | null>(null);
  useEffect(() => { api<L>("/my/level").then(setD); }, [lang.value]);
  if (!d) return <main class="card"><p>{t("ui.loading")}</p></main>;
  const when = (iso: string) => new Intl.DateTimeFormat(lang.value === "es" ? "es-US" : "en-US", { dateStyle: "medium" }).format(new Date(iso));
  return (
    <main>
      <h1>{t("ui.nav_level")}</h1>
      {!d.rating ? <p class="card">{t("ui.level_not_yet")}</p> : <section class="card"><p class="big">{d.rating.level}</p>
        <p class="meta">{t("ui.rated_games", { count: d.rating.rated_games })}{d.rating.provisional ? ` · ${t("ui.provisional")}` : ""}</p></section>}
      {d.events.length > 0 && <section class="card"><h2>{t("ui.history")}</h2><ul class="plain">{d.events.map((e) => <li><span class="meta">{when(e.at)}</span> {e.explanation}</li>)}</ul></section>}
    </main>
  );
}
