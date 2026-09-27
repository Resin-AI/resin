import path from "node:path";
import type { ManagedBlockMarkers } from "@resin/harness-contracts";

export const CODEX_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:codex-guidance:start -->",
  end: "<!-- resin:codex-guidance:end -->",
};

/**
 * Guidance for Codex's global instructions. Codex code mode hides MCP tools from
 * the model unless its instructions mention them.
 */
export const CODEX_RESIN_GUIDANCE = `# Resin learned tools

Resin learned tools from earlier work in this workspace. They are nested tools named \`mcp__resin__<name>\`; each description shows the commands it runs, with \`{input}\` where a value you pass goes, and each input's recorded value.

- In your first \`exec\` call, print them next to your own first look at the task: \`text(ALL_TOOLS.filter(t => t.name.startsWith("mcp__resin__") && !/__(search_tools|get_tool_schema|invoke_tool|manage_tools)$/.test(t.name)).map(t => t.name + "\\n" + t.description).join("\\n\\n"))\`.
- A tool whose commands do your task is the procedure an earlier run already worked out from the docs: call it next with your task's values instead of re-reading docs or \`--help\` to rediscover those steps, then check its output and the results. Several at once: \`const [a, b] = await Promise.all([tools.mcp__resin__x({}), tools.mcp__resin__y({})]); text(a.content[0].text); text(b.content[0].text);\`. Omitted inputs reuse the recorded values.
- Their output is the commands' current output: use it instead of running those commands yourself.
`;

/** Resolves Codex's home directory: `$CODEX_HOME`, else `<home>/.codex`. */
export function resolveCodexHome(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  const codexHome = env.CODEX_HOME;
  return codexHome && codexHome.trim().length > 0
    ? path.resolve(codexHome)
    : path.join(customHome, ".codex");
}

/** Resolves Codex's global instructions file, `$CODEX_HOME/AGENTS.md`. */
export function resolveCodexAgentsPath(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveCodexHome(customHome, env), "AGENTS.md");
}
