# Claude Code or Codex

Agents that work in a terminal do best with the command line. Everything is in the [command line guide](../cli/README.md);
in short:

## As a person (your own agent, working for you)

```bash
openpadel login https://staff.yourclub.com --device --no-wait --json
```

It prints a link and a code. Open the link on your phone, sign in, check the code matches and allow it, choosing how
much it may spend for you each week. Then:

```bash
openpadel help                  # the commands you may use
openpadel day --location Main   # read the day
openpadel booking cancel --booking <id>      # shows the preview, changes nothing
openpadel confirm <run_id>      # only after you said yes to the preview
```

Tell the agent the rule: show the preview's words, and confirm only on your yes.

## As a club agent (working for the club, on a server or in CI)

Make the agent in the staff app, Settings, Agents (only a person there can make one). Its token is shown
once. On the machine it runs on, keep it in the environment, never in a command's arguments:

```bash
export KUMI_AGENT_TOKEN=opa_...        # from a secret store, not typed into the shell's history
openpadel login https://staff.yourclub.com --agent-token
openpadel whoami                        # the agent, its role, and its weekly limit left
```

`--agent-token` also reads the token piped in (`... | openpadel login <address> --agent-token`). The token doesn't run
out; it ends when the club revokes the agent or gives it a new token.
