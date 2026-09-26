import path from "node:path";
import {
  type ManagedBlockMarkers,
  applyManagedBlock,
  defaultFsBridge,
} from "@resin/harness-contracts";
import { resolveOmpHome } from "./discovery.js";

export const DEFAULT_APPEND_SYSTEM_FILENAME = path.join("agent", "APPEND_SYSTEM.md");

const OMP_CATALOG_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:catalog:start -->",
  end: "<!-- resin:catalog:end -->",
};

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
