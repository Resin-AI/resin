# Invariant Meta-Tools Specification

The Resin MCP Gateway exposes four invariant, stable **Meta-Tools**. Rather than bloating agent prompt context with dozens of tool schemas upfront, harnesses interact with the system dynamically through these four endpoints.

---

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                    AI Coding Harness                        │
│            (Claude Code / Codex CLI / OMP)                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ Model Context Protocol (MCP)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                Resin Gateway (Port 9400)             │
├──────────────────┬──────────────────┬───────────────────────┤
│   search_tools   │ get_tool_schema  │      invoke_tool      │
├──────────────────┴──────────────────┴───────────────────────┤
│                        manage_tools                         │
└──────────────────────────────┬──────────────────────────────┘
                               │ IPC / Sandboxed Worker Pool
                               ▼
┌─────────────────────────────────────────────────────────────┐
│          Evolved Tools Execution Runtime (Deno/Node)        │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. `search_tools`

Search the active and canary tool catalog by keywords, semantic intent, tags, or operational capability.

### Parameters

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query or natural language description of desired capability"
    },
    "category": {
      "type": "string",
      "description": "Optional category filter (e.g. 'git', 'refactor', 'test', 'inspection')"
    },
    "limit": {
      "type": "integer",
      "description": "Maximum number of results to return (default: 5, max: 20)",
      "default": 5
    }
  },
  "required": ["query"]
}
```

### Response Example

```json
{
  "matches": [
    {
      "id": "git_branch_cleaner",
      "version": "1.2.0",
      "name": "Git Branch Cleaner",
      "description": "Safely identifies and prunes merged local branches while preserving active worktrees.",
      "score": 0.94,
      "state": "promoted"
    }
  ],
  "total": 1
}
```

---

## 2. `get_tool_schema`

Retrieve the full JSON Schema parameters, return type specification, and capability envelope requirements for a given tool.

### Parameters

```json
{
  "type": "object",
  "properties": {
    "toolId": {
      "type": "string",
      "description": "Unique identifier of the tool (from search_tools results)"
    },
    "version": {
      "type": "string",
      "description": "Optional specific semver version. If omitted, returns the active promoted/canary version."
    }
  },
  "required": ["toolId"]
}
```

### Response Example

```json
{
  "toolId": "git_branch_cleaner",
  "version": "1.2.0",
  "name": "Git Branch Cleaner",
  "description": "Safely identifies and prunes merged local branches.",
  "parameters": {
    "type": "object",
    "properties": {
      "dryRun": { "type": "boolean", "default": true },
      "targetRemote": { "type": "string", "default": "origin" }
    }
  },
  "capabilities": {
    "command": { "allowedCommands": ["git"] },
    "fs": { "allowWorkspaceRoot": true }
  }
}
```

---

## 3. `invoke_tool`

Execute a registered tool inside an isolated worker sandbox subject to the active capability envelope and policy constraints.

### Parameters

```json
{
  "type": "object",
  "properties": {
    "toolId": {
      "type": "string",
      "description": "Unique identifier of the tool to invoke"
    },
    "version": {
      "type": "string",
      "description": "Optional explicit version target"
    },
    "arguments": {
      "type": "object",
      "description": "Key-value arguments conforming to the tool's parameter schema"
    }
  },
  "required": ["toolId", "arguments"]
}
```

### Response Example

```json
{
  "success": true,
  "executionId": "exec_84f9a01c",
  "toolId": "git_branch_cleaner",
  "version": "1.2.0",
  "durationMs": 42,
  "output": {
    "prunedBranches": ["feat/old-auth", "fix/typo"],
    "skipped": ["main", "develop"]
  }
}
```

---

## 4. `manage_tools`

Perform administrative lifecycle operations on tools: enabling, disabling, pinning versions, inspecting canaries, or triggering instant rollbacks.

### Parameters

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": ["list", "pin", "unpin", "disable", "enable", "rollback", "promote"],
      "description": "Management action to perform"
    },
    "toolId": {
      "type": "string",
      "description": "Target tool ID (required for pin/disable/rollback/promote)"
    },
    "targetVersion": {
      "type": "string",
      "description": "Target version string for pin or rollback"
    },
    "reason": {
      "type": "string",
      "description": "Audit reason for the management action"
    }
  },
  "required": ["action"]
}
```

### Response Example

```json
{
  "action": "rollback",
  "toolId": "git_branch_cleaner",
  "previousVersion": "1.3.0-canary.1",
  "activeVersion": "1.2.0",
  "status": "rolled_back",
  "auditRecordId": "aud_7719ab23"
}
```

---

## Offline Availability

These four tools are locked into the local MCP gateway. They remain callable after `resin logout`, with `--local-only` installs, and when the cloud origin is unreachable, as long as the local daemon is running and IPC is connected (`resin status`).

They are the only tools the gateway guarantees in that degraded mode. Evolved/custom tools may be absent until authenticated catalog sync succeeds again.

Cloud access and refresh tokens are not required to invoke them and are not placed in tool schemas or project lockfiles.

## Related Documentation

- [Getting Started](getting-started.md)
- [Configuration Reference](configuration.md)
- [Harness Integration Guide](harness-guide.md)
- [Security & Privacy](security-and-privacy.md)
