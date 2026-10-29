import { serve } from "@hono/node-server";
import { connect, migrate } from "@kumi/core";
import { makeApp } from "./app.ts";
import { MemoryMailer } from "./mailer.ts";

const db = connect();
const applied = await migrate(db);
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
const port = Number(process.env.PORT ?? 8790);
serve({ fetch: makeApp({ db, mailer: new MemoryMailer(true), secureCookies: process.env.NODE_ENV === "production" }).fetch, port });
console.log(`kumi server on http://127.0.0.1:${port}`);
