// The vendor adapter interface: everything that differs from one camera system to the next, in one small object. The
// rest of the plugin (the club's door, matching a clip to a booking, the game's card, retries, health) is the same for
// every vendor. README.md, "Making an adapter for your cameras", walks through writing one; generic_http.ts is a whole
// one to copy.
import type { Fetch } from "../door.ts";

export interface Words { en: string; es: string }

/** One number (or short words) about a game: a known `key` (words.ts, STATS) gets openPadel's own words in both
 *  languages; any other key needs its `label` in both. */
export interface Stat { key: string; value: number | Words; label?: Words }

/** What the vendor says is ready, as the plugin understands it. */
export interface Notice {
  kind: "highlight" | "stats";
  /** The vendor's own id for it: the same id again replaces it (a re-cut clip, corrected stats), never adds one. */
  id: string;
  /** The vendor's camera id, as the club's `cameras` setting names it. */
  camera: string;
  /** The session id the plugin gave the camera for the booking (Session.id), when the vendor sends it back. */
  session: string | null;
  /** When it happened, in milliseconds since 1970: a clip's start and end; a game's stats, the stretch they cover. */
  start: number;
  end: number | null;
  /** An https link: the clip, or (with stats) the game's page at the vendor. */
  url: string | null;
  /** A clip's length. */
  seconds: number | null;
  stats: Stat[];
}

/** A booking on a court with a camera, as the plugin tells the vendor: no names, nothing but the court's camera, an
 *  id and the times. */
export interface Session { id: string; camera: string; starts_at: string; ends_at: string }

export interface TellOpts { baseUrl: string; apiKey: string | null; fetch: Fetch; timeoutMs: number }

/** Thrown by an adapter for what it can't read (`bad_body`), or by `tell` when the vendor fails: `status` is its HTTP
 *  status, 0 when it didn't answer. 401 and 403 mean the API key is wrong. */
export class VendorError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface CameraAdapter {
  /** Its name, for logs and CAMERA_ADAPTER. */
  name: string;
  /** Whether the vendor really sent this: its own signature over the body, under the secret the owner put in the vault
   *  (CAMERA_WEBHOOK_SECRET). Headers come with lowercase names. */
  verify(headers: Record<string, string>, rawBody: string, secret: string, nowSeconds: number): boolean;
  /** What the vendor posted, as notices (none for a message it sends that isn't one, a ping). Throws VendorError(400)
   *  for a body it can't read. */
  parse(rawBody: string): Notice[];
  /** Optional: tell the cameras a booking's start and end (`upsert`, the same session again to move it), or that it's
   *  off (`cancel`). Called only when the club turns `tell_cameras` on. Must be safe to repeat. */
  tell?(o: TellOpts, op: "upsert" | "cancel", s: Session): Promise<void>;
}
