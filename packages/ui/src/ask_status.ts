/** What GET /assistant says (the server's assistant.ts): on (the club's key), turned off by this person, paused at the
 *  club's monthly limit, what it may spend for them this week, and their conversations in this app. */
export type AskStatus = { on: boolean; turned_off: boolean; paused: boolean; model: string; spending: { weekly_cap_cents: number; spent_cents: number };
  chats: { id: string; title: string; updated_at: string }[] };
