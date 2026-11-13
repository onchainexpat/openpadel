import { render } from "preact";
import { startBoot, wordingReady } from "@kumi/ui";
import { App } from "./App.tsx";
import "@kumi/ui/styles.css";

// The first screen waits for the wording in the person's language (a few kB, fetched alongside the app). Until it
// can draw, the club's start screen shows (index.html, boot.ts).
wordingReady.then(() => { startBoot(); render(<App />, document.getElementById("app")!); });
