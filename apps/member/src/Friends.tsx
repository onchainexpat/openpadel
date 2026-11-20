// Friends: people the member has added and who added them, people they've played with lately (to add),
// and their own friend link. A friend is someone each has added; only friends save each other match places.
import { useEffect, useState } from "preact/hooks";
import { Icon, Skeleton, api, ApiError, me, t, usePreview } from "@kumi/ui";

type Named = { id: string; display_name: string };
type Page = { friends: Named[]; added_you: Named[]; you_added: Named[]; played_with: Named[]; code: string };

export function Friends() {
  if (me.value?.kid && !me.value.kid.friends) return <main><h1>{t("ui.friends")}</h1><p class="card">{t("ui.kid_friends_off_note")}</p></main>;
  return <FriendsPage />;
}
function FriendsPage() {
  const [f, setF] = useState<Page | null>(null), [copied, setCopied] = useState(false);
  const load = () => api<Page>("/my/friends").then(setF);
  const { preview, sheet } = usePreview(() => void load());
  useEffect(() => { void load(); }, []);
  if (!f) return <Skeleton />;
  const pid = me.value!.person.id, link = `${location.origin}/friend/${f.code}`;
  const copy = async () => { await navigator.clipboard?.writeText(link).catch(() => {}); setCopied(true); };
  const share = () => navigator.share?.({ title: t("ui.friend_link_title"), url: link }).catch(() => {});
  const list = (rows: Named[], label: string, action: "friend.add" | "friend.remove", primary = false) => <ul class="plain">{rows.map((p) => (
    <li class="row"><span>{p.display_name}</span>
      <button class={primary ? "small primary" : "small"} onClick={() => preview(action, { person_id: pid, friend_id: p.id })}>{label}</button></li>))}</ul>;
  return (
    <main>
      <h1>{t("ui.friends")}</h1>
      {sheet}
      {f.added_you.length > 0 && <section class="card"><h2>{t("ui.added_you")}</h2>{list(f.added_you, t("ui.add_back"), "friend.add", true)}</section>}
      <section class="card">
        <h2>{t("ui.see_friends")}</h2>
        {f.friends.length ? list(f.friends, t("ui.remove"), "friend.remove") : <p class="meta">{t("ui.friends_none")}</p>}
        {f.you_added.length > 0 && <><p class="meta">{t("ui.you_added")}</p>{list(f.you_added, t("ui.take_back"), "friend.remove")}</>}
      </section>
      <section class="card">
        <h2>{t("ui.played_with_lately")}</h2>
        {f.played_with.length ? list(f.played_with, t("ui.add_friend"), "friend.add") : <p class="meta">{t("ui.played_with_none")}</p>}
      </section>
      <section class="card">
        <h2>{t("ui.friend_link_title")}</h2>
        <p class="meta">{t("ui.friend_link_hint")}</p>
        <p><button onClick={copy}>{copied ? t("ui.link_copied") : t("ui.copy_friend_link")}</button>{" "}
          {"share" in navigator && <button onClick={share}><Icon name="share-2" />{t("ui.share_friend_link")}</button>}</p>
      </section>
    </main>
  );
}

/** Someone's friend link, opened: their name and one button. */
export function FriendLink({ code }: { code: string }) {
  const [p, setP] = useState<(Named & { status: "self" | "friends" | "waiting" | "added_you" | "none" }) | null>(null), [error, setError] = useState<string | null>(null);
  const load = () => api<NonNullable<typeof p>>(`/my/friends/link/${encodeURIComponent(code)}`).then(setP).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  const { preview, sheet } = usePreview(() => void load());
  useEffect(() => { void load(); }, [code]);
  if (error) return <main class="card"><p class="error">{error}</p></main>;
  if (!p) return <Skeleton />;
  const name = p.display_name;
  return (
    <main>
      {sheet}
      <section class="card">
        {p.status === "self" ? <p>{t("ui.friend_link_self")}</p>
          : p.status === "friends" ? <p>{t("ui.friend_link_friends", { name })}</p>
          : p.status === "waiting" ? <p>{t("ui.friend_link_waiting", { name })}</p>
          : <>
            <h1>{t("ui.friend_link_page", { name })}</h1>
            {p.status === "added_you" && <p class="meta">{t("ui.friend_link_added_you", { name })}</p>}
            <button class="primary" onClick={() => preview("friend.add_by_code", { person_id: me.value!.person.id, code })}>{p.status === "added_you" ? t("ui.add_back") : t("ui.add_friend")}</button>
          </>}
        <p><a href="/friends">{t("ui.see_friends")}</a></p>
      </section>
    </main>
  );
}
