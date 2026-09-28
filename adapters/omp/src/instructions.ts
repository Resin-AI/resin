import path from "node:path";
import {
  type ManagedBlockMarkers,
  applyManagedBlock,
  defaultFsBridge,
  readHostPathEnv,
} from "@resin/harness-contracts";
import { ompMcpToolName } from "./device-surface.js";
import { resolveOmpHome } from "./discovery.js";

export const DEFAULT_APPEND_SYSTEM_FILENAME = path.join("agent", "APPEND_SYSTEM.md");

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

- In your first step, next to your own first look at the task, \`read\` the \`xd://mcp__resin_\` devices listed in your prompt (other than \`search_tools\`, \`get_tool_schema\`, \`invoke_tool\` and \`manage_tools\`) to see their commands and inputs.
- A tool whose commands do your task is the procedure an earlier run already worked out from the docs: call it next with your task's values instead of re-reading docs or \`--help\` to rediscover those steps, then check its output and the results. Call one by writing its JSON arguments to the device path (e.g. \`write\` \`{"path": "xd://mcp__resin_<name>", "content": "{}"}\`); when several apply, call them together. Omitted inputs reuse the recorded values.
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
  return (
    readHostPathEnv(env, "OMP_HOME") ??
    readHostPathEnv(env, "RESIN_OMP_HOME") ??
    path.join(home, ".omp")
  );
}

const OMP_CATALOG_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:catalog:start -->",
  end: "<!-- resin:catalog:end -->",
};

/**
 * Renders the per-tool invocation convention for Oh My Pi sessions.
 * OMP surfaces MCP tools as `xd://<registered tool name>` paths: writing JSON
 * args to the path invokes the tool; reading it returns its documentation.
 */
export function renderOmpInvocationSnippet(toolName: string, serverName: string): string {
  const path = `xd://${ompMcpToolName(serverName, toolName)}`;
  return [
    `- **Invoke**: write the JSON arguments to \`${path}\` (e.g. \`write\` \`{"path": "${path}", "content": "{}"}\` when the tool takes no inputs).`,
    `- **Docs**: \`read\` \`${path}\` returns the tool's documentation.`,
  ].join("\n");
}

/**
 * Builds the managed instructions block appended to OMP's system prompt.
 * `toolNames` augments the catalog markdown with explicit per-tool invocation
 * snippets; when omitted the markdown is embedded as-is.
 */
export function buildOmpCatalogInstructionsBlock(options: {
  markdown: string;
  toolNames?: string[];
  serverName?: string;
}): string {
  return `${OMP_CATALOG_MARKERS.start}\n${renderOmpCatalogInstructionsBody(options)}\n${OMP_CATALOG_MARKERS.end}`;
}

function renderOmpCatalogInstructionsBody(options: {
  markdown: string;
  toolNames?: string[];
  serverName?: string;
}): string {
  const serverName = options.serverName ?? "resin";
  const lines: string[] = [
    "",
    options.markdown.trim(),
    "",
    "These tools are exposed over MCP. Invoke them through the `xd://` tool-device surface rather than re-running the underlying shell commands manually.",
  ];

  for (const toolName of options.toolNames ?? []) {
    lines.push("", `#### Invocation: \`${toolName}\``);
    lines.push(renderOmpInvocationSnippet(toolName, serverName));
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Extracts evolved tool names from rendered catalog instructions markdown
 * (each tool appears as a `### \`name\`` heading).
 */
export function parseCatalogInstructionToolNames(markdown: string): string[] {
  const names: string[] = [];
  for (const match of markdown.matchAll(/^### `([^`]+)`$/gm)) {
    names.push(match[1]!);
  }
  return names;
}

export interface SyncOmpCatalogInstructionsOptions {
  /** Base URL of the resin cloud backend, e.g. http://127.0.0.1:8080 */
  cloudUrl: string;
  workspaceId: string;
  accountId?: string;
  /** Extra auth headers merged over the dev defaults. */
  headers?: Record<string, string>;
  serverName?: string;
  ompHome?: string;
  appendSystemPath?: string;
  fetchFn?: typeof fetch;
}

/**
 * Fetches the workspace catalog instructions from the cloud backend and
 * upserts them into OMP's append-system-prompt file with per-tool xd://
 * invocation snippets (D3).
 */
export async function syncOmpCatalogInstructions(
  options: SyncOmpCatalogInstructionsOptions,
): Promise<ApplyOmpCatalogInstructionsResult> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const url = new URL("/v1/evolution/catalog/instructions", options.cloudUrl);
  const headers = new Headers(options.headers);
  headers.set("x-workspace-id", options.workspaceId);
  if (options.accountId) {
    headers.set("x-account-id", options.accountId);
  }
  const response = await fetchFn(url, { headers });
  if (!response.ok) {
    throw new Error(`Catalog instructions fetch failed: HTTP ${response.status}`);
  }
  // SAFETY: Evolution catalog instructions endpoint returns a JSON payload with an optional markdown string.
  const body = (await response.json()) as { markdown?: string };
  const markdown = body.markdown && String(body.markdown) === body.markdown ? body.markdown : "";
  const toolNames = parseCatalogInstructionToolNames(markdown);
  return applyOmpCatalogInstructions({
    markdown,
    toolNames,
    serverName: options.serverName,
    ompHome: options.ompHome,
    appendSystemPath: options.appendSystemPath,
  });
}

export interface ApplyOmpCatalogInstructionsOptions {
  markdown?: string;
  toolNames?: string[];
  serverName?: string;
  ompHome?: string;
  appendSystemPath?: string;
}

export interface ApplyOmpCatalogInstructionsResult {
  path: string;
  action: "created" | "updated" | "removed" | "unchanged";
}

/**
 * Upserts the resin managed block in OMP's append-system-prompt file
 * (default `~/.omp/agent/APPEND_SYSTEM.md`). Content outside the managed
 * markers is preserved; an empty/omitted markdown removes the block.
 */
export async function applyOmpCatalogInstructions(
  options: ApplyOmpCatalogInstructionsOptions,
): Promise<ApplyOmpCatalogInstructionsResult> {
  const targetPath =
    options.appendSystemPath ??
    path.join(resolveOmpHome({ customHome: options.ompHome }), DEFAULT_APPEND_SYSTEM_FILENAME);

  const markdown = options.markdown?.trim();
  const body = markdown
    ? renderOmpCatalogInstructionsBody({
        markdown,
        toolNames: options.toolNames,
        serverName: options.serverName,
      })
    : null;
  return applyManagedBlock(defaultFsBridge, targetPath, OMP_CATALOG_MARKERS, body);
}
