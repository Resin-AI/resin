# Recorded OMP fixtures

`<version>/sessions/` holds real OMP sessions recorded headlessly with `omp -p`, scrubbed, in
OMP's own on-disk layout: `<ts>_<id>.jsonl` main sessions, `<ts>_<id>/<Agent>.jsonl` subagent
sessions, and `<ts>_<id>/<n>.eval.log` spilled Eval output. `tests/recorded-fixtures.test.ts`
decodes every version listed in `OMP_TESTED_VERSIONS` (`src/versions.ts`).

## 18.3.2

| Session | Covers |
| --- | --- |
| `2026-09-26T23-01-05-051Z_01a0dff3-…` | bash, read, edit, write, an MCP call through the device surface (`write xd://mcp__fixture_echo_shout`), a `task` subagent and `wait` |
| `…/HumanBlackbird.jsonl` | the subagent: `session.parentSession` set, bash, `yield` |
| `2026-09-26T23-04-33-426Z_01a0dff6-…` | Eval whose display was byte-truncated (`details.meta.truncation.artifactId`) with the full stream in `0.eval.log`; a read-only Resin gateway call (`manage_tools` `list_versions`, recorded as tool discovery); glob |
| `2026-09-26T23-04-49-530Z_01a0dff6-…` | bash aborted by `--max-time` |

Not covered by these recordings: compaction (too costly to force headlessly; the frozen rometrics
history contains 32 real compaction records and the decoder tests cover the shape).

### Regenerate

```sh
P=/tmp/resin-fixture-omp-1832
mkdir -p $P/project/.omp $P/sessions && cd $P/project && git init -q
printf '# Tiny demo\n\nA small greeting script.\n' > README.md
printf 'def greet(name):\n    return "Hello, " + name\n\nprint(greet("world"))\n' > greet.py
# $P/echo-mcp.mjs: a stdio MCP server with one tool `shout` that uppercases `text`.
printf '{"mcpServers":{"fixture-echo":{"command":"node","args":["%s/echo-mcp.mjs"]}}}\n' $P > .omp/mcp.json
git add -A && git commit -qm init

OMP="omp -p --model anthropic/claude-sonnet-5 --thinking low --session-dir $P/sessions --no-title --auto-approve"
$OMP --max-time 8m "Do these steps in order, one tool call each, then reply DONE: 1) run the shell command 'python3 greet.py'. 2) read README.md. 3) edit greet.py so the greeting says 'Hi, ' instead of 'Hello, '. 4) write a new file NOTES.md containing the single line 'fixture notes'. 5) call the fixture-echo MCP tool shout with text 'resin fixture'. 6) spawn one subagent task (task tool) whose job is only to run 'ls' in this directory and report the file names."
$OMP --max-time 8m "Do these steps in order, one tool call each, then reply DONE: 1) use the eval tool with Python code: for i in range(1500): print(f'line {i:05d} of the fixture output stream') . 2) call the resin MCP tool manage_tools with arguments {\"action\":\"list_versions\",\"scope\":\"workspace\",\"compact\":true,\"query\":\"fixture\"}. 3) use the find tool to list *.py files."
$OMP --max-time 20s "Run the shell command 'sleep 90' and then say finished."

# From the repo root, scrub every file into the fixture tree:
cd $P/sessions && for f in $(find . -type f); do
  mkdir -p "$OLDPWD/adapters/omp/tests/fixtures/recorded/18.3.2/sessions/$(dirname "$f")"
  node "$OLDPWD/scripts/harness-fixtures/scrub.mjs" "$f" \
    "$OLDPWD/adapters/omp/tests/fixtures/recorded/18.3.2/sessions/$f" \
    --project $P/project --replace $P=/workspace
done
```

After scrubbing, two OMP-specific fields are rewritten because they describe the recording
machine rather than the session: `session_init.systemPrompt` becomes `<scrubbed:system-prompt>`
and `session_init.tools` keeps only built-ins plus `mcp__fixture_echo_*`/`mcp__resin_*`;
`credential_pin.hash` becomes `<scrubbed:opaque>`. The decoder reads none of these fields.
