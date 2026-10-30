// Which Kumi this is: the release in package.json, shown by /health and kumi doctor.
import { readFileSync } from "node:fs";

export const VERSION: string = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
