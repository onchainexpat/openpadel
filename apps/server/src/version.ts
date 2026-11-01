// Which Kumi this is: the release in package.json, shown by /health and kumi doctor.
import { readFileSync } from "node:fs";

export const VERSION: string = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
/** Which commit this release is (deploy/release.sh writes REVISION when it installs one); "dev" from a checkout. */
export const REVISION: string = (() => { try { return readFileSync(new URL("../../../REVISION", import.meta.url), "utf8").trim() || "dev"; } catch { return "dev"; } })();
