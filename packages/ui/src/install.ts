// Installing the members' app to the home screen. Chrome offers it once, early (beforeinstallprompt): the offer is kept
// here from the first screen, and the profile shows "Install the app" only while there is one. Safari on an iPhone has
// no offer: the profile says where Add to Home Screen is instead. Neither shows once the app runs installed.
import { signal } from "@preact/signals";

type InstallOffer = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

export const installOffer = signal<InstallOffer | null>(null);

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => { installOffer.value = e as InstallOffer; });
  window.addEventListener("appinstalled", () => { installOffer.value = null; });
}

/** Running as the installed app (from the home screen), not in a browser tab. */
export const installed = () => typeof window !== "undefined"
  && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);

/** An iPhone or iPad, in a browser tab (an iPad says it's a Mac, but has a touch screen). */
export const onIos = () => typeof navigator !== "undefined"
  && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Asks the browser to install the app; the offer is used up either way. */
export async function install() {
  const offer = installOffer.value;
  if (!offer) return false;
  installOffer.value = null;
  await offer.prompt();
  return (await offer.userChoice).outcome === "accepted";
}
