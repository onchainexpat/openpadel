# Ask the club: a decision model

**What it's for:** a member's new question gets the club's own answer straight away when one of the club's
facts answers it completely ("When are you open?", "Where do I park?"). A decision model picks the fact, word
for word, or hands the question to the staff. It never writes anything itself. Optional: without it, every
question goes to the staff, as it does now.
**Who does what:** the owner creates the account (or both) and the key. The agent sets openPadel up and checks it.
**Time and cost:** 15 minutes. A question costs a fraction of a cent. On openPadel's own test set (22 questions,
eight facts), Jev cost about $0.00004 a question and answered in about 50 ms; Claude Haiku cost about $0.0001
a question and answered in under a second, two at most. List prices, November 2026: Jev $0.042 per million
input tokens, output free; Claude Haiku 5.5 $0.10 per million input tokens and $0.50 per million output.
**`openpadel doctor` checks:** `answers`.

## Which model

- **Jev (TypeSafe)**, the one openPadel asks first: a decision model that says how sure it is that each fact
  answers the question. openPadel sends a fact only when it's at least 85% sure it answers it completely, and
  the question doesn't need a person. Fast and cheap. Its main language is English; Spanish works, less well.
- **Claude Haiku (Anthropic)**: makes the same decision from a fixed list (a fact, or none), when Jev fails or
  is slow (1.5 seconds), or on its own without a TypeSafe key. It doesn't say how sure it is, so the club's staff see
  "sent by openPadel" without a percentage.

Both keys is the most dependable. Either one alone works.

## What leaves the club's server

Only the question's words and the club's facts, each under a short key (a1, a2, ...). No names, emails,
phone numbers, ids, membership or level go to either model. A question about the member's own bookings,
money, membership or level, a complaint, an injury, or anything only the staff can know goes to the staff.

Both companies go on the club's list of services that see member data
([../../processors.md](../../processors.md)). As of 2 November 2026: TypeSafe's privacy policy says it won't
train or fine tune any model on what it's sent, and Anthropic's commercial terms say it may not train
models on customer content from its API. Check both again, and ask each for a data processing agreement,
before a club relies on them.

## Steps

1. **Owner: TypeSafe.** Sign up at typesafe.ai, open the API console (console.typesafe.ai), and create an API
   key named for the club.
2. **Owner: Anthropic.** In the Claude Console (platform.claude.com), create a workspace for the club with a
   low monthly limit (a few dollars is plenty), add credit, and create an API key in that workspace. This is
   the pay-as-you-go API, separate from any Claude subscription.
3. **Owner: add the keys** to the server's settings file by typing them in, never through the chat:
   ```
   OPENPADEL_TYPESAFE_API_KEY=...
   OPENPADEL_ANTHROPIC_API_KEY=sk-ant-...
   ```
   and restart openPadel (`sudo systemctl restart kumi`, or `docker compose up -d` for Docker).
4. **Agent: check it.** `openpadel doctor` shows `answers` as ok, naming the models. It only asks each company
   whether it takes the key, which costs nothing.
5. **Staff: write the facts** (step 5h) if the club hasn't yet. The model can only pick from those that are
   switched on.
6. **Agent: try it** as a member in practice: ask something one fact answers, and something it doesn't. The
   first gets the fact at once; the second waits for the staff. On the Questions page, staff see which fact
   openPadel sent and how sure it was.

To stop it, untick "Answer new questions from the club's facts by itself" in Settings. Removing the keys
stops it too.

## Day to day

- **A member taps "That didn't answer it" or "Ask a person":** the question goes to the staff at once, and
  the decision keeps the label, so the club can see where it went wrong.
- **A staff answer always wins:** if the staff answer while the model is still deciding, the fact isn't sent.
- **A model down or slow:** the question goes to the staff, as without a model. `openpadel doctor` and
  `/health/deep` say so when more than a fifth of the last day's questions got no decision.
