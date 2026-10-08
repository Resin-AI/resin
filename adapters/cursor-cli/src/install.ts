import path from "node:path";
import {
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type HarnessGuidanceSurface,
  type HarnessInstallDefinition,
} from "@resin/harness-contracts";
import { planCursorMcpConfig } from "./config-planner.js";
import { probeCursorInstallation } from "./discovery.js";
import { cursorCaptureHooksExtension } from "./hooks.js";
import {
  CURSOR_HARNESS_ID,
  CURSOR_TESTED_VERSIONS,
  resolveCursorHome,
  resolveCursorMcpConfigPath,
} from "./paths.js";

/**
 * Guidance lives in a Resin-owned user rule, `~/.cursor/rules/resin.mdc`. A `.mdc` rule needs
 * its frontmatter on the first line, so the start marker carries it and the whole file is the
 * managed block (removal deletes the file).
 */
export const cursorGuidance: HarnessGuidanceSurface = {
  resolvePath: (home) => path.join(resolveCursorHome(home), "rules", "resin.mdc"),
  markers: {
    start:
      "---\ndescription: Resin learned tools\nalwaysApply: true\n---\n<!-- resin:cursor-guidance:start -->",
    end: "<!-- resin:cursor-guidance:end -->",
  },
  body: `# Resin learned tools

Resin may have learned tools from earlier work in your projects. They are not listed: the \`resin\` server lists only \`search_tools\`, \`get_tool_schema\`, \`invoke_tool\` and \`manage_tools\`. The \`search_tools\` description says how many learned tools this workspace has and names the commands they run.

- If it says there are none, do the task directly: there is nothing to search for, and tools Resin learns from this work reach later sessions.
- Otherwise, before running one of those commands or another multi-step job by hand, call the \`resin\` server's \`search_tools\` with \`{"query": "<the job or command line you are about to run>"}\`, unless an earlier search already found a tool for it: invoke that one directly, and search again only if invoke_tool rejects it.
- A result that does your task is the procedure an earlier run already worked out: its description lists the recorded steps and its \`inputSchema\` the inputs, so run it directly with your task's values through \`invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, instead of re-reading docs or \`--help\` to rediscover those steps. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.
- If its output does not answer your question (it keeps a value fixed that your task needs changed, such as a period, granularity or filter), do the rest yourself with your usual tools.`,
};

export const cursorInstallHarness: HarnessInstallDefinition = {
  id: CURSOR_HARNESS_ID,
  displayName: "Cursor CLI",
  shortName: "Cursor",
  adapterPackage: "@resin/adapter-cursor-cli",
  testedVersions: CURSOR_TESTED_VERSIONS,
  knownLimits: [
    "Capture requires Resin's hooks in ~/.cursor/hooks.json (installed by `resin init`); sessions from before installation, or run while hooks were removed, are reported as uncaptured, not decoded.",
    "Cursor Cloud Agents that run on Cursor's machines leave no local record and cannot be captured; cursor-agent 2026.09.26 removed the CLI's --cloud/--background flags. Self-hosted `cursor-agent worker` sessions are captured and flagged isBackgroundAgent.",
    "Hook payloads carry no timestamps; event times are when Resin's hook received them.",
    "Token usage is per turn, from the `stop` hook (input, output, cache-read tokens). Headless `cursor-agent -p` runs fire no beforeSubmitPrompt, afterAgentResponse or stop hooks (verified with 2026.09.26), so their prompt, final answer and usage are not captured; their tool calls, edits and session end are.",
    "Tool calls are recorded at completion (postToolUse/postToolUseFailure); calls still running when a session is aborted are not recorded (the session ends with reason `error`). One model edit is reported as a Read and a Write sharing a tool_use_id, so call ids are `<tool_name>:<tool_use_id>`.",
    "afterFileEdit carries no tool_use_id and fires before its Write's postToolUse, so file edits are not linked to their call (no producedByCallId).",
    "Task subagents run as separate conversations and are captured as their own sessions. In the recorded 2026.09.26 runs cursor-agent fired no subagentStart/subagentStop hook and no postToolUse for the Task call, so those subagent sessions carry no parent link and are not marked as agents; when a subagentStart/subagentStop hook does arrive (`parent_conversation_id`, `child_conversation_id`, `subagent_id`, `subagent_type`), the child is linked as an agent session under its parent. Each conversation's tool calls and usage are counted in that conversation only.",
    "cursor-agent does not apply an MCP server's tools/list_changed mid-session (a tool added after list_changed stayed unavailable for the rest of the session); new Resin tools reach the next session.",
    "cursor-agent has no user-level rules directory: it loads `.cursor/rules` from the workspace and each of its ancestors (verified with 2026.09.26), so the guidance rule in ~/.cursor/rules reaches projects under your home directory only. Elsewhere agents get Resin's MCP server instructions but not this guidance.",
  ],
  probeInstallation: (context) =>
    probeCursorInstallation({
      home: context.home,
      env: context.env,
      configPath: context.targetPath,
    }),
  mcpConfig: {
    resolvePath: (home) => resolveCursorMcpConfigPath(home),
    uninstallPaths: (home) => [resolveCursorMcpConfigPath(home)],
    format: "json",
    serverKey: CANONICAL_RESIN_MCP_SERVER_KEY,
    jsonContainerKeys: ["mcpServers"],
    transports: ["stdio", "http", "sse"],
    planRegistration: (context) => planCursorMcpConfig(context),
  },
  guidance: cursorGuidance,
  installExtensions: [cursorCaptureHooksExtension],
};
