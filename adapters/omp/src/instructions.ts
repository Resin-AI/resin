import * as fsp from "node:fs/promises";
import path from "node:path";
import { resolveOmpHome } from "./discovery.js";

export const DEFAULT_APPEND_SYSTEM_FILENAME = path.join("agent", "APPEND_SYSTEM.md");

const MANAGED_BLOCK_START = "<!-- resin:catalog:start -->";
const MANAGED_BLOCK_END = "<!-- resin:catalog:end -->";

/**
 * Renders the per-tool invocation convention for Oh My Pi sessions.
 * OMP surfaces MCP tools as `xd://mcp__<server>_<tool>` paths: writing JSON
 * args to the path invokes the tool; reading it returns its documentation.
 */
export function renderOmpInvocationSnippet(toolName: string, serverName: string): string {
  const server = serverName.replace(/-/g, "_");
  const path = `xd://mcp__${server}_${toolName}`;
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
  const serverName = options.serverName ?? "resin";
  const lines: string[] = [
    MANAGED_BLOCK_START,
    "",
    options.markdown.trim(),
    "",
    "These tools are exposed over MCP. Invoke them through the `xd://` tool-device surface rather than re-running the underlying shell commands manually.",
  ];

  for (const toolName of options.toolNames ?? []) {
    lines.push("", `#### Invocation: \`${toolName}\``);
    lines.push(renderOmpInvocationSnippet(toolName, serverName));
  }

  lines.push("", MANAGED_BLOCK_END);
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
  const headers: Record<string, string> = {
    "x-workspace-id": options.workspaceId,
    ...(options.accountId ? { "x-account-id": options.accountId } : {}),
    ...options.headers,
  };
  const response = await fetchFn(url, { headers });
  if (!response.ok) {
    throw new Error(`Catalog instructions fetch failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { markdown?: string };
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
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

  const existing = await fsp.readFile(targetPath, "utf8").catch(() => undefined);

  const markdown = options.markdown?.trim();
  const block = markdown
    ? buildOmpCatalogInstructionsBlock({
        markdown,
        toolNames: options.toolNames,
        serverName: options.serverName,
      })
    : undefined;

  const startIdx = existing?.indexOf(MANAGED_BLOCK_START) ?? -1;
  const endIdx = existing?.indexOf(MANAGED_BLOCK_END) ?? -1;
  const hasBlock = existing !== undefined && startIdx !== -1 && endIdx > startIdx;

  let next: string;
  let action: ApplyOmpCatalogInstructionsResult["action"];

  if (hasBlock) {
    const before = existing!.slice(0, startIdx).trimEnd();
    const after = existing!.slice(endIdx + MANAGED_BLOCK_END.length).trimStart();
    if (block) {
      next = `${[before, block, after].filter((part) => part.length > 0).join("\n\n")}\n`;
      action = next === existing ? "unchanged" : "updated";
    } else {
      next = [before, after].filter((part) => part.length > 0).join("\n\n");
      next = next.length > 0 ? `${next}\n` : "";
      action = "removed";
    }
  } else if (block) {
    next =
      existing && existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
    action = existing === undefined ? "created" : "updated";
  } else {
    return { path: targetPath, action: "unchanged" };
  }

  if (action !== "unchanged") {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, next, "utf8");
  }
  return { path: targetPath, action };
}
