# Harness Integration Guide

Resin integrates seamlessly with multiple AI developer harnesses via the Model Context Protocol (MCP) and local observation adapters.

---

## Supported Coding Harnesses

| Harness | Tested Versions | Configuration File | Bridge Protocol | Observation Mode | Refresh Mechanism |
|---------|-----------------|-------------------|-----------------|------------------|-------------------|
| **Claude Code CLI** | `2.1.283` | `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set) | MCP over Stdio | Local JSONL Session Tailing (incl. subagents) | Native ListChanged Notification |
| **Codex CLI** | `0.156.1`, `0.157.1` | `$CODEX_HOME/config.toml` (`~/.codex/config.toml`) | MCP over Stdio | Native JSONL Rollout Tailing | Stable Meta-Tools + Response Catalog Notices |
| **Oh My Pi (OMP)** | `0.1.0`, `0.2.0`, `17.3.8` (`>= 0.1.0`) | `~/.omp/agent/mcp.json` (legacy `~/.omp/config.json`) | MCP over Stdio / SSE / Hub IPC | In-process Event Tailer | Native ListChanged Notification |

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

### Automated Registration

For OMP environments, Resin updates `~/.omp/agent/mcp.json`:

```json
{
  "$schema": "https://json.schemastore.org/mcp-server-config.json",
  "mcpServers": {
    "resin": {
      "type": "stdio",
      "command": "resin-gateway",
      "args": ["--stdio"],
      "env": {}
    }
  }
}
```

### In-Process Hub Integration

OMP sessions connect directly to the Gateway's SSE endpoint and receive real-time tool catalog updates. When a new tool completes its canary evaluation and is promoted, an SSE `notifications/tools/list_changed` message is dispatched immediately to active OMP agents.

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
