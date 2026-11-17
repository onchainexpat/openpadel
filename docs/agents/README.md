# Agents at the club: recipes

A club's assistant is either openPadel's own or the club's own agent. This folder is about the club's own: how each
kind of tool connects to the club, and how it hears what happens there. There's no plugin per AI vendor. Every tool
goes through the same door, the catalogue that the staff app, the command line (`openpadel`) and the club's MCP
connector (`/mcp`) share, so every change:

- is checked against what the connection may do (a person's own permissions, or a club agent's role);
- shows its preview first, and changes nothing until it's confirmed;
- waits in Approvals for a person when the role says *ask*;
- is in the change log (Changes), with who did it and through what, and can be undone the way its preview said;
- counts against a weekly money limit.

Two kinds of connection:

| | A person's assistant | A club agent |
|---|---|---|
| Is | someone's own Claude, ChatGPT, Claude Code, Codex | an n8n workflow, a bot, a desk agent running at night |
| Acts as | that person, never further than they could when they connected it | itself, on behalf of the club |
| Can do | what the person can | what its role allows (any role but the owner's or a coach's; make one just for it in Settings, Roles and permissions) |
| Connects with | a sign-in (browser, or a code on another device) | a token, shown once when the agent is made |
| Weekly limit | money the person pays, set by them | money its changes move (payments and refunds), set by the club |
| Listed in | the person's Profile, Assistants; and Settings, Agents | Settings, Agents |
| Ended by | Disconnect | Revoke (or a new token, which ends the old one) |

A club agent is made by the owner (a manager asks, and the owner says yes) in **Settings, Agents**, signed in with a passkey or two steps.
Making an agent, changing its role or limit and giving it a new token are only ever done in the app, never by an
assistant or another agent: a token works on its own for as long as it lasts. Revoking one can be done anywhere. An agent can never make, change or revoke agents, and can never be given a role with
`role.assign`.

## Recipes

- [Claude Code or Codex](claude-code-codex.md): the command line.
- [Claude or ChatGPT](claude-chatgpt.md): the club's connector.
- [n8n](n8n.md): an MCP or HTTP node to act, a webhook trigger to hear.
- [Any MCP client](any-mcp-client.md): the address and a header.
- [Webhooks](webhooks.md): the events, how they're signed, and checking a signature (with code).
