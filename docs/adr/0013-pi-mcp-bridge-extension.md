# ADR 0013: Deliver Resin tools to Pi through a Resin-owned MCP bridge extension

- **Status**: accepted
- **Date**: 2026-09-26
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Harness capture epic (Resin-AI/resin-dev#8, #11)

## Context and Problem Statement

Pi (`@earendil-works/pi-coding-agent`, tested 0.87.1) has no MCP client. Its installed package
contains no MCP configuration surface; the only `mcp` strings are in the bundled Anthropic SDK.
The model sees Pi's built-in tools (`read`, `bash`, `edit`, `write`, …) plus tools that
extensions register with `pi.registerTool`. Pi auto-loads `.ts`/`.js` files from
`<agent-dir>/extensions/` (`<agent-dir>` = `$PI_CODING_AGENT_DIR` or `~/.pi/agent`) and accepts
plain JSON Schema as tool parameters. Resin needs learned tools to reach Pi's model, including
tools learned while a session runs.

## Considered Options

1. **Resin-owned bridge extension** — one generated file speaks MCP over stdio to `resin mcp` and
   registers each gateway tool as a Pi tool.
2. **Third-party MCP adapter package** installed with `pi install` — adds an external
   dependency Resin does not control, and its tool naming and refresh behavior would change
   under Resin.
3. **Native Pi tools per learned tool** generated into extension files — duplicates the gateway's
   catalog, invocation, and validation logic, and needs file rewrites on every catalog change.

## Decision

Option 1. `resin init` writes `<agent-dir>/extensions/resin.ts` (first line
`// resin-managed: pi-mcp-bridge`) through the harness definition's `owned-file` registration
format. The extension:

- starts `resin mcp` on `session_start` and closes it on `session_shutdown`;
- registers every gateway tool as `mcp__resin__<tool>` (non `[A-Za-z0-9_-]` characters become
  `_`, 64-character limit), passing the tool's input schema through unchanged — except the
  gateway's discovery meta-tools (`search_tools`, `get_tool_schema`, `invoke_tool`,
  `manage_tools`), which it never registers;
- follows `notifications/tools/list_changed`: new tools are registered and activated, dropped
  tools are deactivated, all without restarting Pi;
- maps MCP `isError` results to thrown errors so Pi records `isError: true` tool results;
- only warns when the gateway cannot start, so Pi still runs.

Guidance goes into the agent directory's context file (Pi reads only the first existing of
`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`), not `APPEND_SYSTEM.md`,
because a project's `.pi/APPEND_SYSTEM.md` replaces the agent-directory one. `resin uninstall`
deletes the extension only when it carries the marker, and removes the guidance block.

The meta-tools exist for MCP clients whose native catalog can go stale. The bridge follows
`list_changed`, so every learned tool is already a first-class Pi tool and the meta-tools add
nothing but tokens: Pi sends each tool's definition with every request and also lists its
description in the system prompt. In Pi 0.87.1 conformance they plus the earlier guidance cost
about 1,400 input tokens on every model request (first request 2,511 tokens with Resin and no
learned tools vs 1,118 without Resin), which outweighed the calls a learned tool saved. The
guidance is correspondingly short and no longer names the meta-tools.

## Consequences

- Verified end to end on Pi 0.87.1: a Pi session with the installed extension listed the gateway
  tools and called them through the real gateway; learned tools reach the model as
  `mcp__resin__<tool>` while the discovery meta-tools do not.
- Pi sessions cannot manage tool state (pin, disable, roll back) through the model; that stays
  with the `resin` CLI.
- Transcripts show bridged calls as ordinary Pi tool calls named `mcp__<server>__<tool>`; the Pi
  decoder reports `<server>` as the call's connection.
- Pi runs started with `--no-extensions` / `-ne` do not load the bridge and see no Resin tools.
