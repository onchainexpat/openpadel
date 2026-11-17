# Claude or ChatGPT

Both connect to the club's MCP connector as a person's own assistant.

1. In Claude: Settings, Connectors, Add custom connector. In ChatGPT: Settings, Connectors (developer mode), Create.
2. The address is the club's own, with `/mcp` on the end: `https://staff.yourclub.com/mcp` (the members' app address
   works too).
3. Claude or ChatGPT opens the club's sign-in page. Sign in, and choose how much it may spend for you each week.

It then has a `*_preview` and a `*_confirm` tool for each change you may make, and the reads the apps show you. It
shows you each preview and confirms only on your yes. You can see and disconnect it in the app under Profile,
Assistants; the owner and managers see it in Settings, Agents.

A chat assistant can't hold a club agent's token: for an agent that works for the club on its own, use
[n8n](n8n.md), [any MCP client](any-mcp-client.md) or the [command line](claude-code-codex.md).
