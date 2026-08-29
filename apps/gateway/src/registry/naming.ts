import type { ToolScopeHierarchy } from "./types.js";

const MAX_MCP_NAME_LENGTH = 64;
const VALID_NAME_CHARACTERS = /[^a-zA-Z0-9_-]/g;

/**
 * Normalizes and sanitizes a raw tool name to MCP specification format.
 * MCP tool names must consist only of alphanumeric characters, underscores, and hyphens.
 */
export function sanitizeToolName(rawName: string): string {
  if (!rawName || Object.prototype.toString.call(rawName) !== "[object String]") {
    return "unnamed_tool";
  }

  // Replace invalid characters with underscore
  let sanitized = rawName.trim().replace(VALID_NAME_CHARACTERS, "_");

  // Collapse multiple consecutive underscores
  sanitized = sanitized.replace(/_+/g, "_");

  // Strip leading/trailing underscores or hyphens if name is not empty
  sanitized = sanitized.replace(/^[_-]+|[_-]+$/g, "");

  if (!sanitized) {
    sanitized = "tool";
  }

  // Bound to MAX_MCP_NAME_LENGTH
  if (sanitized.length > MAX_MCP_NAME_LENGTH) {
    sanitized = sanitized.slice(0, MAX_MCP_NAME_LENGTH).replace(/[_-]+$/, "");
  }

  return sanitized;
}

export interface FormatMcpToolNameOptions {
  scope?: ToolScopeHierarchy | string;
  namespace?: string;
  suffix?: string;
}

/**
 * Formats an MCP-exposed tool name with optional namespace, scope, or suffix.
 */
export function formatMcpToolName(name: string, options?: FormatMcpToolNameOptions): string {
  const base = sanitizeToolName(name);

  if (!options) {
    return base;
  }

  let formatted = base;

  if (options.namespace) {
    const ns = sanitizeToolName(options.namespace);
    formatted = `${ns}__${formatted}`;
  }

  if (options.suffix) {
    const suf = sanitizeToolName(options.suffix);
    formatted = `${formatted}__${suf}`;
  }

  if (formatted.length > MAX_MCP_NAME_LENGTH) {
    formatted = formatted.slice(0, MAX_MCP_NAME_LENGTH).replace(/[_-]+$/, "");
  }

  return formatted;
}

export interface CandidateToolForNaming {
  toolId: string;
  name: string;
  scope?: ToolScopeHierarchy | string;
  version?: string;
  isSystem?: boolean;
}

const SCOPE_RANK = {
  session: 4,
  workspace: 3,
  account: 2,
  user: 2,
  system: 1,
  global: 1,
} as const;

function getScopeRank(scope?: ToolScopeHierarchy | string): number {
  const normalizedScope = scope ?? "workspace";
  return Object.entries(SCOPE_RANK).find(([key]) => key === normalizedScope)?.[1] ?? 0;
}

/**
 * Resolves naming collisions across multiple candidate tools in a deterministic,
 * collision-resistant manner. Narrower scopes (session > workspace > account > system)
 * receive precedence for clean base names, with colliding entries receiving unique suffixes.
 *
 * @returns Map of toolId -> unique exposedName
 */
export function resolveNameCollision(tools: CandidateToolForNaming[]): Map<string, string> {
  const result = new Map<string, string>();
  if (!tools || tools.length === 0) {
    return result;
  }

  // Sort tools by scope precedence descending so higher precedence tools get first claim on canonical name
  // Sort tools: system tools first, then by scope precedence descending, then by toolId
  const sorted = [...tools].sort((a, b) => {
    if (a.isSystem && !b.isSystem) return -1;
    if (!a.isSystem && b.isSystem) return 1;

    const rankA = getScopeRank(a.scope);
    const rankB = getScopeRank(b.scope);
    if (rankB !== rankA) {
      return rankB - rankA;
    }
    // Secondary deterministic sort by toolId
    return a.toolId.localeCompare(b.toolId);
  });

  const usedNames = new Set<string>();

  for (const tool of sorted) {
    const baseName = sanitizeToolName(tool.name);

    if (!usedNames.has(baseName)) {
      usedNames.add(baseName);
      result.set(tool.toolId, baseName);
      continue;
    }

    // Collision detected: generate unique disambiguated name
    let disambiguatedName = "";
    const shortId = tool.toolId.replace(/[^a-zA-Z0-9]/g, "").slice(-6) || "x";
    const scopeTag = tool.scope ? sanitizeToolName(tool.scope) : "";

    // Strategy 1: try `${baseName}__${scopeTag}`
    if (scopeTag) {
      const candidate1 = formatMcpToolName(baseName, { suffix: scopeTag });
      if (!usedNames.has(candidate1)) {
        disambiguatedName = candidate1;
      }
    }

    // Strategy 2: try `${baseName}__${shortId}`
    if (!disambiguatedName) {
      const candidate2 = formatMcpToolName(baseName, { suffix: shortId });
      if (!usedNames.has(candidate2)) {
        disambiguatedName = candidate2;
      }
    }

    // Strategy 3: fallback with monotonic counter
    if (!disambiguatedName) {
      let counter = 2;
      while (true) {
        const candidate3 = formatMcpToolName(baseName, { suffix: `${shortId}_${counter}` });
        if (!usedNames.has(candidate3)) {
          disambiguatedName = candidate3;
          break;
        }
        counter++;
      }
    }

    usedNames.add(disambiguatedName);
    result.set(tool.toolId, disambiguatedName);
  }

  return result;
}
