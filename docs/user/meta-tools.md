# Invariant Meta-Tools Specification

The Resin MCP Gateway exposes four invariant, stable **Meta-Tools** for finding, inspecting, running and managing tools. Every tool a harness lists is sent with every model request, so `resin mcp` lists only what the current repository needs: its own learned tools (those scoped to the repository; at most 8, and only while the whole listing, instructions included, stays within about 1,500 estimated tokens), `invoke_tool`, and `search_tools` only when more of the repository's learned tools exist than fit. With none, it lists `invoke_tool` alone, with a one-line instruction. `get_tool_schema`, `manage_tools` and learned tools not scoped to a repository are not listed; they answer by name, and `search_tools` finds unscoped tools. `resin mcp --full-catalog` lists every tool, learned tools included, next to all four; `--search-listing` is accepted for older registrations and changes nothing.

On a fresh install, a connection's first tool list waits up to 5 seconds for the workspace's learned tools to sync if none are available yet, so `search_tools` finds them from the start; later lists and already-synced installs never wait.

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

For a learned tool that replays recorded programs, the description in `search_tools` and `get_tool_schema` results ends with the program each step runs. Each program is shown up to 600 characters and shortened further (down to 100) until all steps fit about 2,000 characters; steps that still do not fit are counted (`[N more steps not shown]`), not shown. Queries match that shown text, but a word that appears only as a recorded argument value (an option's value or the right side of `key=value`) cannot by itself make the tool match. It is shown only to the workspace that recorded the tool and is never uploaded, but it does reach your model provider and your harness transcript, so it shows only what the tool's plan carries: a program's redacted text (secrets appear as `[REDACTED_<TYPE>:<tag>]`), `{name}` where a parameter goes, and `<private:N>` for each value the plan keeps private, such as a program recorded wholly as a private value or a harness tool's argument. Invoking the tool still runs the original program with every private value resolved locally. As a second safeguard, any text these meta-tools return (descriptions, input docs, `manage_tools` listings) has each private value of the tool's plan that is 4 or more characters long replaced with `<private>`. A short value made only of ASCII letters and `_` (such as a recorded `play` or `server` argument) is replaced only where it stands as a whole word, so tool and input names that contain it stay intact.

A step whose recorded program piped its output through a display filter (`tail`, `head`, `grep`) is followed by a line saying what an invocation returns. A version-1 step runs without the final filter, so the full output comes back and the command's own exit status decides success. A version-2 step runs as recorded; its output adds the error, warning and failure lines the filters hid, the unfiltered output is kept in files under the Resin home, and a failing command fails the call with each command's exit status. A command after `&&` is named with the one it runs only after, unless that one's output was filtered (then the filter's status decides).

`search_tools` lists workspace tools; Resin's own meta-tools appear only with `"scope": "system"`. Every match, including each tool listed under another's `similar` (tools running the same commands), includes the tool's `inputSchema`, so a caller invokes it with `invoke_tool` and `{name, parameters}` directly, without a `get_tool_schema` call; the response's `note` says so. A tool the cloud measured to cost more than doing the job directly is marked `"recommended": false`: a query returns it only when the query is its exact name or a leading part of it, an empty query still lists it, and `invoke_tool` still runs it by name.

A query matches whole words (`tests` finds `test`, but `test` does not find `latest`). Words that are rare among the listed tools count most, so searching with the command you are about to run (`gh pr checks --watch`, `pnpm test`) ranks the tools that run it first; words nearly every tool contains, such as the shared learned-tool text, do not make a tool match. A word in a tool's name counts more than one in its tags or description, and an exact or leading tool name ranks first. Tools that match much less of the query than the best result are left out, so `total` counts real matches.

A learned tool may take optional parameters for values its recorded programs ran with, such as a file path, a flag's value, or a word several steps share (the project in `./release test alpha` and `./release build alpha`). Omit a parameter to run the recorded value; pass one to substitute it at every position it held. Parameter names come from the flag (`--month` → `month`) or the value's shape (`path`, `number`, `text`). The tool's description on this machine lists each parameter's recorded value as the plan carries it; a value the plan keeps private is listed as its `<private:N>` placeholder. `get_tool_schema` also sets each such parameter's JSON Schema `default` to its recorded value, typed by the parameter's `type`, but only when the value is not private, not a date (dated inputs are required) and the same at every position.

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

When a tool's result is text, `invoke_tool` returns the text itself rather than an escaped JSON string. A learned tool that runs several independent commands returns every command's output in recorded order, one section per step (`--- step 1/3 ---`).

A learned tool with at least one text input also accepts `for_each`, both as a native tool argument and inside `invoke_tool`'s `arguments`: `{"for_each": {"<input>": ["v1", "v2"]}}` (one input, 2–20 text values). The whole tool runs once per value, in order, through the normal call path (policy checks, validation and one invocation record per run), and stops at the first failing run. The result has one `[<input>=<value>]` section per run and names the failed value and the values that were not run. A malformed `for_each`, or one that conflicts with a value given directly for the same input, is refused before anything runs.

A step that recordings of the same job show is not always needed can be optional: it is skipped when its boolean input (default `true`) is `false`, later steps still run, and the combined output shows `--- step N/M skipped ---` for it. A check inside a recorded `&&` chain (such as `cargo clippy` in `cargo fmt --check && cargo clippy && cargo test`) can be optional in the same way, but only when it changes nothing and everything after it in the chain is also a check. Turning it off runs the rest of the chain as written.

An option's value can be an optional input (`--subject {subject}` in `gh pr merge 18 --squash --subject …`). If you omit it, the option is left out of the command, so the command's own default applies, for example gh's default squash subject. The recorded value is not reused. The input's description says so.

If a call leaves out a required input, nothing runs. The refusal names each missing input with its description and gives one complete call to repeat, with a placeholder for each missing value. The call is shown both as an OMP `write … to xd://mcp__resin_invoke_tool` and as plain `invoke_tool` arguments. `_meta.resinMissingInputs` lists the missing inputs.

When a step fails, the steps after it do not run, since a later step such as a merge may depend on it. The exception is a plan whose recording itself carried on past that failure. The failure names the step and its error, which includes what the step printed. It then lists the output of every step that completed before it. A completed output longer than 2,000 characters (8,000 across all steps) is cut to its last part, and the full output is saved to a file named in the report.

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
