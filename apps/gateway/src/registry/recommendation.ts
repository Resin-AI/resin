import type { ToolManifest } from "@resin/contracts";

/**
 * Whether Resin offers a tool on its own: in instructions, command suggestions, direct listings
 * and query searches. False only when the cloud's repeated measurements showed the tool costing
 * more than doing the job directly; a search then returns it only when the query names it, an
 * empty-query listing still lists it, and the tool still answers by name.
 */
export function isAutomaticallyRecommended(tool: { manifest?: ToolManifest }): boolean {
  return tool.manifest?.recommendation?.automatic !== false;
}
