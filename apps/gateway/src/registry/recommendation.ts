import type { ToolManifest } from "@resin/contracts";

/**
 * Whether Resin offers a tool on its own: in instructions, command suggestions and direct listings,
 * and ahead of other matches in search. False only when the cloud's repeated measurements showed
 * the tool costing more than doing the job directly; the tool still answers by name.
 */
export function isAutomaticallyRecommended(tool: { manifest?: ToolManifest }): boolean {
  return tool.manifest?.recommendation?.automatic !== false;
}
