// What the members' app and the staff app share: who's signed in, the language, sign-in,
// the preview-and-confirm sheet, the profile page.
import { lazyPage } from "./state.ts";
export * from "./state.ts";
export { SignIn } from "./SignIn.tsx";
export { AccountData } from "./AccountData.tsx";
export { Inbox, InboxLink } from "./Inbox.tsx";
export { usePreview, useStepUp, needsStep, dollars, ChargeLines, type Charge, type Pending } from "./Preview.tsx";
export { useBackCloses } from "./back.ts";
export { ProgramCard, placesLeft, type ProgramCardData } from "./ProgramCard.tsx";
export { protectedPost, botProof } from "./pow.ts";
export { ReceiptSheet, type ReceiptView } from "./Receipt.tsx";
export { OtherLang, otherLang, savedIn, translationsOf } from "./OtherLang.tsx";
export { RunsOn } from "./RunsOn.tsx";
export { Illustration, EmptyState, type IllustrationName } from "./Illustration.tsx";
// The start screen while an app starts, and the short welcome at a first sign-in.
export { startBoot, bootDone } from "./boot.ts";
export { Greeting } from "./Greeting.tsx";
export { greetFor, lessMotion } from "./greet.ts";
export { pageTitle, type AppKind } from "./title.ts";
export { Notices, NewOnly } from "./Notices.tsx";
// Kept from the first screen: Chrome makes its install offer once, early (install.ts).
export { installOffer } from "./install.ts";
export { whyNothingNew } from "./notices.ts";
/** The profile page, loaded when it's opened, so neither app carries it on its first screen. */
export const ProfilePage = lazyPage(() => import("./Profile.tsx").then((m) => m.Profile));
/** The second step at sign-in, while a session owes it (me.gate): loaded only then. */
export const TwoFactor = lazyPage(() => import("./TwoFactor.tsx").then((m) => m.TwoFactor));
/** Ask openPadel, the hosted assistant (staff app's Ctrl+K, the members' Ask tab): loaded only when it's opened. */
export const AskChat = lazyPage(() => import("./AskChat.tsx").then((m) => m.AskChat));
export type { AskStatus } from "./ask_status.ts";
