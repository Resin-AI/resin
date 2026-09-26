import path from "node:path";
import type { ConfigFsBridge } from "@resin/harness-contracts";

export const CODEX_GUIDANCE_START_MARKER = "<!-- resin:codex-guidance:start -->";
export const CODEX_GUIDANCE_END_MARKER = "<!-- resin:codex-guidance:end -->";

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

export type CodexGuidanceAction = "created" | "updated" | "unchanged" | "removed";

export interface CodexGuidanceResult {
  readonly path: string;
  readonly action: CodexGuidanceAction;
}

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

/** Splits content around the managed block; returns null when no complete block exists. */
function splitBlock(content: string): { before: string; after: string } | null {
  const start = content.indexOf(CODEX_GUIDANCE_START_MARKER);
  if (start === -1) {
    return null;
  }
  const end = content.indexOf(CODEX_GUIDANCE_END_MARKER, start);
  if (end === -1) {
    return null;
  }
  return {
    before: content.slice(0, start),
    after: content.slice(end + CODEX_GUIDANCE_END_MARKER.length),
  };
}

/**
 * Installs or removes the Resin guidance block in Codex's AGENTS.md. Content
 * outside the markers is preserved verbatim. With `dryRun`, reports the action
 * without writing.
 */
export async function applyCodexGuidance(
  filePath: string,
  fs: ConfigFsBridge,
  options: { install: boolean; dryRun?: boolean },
): Promise<CodexGuidanceResult> {
  const current = await fs.readFile(filePath);
  const parts = current === null ? null : splitBlock(current);

  if (!options.install) {
    if (current === null || parts === null) {
      return { path: filePath, action: "unchanged" };
    }
    const before = parts.before.replace(/\n*$/, "");
    const after = parts.after.replace(/^\n*/, "");
    const remaining = before && after ? `${before}\n\n${after}` : `${before}${after}`;
    if (!options.dryRun) {
      if (remaining.trim().length === 0) {
        await fs.unlink(filePath);
      } else {
        await fs.writeFile(filePath, remaining.endsWith("\n") ? remaining : `${remaining}\n`);
      }
    }
    return { path: filePath, action: "removed" };
  }

  const block = `${CODEX_GUIDANCE_START_MARKER}\n${CODEX_RESIN_GUIDANCE.trimEnd()}\n${CODEX_GUIDANCE_END_MARKER}`;
  let next: string;
  if (current === null || current.trim().length === 0) {
    next = `${block}\n`;
  } else if (parts === null) {
    next = `${current.replace(/\n*$/, "")}\n\n${block}\n`;
  } else {
    next = `${parts.before}${block}${parts.after}`;
  }
  if (next === current) {
    return { path: filePath, action: "unchanged" };
  }
  if (!options.dryRun) {
    await fs.mkdirp(path.dirname(filePath));
    await fs.writeFile(filePath, next);
  }
  return { path: filePath, action: current === null ? "created" : "updated" };
}
