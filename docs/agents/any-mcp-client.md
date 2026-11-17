# Any MCP client

The club's connector is a Streamable HTTP MCP server at `https://staff.yourclub.com/mcp` (or the members' app address).

- **A person's own assistant** signs in with OAuth 2.1: the client finds the club's sign-in server from
  `/.well-known/oauth-protected-resource/mcp`, registers itself (dynamic registration, or a client ID metadata
  document), and the person signs in and allows it in the browser. A client with no browser uses the device code
  (`/oauth/device_authorization`, RFC 8628). Access tokens last an hour and are renewed with the refresh token.
- **A club agent** sends its token on every request: `Authorization: Bearer opa_...`. Nothing to renew; it ends when
  the club revokes the agent or gives it a new token.

Then:

- `whoami`: who the connection acts as, its roles, and its weekly limit left.
- the reads (`people`, `day`, `free_courts`, ...) the apps show it;
- for each change it may make, `<action>_preview` (gives a `run_id` and a `summary` to show) and `<action>_confirm`
  (with that `run_id`). A preview may come back `awaiting_approval`: a person says yes in Approvals.
- `webhook_subscribe_preview` to hear events ([webhooks.md](webhooks.md)).

Errors come back as a tool result with `isError`, the words in the connection's language, and `_meta["kumi/error"]`
(the reason's key) and `_meta["kumi/status"]` for a program to read.
