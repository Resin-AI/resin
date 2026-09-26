#!/usr/bin/env bash
# Regenerates the muse-code recorded fixtures with the real `muse` binary driven headlessly
# against the scripted provider in fake-meta.py. See ../CAPTURE.md.
#
# Usage: capture.sh [output-dir]   (default: ../<muse version>)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../../../.." && pwd)"
VERSION="$(MUSE_NO_AUTO_UPDATE=1 muse --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
OUT="${1:-$HERE/../$VERSION}"
H=/tmp/resin-fixture-muse-home
P=/tmp/resin-fixture-muse-cap
RAW=/tmp/resin-fixture-muse-raw
PORT=18777
export MUSE_NO_AUTO_UPDATE=1

SCRIPT="$(mktemp)"
SCRIPT="$SCRIPT" PORT="$PORT" python3 "$HERE/fake-meta.py" &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true; rm -f "$SCRIPT"' EXIT
sleep 1

reset_home() {
  rm -rf "$H" "$P"
  mkdir -p "$H/.config/muse" "$P"
  printf '{"schema_version":1,"mcp_servers":{"demo":{"command":"python3","args":["%s"]}}}\n' \
    "$HERE/demo-mcp-server.py" >"$H/.config/muse/settings.json"
  (cd "$P" && git init -q && echo "# demo" >README.md && git add . &&
    git -c user.email=fixture@example.invalid -c user.name=fixture commit -qm init)
}

run_muse() { # <signal> <seconds> <prompt> [extra muse args...]
  local signal="$1" seconds="$2" prompt="$3"
  shift 3
  (cd "$P" && META_API_KEY=dummy HOME="$H" timeout -s "$signal" "$seconds" \
    muse exec --base-url "http://127.0.0.1:$PORT" --model fake-model --approval-judge off --yolo \
    "$@" "$prompt" >/dev/null 2>&1) || true
}

save_raw() { # <scenario>
  rm -rf "${RAW:?}/$1"
  mkdir -p "$RAW/$1"
  cp -r "$H/.local/share/muse/sessions/." "$RAW/$1/sessions"
  rm -rf "$RAW/$1/sessions/.msp-view-v1"
}

# full: shell, read, edit, write, MCP call, failing shell, subagent spawn + wait.
cat >"$SCRIPT" <<'EOF'
[{"ns":"muse","name":"bash","args":{"command":"ls && git status --short","description":"List files"}},
 {"ns":"muse","name":"read_file","args":{"path":"README.md"}},
 {"ns":"muse","name":"edit_file","args":{"path":"README.md","find":"# demo","replace":"# demo project"}},
 {"ns":"muse","name":"write_file","args":{"path":"hello.py","content":"print('hello')\n"}},
 {"name":"mcp__demo__add","args":{"a":2,"b":3}},
 {"ns":"muse","name":"bash","args":{"command":"exit 3","description":"Run failing command"}},
 {"ns":"muse","name":"subagent_spawn","args":{"command_id":"spawn-1","role":"explorer","objective":"Count lines in README.md and report."}},
 {"ns":"muse","name":"subagent_wait","args":{"command_id":"wait-1","agent_path":"main/explorer/1","timeout_ms":30000}}]
EOF
reset_home
run_muse TERM 120 "Inspect the repo, tweak README, add hello.py, add 2+3 via demo MCP, then delegate a line count." --json
save_raw full

# abort: SIGINT while a side-effecting shell command runs.
cat >"$SCRIPT" <<'EOF'
[{"ns":"muse","name":"bash","args":{"command":"echo start > started.txt && sleep 30 && echo end > ended.txt","description":"Run long command"}}]
EOF
reset_home
run_muse INT 6 "Run the long command." --json
save_raw abort

# kill: SIGKILL mid-command, then resume the same session so muse reconciles the call.
reset_home
run_muse KILL 6 "Run the long command." --json
save_raw kill
cp "$(find "$RAW/kill/sessions" -maxdepth 5 -name session.jsonl | head -1)" "$RAW/kill/session.before-resume.jsonl"
echo '[]' >"$SCRIPT"
SESSION_ID="$(basename "$(dirname "$(find "$H/.local/share/muse/sessions" -maxdepth 5 -path '*/20*' -name session.jsonl | head -1)")")"
run_muse TERM 60 "continue" --session-id "$SESSION_ID"
rm -rf "$RAW/kill/sessions"
cp -r "$H/.local/share/muse/sessions/." "$RAW/kill/sessions"
rm -rf "$RAW/kill/sessions/.msp-view-v1"

# Scrub every session log and patch summary into the fixture tree.
for scenario in full abort kill; do
  (cd "$RAW/$scenario" && find . -name 'session*.jsonl' -o -name '*tool_patch.json') | while read -r file; do
    dest="$OUT/$scenario/${file#./}"
    mkdir -p "$(dirname "$dest")"
    node "$REPO/scripts/harness-fixtures/scrub.mjs" "$RAW/$scenario/$file" "$dest" \
      --project "$P" --replace "$H=/home/user" >/dev/null
  done
done
echo "fixtures written to $OUT"
