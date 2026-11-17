// Plugins' cards in a slot (plugin_cards.ts on the server): a court's tile, a game's page, a member's profile, Money,
// Connectors. A card is data, never a plugin's code: its title (from the plugin's manifest), a tone, up to six rows of
// words in the reader's language, and an https link, drawn here with the apps' own pieces. Nothing to show, nothing
// drawn; a read that fails (a role that doesn't read the slot, an older server) draws nothing too.
import { useEffect, useState } from "preact/hooks";
import { api, lang, t } from "./state.ts";

export type PluginCardData = { plugin: string; slot: string; subject: string | null; title: string; tone: "ok" | "warn" | "off";
  rows: { label: string; text: string }[]; link: { url: string; label: string } | null; put_at: string };

/** The cards at an address (null: none asked for), read again when the language changes or `again` does. */
export function usePluginCards<T = PluginCardData[]>(path: string | null, again: unknown = null): T | null {
  const [cards, setCards] = useState<T | null>(null);
  useEffect(() => {
    if (!path) { setCards(null); return; }
    let live = true;
    api<T>(path).then((c) => { if (live) setCards(c); }).catch(() => { if (live) setCards(null); });
    return () => { live = false; };
  }, [path, lang.value, again]);
  return cards;
}

/** One plugin's card. `bare`: without its own frame, inside something that already is one (a court's tile). */
export function PluginCard({ c, bare }: { c: PluginCardData; bare?: boolean }) {
  return (
    <section class={`${bare ? "" : "card "}plugin-card tone-${c.tone}`} aria-label={t("ui.plugin_card_from", { title: c.title, plugin: c.plugin })}>
      <header class="plugin-card-head">
        <strong>{c.title}</strong>
        {c.tone !== "ok" && <span class={`pill ${c.tone === "warn" ? "pill-paused" : "pill-cancelled"}`}>{t(c.tone === "warn" ? "ui.plugin_card_warn" : "ui.plugin_card_off")}</span>}
        <span class="meta plugin-card-by">{t("ui.plugin_card_by", { plugin: c.plugin })}</span>
      </header>
      <dl class="plugin-card-rows">{c.rows.map((r) => <div><dt>{r.label}</dt><dd>{r.text}</dd></div>)}</dl>
      {c.link && <p class="plugin-card-link"><a href={c.link.url} target="_blank" rel="noopener noreferrer nofollow">{c.link.label}</a></p>}
    </section>
  );
}

/** A slot's cards, each as its own card. */
export function PluginCards({ cards, bare }: { cards: PluginCardData[] | null | undefined; bare?: boolean }) {
  if (!cards?.length) return null;
  return <div class="plugin-cards">{cards.map((c) => <PluginCard key={`${c.plugin}:${c.subject ?? ""}`} c={c} bare={bare} />)}</div>;
}
