# Pi recorded fixtures

Real transcripts from `pi` (`@earendil-works/pi-coding-agent`) **0.87.1**, captured on linux/arm64,
scrubbed with `scripts/harness-fixtures/scrub.mjs`. Driver scripts are in `0.87.1/drivers/`.

| File | Covers |
| --- | --- |
| `tools-mcp-bridge.jsonl` | `-p` headless run: `bash`, `read`, `edit`, `write`, an MCP tool (`mcp__fixture__word_count`) reached through the Resin bridge extension, usage, thinking |
| `resin-gateway-bridge.jsonl` | `-p` run with the bridge extension spawning the real `resin mcp` gateway; `mcp__resin__manage_tools` call |
| `rpc-branch-model-bash-abort-compaction.jsonl` | RPC run: `/tree` rewind with branch summary (`branch_summary`), `set_model` (`model_change`), user shell `bash` (`bashExecution`), abort mid tool call (`isError` result + `stopReason: "aborted"`), later resumed with `--session` for a manual `compact` (`compaction`) and one more turn |
| `rpc-fork.jsonl` | RPC `fork` of the session above: new file with `parentSession`, copied parent entries, one new turn |
| `rpc-tree-rewind.jsonl` | RPC `/tree` rewind without summary: an entry whose `parentId` points back to an earlier entry in the same file |

## Authentication

Pi had no credentials. The capture reused Codex's ChatGPT login without refreshing it: a
throwaway agent dir received an `openai-codex` OAuth credential built from the access token and
account id in `~/.codex/auth.json`, with its expiry copied from the token and a placeholder
refresh token (so Pi never rotates Codex's refresh token). Model: `openai-codex/gpt-5.6-luna`,
`--thinking low` (the cheapest model the ChatGPT account accepts).

```sh
export PI_CODING_AGENT_DIR=/tmp/resin-fixture-pi-agentdir
mkdir -p "$PI_CODING_AGENT_DIR" && umask 077
node -e 'const a=require(process.env.HOME+"/.codex/auth.json");const t=a.tokens.access_token;const p=JSON.parse(Buffer.from(t.split(".")[1],"base64url"));require("fs").writeFileSync(process.env.PI_CODING_AGENT_DIR+"/auth.json",JSON.stringify({"openai-codex":{type:"oauth",access:t,refresh:"resin-fixture-no-refresh",expires:p.exp*1000-600000,accountId:a.tokens.account_id}}))'
```

## Project and bridge extension

```sh
P=/tmp/resin-fixture-pi-proj; mkdir -p $P && cd $P && git init -q
printf '# Greeter\n\nA tiny demo project.\n' > README.md
printf '#!/bin/sh\necho "hello, $1"\n' > greet.sh && chmod +x greet.sh
git add -A && git -c user.email=f@x -c user.name=f commit -qm init
mkdir -p /tmp/resin-fixture-pi-mcp && cp adapters/pi/tests/fixtures/recorded/0.87.1/drivers/* /tmp/resin-fixture-pi-mcp/
# Render the bridge for the fixture MCP server and for the real gateway (from adapters/pi):
node --experimental-strip-types -e 'import("./src/extension.ts").then(m=>{const fs=require("fs");fs.writeFileSync("/tmp/resin-fixture-pi-mcp/resin-fixture.ts",m.renderPiResinExtension({name:"fixture",command:"node",args:["/tmp/resin-fixture-pi-mcp/server.mjs"]}));fs.writeFileSync("/tmp/resin-fixture-pi-mcp/resin-gateway.ts",m.renderPiResinExtension({name:"resin",command:process.env.HOME+"/.local/bin/resin",args:["mcp"]}))})'
```

## Sessions (run in `$P`, resetting it with `git checkout -q . && git clean -qfd` between runs)

```sh
M="--provider openai-codex --model gpt-5.6-luna --thinking low --no-extensions"
# tools-mcp-bridge
pi -p $M -e /tmp/resin-fixture-pi-mcp/resin-fixture.ts --session-dir /tmp/resin-fixture-pi-sessions \
  "Do these steps in order using your tools: 1) run the shell command './greet.sh world' 2) read README.md 3) edit README.md to change 'tiny demo' to 'small demo' 4) write a new file NOTES.md containing 'notes' 5) call the mcp__fixture__word_count tool with text 'one two three'. Then reply DONE."
# rpc-branch-model-bash-abort-compaction + rpc-fork
node /tmp/resin-fixture-pi-mcp/drive.mjs $P /tmp/resin-fixture-pi-sessions2
echo '{"compaction":{"keepRecentTokens":200}}' > $PI_CODING_AGENT_DIR/settings.json
node /tmp/resin-fixture-pi-mcp/compact.mjs $P /tmp/resin-fixture-pi-sessions2 <first-session-id-prefix>
# resin-gateway-bridge
pi -p $M -e /tmp/resin-fixture-pi-mcp/resin-gateway.ts --session-dir /tmp/resin-fixture-pi-sessions3 \
  'List the names of your tools that start with mcp__resin__, then call mcp__resin__manage_tools with {"action":"list_versions","scope":"workspace","compact":true,"query":"greet"} and report how many results came back. Be brief.'
# rpc-tree-rewind
node /tmp/resin-fixture-pi-mcp/drive-plain.mjs $P /tmp/resin-fixture-pi-sessions4
```

`pi -p --no-session "Reply with just OK"` was also run: it answered and created no session file
(the session directory did not exist afterwards), which is why `--no-session` runs are reported
as not capturable.

## Scrub

```sh
R="--project /tmp/resin-fixture-pi-proj --replace /tmp/resin-fixture-pi-sessions2=<pi-session-dir> --replace /tmp/resin-fixture-pi-sessions3=<pi-session-dir> --replace /tmp/resin-fixture-pi-sessions4=<pi-session-dir> --replace /tmp/resin-fixture-pi-sessions=<pi-session-dir>"
node scripts/harness-fixtures/scrub.mjs <raw.jsonl> adapters/pi/tests/fixtures/recorded/0.87.1/<name>.jsonl $R
```
