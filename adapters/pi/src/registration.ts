import { existsSync } from "node:fs";
import path from "node:path";
import {
  type ConfigFsBridge,
  type ConfigMutationPlan,
  type ManagedBlockMarkers,
  planConfigMutation,
} from "@resin/harness-contracts";
import {
  PI_RESIN_EXTENSION_MARKER,
  type PiMcpBridgeServer,
  renderPiResinExtension,
} from "./extension.js";
import { PI_HARNESS_ID, resolvePiAgentDir } from "./paths.js";

export const PI_RESIN_SERVER_NAME = "resin";

export interface PlanPiRegistrationOptions {
  targetPath: string;
  command: string;
  args: readonly string[];
  fsBridge: ConfigFsBridge;
}

/**
 * Plans writing the Resin bridge extension. A file at the target that Resin did not write is
 * a user's own extension and is never overwritten.
 */
export async function planPiRegistration(
  options: PlanPiRegistrationOptions,
): Promise<ConfigMutationPlan> {
  const currentContent = await options.fsBridge.readFile(options.targetPath);
  if (currentContent !== null && !currentContent.startsWith(PI_RESIN_EXTENSION_MARKER)) {
    throw new Error(
      `${options.targetPath} exists and was not written by Resin; move it aside so Resin can install its Pi extension there.`,
    );
  }
  const server: PiMcpBridgeServer = {
    name: PI_RESIN_SERVER_NAME,
    command: options.command,
    args: options.args,
  };
  return planConfigMutation({
    harnessId: PI_HARNESS_ID,
    targetPath: options.targetPath,
    currentContent,
    plannedContent: renderPiResinExtension(server),
    description: "Install the Resin MCP bridge extension for Pi",
    // An owned file needs no backup: the previous content is Resin's own rendering.
    backupPath: `${options.targetPath}.resin-backup`,
  });
}

/** Whether the bridge extension at `targetPath` is Resin's and spawns `command mcp`. */
export async function verifyPiRegistration(options: {
  targetPath: string;
  command: string;
  /** Expected arguments; `["mcp"]` by default (`[<resin.mjs>, "mcp"]` under node on Windows). */
  args?: readonly string[];
  fsBridge: ConfigFsBridge;
}): Promise<boolean> {
  const content = await options.fsBridge.readFile(options.targetPath);
  return (
    content !== null &&
    content ===
      renderPiResinExtension({
        name: PI_RESIN_SERVER_NAME,
        command: options.command,
        args: [...(options.args ?? ["mcp"])],
      })
  );
}

/** Deletes Resin-written bridge extensions (and their plan backups) among `paths`. */
export async function removePiRegistration(options: {
  paths: readonly string[];
  fsBridge: ConfigFsBridge;
  dryRun?: boolean;
}): Promise<boolean> {
  let changed = false;
  for (const filePath of new Set(options.paths)) {
    const content = await options.fsBridge.readFile(filePath);
    if (content === null || !content.startsWith(PI_RESIN_EXTENSION_MARKER)) continue;
    changed = true;
    if (options.dryRun) continue;
    await options.fsBridge.unlink(filePath);
    await options.fsBridge.unlink(`${filePath}.resin-backup`);
  }
  return changed;
}

export const PI_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:pi-guidance:start -->",
  end: "<!-- resin:pi-guidance:end -->",
};

/**
 * Guidance placed in Pi's global context file. `resin mcp` lists only Resin's meta tools, so the
 * bridge extension registers just those; learned tools are found by searching.
 */
export const PI_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools from earlier work in this workspace. They are not in your tool list: find them with \`mcp__resin__search_tools\`. Its description says how many learned tools this workspace has and names the commands they run.

- If it says there are none, do the task directly: there is nothing to search for, and tools Resin learns from this work reach later sessions.
- Otherwise, before running one of those commands or another multi-step job by hand, call \`mcp__resin__search_tools\` with \`{"query": "<the job in a few words, e.g. the commands or scripts you are about to run>"}\`.
- A result that does your task is the procedure an earlier run already worked out: its description lists the recorded steps and its \`inputSchema\` the inputs, so run it directly with your task's values through \`mcp__resin__invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, instead of re-reading docs or \`--help\` to rediscover those steps. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.
- If its output does not answer your question (it keeps a value fixed that your task needs changed, such as a period, granularity or filter), do the rest yourself with your usual tools.`;

/** Context-file names Pi reads from the agent directory; the first existing one wins. */
const PI_CONTEXT_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
];

/**
 * Pi loads exactly one context file from its agent directory (the first that exists, see
 * `loadContextFileFromDir`), so guidance goes into that file, else a new `AGENTS.md`.
 * `APPEND_SYSTEM.md` is not used because a project's `.pi/APPEND_SYSTEM.md` replaces it.
 */
export function resolvePiGuidancePath(home: string, env: NodeJS.ProcessEnv): string {
  const agentDir = resolvePiAgentDir(home, env);
  const existing = PI_CONTEXT_FILE_NAMES.map((name) => path.join(agentDir, name)).find((file) =>
    existsSync(file),
  );
  return existing ?? path.join(agentDir, "AGENTS.md");
}
