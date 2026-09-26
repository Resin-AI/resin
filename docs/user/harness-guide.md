# Harness Integration Guide

Resin integrates seamlessly with multiple AI developer harnesses via the Model Context Protocol (MCP) and local observation adapters.

---

## Supported Coding Harnesses

| Harness | Tested Versions | Configuration File | Bridge Protocol | Observation Mode | Refresh Mechanism |
|---------|-----------------|-------------------|-----------------|------------------|-------------------|
| **Claude Code CLI** | `0.2.29`, `1.0.0` (`>= 0.1.0`) | `~/.claude.json` or `~/.claude/claude.json` | MCP over SSE / Stdio | Local JSONL Session Tailing | Context Notice Prompt Nudge |
| **Codex CLI** | `0.1.0`, `0.2.0` (`>= 0.1.0`) | `~/.codex/config.toml` | MCP over SSE | Native JSONL Rollout Tailing | Stable Meta-Tools + Response Catalog Notices |
| **Oh My Pi (OMP)** | `18.3.2` (other versions run and are reported as untested) | `~/.omp/agent/mcp.json` (`$OMP_HOME/agent/mcp.json`; legacy `~/.omp/config.json`) | MCP over Stdio | JSONL Session Tailing (main and subagent transcripts) | Native ListChanged Notification |

`npx resin init` writes the explicitly supplied `--gateway-url` into each configured harness. When that flag is omitted, the URL is `http://127.0.0.1:9400/mcp/sse`.

## 1. Claude Code CLI Integration

### Automated Registration

When you run `npx resin init`, Resin automatically patches `~/.claude.json` or `~/.claude/claude.json` with the gateway URL from `--gateway-url` (default `http://127.0.0.1:9400/mcp/sse` only when omitted):

```json
{
  "mcpServers": {
    "resin": {
      "type": "sse",
      "url": "http://127.0.0.1:9400/mcp/sse"
    }
  }
}
```

### Manual Verification

To verify that Claude Code recognizes Resin:

```bash
claude mcp list
```

Expected output:

```text
✓ resin (SSE: http://127.0.0.1:9400/mcp/sse) - 4 tools enabled
```

### Session Observation

Resin monitors Claude Code sessions locally by following active session files in `~/.claude/projects/`. Only normalized structural telemetry (tool names, execution status, latencies) is processed; raw prompt context and assistant reasoning are strictly kept on localhost.

---

## 2. Codex CLI Integration

### Automated Registration

Resin automatically registers the gateway MCP server in `~/.codex/config.toml`:

```toml
# Resin Gateway Registration
[mcp_servers.resin]
url = "http://127.0.0.1:9400/mcp/sse"
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

### Session Observation

Codex CLI JSONL rollouts are tailed from `~/.codex/sessions/`. Native session metadata, turn context, messages, function calls and outputs, provider usage, and terminal events are normalized locally. The recorded `session_meta.cwd` binds a rollout to its project; a missing or invalid working directory remains unbound rather than being guessed from the Codex home directory.

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
