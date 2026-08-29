# Harness Integration Guide

Resin integrates seamlessly with multiple AI developer harnesses via the Model Context Protocol (MCP) and local observation adapters.

---

## Supported Coding Harnesses

| Harness | Tested Versions | Configuration File | Bridge Protocol | Observation Mode | Refresh Mechanism |
|---------|-----------------|-------------------|-----------------|------------------|-------------------|
| **Claude Code CLI** | `0.2.29`, `1.0.0` (`>= 0.1.0`) | `~/.claude.json` or `~/.claude/claude.json` | MCP over SSE / Stdio | Local JSONL Session Tailing | Context Notice Prompt Nudge |
| **Codex CLI** | `0.1.0`, `0.2.0` (`>= 0.1.0`) | `~/.codex/config.toml` | MCP over SSE | Local TOML/JSON Log Tailing | Session Restart Required |
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

When a new tool is synthesized or promoted, agents do not need to restart their sessions:

1. **SSE Push Notification**: The Gateway broadcasts `notifications/tools/list_changed` across all open SSE client streams.
2. **Dynamic Invalidation**: The harness invalidates its local tool cache and invokes `tools/list` to fetch the updated catalog.
3. **Instant Availability**: Newly promoted tools can be discovered immediately via `search_tools`.

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
