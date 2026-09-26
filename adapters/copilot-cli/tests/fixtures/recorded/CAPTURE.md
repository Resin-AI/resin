# GitHub Copilot CLI recorded fixtures

Captured from `@github/copilot` **1.0.88** (`copilot --version` → `GitHub Copilot CLI 1.0.88.`) on
linux-arm64, authenticated account, model `auto` (the account's router picked `gpt-6-luna`,
`gpt-5.6-luna` and `mai-code-1.1-flash`; explicit `--model claude-*`/`gpt-5-mini` were rejected as
"not available"). Every file was scrubbed as described below.

## Capture source: `session-state/<id>/events.jsonl`

Three sources were compared on the same real `copilot -p` run (session `4842b6bb…`):

| Need | `session-state/<id>/events.jsonl` | OTel file export (`COPILOT_OTEL_FILE_EXPORTER_PATH`) | Hooks |
| --- | --- | --- | --- |
| Exact tool arguments | yes: `tool.execution_start.data.arguments` (JSON object, or the raw `apply_patch` string) | no: `execute_tool` spans carry only name and call id; MCP tool and server names are SHA-256 hashed (see `1.0.88/otel-basic-tools.jsonl`) | payload per hook; requires writing hook config into the user's settings |
| Exact tool results | yes: `tool.execution_complete.data.result.content` (+ `detailedContent` diff, `error`) | no | partial, per hook |
| Token usage | per process run: `session.shutdown.tokenDetails` / `modelMetrics` (cumulative over the session) | per model call: `chat` spans `gen_ai.usage.*` | no |
| Always on | yes, for every session including ones started before Resin | no: env var must be set when Copilot starts | no: needs config written |
| Subagents / compaction / abort | yes (`subagent.*`, `session.compaction_*`, `abort`) | spans only | `sessionStart`/`sessionEnd` only |

