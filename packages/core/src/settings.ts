// The server's settings, by one reader. A setting is named OPENPADEL_X in the settings file (/etc/kumi/kumi.env, read
// into the environment); the old name KUMI_X, from before openPadel was renamed (November 2026), is still read when the
// new one isn't there. `openpadel settings rename` moves a settings file to the new names (settings_file.ts), and
// `openpadel doctor` says, gently, while any old name is still in use. The settings a club's services need (keys,
// a sender) can also be set in the app, in the vault: service_settings.ts reads those, the file first.
export type Env = Record<string, string | undefined>;

export const SETTING_PREFIX = "OPENPADEL_";
export const OLD_SETTING_PREFIX = "KUMI_";

/** A setting's short name: "RESEND_API_KEY" for OPENPADEL_RESEND_API_KEY, KUMI_RESEND_API_KEY or RESEND_API_KEY. */
export const shortName = (name: string) => name.startsWith(SETTING_PREFIX) ? name.slice(SETTING_PREFIX.length) : name.startsWith(OLD_SETTING_PREFIX) ? name.slice(OLD_SETTING_PREFIX.length) : name;
/** A setting's name as the settings file writes it now: OPENPADEL_X. */
export const settingName = (name: string) => SETTING_PREFIX + shortName(name);
/** Its old name: KUMI_X. */
export const oldSettingName = (name: string) => OLD_SETTING_PREFIX + shortName(name);

const given = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

/** A setting's value: OPENPADEL_X, else KUMI_X. An empty new one (an example file's blank line) doesn't hide an old
 *  one that has a value. Undefined when neither is there. */
export function setting(name: string, env: Env = process.env): string | undefined {
  const s = shortName(name), now = env[SETTING_PREFIX + s], old = env[OLD_SETTING_PREFIX + s];
  if (given(now)) return now;
  return old ?? now;
}

/** Where a setting's value comes from in the environment: its new name, its old one, or neither; and whether both are
 *  set to different values (the new one wins). */
export function settingFrom(name: string, env: Env = process.env): { value: string | undefined; from: string | null; differs: boolean } {
  const s = shortName(name), now = env[SETTING_PREFIX + s], old = env[OLD_SETTING_PREFIX + s];
  if (given(now)) return { value: now, from: SETTING_PREFIX + s, differs: given(old) && old.trim() !== now.trim() };
  if (given(old)) return { value: old, from: OLD_SETTING_PREFIX + s, differs: false };
  return { value: old ?? now, from: null, differs: false };
}

/** The Docker image's own defaults (the Dockerfile keeps them under their KUMI_ names, so a club's .env wins under
 *  either name): OPENPADEL_IMAGE_DEFAULTS lists them as NAME=value, space-separated. */
export function imageDefaults(env: Env = process.env): Map<string, string> {
  return new Map((env.OPENPADEL_IMAGE_DEFAULTS ?? "").split(/\s+/).filter((x) => x.includes("=")).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] as [string, string]));
}
/** The old names the club still sets (with a value), sorted: for doctor's gentle warning. Not the image's defaults
 *  (one the club's .env didn't change still has the image's value), nor the test suite's own variables. */
export function oldNamesInUse(env: Env = process.env): string[] {
  const image = imageDefaults(env);
  return Object.keys(env).filter((k) => k.startsWith(OLD_SETTING_PREFIX) && !/^KUMI_(TEST|SHAPE)_/.test(k) && given(env[k]) && image.get(k) !== env[k]).sort();
}
/** The settings set under both names with different values (short names, sorted): the OPENPADEL_ one is used. */
export function namesThatDiffer(env: Env = process.env): string[] {
  // An image default under the old name isn't the club's: its OPENPADEL_ value replacing it is the point.
  const image = imageDefaults(env);
  return Object.keys(env).filter((k) => k.startsWith(SETTING_PREFIX)).map(shortName)
    .filter((s) => settingFrom(s, env).differs && image.get(OLD_SETTING_PREFIX + s) !== env[OLD_SETTING_PREFIX + s]).sort();
}
