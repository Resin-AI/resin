# Harness Integration Guide

Resin integrates seamlessly with multiple AI developer harnesses via the Model Context Protocol (MCP) and local observation adapters.

---

## Supported Coding Harnesses

| Harness | Tested Versions | Configuration File | Bridge Protocol | Observation Mode | Refresh Mechanism |
|---------|-----------------|-------------------|-----------------|------------------|-------------------|
| **Claude Code CLI** | `0.2.29`, `1.0.0` (`>= 0.1.0`) | `~/.claude.json` or `~/.claude/claude.json` | MCP over SSE / Stdio | Local JSONL Session Tailing | Context Notice Prompt Nudge |
| **Codex CLI** | `0.1.0`, `0.2.0` (`>= 0.1.0`) | `~/.codex/config.toml` | MCP over SSE | Local TOML/JSON Log Tailing | Stable Meta-Tools + Response Catalog Notices |
| **Oh My Pi (OMP)** | `0.1.0`, `0.2.0`, `17.3.8` (`>= 0.1.0`) | `~/.omp/agent/mcp.json` (legacy `~/.omp/config.json`) | MCP over Stdio / SSE / Hub IPC | In-process Event Tailer | Native ListChanged Notification |

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

Codex CLI session logs are tailed from `~/.codex/sessions/`. Resin's observer extracts normalized events (`tool_discovery`, `tool_call`, `tool_result`, `error`) and updates local usage counters.

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
