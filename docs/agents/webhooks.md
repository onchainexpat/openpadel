# Webhooks

A club agent (or the owner) can have the club's events sent to an address as they happen, so an automation reacts
instead of asking every few minutes. Each is POSTed after the change it comes from is saved, signed with a secret only
the club and the receiver know.

## Subscribing

As the agent, through the door (`openpadel webhook subscribe`, or the `webhook_subscribe_preview` and `_confirm` tools):

```bash
openpadel webhook subscribe --url https://hooks.example.com/club --topics booking.cancelled,payment.failed
```

or in Settings, Agents, Webhooks. The preview says which of the events its role doesn't read: those it won't get. The
result has the subscription's signing **secret** (`whsec_...`), shown once; afterwards only its last four characters.
`webhook update` changes the address or the events (and `--resume` starts a paused one again), `webhook remove` stops it,
and `webhook test` sends a test event. A manager's subscription waits for the owner's yes.

In production the address must be https, and never on the server's own network (loopback, private ranges,
link-local, cloud metadata): checked when it's saved and again on the address actually connected to. Redirects aren't
followed.

## The events

The outbox's own event names. Each needs its reader (the agent, or the person who subscribed) to read a part of the
club:

| Part of the club | Events |
|---|---|
| Bookings | booking.created, booking.confirmed, booking.cancelled, booking.moved, booking.player_added, booking.player_removed, booking.player_left, booking.joined, booking.no_show, open_match.opened, court.blocked, court.freed |
| Money | payment.succeeded, payment.failed, refund.failed, booking.refunded |
| Memberships | membership.started, membership.renewed, membership.cancelled, membership.ended, membership.payment_failed |
| Programs | program.published, program.min_cancelled, enrolment.booked, enrolment.left, enrolment.removed, waitlist.offered |
| Members | person.created, person.signed_up |
| Levels and scores | game.scored, result.confirmed |
| The club news list | club_news.joined, club_news.left |

The club news list is whoever said yes to club news by email (the `club_news_list` read): owners, managers, the front
desk and the accountant read it, a role the club made when it covers messages, and a plugin when its manifest reads
`club_news`. `club_news.joined` and `club_news.left` carry only the person's id (and for `left`, `why`: `said_no`,
`unsubscribed` from an email's link, `text_stop`, `unsubscribed_elsewhere` when a marketing sync said they unsubscribed
there, or `deleted` for an account deleted).

A delivery carries the event's own data (mostly ids, with emails and phone numbers shortened); read what changed through
the door (`person_page`, `day`, ...) with the agent's own permissions.

## A delivery

```http
POST /club HTTP/1.1
content-type: application/json
user-agent: openPadel-Webhooks/1
openpadel-event: booking.cancelled
openpadel-delivery: 812
openpadel-signature: t=1763300000,v1=5f2b...

{"id":"evt_8812","type":"booking.cancelled","created_at":"2026-11-16T18:20:00.000Z","data":{"booking_id":"...","by":"..."}}
```

- `id` is the event's: the same event can arrive twice (a retry after an answer that didn't get back), so keep the ids
  you've handled.
- Answer with any 2xx within 10 seconds. Anything else, or no answer, is tried again: up to 8 times, the wait doubling
  from 30 seconds to an hour.
- An address that keeps failing (15 tries in a row, or failing for a day) is **paused**: what was waiting for it is
  dropped, and the owner hears once. Start it again with `webhook update --resume` once it's fixed; events from while
  it was paused aren't sent.
- `webhook.test` events (from `webhook test`) carry no club data.

## Checking the signature

`openpadel-signature` is `t=<unix seconds>,v1=<hex>`, where the hex is the HMAC-SHA256 of the time, a dot and the
exact body bytes, keyed with the whole secret (`whsec_...` as UTF-8). Check it on the raw body, before parsing it,
compare in constant time, and refuse a time more than 5 minutes from now (a delivery replayed later).

Node (also an n8n Code node):

<!-- signature-sample: checked by apps/server/test/agents_docs.test.ts -->
```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyOpenPadelSignature(secret, header, rawBody, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t), v1 = parts.v1 ?? "";
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > 300 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest();
  return timingSafeEqual(Buffer.from(v1, "hex"), expected);
}
```

Python:

```python
import hashlib, hmac, time

def verify_openpadel_signature(secret: str, header: str, raw_body: bytes, now: int | None = None) -> bool:
    parts = dict(p.strip().split("=", 1) for p in header.split(","))
    t, v1 = int(parts.get("t", "0")), parts.get("v1", "")
    if abs((now or int(time.time())) - t) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(v1, expected)
```
