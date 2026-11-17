# n8n

An n8n workflow is a club agent: it acts for the club with the role it was given, and hears what happens through a
signed webhook.

## 1. Make the agent

In Settings, Agents, make an agent (say "n8n bookings") with a role that holds just what the workflow needs: make one
in Settings, Roles and permissions if no role fits. Give it a weekly limit if it will take payments or give refunds.
Copy its token: it's shown once.

## 2. Let it act: an MCP Client node (or HTTP Request)

- **MCP Client Tool** node (with an AI Agent node): Endpoint `https://staff.yourclub.com/mcp`, transport *HTTP
  Streamable*, authentication *Header Auth* with the name `Authorization` and the value `Bearer opa_...` (keep it as
  an n8n credential).
- Or an **HTTP Request** node, POST to the same address, with the same header and
  `Accept: application/json, text/event-stream`, and a JSON-RPC body:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "tag_create_preview", "arguments": { "name": "Thursday league" } } }
```

Every change is two calls: `<action>_preview` gives a `run_id` and a `summary`; `<action>_confirm` with that `run_id`
makes it. A preview whose `status` is `awaiting_approval` waits in Approvals for a person: don't confirm it, and don't
ask again. `tools/list` gives the tools this agent has.

## 3. Let it hear: a Webhook trigger

1. Add a **Webhook** node (method POST, respond immediately). Copy its production URL (https).
2. Subscribe it to the events the workflow needs, as the agent itself (an HTTP Request node, once), or in Settings,
   Agents, Webhooks, choosing the agent under "Gets what this one may read":

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "webhook_subscribe_preview",
              "arguments": { "url": "https://n8n.yourclub.com/webhook/abc", "topics": ["booking.cancelled", "payment.failed"] } } }
```

   then `webhook_subscribe_confirm` with the `run_id`. Its result has the signing `secret`, once: keep it as an n8n
   credential.
3. Check each delivery's signature before the workflow trusts it: a **Code** node with the check from
   [webhooks.md](webhooks.md) (turn on "raw body" in the Webhook node, since the signature is over the exact bytes).
4. `webhook_test_preview` / `_confirm` sends a test event, signed like the real ones.

The agent gets only the events its role reads: a role about bookings doesn't get `payment.failed`.
