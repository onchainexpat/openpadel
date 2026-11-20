// Roles: the built-in ones (fixed, but they can be copied) and the club's own. A club's role is a name and,
// area by area, what it may do: nothing, the person's own, or everyone's, optionally with approval. Below them, the
// club's second-yes rule: the changes that wait for two different people's yes, and the amount over which any change
// by staff does too (role.second_yes).
import { useEffect, useState } from "preact/hooks";
import { Skeleton, api, dollars, lang, t, usePreview } from "@kumi/ui";
import { fromMajor, toMajor } from "@kumi/i18n/format";

type Role = { key: string; name: string; system: boolean; based_on: string | null; holders: number };
type Area = { key: string; title: string; actions: { name: string; title: string }[] };
type Grant = { action: string; scope: "own" | "any"; approval: boolean };
type Choice = "" | "own" | "own_ask" | "any" | "any_ask";
type SecondYes = { actions: string[]; over_cents: number | null; areas: Area[] };
const toChoice = (g?: Grant): Choice => (!g ? "" : `${g.scope}${g.approval ? "_ask" : ""}` as Choice);
const fromChoices = (c: Record<string, Choice>): Grant[] => Object.entries(c).filter(([, v]) => v).map(([action, v]) => ({ action, scope: v.startsWith("any") ? "any" : "own", approval: v.endsWith("_ask") }));

export function Roles() {
  const [roles, setRoles] = useState<Role[] | null>(null), [areas, setAreas] = useState<Area[]>([]);
  const [editing, setEditing] = useState<{ key?: string; name: string; based_on?: string; choices: Record<string, Choice> } | null>(null);
  const [second, setSecond] = useState<SecondYes | null>(null), [rule, setRule] = useState<{ actions: string[]; over: string } | null>(null);
  const load = async () => {
    setRoles(await api<Role[]>("/staff/roles")); setAreas(await api<Area[]>("/staff/roles/catalogue"));
    setSecond(await api<SecondYes>("/staff/roles/second_yes").catch(() => null));
  };
  const { preview, sheet } = usePreview(() => { setEditing(null); setRule(null); void load(); });
  useEffect(() => { void load(); }, []);
  const start = async (r: Role | null, copy: boolean) => {
    const grants = r ? await api<Grant[]>(`/staff/roles/${r.key}/grants`) : [];
    setEditing({ key: copy || !r ? undefined : r.key, name: copy || !r ? "" : r.name, based_on: copy && r ? r.key : undefined,
      choices: Object.fromEntries(grants.map((g) => [g.action, toChoice(g)])) });
  };
  if (!roles) return <Skeleton />;
  if (rule && second) {
    const toggle = (name: string, on: boolean) => setRule({ ...rule, actions: on ? [...rule.actions, name] : rule.actions.filter((a) => a !== name) });
    const submit = (e: Event) => {
      e.preventDefault();
      const over = rule.over.trim() === "" ? null : fromMajor(Number(rule.over.replace(",", ".")));
      void preview("role.second_yes", { actions: rule.actions, over_cents: over });
    };
    return (
      <main>
        <h1>{t("ui.second_yes_title")}</h1>
        <form class="card card-form" onSubmit={submit}>
          <p class="meta">{t("ui.second_yes_hint")}</p>
          <label>{t("ui.second_yes_over")}<input type="number" min="0" step="1" inputMode="decimal" placeholder={t("ui.second_yes_no_amount")} value={rule.over}
            onInput={(e) => setRule({ ...rule, over: e.currentTarget.value })} /></label>
          <p class="meta">{t("ui.second_yes_changes")}</p>
          {second.areas.map((a) => (
            <details class="area" key={a.key} open={a.actions.some((x) => rule.actions.includes(x.name))}>
              <summary>{a.title}{a.actions.some((x) => rule.actions.includes(x.name)) ? ` (${a.actions.filter((x) => rule.actions.includes(x.name)).length})` : ""}</summary>
              {a.actions.map((x) => (
                <label class="check" key={x.name}><input type="checkbox" checked={rule.actions.includes(x.name)} onChange={(e) => toggle(x.name, e.currentTarget.checked)} /> {x.title}</label>
              ))}
            </details>
          ))}
          <button class="primary">{t("ui.preview")}</button> <button type="button" onClick={() => setRule(null)}>{t("ui.cancel")}</button>
        </form>
        {sheet}
      </main>
    );
  }
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
      {/* The club's second-yes rule, as it stands: what it names, and the amount. */}
      {second && <section class="card">
        <h2>{t("ui.second_yes_title")}</h2>
        {!second.actions.length && second.over_cents === null ? <p class="meta">{t("ui.second_yes_none")}</p> : <ul>
          {second.over_cents !== null && <li>{t("ui.second_yes_over")} {dollars(second.over_cents, lang.value)}</li>}
          {second.actions.map((n) => <li key={n}>{second.areas.flatMap((a) => a.actions).find((x) => x.name === n)?.title ?? n}</li>)}
        </ul>}
        <button onClick={() => setRule({ actions: second.actions, over: second.over_cents === null ? "" : String(toMajor(second.over_cents)) })}>{t("ui.change")}</button>
      </section>}
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
