# Recorded Codex CLI fixtures

Real rollouts from headless `codex exec` runs, scrubbed with `scripts/harness-fixtures/scrub.mjs`.
`tests/recorded-fixtures.test.ts` decodes every file and fails on any record the decoder does not
recognize.

| Fixture | Covers |
|---------|--------|
| `<version>/tools.jsonl` | code-mode `exec` cells with nested `exec_command` (shell, file read), `apply_patch` (edit + add file), a stdio MCP call (`fixture.word_count`), Resin `invoke_tool` (error result), token usage, `world_state`, `thread_settings_applied` |
| `<version>/subagent-parent.jsonl` | `spawn_agent` / `wait` multi-agent calls (`CollabAgentToolCall`) |
| `<version>/subagent-child.jsonl` | the spawned child's own rollout (`thread_source: "subagent"`, `parent_thread_id`) |
| `<version>/compaction.jsonl` | automatic compaction (`compacted`, `ContextCompaction`) |
| `<version>/aborted-turn.jsonl` | a turn interrupted with SIGINT during a running shell command (`turn_aborted`) |

Versions: `0.157.1` (npm global install) and `0.156.1` (`npm i @openai/codex@0.156.1` in a
scratch directory). Model `gpt-5.6-luna`, reasoning effort `low`.

## Regenerate

From the repo root, with an authenticated Codex and Resin registered in Codex's MCP config:

```sh
bash adapters/codex-cli/tests/fixtures/recorded/capture.sh codex
mkdir -p /tmp/codex-0156 && (cd /tmp/codex-0156 && npm i @openai/codex@0.156.1)
bash adapters/codex-cli/tests/fixtures/recorded/capture.sh /tmp/codex-0156/node_modules/.bin/codex
```

`capture.sh` creates the throwaway project `/tmp/resin-fixture-codex-<version digits>` (a README and
`greet.py` in a git repo) and a one-tool stdio MCP server, then runs four `codex exec --json`
sessions with `--dangerously-bypass-approvals-and-sandbox` (so MCP calls are not refused in
headless mode; the project is disposable) and per-run `-c` overrides only:

1. tools: shell, read, `apply_patch` edit, new file, `fixture.word_count`, `resin.invoke_tool`;
2. subagent: spawn one subagent running `wc -l greet.py` and wait for it;
3. compaction: `-c model_context_window=30000 -c model_auto_compact_token_limit=5000 -c model_post_turn_compact_threshold_percent=10`;
4. aborted turn: `sleep 60`, interrupted with SIGINT after 25 s.

It then picks the newest rollout per scenario from `$CODEX_HOME/sessions` (matched by project
`cwd` and `cli_version`), trims instruction text Resin never reads (base instructions,
`world_state` texts, developer messages, the injected AGENTS.md message) to 400 characters, and
scrubs each file with `--project <capture dir>` plus `--replace` for the account and workspace ids
found in the rollout. `--skip-run` re-scrubs existing rollouts without starting new sessions;
`PROJECT=<dir>` overrides the project path (the committed fixtures used
`/tmp/resin-fixture-codex-0157` and `/tmp/resin-fixture-codex-0156`).
