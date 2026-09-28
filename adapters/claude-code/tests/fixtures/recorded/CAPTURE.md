# Recorded Claude Code sessions

Real `claude` 2.1.283 (native ARM64 build, claude.ai Max login) headless sessions, model `haiku`
(`claude-haiku-4-5-20251001`), captured 2026-09-26. Claude writes transcripts to
`~/.claude/projects/-tmp-resin-fixture-claude-cap-proj/`; subagent transcripts go to
`<session-id>/subagents/agent-<agent-id>.jsonl` with a `.meta.json` beside them.

## Setup

```bash
D=/tmp/resin-fixture-claude-cap
mkdir -p $D/proj /tmp/resin-fixture-claude-mcp && cd $D/proj && git init -q
printf '# Demo\nTiny demo project.\n' > README.md
printf 'def add(a, b):\n    return a + b\n\nprint(add(2, 3))\n' > calc.py
```

`/tmp/resin-fixture-claude-mcp/server.mjs` is a ~15-line newline-delimited JSON-RPC stdio server
exposing one tool, `echo_upper` (uppercases `text`); `dyn.mjs` is the same server advertising
`tools.listChanged`, which adds `echo_lower` and sends `notifications/tools/list_changed` after its
first `tools/call`.

```bash
echo '{"mcpServers":{"echo":{"type":"stdio","command":"node","args":["/tmp/resin-fixture-claude-mcp/server.mjs"]}}}' > $D/mcp.json
echo '{"mcpServers":{"dyn":{"type":"stdio","command":"node","args":["/tmp/resin-fixture-claude-mcp/dyn.mjs"]}}}' > $D/dyn.json
```

## Sessions (run from `$D/proj`)

| Fixture | Covers | Command |
|---|---|---|
| `9cdec615-…` (+ `9cdec615-…/subagents/agent-a83a4563dddcae8c8.*`) | Bash, Read, Edit, Write (no final newline), ToolSearch, MCP call, background `Agent` subagent + task notification, usage | `claude -p "Do these steps in order, one tool call each: 1) Run the shell command 'python3 calc.py'. 2) Read README.md. 3) Edit calc.py to change 'add(2, 3)' to 'add(4, 5)'. 4) Write a new file notes.txt containing the single line 'hello'. 5) Call the echo_upper MCP tool with text 'resin'. 6) Launch a general-purpose subagent (Agent/Task tool) that reads README.md and reports its first line. Then summarize in one sentence." --model haiku --output-format json --mcp-config ../mcp.json --strict-mcp-config --allowedTools "Bash,Read,Edit,Write,Task,Agent,mcp__echo__echo_upper"` |
| `e1932364-…` | manual compaction (`compact_boundary`, compact summary) | `claude -p "Run the shell command 'ls' and tell me the file count." --model haiku --output-format json --allowedTools Bash`, then `claude -p "/compact" --resume <session-id> --model haiku --output-format json` |
| `897e3120-…` | tool call blocked with `is_error` | `claude -p "Run the shell command 'sleep 60' with Bash in the foreground (run_in_background false), then say done." --model haiku --output-format stream-json --verbose --allowedTools Bash` |
| `01d6de19-…` | interrupt during a running tool (SIGINT) | `timeout -s INT 25 claude -p "Run exactly this shell command with Bash in the foreground: python3 -c 'import time; time.sleep(90)'  then say done." --model haiku --output-format stream-json --verbose --allowedTools Bash` |
| `b167cb7a-…` | Write creating a file with a final newline; rejected overwrite | `claude -p "Use the Write tool to create todo.txt whose content is exactly the two lines 'alpha' and 'beta', with a trailing newline after beta. Then use the Write tool again to overwrite notes.txt with the content 'hello world' followed by a trailing newline. No other tools." --model haiku --output-format json --allowedTools "Write,Read"` |
| `cf4ec19a-…` | mid-session `tools/list_changed` refresh (`deferred_tools_delta`) | `claude -p "Call the dyn server's echo_upper tool with text 'a'. After that, search your tools for a dyn tool named echo_lower; if it exists call it with text 'B'. Report exactly which tools you called and their outputs." --model haiku --output-format json --mcp-config ../dyn.json --strict-mcp-config --allowedTools "mcp__dyn__echo_upper,mcp__dyn__echo_lower"` |
| `8ea90a99-…` | one-shot RUNBOOK deploy: Read + 10 Bash calls, one content block per record, `end_turn`, exit `cost-state` (resin-bench conformance `deploy-promote-web` run; `attachment` records dropped before scrubbing) | resin-bench conformance run, `claude -p "Promote the \`web\` app to production, following RUNBOOK.md." --model haiku` in a work dir holding `RUNBOOK.md` and `deployctl` |
| `-workspace-logs/1100efe6-…` | log rotation: `ls`, `gzip -k`, `sha256sum … > ….sha256`, `ls && cat` (Bash calls with `description`, empty-output results), `end_turn`; `attachment` records dropped before scrubbing | `claude -p "Rotate the log file var/svc.log.2: gzip it (keep the original with -k), then write its sha256 into var/svc.log.2.gz.sha256 using sha256sum, then list var/ with ls -l. Run each step as a separate shell command." --allowedTools Bash --strict-mcp-config` in a git repo holding `var/svc.log.{1,2}`; scrubbed with `--project <cwd> --replace <cwd>=/workspace/logs --replace <user>=user` |

## Scrub

Every file (transcripts and `.meta.json`), from the repository root:

```bash
node scripts/harness-fixtures/scrub.mjs ~/.claude/projects/-tmp-resin-fixture-claude-cap-proj/<file> \
  adapters/claude-code/tests/fixtures/recorded/2.1.283/projects/-workspace-project/<file> \
  --project /tmp/resin-fixture-claude-cap/proj --replace /tmp/resin-fixture-claude-cap=/workspace \
  --replace <account-email>=user@example.com --replace <organization-uuid>=00000000-0000-4000-8000-000000000000
```

Claude 2.x records the account email (`session_context` attachment) and organization UUID
(`credential_org` attachment) in transcripts; both need the explicit `--replace` pairs.
