# Cursor CLI recorded fixtures

`2026.9.26-dd393fe/` holds real hook spool files (one `<conversation_id>.jsonl` per conversation) written by Resin's capture hook under cursor-agent `2026.09.26-dd393fe` (model `auto`, which served `grok-4.5`). The directory name is the normalized version listed in `CURSOR_TESTED_VERSIONS` (`src/paths.ts`). `tests/qualification-fixtures.ts` copies them into `~/.resin/capture/cursor-cli/` of a fresh home for `apps/observer/tests/harness-qualification.test.ts`; `tests/capture.test.ts` decodes them directly.

| File | Run | Covers |
| --- | --- | --- |
| `a4624dd3-…` | headless `-p` | failed shell (README.md missing), Read, edit reported as Read + Write sharing a tool_use_id, write (create), `afterFileEdit`, MCP `demo` echo, list_changed (tool `shout` added, never offered) |
| `5ce9d009-…` | headless `-p` | successful shell, Task subagent launches (no hook for the Task call) |
| `74b830d3-…`, `26cbf135-…`, `f1e5a284-…` | subagents of `5ce9d009` | standalone conversations: thoughts and shell calls only, no session hooks, no parent link |
| `a2d415bc-…` | headless `-p`, SIGINT after 12 s | abort: running `sleep 60` never reported, `sessionEnd` reason `error` |
| `1d62dbba-…`, `6f7df196-…` | interactive (pty) | `beforeSubmitPrompt`, MCP + shell, `stop` with turn usage (status `error` from this model), list_changed ignored on a second prompt |
| `1e94d25f-…` | interactive (pty) + `/compact` | `stop` completed, `afterAgentResponse` (same usage as `stop`), `preCompact` manual |

Observed contract facts (2026.09.26): headless runs fire no `beforeSubmitPrompt`, `afterAgentResponse` or `stop`; interactive runs fire two `afterAgentThought` per thought (model `default` and the served model); `subagentStart`/`subagentStop` never fired.

## Regenerate

Everything runs under a throwaway HOME so the user's `~/.cursor` and `~/.resin` are never touched. The auth file is symlinked, never copied; `cli-config.json` is copied. Do not copy `hooks.json` or `mcp.json`.

```sh
export PATH=/path/to/node22/bin:$PATH; umask 022
V=2026.9.26-dd393fe                                   # normalized `cursor-agent --version`
H=$(mktemp -d /tmp/resin-fixture-cursor-home-XXXX); P=$(mktemp -d /tmp/resin-fixture-cursor-proj-XXXX)
M=$PWD/adapters/cursor-cli/tests/fixtures/recorded/capture-tools   # server.mjs, drive.py (run from resin root)
mkdir -p "$H/.cursor" "$H/.config/cursor"
cp ~/.cursor/cli-config.json "$H/.cursor/"
ln -s ~/.config/cursor/auth.json "$H/.config/cursor/auth.json"
# 1. Resin's own install extension writes the hook script and hooks.json (resin repo root, after `pnpm run build`):
(cd adapters/cursor-cli && H=$H node --input-type=module -e '
  import { NodeConfigFsBridge } from "@resin/harness-contracts";
  import { installCursorCaptureHooks } from "./dist/index.js";
  await installCursorCaptureHooks({ home: process.env.H, env: {}, fsBridge: new NodeConfigFsBridge() });')
# 2. MCP server `demo`: stdio JSON-RPC with tool `echo`; after the first echo call it adds tool `shout`
#    and sends notifications/tools/list_changed.
printf '{"mcpServers":{"demo":{"command":"%s","args":["%s/server.mjs"]}}}\n' "$(command -v node)" "$M" > "$H/.cursor/mcp.json"
printf 'print("hi")\n' > "$P/hello.py"            # README.md is created before run 2 only
cd "$P"
# 3. Headless runs
HOME=$H cursor-agent -p --trust --force --approve-mcps --output-format stream-json --model auto \
  "Run 'wc -l README.md' in the shell, read hello.py, change hi to hello in hello.py, create notes.txt containing ok, then call the demo MCP echo tool with text ping. After that, if a demo tool named shout is available, call it with text ping." > "$H/run1.stream.jsonl"
printf '# demo\nline two\nline three\n' > README.md
HOME=$H cursor-agent -p --trust --force --approve-mcps --output-format stream-json --model auto \
  "Run the shell command 'wc -l README.md' and report the count. Then use a subagent (the Task tool) to list the files in this directory and report back." > "$H/run2.stream.jsonl"
HOME=$H timeout -s INT 12 cursor-agent -p --trust --force --model auto "Run the shell command 'sleep 60; echo done' and then report." || true
# 4. Interactive runs: drive.py forks `cursor-agent --force --approve-mcps --model auto <prompt>` in a
#    200x50 pty with HOME=$H, waits, types each extra argument then Enter, then sends Ctrl-C twice.
python3 $M/drive.py "$H" "$P" "Call the demo MCP echo tool with text ping, then run the shell command 'cat README.md'." 60
STEP_WAIT=60 python3 $M/drive.py "$H" "$P" "Call the demo MCP echo tool with text ping." 60 \
  "Now list the demo MCP tools again; if one named shout exists call it with text ping, otherwise reply exactly: shout unavailable."
STEP_WAIT=40 python3 $M/drive.py "$H" "$P" "Read README.md and summarize it in one line." 45 "/compact"
cd - >/dev/null
# 5. Scrub every spool file into this directory (resin repo root). Cursor's project slug is not
#    covered by --project, so replace it explicitly.
S=$(echo "$P" | sed 's/[^a-zA-Z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')
mkdir -p "adapters/cursor-cli/tests/fixtures/recorded/$V"
for f in "$H"/.resin/capture/cursor-cli/*.jsonl; do
  node scripts/harness-fixtures/scrub.mjs "$f" "adapters/cursor-cli/tests/fixtures/recorded/$V/$(basename "$f")" \
    --project "$P" --replace "$H=/home/user" --replace "$M=/tmp/mcp" --replace "$S=workspace-project"
done
```

Model output is nondeterministic, so a re-recording will differ in detail; update the expectations in `tests/capture.test.ts` to the new sessions.
