# Grok Build recorded fixtures

Captured from the official `grok` CLI (`grok 1.0.13 (5e9a58528b76) [stable]`, source
xai-org/grok-build rev `036a5d8348cd744767cd0b08518ab17bf608fa7f`) on linux/arm64.

`1.0.13/sessions/<id>/` mirrors `~/.grok/sessions/<encoded cwd>/<id>/`, keeping only what Resin
reads: `updates.jsonl`, `summary.json`, and the parent's `subagents/<child>/meta.json`.
`mcp-events.jsonl` is the `mcp_*` subset of that session's `events.jsonl` (MCP dedupe evidence).
`headless-streaming-json.ndjson` is the stdout of the first headless run.

| Session | Mode | Covers |
| --- | --- | --- |
| `11111111-…` | headless `-p`, then `--resume` | shell, read, edit, write, MCP via `use_tool` (fixture server + Resin gateway), usage, background subagent |
| `01a0dfee-…` | subagent child of `11111111-…` | `session_kind: "subagent"`, linked by the parent's `subagents/<id>/meta.json` |
| `22222222-…` | `--resume 1111… --fork-session`, then `/compact` | fork with the parent's updates copied as a prefix, `parent_session_id`, compaction |
| `33333333-…` | ACP (`grok agent stdio`) | two prompts, `_x.ai/rewind/execute` to prompt 1 (`rewind_marker`), replacement prompt |
| `01a0e63f-…` | headless `-p` through `resin init --harness grok-build` (isolated home, local cloud) | code-stats job (`grep -c TODO` + `wc -l` into `src-stats.txt`): `search_tool` and `use_tool` → `resin__manage_tools` before the `run_terminal_command` work; scrubbed with `scripts/harness-fixtures/scrub.mjs`, plus the project path inside the `grep` tool's byte-array `stdout` |

## Setup

An isolated home keeps the user's hooks, skills and MCP servers out of the capture. Only the
authenticated `auth.json` is copied (never printed).

```sh
H=/tmp/resin-fixture-grok-home
mkdir -p $H/.grok && cp ~/.grok/auth.json $H/.grok/ && chmod 600 $H/.grok/auth.json
cat > $H/.grok/config.toml <<'EOF'
[mcp_servers.fixture]
command = "node"
args = ["/tmp/resin-fixture-grok-mcp/server.mjs"]

[mcp_servers.resin]
command = "/home/<user>/.resin/bin/resin"
args = ["mcp"]
env = { HOME = "/home/<user>" }
EOF
# Claude Code's registration of the same gateway, which Grok also loads (compat.claude.mcps):
printf '{"mcpServers":{"resin":{"type":"stdio","command":"/home/<user>/.resin/bin/resin","args":["mcp"]}}}' > $H/.claude.json
```

`/tmp/resin-fixture-grok-mcp/server.mjs` is a ~20-line stdio MCP server exposing one `echo` tool
that returns `echo: <text>`. The project `/tmp/resin-fixture-grok-proj` is a git repo holding a
`README.md` (3 lines) and `calc.py` (`def add(a, b)` + `print(add(2, 3))`).

## Commands

```sh
cd /tmp/resin-fixture-grok-proj
G=~/.grok/bin/grok; S1=11111111-1111-4111-8111-111111111111; S2=22222222-2222-4222-8222-222222222222
HOME=$H $G -p "Do these steps in order using your tools: 1) run the shell command 'ls' ; 2) read calc.py ; 3) edit calc.py so add() is renamed to plus() everywhere ; 4) create a new file NOTES.md containing the single line 'hello notes' ; 5) call the MCP tool fixture__echo with text 'ping' ; 6) call the MCP tool resin__manage_tools with action list_versions, scope workspace, compact true, query 'echo'. Then reply with one short sentence." \
  --output-format streaming-json --always-approve --session-id $S1 > headless.ndjson
HOME=$H $G -p "Spawn one explore subagent to count the lines in README.md, then tell me the number in one sentence." \
  --resume $S1 --output-format streaming-json --always-approve
HOME=$H $G -p "Append a new line 'forked' to NOTES.md, then reply 'done'." \
  --resume $S1 --fork-session --session-id $S2 --output-format streaming-json --always-approve
HOME=$H $G -p "/compact" --resume $S2 --output-format streaming-json --always-approve
# ACP: initialize, session/new {_meta.sessionId}, two session/prompt calls,
# _x.ai/rewind/execute {sessionId, targetPromptIndex: 1, force: true}, one more session/prompt.
HOME=$H node acp-rewind.mjs /tmp/resin-fixture-grok-proj 33333333-3333-4333-8333-333333333333
```

The ACP driver spawns `grok agent --always-approve stdio` and answers permission requests with
the first `allow*` option. Without `force: true`, `_x.ai/rewind/execute` is only a preview
(`success: false`) and writes no marker.

## Scrub

```sh
R="--project /tmp/resin-fixture-grok-proj --replace %2Ftmp%2Fresin-fixture-grok-proj=%2Fworkspace%2Fproject --replace /tmp/resin-fixture-grok-home=/home/user --replace /tmp/resin-fixture-grok-mcp=/workspace/mcp"
node scripts/harness-fixtures/scrub.mjs <raw> <out> $R
```

## Duplicate gateway check

`mcp-events.jsonl` shows `mcp_config_resolved` listing `resin` once (from `config.toml`) although
`~/.claude.json` also declares `resin`: Grok merges MCP sources by name and `config.toml` wins.
`HOME=$H grok inspect --json` reports the single `resin` entry with `source.type = "configToml"`;
removing it from `config.toml` flips the source to `claudeJson`.
