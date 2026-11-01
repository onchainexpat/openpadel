// Roles: the built-in ones (fixed, but they can be copied) and the club's own. A club's role is a name and,
// area by area, what it may do: nothing, the person's own, or everyone's, optionally with approval.
import { useEffect, useState } from "preact/hooks";
import { api, t, usePreview } from "@kumi/ui";

type Role = { key: string; name: string; system: boolean; based_on: string | null; holders: number };
type Area = { key: string; title: string; actions: { name: string; title: string }[] };
type Grant = { action: string; scope: "own" | "any"; approval: boolean };
type Choice = "" | "own" | "own_ask" | "any" | "any_ask";
const toChoice = (g?: Grant): Choice => (!g ? "" : `${g.scope}${g.approval ? "_ask" : ""}` as Choice);
const fromChoices = (c: Record<string, Choice>): Grant[] => Object.entries(c).filter(([, v]) => v).map(([action, v]) => ({ action, scope: v.startsWith("any") ? "any" : "own", approval: v.endsWith("_ask") }));

export function Roles() {
  const [roles, setRoles] = useState<Role[] | null>(null), [areas, setAreas] = useState<Area[]>([]);
  const [editing, setEditing] = useState<{ key?: string; name: string; based_on?: string; choices: Record<string, Choice> } | null>(null);
  const load = async () => { setRoles(await api<Role[]>("/staff/roles")); setAreas(await api<Area[]>("/staff/roles/catalogue")); };
  const { preview, sheet } = usePreview(() => { setEditing(null); void load(); });
  useEffect(() => { void load(); }, []);
  const start = async (r: Role | null, copy: boolean) => {
    const grants = r ? await api<Grant[]>(`/staff/roles/${r.key}/grants`) : [];
    setEditing({ key: copy || !r ? undefined : r.key, name: copy || !r ? "" : r.name, based_on: copy && r ? r.key : undefined,
      choices: Object.fromEntries(grants.map((g) => [g.action, toChoice(g)])) });
  };
  if (!roles) return <main class="card"><p>{t("ui.loading")}</p></main>;
  if (editing) {
    const set = (action: string, v: Choice) => setEditing({ ...editing, choices: { ...editing.choices, [action]: v } });
    const submit = (e: Event) => {
      e.preventDefault();
      const grants = fromChoices(editing.choices);
      void (editing.key ? preview("role.update", { role: editing.key, name: editing.name, grants }) : preview("role.create", { name: editing.name, based_on: editing.based_on, grants }));
    };
    return (
      <main>
        <h1>{editing.key ? t("ui.role_edit_title") : t("ui.role_new_title")}</h1>
        <form class="card card-form" onSubmit={submit}>
          <label>{t("ui.role_name")}<input required maxLength={60} value={editing.name} onInput={(e) => setEditing({ ...editing, name: e.currentTarget.value })} /></label>
          <p class="meta">{t("ui.role_editor_hint")}</p>
          {/* An area folds away; it starts open when the role already has something in it. */}
          {areas.map((a) => (
            <details class="area" key={a.key} open={a.actions.some((x) => editing.choices[x.name])}>
              <summary>{a.title}{a.actions.some((x) => editing.choices[x.name]) ? ` (${a.actions.filter((x) => editing.choices[x.name]).length})` : ""}</summary>
              {a.actions.map((x) => (
                <label key={x.name}>{x.title}
                  <select value={editing.choices[x.name] ?? ""} onChange={(e) => set(x.name, e.currentTarget.value as Choice)}>
                    <option value="">{t("ui.role_no")}</option>
                    <option value="own">{t("ui.role_own")}</option>
                    <option value="own_ask">{t("ui.role_own_ask")}</option>
                    <option value="any">{t("ui.role_any")}</option>
                    <option value="any_ask">{t("ui.role_any_ask")}</option>
                  </select>
                </label>
              ))}
            </details>
          ))}
          <button class="primary">{t("ui.preview")}</button> <button type="button" onClick={() => setEditing(null)}>{t("ui.cancel")}</button>
        </form>
        {sheet}
      </main>
    );
  }
  return (
    <main>
      <h1>{t("ui.roles_title")}</h1>
      <section class="card">
        <p class="meta">{t("ui.roles_hint")}</p>
        <button class="primary" onClick={() => void start(null, false)}>{t("ui.role_new")}</button>
      </section>
      {roles.map((r) => (
        <section class="card" key={r.key}>
          <h2>{r.name}</h2>
          <p class="meta">{r.system ? t("ui.role_built_in") : t("ui.role_club_made")} · {t("ui.role_holders", { count: r.holders })}</p>
          {r.key !== "owner" && r.key !== "member" && <button onClick={() => void start(r, true)}>{t("ui.role_copy")}</button>}{" "}
          {!r.system && <><button onClick={() => void start(r, false)}>{t("ui.role_edit")}</button> <button onClick={() => preview("role.retire", { role: r.key })}>{t("ui.role_retire")}</button></>}
        </section>
      ))}
      {sheet}
    </main>
  );
}
