// Cursor CLI (cursor-agent) harness adapter
import path from "node:path";
import {
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type HarnessDefinition,
  type HarnessGuidanceSurface,
} from "@resin/harness-contracts";
import { CursorHarnessAdapter } from "./adapter.js";
import { planCursorMcpConfig } from "./config-planner.js";
import { CursorRecordDecoder } from "./decoder.js";
import { probeCursorInstallation } from "./discovery.js";
import { cursorCaptureHooksExtension } from "./hooks.js";
import {
  CURSOR_HARNESS_ID,
  CURSOR_TESTED_VERSIONS,
  resolveCursorHome,
  resolveCursorMcpConfigPath,
} from "./paths.js";

export * from "./adapter.js";
export * from "./config-planner.js";
export * from "./decoder.js";
export * from "./discovery.js";
export * from "./hook-records.js";
export * from "./hooks.js";
export * from "./paths.js";
export * from "./source.js";

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

Resin learned tools from earlier work in your projects. They are MCP tools on the \`resin\` server; each description lists the commands it runs, with \`{input}\` where a value you pass goes, and each input's recorded value.

- Before working out a multi-step procedure yourself, check the \`resin\` tools. A tool whose commands do your task is the procedure an earlier run already worked out: call it with your task's values instead of rediscovering the steps. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.`,
};

export const cursorHarness: HarnessDefinition = {
  id: CURSOR_HARNESS_ID,
  displayName: "Cursor CLI",
  shortName: "Cursor",
  adapterPackage: "@resin/adapter-cursor-cli",
  testedVersions: CURSOR_TESTED_VERSIONS,
  knownLimits: [
    "Capture requires Resin's hooks in ~/.cursor/hooks.json (installed by `resin init`); sessions from before installation, or run while hooks were removed, are reported as uncaptured, not decoded.",
    "Cursor Cloud Agents that run on Cursor's machines leave no local record and cannot be captured; cursor-agent 2026.09.26 removed the CLI's --cloud/--background flags. Self-hosted `cursor-agent worker` sessions are captured and flagged isBackgroundAgent.",
    "Hook payloads carry no timestamps; event times are when Resin's hook received them.",
    "Per-generation usage comes from afterAgentResponse (input, output, cache-read tokens); totals are not reported by cursor-agent and are not synthesized.",
    "Tool calls are recorded at completion (postToolUse/postToolUseFailure); calls still running when a session is killed are not recorded.",
    "Whether cursor-agent applies user rules from ~/.cursor/rules and reacts to MCP list_changed is unverified; new Resin tools are assumed to reach the next session.",
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
  createAdapter: () => new CursorHarnessAdapter(),
  createDecoder: () => new CursorRecordDecoder(),
  sessionCapture: "file-activity",
};
