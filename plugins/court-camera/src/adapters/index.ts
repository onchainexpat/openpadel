// The adapters this build knows, by name. CAMERA_ADAPTER picks one (generic-http unless set). A vendor adds its own
// here (README.md, "Making an adapter for your cameras") and ships its own release and manifest.
import { genericHttp } from "./generic_http.ts";
import type { CameraAdapter } from "./types.ts";

export const ADAPTERS: Record<string, CameraAdapter> = { [genericHttp.name]: genericHttp };

export function adapterNamed(name: string | undefined): CameraAdapter {
  const a = ADAPTERS[name || genericHttp.name];
  if (!a) throw new Error(`no camera adapter called ${name}; this build has ${Object.keys(ADAPTERS).join(", ")}`);
  return a;
}