The session log is the only source that is on by default and carries exact arguments and results,
so the adapter tails it. Its schema ships with the CLI at
`~/.cache/copilot/pkg/<platform>/1.0.88/schemas/session-events.schema.json`
(`copilot-sdk/generated/session-events.d.ts`). Per-call usage (`assistant.usage`) is declared
`ephemeral: true` there and is never written to disk; the persisted usage is `session.shutdown`,
whose totals accumulate across `--resume` runs, so the decoder reports the delta between successive
shutdowns. `tokenDetails` (session-wide) is used for totals because `modelMetrics` omits the
compaction model call (the `/compact` run below added 9,585 input / 1,335 output tokens to
`tokenDetails` while every model's `usage` stayed flat).

## `tools/list_changed` timing (github/copilot-cli#3125)

`96d45076…`, first prompt: the fixture server's `learn_tool` adds `count_chars` and sends
`notifications/tools/list_changed`; the model calls `fixture-count_chars` in the next assistant
step (turnId 1) of the same interaction. On 1.0.88 the new tool is usable immediately, not one user
turn late; the adapter therefore relies on native list_changed (no restart, no nudge).

## Sessions

| Directory | What it covers |
| --- | --- |
| `4842b6bb-0529-4e1b-ba95-cb76fd815f52` | headless `-p`: shell (`bash`), file read (`view`), file edit and file write (`apply_patch` Update/Add), MCP tool (`fixture-echo_upper`), usage |
| `96d45076-f850-4775-8447-25e3b47da524` | list_changed learned tool; `--resume` with an `explore` subagent (`task` tool, child events tagged `parentToolCallId`); `--resume -p /compact` compaction; three cumulative shutdowns |
| `aabf7bd1-e888-432f-bca8-414de2b191d2` | Ctrl+C (SIGINT to the native agent process) during a 40 s shell call: `abort` (`user_initiated`), no tool completion, clean `session.shutdown` with usage |
| `56ef3192-776c-4782-b447-0a3701dc9dd8` | agent process SIGKILLed mid tool call: log ends at `tool.execution_start`, no shutdown, no usage |

Signals sent to the `copilot` npm launcher (node) are not forwarded to the native agent process:
SIGINT/SIGTERM/SIGKILL on the launcher's process group left the agent running to completion. The
abort and kill captures therefore signal the launcher's child process directly.

## Regenerating

```sh
# Project and MCP server
P=/tmp/resin-fixture-copilot-proj; rm -rf $P; mkdir -p $P && cd $P && git init -q
printf '# Demo\nTiny demo project.\n' > README.md
printf 'def add(a, b):\n    return a + b\n\nprint(add(2, 3))\n' > calc.py
git add -A && git -c user.email=a@b -c user.name=a commit -qm init
mkdir -p /tmp/resin-fixture-copilot-mcp
cp <repo>/adapters/copilot-cli/tests/fixtures/recorded/fixture-mcp-server.mjs /tmp/resin-fixture-copilot-mcp/server.mjs
MCP='{"mcpServers":{"fixture":{"type":"local","command":"node","args":["/tmp/resin-fixture-copilot-mcp/server.mjs"],"tools":["*"]}}}'

# 4842b6bb: tools + usage (+ OTel comparison)
COPILOT_OTEL_FILE_EXPORTER_PATH=/tmp/resin-fixture-copilot-otel1.jsonl copilot -p "Do these steps in order: 1) run the shell command 'python3 calc.py'; 2) read README.md; 3) edit calc.py to change 'return a + b' to 'return b + a'; 4) create notes.txt containing 'hello'; 5) call the fixture MCP tool echo_upper with text 'resin'. Then reply done." --allow-all-tools --additional-mcp-config "$MCP" --no-auto-update

# 96d45076: list_changed, then subagent, then compaction (reset the repo first)
git checkout -q . && git clean -qfd
copilot -p "Call the fixture MCP tool learn_tool. Then, if a tool named count_chars (from the fixture server) is now available to you, call it with text 'resin'; if it is not in your tool list, say exactly 'count_chars unavailable'. Do not use any other tools." --allow-all-tools --additional-mcp-config "$MCP" --no-auto-update
copilot --resume=<id> -p "Use the task tool to launch an explore subagent that reports how many lines calc.py has. Then reply with the number." --allow-all-tools --no-auto-update
copilot --resume=<id> -p "/compact" --allow-all-tools --no-auto-update

# aabf7bd1: Ctrl+C. The launcher's child is the native agent.
copilot -p "Run the shell command 'sleep 40 && echo finished' and then report its output." --allow-all-tools --no-auto-update & P=$!
sleep 10; kill -INT "$(pgrep -P $P | head -1)"

# 56ef3192: hard kill
copilot -p "Run the shell command 'sleep 30 && echo finished' and then report its output." --allow-all-tools --no-auto-update & P=$!
sleep 10; kill -KILL "$(pgrep -P $P | head -1)"
```

Scrub each session (run from the repo root; `prepare.mjs` replaces opaque provider ids, quota
state and prompt copies the adapter does not decode, then the shared scrubber rewrites machine
identity and fails on any secret):

```sh
O=adapters/copilot-cli/tests/fixtures/recorded
for S in <session ids>; do
  mkdir -p $O/1.0.88/session-state/$S
  node $O/prepare.mjs ~/.copilot/session-state/$S/events.jsonl /tmp/$S.jsonl
  node scripts/harness-fixtures/scrub.mjs /tmp/$S.jsonl $O/1.0.88/session-state/$S/events.jsonl \
    --project /tmp/resin-fixture-copilot-proj --replace /tmp/resin-fixture-copilot-mcp=/workspace/fixture-mcp
  node scripts/harness-fixtures/scrub.mjs ~/.copilot/session-state/$S/workspace.yaml \
    $O/1.0.88/session-state/$S/workspace.yaml --project /tmp/resin-fixture-copilot-proj
done
node $O/prepare.mjs /tmp/resin-fixture-copilot-otel1.jsonl /tmp/otel.jsonl
node scripts/harness-fixtures/scrub.mjs /tmp/otel.jsonl $O/1.0.88/otel-basic-tools.jsonl --project /tmp/resin-fixture-copilot-proj
```

Adding a new Copilot version: capture into `recorded/<version>/`, run the package tests against it,
then add the version to `COPILOT_TESTED_VERSIONS` in `src/discovery.ts`.
