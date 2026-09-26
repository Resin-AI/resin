# Harness Integration Guide

Resin integrates seamlessly with multiple AI developer harnesses via the Model Context Protocol (MCP) and local observation adapters.

---

## Supported Coding Harnesses

| Harness | Tested Versions | Configuration File | Bridge Protocol | Observation Mode | Refresh Mechanism |
|---------|-----------------|-------------------|-----------------|------------------|-------------------|
| **Claude Code CLI** | `2.1.283` | `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set) | MCP over Stdio | Local JSONL Session Tailing (incl. subagents) | Native ListChanged Notification |
| **Codex CLI** | `0.156.1`, `0.157.1` | `$CODEX_HOME/config.toml` (`~/.codex/config.toml`) | MCP over Stdio | Native JSONL Rollout Tailing | Stable Meta-Tools + Response Catalog Notices |
| **Oh My Pi (OMP)** | `18.3.2` (other versions run and are reported as untested) | `~/.omp/agent/mcp.json` (`$OMP_HOME/agent/mcp.json`; legacy `~/.omp/config.json`) | MCP over Stdio | JSONL Session Tailing (main and subagent transcripts) | Native ListChanged Notification |
| **Cursor CLI** (`cursor-agent`) | none yet (targets `2026.09.26-dd393fe`; reported `untested`) | `~/.cursor/mcp.json`, `~/.cursor/hooks.json`, `~/.cursor/rules/resin.mdc` | MCP over Stdio | Hook spool tailing (`~/.resin/capture/cursor-cli/`) | Next session |

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

Only the version listed above is qualified with recorded sessions; `resin status` reports other versions as untested.

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

Resin keeps its catalog guidance in a managed block of `~/.omp/agent/APPEND_SYSTEM.md`. `resin uninstall` removes the entry from the active config and from the legacy `~/.omp/config.json`.

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

## Cursor CLI Integration

### Automated Registration

`resin init` makes three idempotent changes, all removed by `resin uninstall`:

- Adds `mcpServers.resin` (`{ "command": "<resin shim>", "args": ["mcp"] }`) to `~/.cursor/mcp.json`. cursor-agent reads this user-level file for every project; other servers are kept.
- Installs `~/.resin/hooks/cursor-capture.mjs` and registers it in `~/.cursor/hooks.json` for the observe-only events `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `afterAgentThought`, `afterAgentResponse`, `postToolUse`, `postToolUseFailure`, `afterFileEdit`, `preCompact`, `subagentStart`, `subagentStop` and `stop`. The script prints nothing and always exits 0. cursor-agent only blocks a step when a hook explicitly answers `continue: false` or denies permission, so the hook changes nothing about what Cursor allows. Resin never registers the permission hooks (`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`). Other hooks in the file are kept.
- Writes the user rule `~/.cursor/rules/resin.mdc` (`alwaysApply: true`), which describes Resin's learned tools.

cursor-agent reads these paths from `os.homedir()/.cursor`. `CURSOR_CONFIG_DIR` only moves `cli-config.json`.

### Session Observation

Resin captures sessions through hooks, not transcript files. cursor-agent writes `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, with subagents under `<id>/subagents/`. Those files keep only message text and tool-call arguments: they have no tool results, call ids, token usage, timestamps or cwd, and the writer rewrites them after summarization. Hook payloads carry all of these fields. The capture script appends each payload to `~/.resin/capture/cursor-cli/<conversation_id>.jsonl`, adding `resin_received_at` and dropping `user_email`. Each session is bound to the `workspace_roots` its hooks recorded. Subagents are linked to their parent through `subagentStart`.

Resin decodes:

- prompts and responses;
- per-generation usage (input, output and cache-read tokens);
- tool calls and their results, with `tool_use_id`;
- shell commands and file edits (old/new strings);
- compaction and subagents;
- aborted or failed turns.

Each payload is checked against the field contract pinned in `adapters/cursor-cli/src/hook-records.ts`. An unknown hook event or a changed field is recorded as drift and never decoded by guesswork.

### Known Limits

- Sessions from before `resin init`, or from while the hooks were missing, are listed as uncaptured (`listUncapturedSessions`, reason `no-hook-capture`) and are not decoded.
- Cloud Agents that run on Cursor's machines leave nothing on this device and cannot be captured. cursor-agent 2026.09.26 removed the CLI's `--cloud`/`--background` flags. Self-hosted `cursor-agent worker` sessions are captured and flagged `isBackgroundAgent`.
- Event times are the moments the hook ran, because payloads carry no timestamps. Tool calls are recorded when they complete.
- Two things are unverified: whether cursor-agent reacts to MCP `list_changed`, and whether it applies user rules from `~/.cursor/rules`. For now, new tools are assumed to reach the next session.

---

## 4. Real-Time Tool Catalog Refresh

### Native Dynamic Catalogs

Claude Code and Oh My Pi retain their native dynamic tool catalogs. For clients that support catalog refresh, the Gateway sends `notifications/tools/list_changed`; the harness can invalidate its tool cache and request the updated catalog with `tools/list`. Newly available tools can also be discovered through `search_tools`.

Codex instead uses the stable gateway described above. Its four advertised tools do not change when the underlying catalog changes, so newly available tools do not depend on native tool-list refresh.

### Catalog Notices in Tool Responses

Each connection starts with a baseline of its visible catalog. When that catalog changes, Resin appends a brief notice to the next successful Resin tool response, once for the pending changes. Changes coalesce between responses rather than generating repeated messages:

- New and updated tools include their names and short descriptions, scoped to what the connection can see.
- Removed tools produce a generic removal notice rather than exposing removed tool details.
- Notices are bounded and contain no tool arguments, results, or secrets. Use `search_tools` and `get_tool_schema` for current discovery and input details.

These notices complement native catalog refresh; they are not unsolicited messages to the model. The agent must first interact with Resin to receive a notice. Resin does not guarantee that an agent will search for tools by default or use Resin on every task. To start discovery explicitly, ask the agent to search Resin for a tool relevant to the task.

---

## 5. Troubleshooting Harness Connections

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
