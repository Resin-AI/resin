# Cursor CLI recorded fixtures

Status: **no recorded fixtures yet.** cursor-agent `2026.09.26-dd393fe` is installed but not logged in, and it fires no hooks before authentication (`Error: Authentication required. Please run 'agent login' first`). For that reason `CURSOR_TESTED_VERSIONS` is empty and `resin status` reports the install as `untested`. The decoder tests use payloads built to match the shapes in the build's hook executor (the `executeHookForStep` call sites).

## Regenerate (after `cursor-agent login`)

Run everything under a throwaway HOME so the user's `~/.cursor` and `~/.resin` are never touched. Copy only `cli-config.json` and the auth state from the logged-in HOME; do not copy `hooks.json` or `mcp.json`.

```sh
V=$(cursor-agent --version)                          # e.g. 2026.09.26-dd393fe
H=$(mktemp -d /tmp/resin-fixture-cursor-home-XXXX)
P=$(mktemp -d /tmp/resin-fixture-cursor-proj-XXXX)
# 1. Install Resin's capture hooks into $H (from the resin repo root). Also register a stdio MCP server
#    named `demo` with one `echo` tool under mcpServers in $H/.cursor/mcp.json:
pnpm --filter @resin/adapter-cursor-cli exec tsx -e '
  import { NodeConfigFsBridge } from "@resin/harness-contracts";
  import { installCursorCaptureHooks } from "./src/index.ts";
  await installCursorCaptureHooks({ home: process.env.H, env: {}, fsBridge: new NodeConfigFsBridge() });'
# 2. Project content:
printf '# demo\nline two\nline three\n' > "$P/README.md"; printf 'print("hi")\n' > "$P/hello.py"
# 3. Headless runs (cheapest model), covering shell, read, edit, write, MCP, subagent, abort:
cd "$P"
HOME=$H cursor-agent -p --trust --output-format stream-json --model auto \
  "Run 'wc -l README.md', read hello.py, change hi to hello in hello.py, create notes.txt containing ok, then call the demo MCP echo tool with text ping." > "$H/run1.stream.jsonl"
HOME=$H cursor-agent -p --trust --output-format stream-json --model auto \
  "Use a subagent to list the files in this directory." > "$H/run2.stream.jsonl"
HOME=$H timeout -s INT 8 cursor-agent -p --trust --model auto "Count to 1000 slowly, one number per line." || true
# 4. Scrub every spool file into this directory (from the resin repo root):
mkdir -p "adapters/cursor-cli/tests/fixtures/recorded/$V"
for f in "$H"/.resin/capture/cursor-cli/*.jsonl; do
  node scripts/harness-fixtures/scrub.mjs "$f" "adapters/cursor-cli/tests/fixtures/recorded/$V/$(basename "$f")" --project "$P"
done
```

Then add the normalized version (`2026.9.26-dd393fe` for `2026.09.26-dd393fe`) to `CURSOR_TESTED_VERSIONS` in `src/paths.ts`. Also add a qualification test that decodes every recorded file with `CursorRecordDecoder` and asserts `driftIssues` is empty.
