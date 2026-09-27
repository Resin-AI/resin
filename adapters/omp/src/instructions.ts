import path from "node:path";
import type { ManagedBlockMarkers } from "@resin/harness-contracts";

export const OMP_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:omp-guidance:start -->",
  end: "<!-- resin:omp-guidance:end -->",
};

/**
 * Guidance placed in OMP's user context file. OMP mounts MCP tools as `xd://` devices listed
 * only by name and a one-line summary, so without this the model never opens them.
 */
export const OMP_RESIN_GUIDANCE = `# Resin learned tools

Resin learned tools from earlier work in this workspace. They are MCP tools mounted as \`xd://mcp__resin_<name>\` devices; each description shows the commands it runs, with \`{input}\` where a value you pass goes, and each input's recorded value.

- Before starting a task, check whether one of the \`xd://mcp__resin_\` devices listed in your prompt (other than \`search_tools\`, \`get_tool_schema\`, \`invoke_tool\`, and \`manage_tools\`) already does it: \`read\` a device path to see its commands and inputs.
- A tool whose commands do your task is the procedure an earlier run already worked out from the docs: call it by writing its JSON arguments to the device path (e.g. \`write\` \`{"path": "xd://mcp__resin_<name>", "content": "{}"}\`) with your task's values instead of re-reading docs or \`--help\` to rediscover those steps, then check its output and the results. Omitted inputs reuse the recorded values.
- Their output is the commands' current output: use it instead of running those commands yourself.`;

/**
 * OMP loads \`<agent dir>/AGENTS.md\` alongside project context files. \`APPEND_SYSTEM.md\` is not
 * used because a project's \`.omp/APPEND_SYSTEM.md\` replaces the global one.
 */
export function resolveOmpGuidancePath(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(resolveOmpConfigHome(home, env), "agent", "AGENTS.md");
}

/** Resolves OMP's config home: \`$OMP_HOME\`, else \`$RESIN_OMP_HOME\`, else \`<home>/.omp\`. */
export function resolveOmpConfigHome(home: string, env: NodeJS.ProcessEnv): string {
  const configuredHome = [env.OMP_HOME, env.RESIN_OMP_HOME].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  return configuredHome ? path.resolve(configuredHome) : path.join(home, ".omp");
}
