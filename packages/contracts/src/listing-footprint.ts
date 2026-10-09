import { z } from "zod";
import { descriptorSafeCanonicalJsonStringify } from "./canonical.js";
import { IdentifierSchema } from "./common.js";
import { bytesToTokens } from "./records.js";

/**
 * Listing-footprint contract.
 *
 * What Resin's standing surface costs a harness session on every model request: the text Resin
 * serves as instructions (the MCP server instructions and the static guidance block Resin installs
 * in the harness's context file) and the tool definitions its MCP server lists. The stdio gateway
 * computes it from exactly what it served a connection and records it locally (see
 * {@link ListingFootprintRecordSchema}); the observer attaches it to the first user prompt of the
 * session that connection served, under {@link RESIN_LISTING_FOOTPRINT_METADATA_KEY}. Absent means
 * unknown, never zero: Resin was not served, or the session could not be tied to one connection.
 * Only counts and cloud tool ids leave the device, never the served text.
 */

/** Event metadata key holding a session's {@link ListingFootprint}, on its first user prompt only. */
export const RESIN_LISTING_FOOTPRINT_METADATA_KEY = "resinListingFootprint" as const;

/** Tokens are UTF-8 bytes / 4, rounded up, per text block or per tool definition. */
export const LISTING_FOOTPRINT_TOKEN_METHOD = "utf8_div4_v1" as const;

/** Most learned tool ids one footprint names; a listing is capped well below this. */
export const LISTING_FOOTPRINT_MAX_TOOL_IDS = 64;

const TokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ListingFootprintSchema = z
  .object({
    version: z.literal(1),
    tokenMethod: z.literal(LISTING_FOOTPRINT_TOKEN_METHOD),
    /** The MCP server instructions plus the harness's Resin guidance block, as served. */
    instructionsTokens: TokenCountSchema,
    /** Every tool definition the MCP server listed: Resin's meta tools and the listed learned tools. */
    toolsTokens: TokenCountSchema,
    totalTokens: TokenCountSchema,
    /** How many tool definitions `toolsTokens` counts. */
    toolCount: z.number().int().nonnegative().max(1024),
    /** Cloud tool ids of the learned tools listed directly, sorted; meta tools are not named. */
    toolIds: z.array(IdentifierSchema).max(LISTING_FOOTPRINT_MAX_TOOL_IDS),
    /** True when the workspace had relevant learned tools the listing cap left out. */
    capped: z.boolean(),
  })
  .strict()
  .refine((value) => value.totalTokens === value.instructionsTokens + value.toolsTokens, {
    message: "totalTokens must equal instructionsTokens + toolsTokens",
  })
  .refine((value) => value.toolIds.length <= value.toolCount, {
    message: "toolIds cannot name more tools than toolCount counts",
  })
  .refine(
    (value) =>
      value.toolIds.every((id, index) => index === 0 || (value.toolIds[index - 1] ?? "") < id),
    { message: "toolIds must be sorted and unique" },
  );

export type ListingFootprint = z.infer<typeof ListingFootprintSchema>;

/** A tool definition as an MCP server lists it; only these fields are counted. */
export interface ListingToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Tokens of one served text block. */
export function listingTextTokens(text: string): number {
  return bytesToTokens(Buffer.byteLength(text, "utf8"));
}

/** Tokens of one served tool definition: its canonical `{name, description, inputSchema}` JSON. */
export function listingToolTokens(tool: ListingToolDefinition): number {
  const serialized = descriptorSafeCanonicalJsonStringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
  return listingTextTokens(serialized ?? "");
}

/**
 * The footprint of a served surface. `instructions` are the text blocks the harness receives
 * (each counted on its own); `tools` every listed definition; `listedToolIds` the cloud ids of the
 * learned tools among them.
 */
export function computeListingFootprint(input: {
  instructions: readonly string[];
  tools: readonly ListingToolDefinition[];
  listedToolIds: readonly string[];
  capped: boolean;
}): ListingFootprint {
  const instructionsTokens = input.instructions.reduce(
    (sum, text) => sum + listingTextTokens(text),
    0,
  );
  const toolsTokens = input.tools.reduce((sum, tool) => sum + listingToolTokens(tool), 0);
  return {
    version: 1,
    tokenMethod: LISTING_FOOTPRINT_TOKEN_METHOD,
    instructionsTokens,
    toolsTokens,
    totalTokens: instructionsTokens + toolsTokens,
    toolCount: input.tools.length,
    toolIds: [...new Set(input.listedToolIds)].sort(),
    capped: input.capped,
  };
}

/** Fail-closed reader: the footprint in untrusted event metadata, or undefined. */
export function readListingFootprint(metadata: unknown): ListingFootprint | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
    return undefined;
  const parsed = ListingFootprintSchema.safeParse(
    (metadata as Record<string, unknown>)[RESIN_LISTING_FOOTPRINT_METADATA_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}

/** Directory under the Resin state dir holding one {@link ListingFootprintRecord} per gateway process. */
export const LISTING_FOOTPRINT_RECORDS_DIRNAME = "listing-footprints" as const;

/** Most surfaces one record keeps (a surface is re-recorded only when a tools/list changes it). */
export const LISTING_FOOTPRINT_RECORD_MAX_SURFACES = 32;

const IsoTimestampSchema = z.string().datetime({ offset: true });

/**
 * A local, never-uploaded record of what one `resin mcp` process served its harness: which harness
 * and directory it served, while it ran, and each distinct surface with when it was first served.
 * The observer reads these to tie a session to the surface it was served.
 */
export const ListingFootprintRecordSchema = z
  .object({
    version: z.literal(1),
    harnessId: z.string().min(1).max(64),
    /** The directory the gateway process serves (its harness session's working directory). */
    cwd: z.string().min(1).max(4096),
    pid: z.number().int().positive(),
    startedAt: IsoTimestampSchema,
    /** When the process stopped serving; absent while it runs. */
    closedAt: IsoTimestampSchema.optional(),
    surfaces: z
      .array(z.object({ servedAt: IsoTimestampSchema, footprint: ListingFootprintSchema }).strict())
      .min(1)
      .max(LISTING_FOOTPRINT_RECORD_MAX_SURFACES),
  })
  .strict();

export type ListingFootprintRecord = z.infer<typeof ListingFootprintRecordSchema>;
