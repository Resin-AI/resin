# Harness Integration Guide

Resin integrates seamlessly with multiple AI developer harnesses via the Model Context Protocol (MCP) and local observation adapters.

---

## Supported Coding Harnesses

Every harness below is registered by `resin init` and removed by `resin uninstall`. Resin's MCP entry is always a stdio command (`<resin home>/bin/resin mcp`). The last column is the resin-bench harness conformance result of 2026-09-27 (learn on one repeated deployment job, invoke on a sibling job, measured from each harness's own usage records). Whether a learned tool saves work depends on the tool the cloud generates, which varies between runs.

| Harness | Tested versions | Config Resin writes | Guidance file | Capture source | Capture method | Catalog refresh | Learn/invoke conformance |
|---------|-----------------|---------------------|---------------|----------------|----------------|-----------------|--------------------------|
| **Claude Code CLI** | `2.1.283` | `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json`) | `~/.claude/CLAUDE.md` (`$CLAUDE_CONFIG_DIR/CLAUDE.md`) | `~/.claude/projects/<project>/<session>.jsonl` + `<session>/subagents/agent-<id>.jsonl` | JSONL transcript tailing | Native `tools/list_changed` | Learns; with the guidance the model checked the learned tools but called none (11→15 calls) |
| **Codex CLI** | `0.156.1`, `0.157.1` | `$CODEX_HOME/config.toml` (`~/.codex/config.toml`) | `$CODEX_HOME/AGENTS.md` | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL rollout tailing | Stable meta-tools + response catalog notices | Learns; learned tool called (8→2 calls, −65% input tokens; the tool's step failed) |
| **Oh My Pi (OMP)** | `18.3.2` | `$OMP_HOME/agent/mcp.json` (`~/.omp/agent/mcp.json`; legacy `~/.omp/config.json` cleaned on uninstall) | `$OMP_HOME/agent/AGENTS.md` (`~/.omp/agent/AGENTS.md`) | `~/.omp/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl` + subagent dirs | JSONL transcript tailing | Native `tools/list_changed` | Learns and invokes (one learned-tool call succeeded, one failed; 14→17 calls) |
| **Pi** (`@earendil-works/pi-coding-agent`) | `0.87.1` | `<agent-dir>/extensions/resin.ts` (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`) | `<agent-dir>/AGENTS.md` (or the first existing context file) | `<agent-dir>/sessions/--<cwd>--/*.jsonl`, `$PI_CODING_AGENT_SESSION_DIR`, `sessionDir` setting | JSONL transcript tailing | Native `tools/list_changed` via the extension | Learns; learned tool called but its step failed (4→10 calls) |
| **Cursor CLI** (`cursor-agent`) | `2026.9.26-dd393fe` | `~/.cursor/mcp.json`, `~/.cursor/hooks.json` | `~/.cursor/rules/resin.mdc` | `~/.resin/capture/cursor-cli/<conversation_id>.jsonl` | Hook spool (`~/.resin/hooks/cursor-capture.mjs`) | Next session (ignores list_changed mid-session) | Learns and invokes (2 successful learned-tool calls; 8→8 calls) |
| **Grok Build** (`grok`) | `1.0.13` | `$GROK_HOME/config.toml` (`~/.grok/config.toml`) | `$GROK_HOME/AGENTS.md` | `~/.grok/sessions/<encoded cwd>/<id>/updates.jsonl` | JSONL transcript tailing | Native `tools/list_changed` | Learns; the model searched and inspected Resin tools but called none (6→13 calls) |
| **Muse Code** (`muse`) | `1.4.0` | `$XDG_CONFIG_HOME/muse/settings.json` (`~/.config/muse/settings.json`) | `$XDG_CONFIG_HOME/muse/AGENTS.md` | `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/session.jsonl` + `subagent/<child>/session.jsonl` | JSONL session-log tailing | Next session | Learns and invokes (8→6 calls, −34% input tokens) |
| **OpenCode** (`opencode`) | `1.18.32`, `1.1.65` | `$XDG_CONFIG_HOME/opencode/opencode.json` (`mcp.resin`) | `$XDG_CONFIG_HOME/opencode/AGENTS.md` | `$XDG_DATA_HOME/opencode/opencode.db` (`OPENCODE_DB`); legacy `storage/` JSON tree | SQLite store / legacy JSON reads | Next session | Learns; learned tools not called by the free model used for testing (11→13 calls) |
| **GitHub Copilot CLI** (`copilot`) | `1.0.88` | `$COPILOT_HOME/mcp-config.json` (`~/.copilot/mcp-config.json`) | `$COPILOT_HOME/copilot-instructions.md` | `~/.copilot/session-state/<id>/events.jsonl` | JSONL event-log tailing | Native `tools/list_changed` | Learns and invokes (15→11 calls, −29% input tokens) |

### Tested, untested, and unknown versions

Each harness definition lists the exact versions Resin recorded real sessions with (`testedVersions`). `resin status` compares the installed version against that list and shows it as tested, `(untested)`, or unknown (when the harness does not report a version). Untested and unknown versions are still registered and observed; a record whose shape changed is kept as an unrecognized record rather than decoded by guesswork.

`npx resin init` writes the explicitly supplied `--gateway-url` into each configured harness. When that flag is omitted, the URL is `http://127.0.0.1:9400/mcp/sse`.

## 1. Claude Code CLI Integration

### Automated Registration

`npx resin init` adds Resin as a user-scope stdio server in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set — the file `claude mcp add -s user` writes). Other servers and settings in the file are preserved:

```json
{
  "mcpServers": {
    "resin": {
      "command": "/home/you/.resin/bin/resin",
      "args": ["mcp"]
    }
  }
}
```

It also installs a short guidance block in Claude's user memory, `~/.claude/CLAUDE.md` (`$CLAUDE_CONFIG_DIR/CLAUDE.md`), between `<!-- resin:claude-guidance:start -->` and `<!-- resin:claude-guidance:end -->`. Claude Code defers MCP tools behind its tool search, so the block tells it that Resin's learned tools are `mcp__resin__<name>` and to look them up. Running `init` again leaves both unchanged; `npx resin uninstall` removes the entry and the block and keeps everything else in those files.

Project-scope `.mcp.json` files are not touched.

### Manual Verification

```bash
claude mcp list
```

Expected output:

```text
resin: /home/you/.resin/bin/resin mcp - ✔ Connected
```

### Session Observation

Resin follows session transcripts in `~/.claude/projects/<encoded-project>/<session-id>.jsonl` and the subagent transcripts Claude writes beside them (`<session-id>/subagents/agent-<id>.jsonl`). A subagent is attributed to its parent session's project, identified by the `sessionId` and `agentId` its transcript records. Shell commands, reads, edits, writes, MCP calls, subagent launches, compactions (`/compact`), interrupts, and per-response token usage are decoded.

A successful `Edit` or `Write` becomes a patch step, the same representation as a Codex `apply_patch`: the diff Claude recorded as applied, confined to the session's working directory and stored only on this device. An edit Claude cannot restate exactly as a unified diff (for example a file without a final newline) is not learned.

Only the version listed above is qualified with recorded sessions; `resin status` reports other versions as untested, and they still register.

### Known Limits

- Only user-scope MCP registration (`.claude.json`) is managed; project `.mcp.json` files are left alone.
- Edit/Write steps are learned only when Claude recorded the resulting patch (`toolUseResult.structuredPatch` or created-file content).

---

## 2. Codex CLI Integration

### Automated Registration

Resin registers its stdio MCP shim in `$CODEX_HOME/config.toml` (`~/.codex/config.toml` by default; `CODEX_CONFIG_PATH` overrides the file):

```toml
[mcp_servers.resin]
command = "/home/<user>/.resin/bin/resin"
args = ["mcp"]
```

Resin also adds a section marked by `<!-- resin:codex-guidance:start -->` and `<!-- resin:codex-guidance:end -->` to Codex's global instructions file, `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md` by default). Codex's code mode shows MCP tools to the model only when its instructions mention them, so without this section the model never sees Resin's learned tools. Content outside the markers is left untouched, and `resin uninstall` removes the section (deleting the file if nothing else remains).

### Stable Tool Gateway

For Codex clients identified as `codex-mcp-client` or `openai-codex-cli`, Resin advertises only four stable MCP tools:

| Tool | Purpose |
|------|---------|
| `search_tools` | Discover tools in the current visible catalog |
| `get_tool_schema` | Inspect a tool's input schema |
| `invoke_tool` | Run a discovered tool |
| `manage_tools` | Manage tools |

Codex can discover and use newly available tools through these routes even when it does not refresh its native MCP tool list. Search and schema lookup are marked read-only; this does not grant permission to execute or manage tools. `invoke_tool` and `manage_tools` remain subject to the host's authorization, including Codex's native permission choices.

Reconnect to the updated Resin server once after a software update to obtain this behavior. Subsequent catalog changes do not require a session restart, custom harness, extra daemon, refresh script, or repeated configuration edits.

### Tested versions

Resin qualifies Codex CLI **0.156.1** and **0.157.1** with rollouts recorded from real headless `codex exec` runs (`adapters/codex-cli/tests/fixtures/recorded/`). `resin status` reports any other installed version as untested: Resin still registers and observes it, but a record whose shape changed may be captured only as an unrecognized record.

### Session Observation

Codex CLI JSONL rollouts are tailed from `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (`~/.codex/sessions/` by default). Interactive (`codex`) and headless (`codex exec`) runs write the same rollouts and are discovered and captured the same way. Native session metadata, turn context, messages, function calls and outputs, provider usage, and terminal events are normalized locally. The recorded `session_meta.cwd` binds a rollout to its project; a missing or invalid working directory remains unbound rather than being guessed from the Codex home directory.

On 0.156 and later, every model tool call is a code-mode `exec` cell (JavaScript) whose nested tools are recorded as separate items. Resin captures:

- shell commands (`exec_command`) as command executions, and `apply_patch` edits as file edits;
- MCP calls (`McpToolCall`), including Resin's own `invoke_tool`, with their server, arguments, result and error;
- built-in web search (`web__run`) as a `web_search` tool call and its results;
- token usage, compaction boundaries (`compacted`), and interrupted turns (`turn_aborted`, recorded as an interrupted session end).

Codex runs subagents (`multi_agent`, on by default). The parent's `spawn_agent`/`wait` calls are recorded as subagent spawn and settle events that name the child thread; each child writes its own rollout whose `session_meta` names the parent thread and carries the same working directory, so it is captured as its own session bound to the parent's project. A record type Resin does not recognize is kept as an unrecognized record rather than dropped.

Codex has no native-tool invoker. Its built-in tools on 0.157 are `exec_command`/`write_stdin` (shell), `apply_patch` (every file create, edit and delete), `view_image`, `web__run`, the multi-agent tools, goals, and MCP resource reads; there is no separate read, write or edit tool. File reads happen through shell commands and file changes through `apply_patch`, so a learned tool covers Codex's built-in steps as shell commands and patch steps. Web search, image viewing and subagent steps are recorded but are not replayed by learned tools.

Fresh sessions that start while observation is running are read from the beginning, including sessions that finish between discovery scans. A saved cursor takes precedence. Touching an old rollout does not make its recorded creation time fresh.

Native source reads are serialized, and delayed acknowledgements do not rewind unread buffered data. Reads yield between bounded work quanta without treating a partially scanned complete record as end-of-file. Metadata headers are inspected up to 1 MiB; individual records larger than 8 MiB are skipped without fabricating events.

Explicit turn usage takes precedence over duplicate last-response snapshots. Unique response reports are summed when turn totals are absent; a last-response-only fallback is marked partial, not claimed as complete turn usage. Missing billing amounts are not invented.

Only a confirmed completed native shell result can establish a successful local baseline. Running, explicitly truncated, or unclassified results are withheld from baseline and computation-success evidence without being relabeled as execution errors. Raw source and result values remain local.

### Known Limits

- No native-tool invoker: learned tools replay Codex built-in steps only as shell commands and `apply_patch` edits; web search and multi-agent steps are recorded but not replayable.
- Multi-agent child threads are separate rollouts, bound to the parent's project through their own `session_meta` cwd.
- Compaction boundaries are captured, but Codex does not record the token count after compaction.

### What a learned tool can vary

A learned tool runs the commands Codex ran, with some recorded values turned into inputs. A value becomes an input candidate when the request named it, when several commands of the job used it, or when two recordings of the same job used different values at that position. Candidates can be:

- a whole command word (`./release test alpha` → `{project}`), or part of one (`out/emea-2025-03/summary.csv` → `out/{region}-{month}/summary.csv`);
- a literal inside a Python or Node program the command runs (a heredoc body or a `-c`/`-e` string); such inputs are named after the record field or variable the literal is compared with or assigned to (`x['merchant']=='…'` → `{merchant}`), and record field names themselves are never inputs;
- a value an earlier command printed, such as a generated deployment id, which later commands then read from that command's output on every run;
- a value on a line a Codex `apply_patch` edit added; the edit runs as a patch step confined to the working directory.

Every candidate stays the recorded value until local validation confirms it. Validation runs nothing recorded: it resolves each step's call as an invocation would and checks that it equals the call this device recorded, so the recorded output answers the step (see [Limitations](limitations.md#recorded-workflow-validation)). Outputs, file edits and the original text of every program stay on this machine. The secret-redacted text of Codex commands, like other secret-redacted program views (see [Security and Privacy](security-and-privacy.md)), is sent to Resin's service to name the tool and choose its inputs; shell commands from other harnesses are not.

---

## 3. Oh My Pi (OMP) Integration

### Tested versions

Resin qualifies OMP against real sessions recorded with that release (`adapters/omp/tests/fixtures/recorded/<version>/`). OMP `18.3.2` is tested. Any other installed version still registers and is captured, but `resin status` reports it as untested.

### Automated Registration

`resin init` adds Resin's stdio entry to `~/.omp/agent/mcp.json` (or `$OMP_HOME/agent/mcp.json`) and preserves every other server and setting:

```json
{
  "mcpServers": {
    "resin": {
      "type": "stdio",
      "command": "/home/you/.resin/bin/resin",
      "args": ["mcp"]
    }
  }
}
```

Resin keeps its learned-tool guidance in a managed block of `$OMP_HOME/agent/AGENTS.md` (`~/.omp/agent/AGENTS.md`), which OMP loads as a user context file in every project; a project's `.omp/APPEND_SYSTEM.md` would replace a global `APPEND_SYSTEM.md`, so Resin does not use that file. `resin uninstall` removes the block, the entry from the active config, and the entry from the legacy `~/.omp/config.json`.

### Session Observation

OMP writes each session to `~/.omp/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl`. A subagent started with the `task` tool writes its own transcript to `<timestamp>_<parentId>/<AgentName>.jsonl`, whose header names the parent in `parentSession`. Resin captures both kinds.

OMP reaches MCP tools through its device surface (`write xd://mcp__<server>_<tool>`). Resin records such a call as the tool it reached, on the server that owns the path in OMP's own configuration, with the tool's own arguments.

When an Eval cell prints more than OMP shows inline, OMP keeps the full output in `<timestamp>_<id>/<n>.eval.log` and marks the result as truncated. Resin reads that file as the call's result. If the file is missing or does not match what the transcript declares, the result is treated as unavailable rather than taken from the truncated display.

A call to a tool the session does not have (OMP answers `Tool <name> not found`) is recorded as a failed call with no result.

### Subagents and learning

Subagent calls are not counted as part of the parent's execution. Each subagent is learned as its own session, with the `task` prompt as its request, and the parent's `task` call is one step of the parent. The reasons:

- A subagent runs in its own context with its own prompt, and the parent only sees the text the subagent returns. The parent's workflow does not depend on the individual calls the subagent made.
- Subagents started by one `task` call run concurrently and finish in any order. Merging their calls into the parent would give a sequence that no single run produced.
- Replaying the parent's work means starting the subagent again, which is what the `task` step already records.

As a result, a workflow whose steps are split between a parent and its subagents is not learned as one tool.

### Built-in tool replay

Learned tools can repeat OMP built-ins (`read`, `write`, `edit`, `bash`, `eval`, and others) by running them from the OMP SDK that Resin pins to the tested version (`@oh-my-pi/pi-coding-agent` `18.3.2`), under Bun. A step that names a built-in the SDK does not export fails with `OMP native tool '<name>' is not available in the installed harness SDK`, followed by the list of built-ins it does export. For example, earlier 18.x sessions recorded a `search` built-in that `18.3.2` exports as `grep`.

### Shared decoder with Pi (decision)

Pi (`pi` 0.87.x) and OMP both write version-3 JSONL sessions with `message` entries whose assistant content carries `toolCall` blocks and whose `toolResult` messages carry `toolCallId`. They still get separate decoders that share only the harness contracts. OMP adds entry types Pi does not have (`session_init`, `mode_change`, `credential_pin`, `ttsr_injection`, `service_tier_change`, `mcp_tool_selection`). OMP also puts subagents in nested directories, calls MCP tools through `xd://` device paths, and spills Eval output to artifacts. Pi has entry types OMP does not have (`usage`, `context_edit`, `label`, `session_info`), records forks as new files with `parentSession`, and has no subagent directories. A shared decoder would need a branch for each of these differences, and a format change in either harness could break the other. The two harnesses release independently, so each decoder is qualified against its own recorded sessions. We would revisit this if the two formats converge again.

---

## 4. Pi Integration

### Tested versions

Pi `0.87.1` is tested (`adapters/pi/tests/fixtures/recorded/0.87.1/`). Other versions are reported as untested and still register.

### Why an extension

Pi has no MCP client: its model sees built-in tools plus tools that Pi extensions register. `resin init` therefore writes a Resin-owned extension to `<agent-dir>/extensions/resin.ts` (`<agent-dir>` is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`). Pi loads it automatically; it starts `resin mcp` over stdio and registers every gateway tool as a Pi tool named `mcp__resin__<tool>`. It follows `notifications/tools/list_changed`, so learned tools appear in running sessions without a restart. `resin init` also adds a marked guidance block to the agent directory's context file (the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` that exists, else a new `AGENTS.md`). `resin uninstall` deletes the extension (only if Resin wrote it) and removes the block. Resin never overwrites a `resin.ts` it did not write.

### Session Observation

Resin reads Pi's JSONL session files (format versions 1–3) from `<agent-dir>/sessions/--<cwd>--/`, `$PI_CODING_AGENT_SESSION_DIR`, and the `sessionDir` setting (global or project `.pi/settings.json`). Sessions belong to the workspace named by the file header's `cwd`. In-file `/tree` rewinds and branch summaries are captured as branch forks, so calls from the abandoned and new branches stay separate; `/fork` and `--fork` sessions link to their parent and skip the copied parent history.

### Known Limits

Runs with `--no-session` write nothing and cannot be captured; runs with `--no-extensions` do not load the Resin extension; sessions stored with `--session-dir` are found only when that directory is also configured through `PI_CODING_AGENT_SESSION_DIR` or `sessionDir`; Pi has no built-in subagents.

---

## 5. Cursor CLI Integration

### Tested versions

Tested: cursor-agent `2026.09.26-dd393fe` (normalized `2026.9.26-dd393fe`), qualified with real hook captures from headless (`-p`) and interactive sessions: shell, read, edit, write, MCP, Task subagents, abort, `/compact` (`adapters/cursor-cli/tests/fixtures/recorded/`). Other versions are reported as untested.

### Automated Registration

`resin init` makes three idempotent changes, all removed by `resin uninstall`:

- Adds `mcpServers.resin` (`{ "command": "<resin shim>", "args": ["mcp"] }`) to `~/.cursor/mcp.json`. cursor-agent reads this user-level file for every project; other servers are kept.
- Installs `~/.resin/hooks/cursor-capture.mjs` and registers it in `~/.cursor/hooks.json` for the observe-only events `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `afterAgentThought`, `afterAgentResponse`, `postToolUse`, `postToolUseFailure`, `afterFileEdit`, `preCompact`, `subagentStart`, `subagentStop` and `stop`. The script prints nothing and always exits 0. cursor-agent only blocks a step when a hook explicitly answers `continue: false` or denies permission, so the hook changes nothing about what Cursor allows. Resin never registers the permission hooks (`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`). Other hooks in the file are kept.
- Writes the user rule `~/.cursor/rules/resin.mdc` (`alwaysApply: true`), which describes Resin's learned tools.

cursor-agent reads these paths from `os.homedir()/.cursor`. `CURSOR_CONFIG_DIR` only moves `cli-config.json`.

### Session Observation

Resin captures sessions through hooks, not transcript files. cursor-agent writes `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`. Those files keep only message text and tool-call arguments: they have no tool results, call ids, token usage, timestamps or cwd, and the writer rewrites them after summarization. Hook payloads carry these fields. The capture script appends each payload to `~/.resin/capture/cursor-cli/<conversation_id>.jsonl`, adding `resin_received_at` and dropping `user_email`. Each session is bound to the `workspace_roots` its hooks recorded.

Resin decodes:

- prompts and responses (interactive sessions only; see below);
- per-turn usage (input, output and cache-read tokens) from `stop`;
- tool calls and their results, identified as `<tool_name>:<tool_use_id>`;
- shell commands and file edits (old/new strings);
- compaction;
- aborted or failed turns.

Each payload is checked against the field contract pinned in `adapters/cursor-cli/src/hook-records.ts`. An unknown hook event or a changed field is recorded as drift and never decoded by guesswork.

### Known Limits

- Sessions from before `resin init`, or from while the hooks were missing, are listed as uncaptured (`listUncapturedSessions`, reason `no-hook-capture`) and are not decoded.
- Cloud Agents that run on Cursor's machines leave nothing on this device and cannot be captured. cursor-agent 2026.09.26 removed the CLI's `--cloud`/`--background` flags. Self-hosted `cursor-agent worker` sessions are captured and flagged `isBackgroundAgent`.
- Event times are the moments the hook ran, because payloads carry no timestamps. Tool calls are recorded when they complete; a call still running when a session is aborted is not recorded, and the session ends with reason `error`.
- Headless `cursor-agent -p` runs fire no `beforeSubmitPrompt`, `afterAgentResponse` or `stop` hook, so their prompt, final answer and token usage are not captured. Their tool calls, edits and session end are.
- One model edit is reported as a Read and a Write sharing one `tool_use_id`; call ids therefore include the tool name. `afterFileEdit` carries no `tool_use_id` and fires before its Write's `postToolUse`, so file edits are not linked to their call.
- Task subagents run as separate conversations. No `subagentStart`/`subagentStop` hook fires and the Task call itself reaches no `postToolUse`, so subagent sessions are captured on their own, unlinked to their parent.
- cursor-agent ignores an MCP server's `tools/list_changed` for the rest of the session (a tool added mid-session was never offered), so new Resin tools reach the next session.
- cursor-agent has no user-level rules directory: it loads `.cursor/rules` from the workspace and each ancestor directory, so Resin's guidance rule in `~/.cursor/rules/resin.mdc` reaches projects under your home directory only (verified with 2026.09.26). Projects elsewhere still get Resin's MCP server instructions.

---

## 6. Grok Build Integration

### Tested versions

Grok Build `1.0.13` is tested (`adapters/grok-build/tests/fixtures/recorded/1.0.13/`). Other versions register and are captured, and `resin status` reports them as untested.

### Automated Registration

`resin init` adds `[mcp_servers.resin]` (`command = "<resin shim>"`, `args = ["mcp"]`) to `$GROK_HOME/config.toml` (`~/.grok/config.toml` by default) and a guidance block between `<!-- resin:grok-guidance:start -->` and `<!-- resin:grok-guidance:end -->` in `$GROK_HOME/AGENTS.md`. A project `.grok/config.toml` overrides the user config for the same server name, as in Grok's own loader. `resin uninstall` removes both and keeps everything else.

### Session Observation

Grok writes each session to `~/.grok/sessions/<encoded cwd>/<id>/`. Resin tails `updates.jsonl` and reads `summary.json` and subagent `subagents/<child>/meta.json`. Headless (`grok -p`), `--resume`, `--fork-session`, ACP (`grok agent stdio`) and background subagents are captured. Because headless runs exit immediately and `--resume` appends to old sessions, capture follows transcript activity rather than session creation time. Grok re-lists Resin's tools when the gateway sends `notifications/tools/list_changed`, so its `search_tool`/`use_tool` meta-tools see new tools in a running session.

### Known Limits

- A rewind keeps the abandoned turns in the captured trajectory; the rewind is recorded as a branch point before the replacement turns.
- Sessions continued from another harness (`/resume-claude`, `/resume-codex`, `/resume-cursor`) capture only Grok's new work; the original transcript is captured by that harness's adapter.
- A fork whose parent session was deleted is captured in full.
- Grok also starts MCP servers from `~/.claude.json`, `~/.cursor/mcp.json` and `.mcp.json`; a Resin entry there under a name other than `resin` starts a second gateway.

---

## 7. Muse Code Integration

### Tested versions

Muse Code `1.4.0` is tested (`adapters/muse-code/tests/fixtures/recorded/1.4.0/`). The muse launcher updates itself hourly; set `MUSE_NO_AUTO_UPDATE=1` to stay on a tested version. Other versions are reported as untested and still register.

The fixtures were recorded with the real `muse` 1.4.0 binary and the real Meta model (`muse-spark-1.3-contributor`): shell, file edits, an MCP call, a subagent, background observers, a SIGINT-cancelled call, and a SIGKILLed call reconciled on resume.

Conformance (resin-bench, 2026-09-27, muse 1.4.0, default model): install, capture, learn and invoke passed; the learned tool was invoked successfully and the treated run took 5 calls and 152,872 input tokens against 8 calls and 204,068 for vanilla (both runs completed the job). The model does not call a learned tool on every run (two of four runs did not).

### Automated Registration

`resin init` adds the Resin stdio entry to `$XDG_CONFIG_HOME/muse/settings.json` (`~/.config/muse/settings.json`), keeping other settings and servers, and a marked guidance block in `$XDG_CONFIG_HOME/muse/AGENTS.md`. `resin uninstall` removes only the entry and the block.

### Session Observation

Muse keeps one append-only log per session at `${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<id>/session.jsonl`, with spawned subagents and persisted background observers at `<id>/subagent/<child>/session.jsonl`. Resin tails these logs; resumed sessions append to the same log, so any log that changes is captured. Shell, file reads/edits/writes, MCP calls, subagents, per-call usage, cancelled calls, and the reconciliation muse writes on resume are decoded.

### Known Limits

- Background skill-reminder observer model calls are not written to muse 1.4.0 session logs, so their token usage cannot be counted; the verify-reminder observer's calls are.
- Sessions run with `--no-session-log` leave no log and are not captured.
- Resin catalog changes reach muse at the next session start (`tools/list_changed` support is unverified).
- Context compaction is not decoded: no muse 1.4.0 compaction record was captured.

---

## 8. OpenCode Integration

### Tested versions

OpenCode `1.18.32` (SQLite store) and `1.1.65` (legacy JSON store) are tested (`adapters/opencode/tests/fixtures/recorded/<version>/`). Other versions are reported as untested and still register.

### Automated Registration

`resin init` adds `mcp.resin` to `$XDG_CONFIG_HOME/opencode/opencode.json` (`~/.config/opencode/opencode.json`) and a marked guidance block in `$XDG_CONFIG_HOME/opencode/AGENTS.md`. Other config keys and servers are preserved; `resin uninstall` removes only Resin's entry and block.

### Session Observation

Current OpenCode releases (tested: 1.18.32) store sessions in SQLite at `$XDG_DATA_HOME/opencode/opencode.db` (`~/.local/share/opencode/opencode.db`; `OPENCODE_DB` overrides it). Older releases (tested: 1.1.65) write a JSON tree under `$XDG_DATA_HOME/opencode/storage/{session,message,part,project}`. Resin reads both, including subagent (child) sessions.

### Known Limits

- MCP tool list changes are picked up by the next OpenCode session.
- Only the default release-channel database (`opencode.db`, or `OPENCODE_DB`) is observed.

---

## 9. GitHub Copilot CLI Integration

### Tested versions

Copilot CLI (`@github/copilot`) `1.0.88` is tested (`adapters/copilot-cli/tests/fixtures/recorded/1.0.88/`). Other versions are reported as untested and still register.

### Automated Registration

`resin init` adds `mcpServers.resin` to `$COPILOT_HOME/mcp-config.json` (`~/.copilot/mcp-config.json`) and a marked guidance block in `$COPILOT_HOME/copilot-instructions.md`. Workspace `.mcp.json` and `.github/mcp.json` files are not touched. `resin uninstall` removes only Resin's entry and block.

### Session Observation

Copilot writes every session, including ones started before Resin was installed, to `~/.copilot/session-state/<id>/events.jsonl` with `workspace.yaml` beside it. Resin tails the event log for exact tool arguments and results, subagents, compaction and aborts. On 1.0.88 a tool added through `notifications/tools/list_changed` is usable in the next assistant step of the same interaction, so no restart is needed.

### Known Limits

- Token usage is recorded per Copilot process run (`session.shutdown`), not per model call: per-call usage events are ephemeral and never written to disk.
- A Copilot process killed outright (not Ctrl+C, which still shuts down cleanly) writes no `session.shutdown`, so that run's token usage is not captured.
- File edits are decoded from `apply_patch` (the tool GPT-family models use); other models' edit tools are captured as exact tool calls and results without file-edit events.

---

## 10. Real-Time Tool Catalog Refresh

### Native Dynamic Catalogs

Claude Code, Oh My Pi, Pi (through its Resin extension), Grok Build and Copilot CLI keep their native dynamic tool catalogs. The Gateway sends `notifications/tools/list_changed`; the harness invalidates its tool cache and requests the updated catalog with `tools/list`. Newly available tools can also be discovered through `search_tools`, except in Pi: its extension registers learned tools directly and leaves out the four discovery meta-tools, because Pi resends every tool definition on every model request.

Codex instead uses the stable gateway described above. Its four advertised tools do not change when the underlying catalog changes, so newly available tools do not depend on native tool-list refresh.

Cursor CLI, Muse Code and OpenCode pick up catalog changes at the next session start. cursor-agent 2026.09.26 was observed to ignore `list_changed` mid-session; for Muse Code and OpenCode it is unverified.

### Catalog Notices in Tool Responses

Each connection starts with a baseline of its visible catalog. When that catalog changes, Resin appends a brief notice to the next successful Resin tool response, once for the pending changes. Changes coalesce between responses rather than generating repeated messages:

- New and updated tools include their names and short descriptions, scoped to what the connection can see.
- Removed tools produce a generic removal notice rather than exposing removed tool details.
- Notices are bounded and contain no tool arguments, results, or secrets. Use `search_tools` and `get_tool_schema` for current discovery and input details.

These notices complement native catalog refresh; they are not unsolicited messages to the model. The agent must first interact with Resin to receive a notice. Resin does not guarantee that an agent will search for tools by default or use Resin on every task. To start discovery explicitly, ask the agent to search Resin for a tool relevant to the task.

---

## 11. Recorded Transcript Corpus

Every decoder is tested against transcripts recorded from a real install of the harness, one directory per tested version:

| Harness | Recorded fixtures | Capture notes |
|---------|-------------------|---------------|
| Claude Code | `adapters/claude-code/tests/fixtures/recorded/2.1.283/` | `adapters/claude-code/tests/fixtures/recorded/CAPTURE.md` |
| Codex CLI | `adapters/codex-cli/tests/fixtures/recorded/{0.156.1,0.157.1}/` | `adapters/codex-cli/tests/fixtures/recorded/CAPTURE.md` (+ `capture.sh`) |
| OMP | `adapters/omp/tests/fixtures/recorded/18.3.2/` | `adapters/omp/tests/fixtures/recorded/CAPTURE.md` |
| Pi | `adapters/pi/tests/fixtures/recorded/0.87.1/` | `adapters/pi/tests/fixtures/recorded/CAPTURE.md` |
| Cursor CLI | `adapters/cursor-cli/tests/fixtures/recorded/2026.9.26-dd393fe/` | `adapters/cursor-cli/tests/fixtures/recorded/CAPTURE.md` (+ `capture-tools/`) |
| Grok Build | `adapters/grok-build/tests/fixtures/recorded/1.0.13/` | `adapters/grok-build/tests/fixtures/recorded/CAPTURE.md` |
| Muse Code | `adapters/muse-code/tests/fixtures/recorded/1.4.0/` | `adapters/muse-code/tests/fixtures/recorded/CAPTURE.md` (+ `capture/`) |
| OpenCode | `adapters/opencode/tests/fixtures/recorded/{1.18.32,1.1.65}/` | `adapters/opencode/tests/fixtures/recorded/CAPTURE.md` |
| Copilot CLI | `adapters/copilot-cli/tests/fixtures/recorded/1.0.88/` | `adapters/copilot-cli/tests/fixtures/recorded/CAPTURE.md` |

Regeneration policy, for a new or changed harness version:

1. Install the real harness release and run it against a throwaway project and an isolated home or XDG directories, so the user's own sessions, hooks and servers stay out of the capture. Follow that adapter's `CAPTURE.md` for the exact commands and scenarios.
2. Scrub every captured file with the shared scrubber before committing it:
   `node scripts/harness-fixtures/scrub.mjs <input> <output> --project <capture-cwd> [--replace <from>=<to> ...]`. It rewrites home, user, host and project paths to placeholders, replaces secrets and opaque provider blobs, and fails if a secret rule still matches.
3. Store the result in `tests/fixtures/recorded/<version>/`, keeping earlier version directories while those versions stay tested.
4. Add the exact version to the adapter's `testedVersions` only after its decoder tests pass on the new recordings.

---

## 12. Troubleshooting Harness Connections

If a harness fails to communicate with Resin:

1. **Check service and IPC**:
   ```bash
   resin status
   ```
   The daemon should be `RUNNING (active)` and IPC `CONNECTED`. Confirm the harness URL matches the `--gateway-url` used at install (default `http://127.0.0.1:9400/mcp/sse` only when omitted).

2. **Run doctor**:
   ```bash
   resin doctor
   ```

3. **Re-apply MCP registration and start the user service**:
   ```bash
   resin repair
   ```

The four locked meta-tools (`search_tools`, `get_tool_schema`, `invoke_tool`, `manage_tools`) remain available on the local gateway when the cloud is unreachable.

## Related Documentation

- [Getting Started](getting-started.md)
- [Configuration Reference](configuration.md)
- [Meta-Tools Reference](meta-tools.md)
- [Doctor & Repair Guide](doctor-and-repair.md)
- [Security & Privacy Model](security-and-privacy.md)
