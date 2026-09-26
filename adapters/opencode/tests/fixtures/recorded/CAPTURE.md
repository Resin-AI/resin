# OpenCode recorded fixtures

Real sessions captured from installed OpenCode builds on linux-arm64, with all OpenCode state
isolated under a throwaway directory through XDG variables (the user's own OpenCode data and
config are never touched).

| Directory | OpenCode | Store | Provider / model |
| --- | --- | --- | --- |
| `1.18.32/opencode-db.jsonl` | 1.18.32 (npm `opencode-ai`, global install) | SQLite `opencode.db` (WAL), exported to JSON Lines | `opencode/nemotron-3.5-lightning-free` (OpenCode free tier, no credentials) |
| `1.1.65/storage/` | 1.1.65 (npm `opencode-ai@1.1.65`, local install) | legacy JSON tree (`storage/{session,message,part,project}`) | `github-copilot/gpt-4.1` |

The 1.1.65 free tier rejects old clients, so that capture used the GitHub Copilot provider
authenticated from the existing GitHub CLI login: OpenCode sends the stored OAuth token
straight to `api.githubcopilot.com`, so `gh auth token` works as the credential. The token is
written only into the throwaway data dir and never into a fixture. `gpt-4.1` is not in 1.1.65's
bundled model list, so the capture config declares it under `provider.github-copilot.models`.

## Common setup

```sh
C=/tmp/resin-fixture-opencode-cap        # 1.18.32 capture root
mkdir -p $C/data/opencode $C/config/opencode $C/cache $C/state $C/proj
cd $C/proj && git init -q
printf '# Tiny demo\n\nA tiny demo project.\n' > README.md
printf 'console.log("hello from greet");\n' > greet.js
git add -A && git -c user.email=a@b -c user.name=fixture commit -qm init
# $C/echo-mcp.mjs: a ~20-line stdio MCP server exposing one `echo` tool (text -> "echo: <text>").
export XDG_DATA_HOME=$C/data XDG_CONFIG_HOME=$C/config XDG_CACHE_HOME=$C/cache XDG_STATE_HOME=$C/state
cat > $C/config/opencode/opencode.json <<EOF
{"\$schema":"https://opencode.ai/config.json","mcp":{"echo":{"type":"local","command":["node","$C/echo-mcp.mjs"],"enabled":true}}}
EOF
```

## 1.18.32 sessions (SQLite)

```sh
M=opencode/nemotron-3.5-lightning-free
# 1. Minimal headless turn.
opencode run --format json -m $M "Reply with just the word hi."
# 2. Shell, read, edit, write, MCP call, subagent.
opencode run --format json -m $M "Do these steps in order using your tools: 1) run the shell command 'node greet.js'. 2) read README.md. 3) edit README.md replacing 'A tiny demo project.' with 'A tiny demo project for fixtures.'. 4) write a new file notes.txt containing 'fixture notes'. 5) call the echo MCP tool with text 'ping'. 6) use the task tool to spawn a general subagent that reads greet.js and reports its contents. Then reply done."
# 3. Abort: kill the CLI while a tool runs (leaves the bash part `running`).
timeout -s INT 25 opencode run --format json -m $M "Run the shell command 'sleep 120' and then say finished."
# 4. Manual compaction of session 2 (`opencode run --command compact` is not a run command in 1.18).
opencode serve --port 45123 &
curl -X POST "http://127.0.0.1:45123/session/<session-2-id>/summarize?directory=$C/proj" \
  -H 'content-type: application/json' \
  -d '{"providerID":"opencode","modelID":"nemotron-3.5-lightning-free"}'
kill %1

# Export transcript tables (never account/credential/share tables) and scrub.
node adapters/opencode/scripts/export-db.mjs $C/data/opencode/opencode.db $C/opencode-db.jsonl
node scripts/harness-fixtures/scrub.mjs $C/opencode-db.jsonl \
  adapters/opencode/tests/fixtures/recorded/1.18.32/opencode-db.jsonl \
  --project $C/proj --replace $C=/workspace/capture
```

Tests rebuild a WAL-mode SQLite database from the export (`tests/helpers.ts`).

## 1.1.65 session (legacy JSON tree)

```sh
L=/tmp/resin-fixture-opencode-legacy     # same project/echo setup as above, rooted at $L
mkdir -p $L/pkg && (cd $L/pkg && npm install opencode-ai@1.1.65)
export XDG_DATA_HOME=$L/data XDG_CONFIG_HOME=$L/config XDG_CACHE_HOME=$L/cache XDG_STATE_HOME=$L/state
# Copilot credential from the gh login (mode 0600, throwaway dir only):
umask 077; TOKEN=$(gh auth token) node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({"github-copilot":{type:"oauth",refresh:process.env.TOKEN,access:"",expires:0}}))' $L/data/opencode/auth.json
cat > $L/config/opencode/opencode.json <<EOF
{"\$schema":"https://opencode.ai/config.json","provider":{"github-copilot":{"models":{"gpt-4.1":{"name":"GPT-4.1","tool_call":true}}}},"mcp":{"echo":{"type":"local","command":["node","$L/echo-mcp.mjs"],"enabled":true}}}
EOF
cd $L/proj && $L/pkg/node_modules/.bin/opencode run --format json -m github-copilot/gpt-4.1 "Do these steps in order using your tools: 1) run the shell command 'node greet.js'. 2) edit README.md replacing 'A tiny demo project.' with 'A tiny demo project for fixtures.'. 3) write a new file notes.txt containing 'fixture notes'. 4) call the echo MCP tool with text 'ping'. 5) use the task tool to spawn a general subagent that reads greet.js and reports its contents. Then reply done."

# Scrub every session/message/part/project file into the fixture tree. OpenCode writes
# pretty-printed JSON; each file is compacted to one line first so the scrubber walks it
# structurally.
S=$L/data/opencode/storage; D=adapters/opencode/tests/fixtures/recorded/1.1.65/storage
for f in $(cd $S && find session message part project -type f -name '*.json'); do
  mkdir -p $D/$(dirname $f)
  node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8")))+"\n")' $S/$f /tmp/oc-min.json
  node scripts/harness-fixtures/scrub.mjs /tmp/oc-min.json $D/$f --project $L/proj --replace $L=/workspace/capture
done
```
