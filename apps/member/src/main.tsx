import { render } from "preact";
import { wordingReady } from "@kumi/ui";
import { App } from "./App.tsx";
import "@kumi/ui/styles.css";
import "./member.css";

// The first screen waits for the wording in the person's language (a few kB, fetched alongside the app).
wordingReady.then(() => render(<App />, document.getElementById("app")!));
