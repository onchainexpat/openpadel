# Ask openPadel: the hosted assistant

**What it's for:** for a club without an agent of its own. Staff press Ctrl+K (⌘K on a Mac) on any staff page and ask
("who's playing on Court 2 tonight?", "block Court 3 Saturday morning for repairs"); members get a club assistant on
their app's Ask tab ("Thursday after 6, doubles, my level"). It reads what the person could read in the app, and
any change comes back as the same preview the app shows: nothing happens until the person presses Confirm. Optional:
without it, the staff app has no Ctrl+K and the Ask tab is the club's questions, as before.
**Who does what:** the owner creates the Anthropic account and the key, and types it into the server's settings. The
agent checks it.
**Time and cost:** 10 minutes, or none if the club already has an Anthropic key for Ask the club. Staff questions use
Claude Sonnet 5.5, members' Claude Haiku 5.5. A staff question that reads two or three things costs about 1 to 6
cents (the first of the day the most, as the tool list is cached after it); a member's about a tenth of a cent. List
prices, November 2026: Sonnet 5.5 $2 per million input tokens and $10 per million output; Haiku 5.5 $0.10 and
$0.50. Every call counts on the club's monthly meter (Usage, "AI: Ask openPadel"), under the owner's cap.
**`openpadel doctor` checks:** `assistant`.

## Turning it on

It uses the same key as Ask the club: `KUMI_ANTHROPIC_API_KEY` in `/etc/kumi/kumi.env` on the server
([ask-the-club.md](ask-the-club.md) says how to make one). The owner types it there themselves; never paste a key into a
chat. Restart openPadel (`sudo systemctl restart kumi`, or `deploy/docker/update.sh` on Docker), then run
`openpadel doctor`: `assistant` says `ok`.

## What it can and can't do

- **Never more than the person.** It acts through a connection of its own for each person, listed under Profile,
  Assistants like an assistant they connect themselves: the same permission check, never further than they could reach
  when it was first turned on, and a weekly spending limit they set ($0 until they choose more, so a member's assistant
  can find a court but they book a paid one in the app until they raise it). Disconnect turns it off for them.
- **Previews only.** It never confirms anything. A change that needs someone else's yes shows "Ask for a yes" first.
- **In the members' app, a member.** Whatever roles a person holds, the members' app's assistant acts as a member.
  "Ask a person" sends what they asked to the front desk as a question to the club.
- **Its runs are marked.** Changes it previewed show in Changes as made through Ask openPadel (`via`
  `assistant:hosted:staff` or `assistant:hosted:member`, with the hosted connection).
- **Past the monthly cap** it says it's paused until the 1st and stops. Nothing else is affected.

## What leaves the club's server

The person's question, and what the reads it makes return (the same the person sees in the app, with emails and phone
numbers shortened in staff reads), go to Anthropic to answer it. Conversations are kept on the club's server for 30
days after their last message, are in the person's data download, and the person can delete them at any time.

## Clubs with their own agent

A club that runs its own agent (Claude Code, Codex, n8n) can leave this off. The members' Ask tab then stays as it is:
openPadel doesn't pass members' messages to a club's own agent.
