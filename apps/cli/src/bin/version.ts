import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const PackageJsonSchema = z.object({
  version: z.string().min(1),
});

function resolveVersion(): string {
  const candidates = [
    new URL("../../../../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = PackageJsonSchema.safeParse(
        JSON.parse(fs.readFileSync(fileURLToPath(candidate), "utf8")),
      );
      if (parsed.success) {
        return parsed.data.version;
      }
    } catch {
      // Continue to the next enclosing package candidate.
    }
  }
  return "0.1.0";
}

/**
 * The running CLI release version (what `resin --version` prints, and what the CLI reports to the
 * cloud when it authorizes a device or refreshes its token).
 */
export const CLI_VERSION = process.env.RESIN_RELEASE_VERSION ?? resolveVersion();
