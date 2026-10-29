// Development only: set up a demo club if the database has none. Email goes to the server log.
import { connect, migrate, runAsSystem } from "@kumi/core";

const db = connect();
await migrate(db);
if (await db.selectFrom("club").select("name").executeTakeFirst()) console.log("a club already exists; nothing to do");
else {
  await runAsSystem(db, "club.setup", {
    name: process.env.KUMI_CLUB_NAME ?? "Kestrel Padel", time_zone: process.env.KUMI_TIME_ZONE ?? "America/Los_Angeles",
    owner_email: process.env.KUMI_OWNER_EMAIL ?? "owner@kestrel.test", owner_name: process.env.KUMI_OWNER_NAME ?? "Robin Hale",
  }, "setup");
  console.log("demo club set up; sign in as owner@kestrel.test (the code appears in the server log)");
}
await db.destroy();
