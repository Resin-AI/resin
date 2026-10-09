import { type ToolManifest, type ToolOpportunities, toolOpportunities } from "@resin/contracts";

/**
 * Whether Resin offers a tool on its own: in instructions, command suggestions, direct listings
 * and query searches. False only when the cloud's repeated measurements showed the tool costing
 * more than doing the job directly; a search then returns it only when the query names it, an
 * empty-query listing still lists it, and the tool still answers by name.
 */
export function isAutomaticallyRecommended(tool: { manifest?: ToolManifest }): boolean {
  return tool.manifest?.recommendation?.automatic !== false;
}

/**
 * The work the cloud observed a recommended tool would have shortened, which a direct listing
 * reads to scope and order it. Undefined for a tool not offered automatically, so the field never
 * changes how such a tool is treated, and for a malformed value.
 */
export function recommendedOpportunities(tool: {
  manifest?: ToolManifest;
}): ToolOpportunities | undefined {
  return isAutomaticallyRecommended(tool)
    ? toolOpportunities(tool.manifest?.recommendation)
    : undefined;
}
