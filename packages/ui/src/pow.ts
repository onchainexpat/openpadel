// The bot check a form passes before sign-up, a sign-in code or a card form (the server's bot.ts): fetch a
// challenge and find a number that makes SHA-256 of "challenge:number" start with enough zero bits.
import { api, ApiError } from "./state.ts";
import { solve } from "./sha256.ts";

/** What a protected form adds to its body: the solved challenge, and the hidden field's value. */
export async function botProof(honeypot = ""): Promise<{ pow?: { challenge: string; counter: number }; website: string }> {
  const c = await api<{ challenge: string | null; bits: number }>("/auth/challenge");
  if (!c.challenge) return { website: honeypot };   // switched off on this server (practice)
  return { pow: { challenge: c.challenge, counter: await solve(c.challenge, c.bits) }, website: honeypot };
}

/** Post a protected form; a stale challenge (or one asked for before the address had trouble) is tried once more. */
export async function protectedPost<T>(path: string, body: Record<string, unknown>, honeypot = ""): Promise<T> {
  try { return await api<T>(path, { ...body, ...await botProof(honeypot) }); }
  catch (e) {
    if (!(e instanceof ApiError) || e.code !== "error.bot_check") throw e;
    return api<T>(path, { ...body, ...await botProof(honeypot) });
  }
}
