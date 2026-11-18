# WhatsApp messages (Meta's WhatsApp Cloud API)

An openPadel plugin: what a member needs to know soon (a place offered, a booking or class the club cancelled or moved)
goes to them by WhatsApp, from the club's own WhatsApp Business number, if they said yes in the app. Their replies go
to the club's front desk, and STOP turns it off. It is a separate program: it talks to the club only through the club's
door (`/mcp`, with its own token) and to Meta through the Cloud API, and needs nothing but Node 24 or later: no
packages, no database.

Its manifest is [docs/plugins/examples/whatsapp/openpadel-plugin.json](../../docs/plugins/examples/whatsapp/openpadel-plugin.json)
(the same one is in openPadel's bundled catalog). It changes nothing at the club, reads nothing of the club, and moves no
money. Its manifest's `channel` makes it the club's WhatsApp channel (one per club).

## Who decides what

**The club decides, never the plugin.** openPadel writes each message, checks the member's yes, their linked number,
quiet hours (9 pm to 8 am in the club's time, unless the message is essential) and STOP on its own server, then hands
the plugin only what it must send, signed, on the plugin's webhook (`message.send`):

```json
{ "id": "msg_…", "type": "message.send", "created_at": "2026-11-18T10:00:00.000Z",
  "data": { "message_id": "…", "channel": "whatsapp", "to": "+34612345678", "language": "es",
            "template": { "name": "openpadel_update", "parameters": ["Kestrel Padel", "La reserva 4F2A de Cancha 1, jue 6:00 p.m., se canceló. https://…/places"] },
            "text": "Kestrel Padel: …\n\nResponde STOP para no recibir más mensajes de WhatsApp nuestros.",
            "essential": false, "send_before": "2026-11-18T20:00:00.000Z" } }
```

The plugin never chooses a recipient and never reads members. It sends what it's handed, or says why it couldn't.

## What it does

- **Templates outside WhatsApp's window, plain messages inside it.** WhatsApp lets a business send a plain message only
  within 24 hours of the member's own last message; otherwise it must be a template Meta approved. The plugin keeps when
  each number last wrote, and sends `text` inside the window (free) and the template otherwise, in the language the
  club's templates were approved in (its settings `template_language_en`, `template_language_es`). If Meta says the
  window closed sooner (131047), it sends the template at once.
- **Statuses.** Meta's reports (sent, delivered, read, failed) go to the club as `plugin_message_status`, so the club's
  message log says how each one went.
- **STOP.** "STOP", "BAJA" (and their kin, in English and Spanish, as the whole message), the template's STOP button,
  and Meta's own opt-out (131050) go to the club as `plugin_channel_stop`: the club turns WhatsApp off for whoever has
  that number, at once, and drops what was waiting. The plugin also drops anything it was holding for that number. The
  club's answer ("You won't get WhatsApp messages from…") is sent back.
- **Replies.** Anything else a member writes goes to the club as `plugin_channel_reply`. A code from the app links their
  number; anything else goes to the front desk as the member's question to the club (staff answer in the app). The
  club's short answer is sent back: "passed to the front desk" at most once an hour, and "this number isn't linked" at
  most once a day to a number the club doesn't know.
- **Pace, retries and failures.** It sends at most `per_second` messages a second (20 unless set; Meta allows 80 to most
  numbers). Meta down, busy (429, 130429, 131056) or failing (131000) is tried again after 30 seconds, doubling to 30
  minutes, up to 6 tries; then the club is told it failed. A message past its `send_before` (quiet hours began, or it
  stopped being news) isn't sent, and the club is told. A token Meta refuses (190) makes the card ask for a new one. A
  template Meta doesn't have (132001) fails that message and the card says which template and language.
- **Reports in order.** What goes to the club (statuses, STOP, replies) waits in order when the club's door doesn't
  answer, and goes when it does.
- **Its card**, on Connectors: the club's number, today's messages (sent, delivered, not delivered), replies, any waiting,
  and anything wrong, with a link to WhatsApp Manager. In English and Spanish.
- **Health** (`GET <address>/health`, for `openpadel doctor` and Connectors): `{ "ok": true, "keys_missing": [], "waiting": 0,
  "reports_waiting": 0, "last_event_at": "…", "last_sent_at": "…", "failing": null }`, 503 when it's failing (keys
  missing, Meta's token refused, Meta or the club's door down). Nothing in it names a club or a member.
- **Its log** names numbers only by their last four, and never logs what a member wrote, a token or a key.

## Setting it up: the owner's Meta account (about an hour, plus Meta's review)

WhatsApp for a business needs the club's own Meta business account, number and approved templates. These are the
owner's to make and pay for: an agent tells the owner what to click, and never enrols or pays for them.

1. **A business portfolio.** At [business.facebook.com](https://business.facebook.com), create one in the club's
   company name. To send more than 250 messages a day, verify it: Settings, Security Center, Start verification
   (Meta asks for the company's documents; it can take a few days).
2. **An app.** At [developers.facebook.com](https://developers.facebook.com): My Apps, Create app, choose "Other", then
   "Business", and connect it to the club's business portfolio. On the app's page, add the product **WhatsApp**, Set up.
3. **The club's number.** WhatsApp, API Setup, Add phone number: a number that isn't already on the WhatsApp app (a new
   one, or one moved off it), its display name (the club's name; Meta reviews it), and the code Meta sends to it. Copy
   its **Phone number ID** (a long number under the phone number).
4. **Payment.** In WhatsApp Manager (business.facebook.com, WhatsApp accounts), Payment methods, Add payment method:
   the club's card. Meta charges per template message, by the member's country (utility messages cost cents or less);
   answers within 24 hours of a member's message are free.
5. **A token that doesn't expire.** Business settings, Users, System users, Add: a name such as "openPadel", role
   Admin. Then Assign assets: the app (full control) and the WhatsApp account (full control). Then Generate new token:
   the app, expiration Never, permissions `whatsapp_business_messaging` and `whatsapp_business_management`. Copy it.
6. **The app secret.** On the app: App settings, Basic, App secret, Show. Copy it.
7. **A verify token.** Make up a long random word (a password manager can make one).
8. **The keys in the club's vault.** In the staff app's Vault (or on the server with
   `openpadel plugin secret whatsapp <NAME>`), add `WHATSAPP_ACCESS_TOKEN` (step 5), `WHATSAPP_PHONE_NUMBER_ID` (step 3),
   `WHATSAPP_APP_SECRET` (step 6) and `WHATSAPP_VERIFY_TOKEN` (step 7). Never paste them into a chat.
9. **The webhook.** On the app: WhatsApp, Configuration, Webhook, Edit. Callback URL:
   `https://<the club's address>/plugins/whatsapp/hook`; Verify token: the word from step 7. Verify and save (the club
   passes Meta's check to the plugin, which answers it). Then under Webhook fields, Subscribe to **messages**.
10. **The templates.** In WhatsApp Manager: Message templates, Create template, category **Utility**, for each of the two
    below, in English (US) and Spanish (Mexico) (or whichever languages the settings name). Add a Quick reply button
    "STOP" (English) or "BAJA" (Spanish). Each takes two variables: `{{1}}` the club's name, `{{2}}` the message. Submit;
    Meta usually approves within minutes, sometimes a day.

    | Name | English | Spanish |
    |---|---|---|
    | `openpadel_update` (a booking or class cancelled or moved, a place lost) | Update from {{1}} about your booking or class: {{2}} Reply STOP to stop WhatsApp messages from us. | Aviso de {{1}} sobre tu reserva o clase: {{2}} Responde STOP para no recibir más mensajes de WhatsApp nuestros. |
    | `openpadel_place` (a place offered, with a deadline) | Good news from {{1}}: {{2}} Reply STOP to stop WhatsApp messages from us. | Buenas noticias de {{1}}: {{2}} Responde STOP para no recibir más mensajes de WhatsApp nuestros. |

    Samples for Meta's review: `{{1}}` "Kestrel Padel"; `{{2}}` "Booking 4F2A for Court 1, Thu 6:00 PM, is cancelled.
    https://play.kestrelpadel.com/places" (Spanish: "La reserva 4F2A de Cancha 1, jue 6:00 p.m., se canceló.
    https://play.kestrelpadel.com/places").

## Installing it at the club

The club's agent installs it and the owner says yes to the preview (see [docs/plugins/README.md](../../docs/plugins/README.md)):

```bash
openpadel plugin install --name whatsapp --settings '{"club_number": "+34 600 123 456"}'
openpadel plugin configure --plugin whatsapp --settings '{"template_language_es": "es_AR"}'   # if the templates are in another Spanish
openpadel doctor                                                                            # its health and any keys it waits for
```

Then a member turns it on in the app (Profile, WhatsApp): they tick the words, confirm, and send the message the app
shows ("Link my WhatsApp: 123456") to the club's number, from their WhatsApp. The code links their number and is good
for an hour; the club answers on WhatsApp that it's linked.

## Running it

**Remote** (any host, the manifest's `run.url`): `PORT=8080 STATE_DIR=./state node src/main.ts` (or `bin/start`). The club
sends its registration to `<address>/register` when it's installed; `OPENPADEL_CLUBS=https://club.example.com` limits which
clubs may register. It keeps what waits to go and its reports in `STATE_DIR`, one file per club, readable by its own user
only; never Meta's token or keys, which it reads through the door and holds in memory.

**Local** (on the club's own server): `node tools/pack.ts --release-url https://…/whatsapp-0.1.0.tar.gz` makes the
release (the same bytes every time) and the manifest that pins it; then `sudo openpadel plugin service whatsapp --apply`.
The club writes `OPENPADEL_URL`, `OPENPADEL_MCP`, `OPENPADEL_TOKEN`, `OPENPADEL_WEBHOOK_SECRET`, `OPENPADEL_HOOK_SECRET` and
`PORT` into its environment; it listens on 127.0.0.1 and takes no registrations. It reaches Meta at graph.facebook.com.

## What it doesn't do (yet)

Club news by WhatsApp (marketing templates, with their own rules and prices), pictures or files, and messages to a
junior (those go to the adults who manage them, as everywhere). A member links one number; linking another means
turning WhatsApp off and on again in the app.

## Tests

`node --test plugins/whatsapp/test/*.test.ts` (part of the repo's `npm test`): a fake club and a fake Meta on 127.0.0.1.
