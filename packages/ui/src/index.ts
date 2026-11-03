// What the members' app and the staff app share: who's signed in, the language, sign-in,
// the preview-and-confirm sheet, the profile page.
import { lazy } from "preact-iso";
export * from "./state.ts";
export { SignIn } from "./SignIn.tsx";
export { AccountData } from "./AccountData.tsx";
export { Inbox, InboxLink } from "./Inbox.tsx";
export { usePreview, dollars } from "./Preview.tsx";
export { ProgramCard, placesLeft, type ProgramCardData } from "./ProgramCard.tsx";
export { protectedPost, botProof } from "./pow.ts";
export { ReceiptSheet, type ReceiptView } from "./Receipt.tsx";
export { OtherLang, otherLang, savedIn, translationsOf } from "./OtherLang.tsx";
export { Notices, NewOnly } from "./Notices.tsx";
export { whyNothingNew } from "./notices.ts";
/** The profile page, loaded when it's opened, so neither app carries it on its first screen. */
export const ProfilePage = lazy(() => import("./Profile.tsx").then((m) => m.Profile));
/** The second step at sign-in, while a session owes it (me.gate): loaded only then. */
export const TwoFactor = lazy(() => import("./TwoFactor.tsx").then((m) => m.TwoFactor));
