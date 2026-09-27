#!/usr/bin/env bash
# Regenerates the muse-code recorded fixtures with the real `muse` binary and the real Meta model,
# driven headlessly in an isolated XDG home whose auth.json is symlinked from the user's muse login.
# See ../CAPTURE.md.
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
AUTH="${XDG_CONFIG_HOME:-$HOME/.config}/muse/auth.json"
[ -f "$AUTH" ] || { echo "run 'muse login' first ($AUTH missing)" >&2; exit 1; }
export MUSE_NO_AUTO_UPDATE=1 XDG_CONFIG_HOME="$H/.config" XDG_DATA_HOME="$H/.local/share"

reset_home() {
  rm -rf "$H" "$P"
  mkdir -p "$H/.config/muse" "$P"
  ln -s "$AUTH" "$H/.config/muse/auth.json"
  printf '{"schema_version":1,"mcp_servers":{"demo":{"command":"python3","args":["%s"]}}}\n' \
    "$HERE/demo-mcp-server.py" >"$H/.config/muse/settings.json"
  (cd "$P" && git init -q && echo "# demo" >README.md && git add . &&
    git -c user.email=fixture@example.invalid -c user.name=fixture commit -qm init)
}

run_muse() { # <signal> <seconds> <prompt> [extra muse args...]
  local signal="$1" seconds="$2" prompt="$3"
  shift 3
  (cd "$P" && timeout -s "$signal" "$seconds" muse exec --approval-judge off --yolo \
    "$@" "$prompt" >/dev/null 2>&1) || true
}

run_until_started() { # <signal> <prompt>: send <signal> once started.txt exists (the effect is running)
  (cd "$P" && exec muse exec --approval-judge off --yolo --json "$2" >/dev/null 2>&1) &
  local pid=$! i
  for i in $(seq 1 600); do [ -f "$P/started.txt" ] && break; sleep 0.5; done
  sleep 2
  kill -"$1" "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

save_raw() { # <scenario>
  rm -rf "${RAW:?}/$1"
  mkdir -p "$RAW/$1"
  cp -r "$H/.local/share/muse/sessions/." "$RAW/$1/sessions"
  rm -rf "$RAW/$1/sessions/.msp-view-v1"
}

LONG="Run exactly this shell command and nothing else: echo start > started.txt && sleep 60 && echo end > ended.txt"

# full: shell, read, edit, write, MCP call, failing shell, subagent spawn + wait (+ observers).
reset_home
run_muse TERM 600 "Do these steps in order, one tool call per step: 1) run the shell command 'ls && git status --short'; 2) read README.md; 3) edit README.md replacing '# demo' with '# demo project'; 4) create hello.py containing print('hello'); 5) call the demo MCP server's add tool with a=2 b=3; 6) run the shell command 'exit 3'; 7) spawn an explorer subagent to count lines in README.md and wait for it. Then report briefly." --json
save_raw full

# abort: SIGINT once the side-effecting shell command has started.
reset_home
run_until_started INT "$LONG"
save_raw abort

# kill: SIGKILL mid-command, then resume the same session so muse reconciles the call.
reset_home
run_until_started KILL "$LONG"
save_raw kill
cp "$(find "$RAW/kill/sessions" -maxdepth 5 -name session.jsonl | head -1)" "$RAW/kill/session.before-resume.jsonl"
SESSION_ID="$(basename "$(dirname "$(find "$H/.local/share/muse/sessions" -maxdepth 5 -path '*/20*' -name session.jsonl | head -1)")")"
run_muse TERM 300 "The previous command was interrupted. Do not rerun it; just say done." --session-id "$SESSION_ID"
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
