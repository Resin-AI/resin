#!/usr/bin/env bash
# Records Codex CLI rollouts headlessly and turns them into scrubbed decoder fixtures.
#
#   capture.sh <codex-binary> [--skip-run]
#
# Run from the resin repo root. Sessions use the real $CODEX_HOME (auth + session store) and
# write rollouts to $CODEX_HOME/sessions like any `codex exec` run. See CAPTURE.md.
set -euo pipefail

CODEX=$1
SKIP_RUN=${2:-}
VERSION=$("$CODEX" --version | awk '{print $NF}')
PROJECT=${PROJECT:-/tmp/resin-fixture-codex-${VERSION//./}}
MCP_SERVER=/tmp/resin-fixture-codex-mcp/server.mjs
CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
OUT=adapters/codex-cli/tests/fixtures/recorded/$VERSION
REPO=$PWD

run_sessions() {
  rm -rf "$PROJECT" && mkdir -p "$PROJECT" "$(dirname "$MCP_SERVER")"
  (
    cd "$PROJECT"
    git init -q
    printf '# Greeter\n\nTiny demo project.\n' >README.md
    printf 'def greet(name):\n    return "Hello, " + name\n\nprint(greet("world"))\n' >greet.py
    git add -A && git -c user.email=fixture@example.invalid -c user.name=fixture commit -qm init
  )
  cat >"$MCP_SERVER" <<'EOF'
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "word_count", description: "Count words in text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(String(m.params.arguments.text).trim().split(/\s+/).length) }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
EOF
  local base=(exec -m gpt-5.6-luna -c 'model_reasoning_effort="low"' --dangerously-bypass-approvals-and-sandbox --json)
  cd "$PROJECT"
  "$CODEX" "${base[@]}" -c 'mcp_servers.fixture.command="node"' -c "mcp_servers.fixture.args=[\"$MCP_SERVER\"]" \
    "Do these steps in order, briefly: 1) run the shell command 'python3 greet.py'. 2) read README.md. 3) edit greet.py with apply_patch so the greeting says 'Hi, ' instead of 'Hello, '. 4) create a new file NOTES.md containing one line 'notes'. 5) call the fixture MCP tool word_count with text 'one two three'. 6) call the resin MCP tool invoke_tool with toolId 'fixture-nonexistent' and empty args (an error is expected and fine). Then reply done." \
    </dev/null >/dev/null
  git checkout -q . && git clean -qfd
  "$CODEX" "${base[@]}" "Use your subagent/spawn_agent tool to spawn exactly one subagent that runs 'wc -l greet.py' and reports the result; wait for it, then reply with its answer." </dev/null >/dev/null
  "$CODEX" "${base[@]}" -c model_context_window=30000 -c model_auto_compact_token_limit=5000 -c model_post_turn_compact_threshold_percent=10 \
    "Run 'cat README.md', then 'cat greet.py', then 'git log --oneline', each as a separate command, then reply done." </dev/null >/dev/null
  # Interrupt a running turn the way Ctrl-C does: SIGINT while `sleep 60` is executing.
  "$CODEX" "${base[@]}" "Run the shell command 'sleep 60 && echo finished' and report its output." </dev/null >/dev/null &
  local pid=$!
  sleep 25
  kill -INT "$pid"
  wait "$pid" || true
  cd "$REPO"
}

[[ $SKIP_RUN == --skip-run ]] || run_sessions

mkdir -p "$OUT"
node - "$CODEX_HOME/sessions" "$PROJECT" "$VERSION" "$OUT" <<'EOF'
// Picks the newest rollout per scenario, trims instruction text Resin never reads, and
// writes raw copies next to the output for scrub.mjs.
const fs = require("node:fs");
const path = require("node:path");
const [root, project, version, out] = process.argv.slice(2);
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) files.push(full);
  }
};
walk(root);
const scenario = (lines) => {
  const meta = lines.find((r) => r.type === "session_meta")?.payload ?? {};
  if (meta.cwd !== project || meta.cli_version !== version) return null;
  const items = lines.map((r) => r.payload?.item?.type);
  if (meta.thread_source === "subagent") return "subagent-child";
  if (items.includes("CollabAgentToolCall")) return "subagent-parent";
  if (lines.some((r) => r.type === "compacted")) return "compaction";
  if (lines.some((r) => r.payload?.type === "turn_aborted")) return "aborted-turn";
  if (lines.some((r) => r.payload?.item?.type === "McpToolCall" && r.payload.item.status === "completed"))
    return "tools";
  return null;
};
const LIMIT = 400;
const trim = (text) => (text.length > LIMIT ? `${text.slice(0, LIMIT)}<trimmed:${text.length}>` : text);
const trimRecord = (r) => {
  if (r.type === "session_meta" && r.payload.base_instructions?.text)
    r.payload.base_instructions.text = trim(r.payload.base_instructions.text);
  if (r.type === "world_state")
    for (const v of Object.values(r.payload.state ?? {})) if (typeof v?.text === "string") v.text = trim(v.text);
  const msgs = r.type === "compacted" ? r.payload.replacement_history ?? [] : [r.payload];
  for (const m of msgs)
    // Developer instructions and the injected AGENTS.md user message hold the operator's config.
    if (
      m?.type === "message" &&
      (m.role === "developer" ||
        (m.role === "user" && m.content?.some((c) => c.text?.startsWith("# AGENTS.md instructions"))))
    )
      for (const c of m.content ?? []) if (typeof c.text === "string") c.text = trim(c.text);
  if (r.type === "turn_context" && typeof r.payload.developer_instructions === "string")
    r.payload.developer_instructions = trim(r.payload.developer_instructions);
  return r;
};
const chosen = {};
for (const f of files) {
  let lines;
  try {
    lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    continue;
  }
  const name = scenario(lines);
  if (name && (!chosen[name] || chosen[name].file < f)) chosen[name] = { file: f, lines };
}
for (const [name, { file, lines }] of Object.entries(chosen)) {
  fs.writeFileSync(path.join(out, `${name}.raw.jsonl`), lines.map((r) => JSON.stringify(trimRecord(r))).join("\n") + "\n");
  console.log(`${name} <- ${path.basename(file)}`);
}
EOF

# Account/workspace identifiers found in real rollouts are replaced as well.
for raw in "$OUT"/*.raw.jsonl; do
  replaces=()
  while read -r id; do replaces+=(--replace "$id=<scrubbed:account>"); done < <(
    grep -oE '"creator_(user|account)_id":"[^"]+"|workspace '"'"'[0-9a-f-]{36}'"'"'' "$raw" |
      grep -oE 'user-[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | sort -u
  )
  node scripts/harness-fixtures/scrub.mjs "$raw" "${raw%.raw.jsonl}.jsonl" --project "$PROJECT" "${replaces[@]}"
  rm "$raw"
done
ls -la "$OUT"
