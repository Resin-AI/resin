import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const PackageJsonSchema = z.object({ version: z.string().min(1) });

/**
 * The version the daemon reports: `RESIN_RELEASE_VERSION` when set, otherwise the `package.json`
 * of the release (or source checkout) that contains the entry file. The entry sits at
 * `<root>/apps/gateway/dist/bin/daemon.js`, so the root is four directories up; the update engine's
 * health gate compares this against the release it activated, so it must never be a workspace
 * package version.
 */
export function resolveDaemonReleaseVersion(
  entryFile: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.RESIN_RELEASE_VERSION?.trim();
  if (override) return override;
  const entryDir = path.dirname(entryFile);
  const candidates = [
    path.resolve(entryDir, "../../../../package.json"),
    path.resolve(entryDir, "../../package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = PackageJsonSchema.safeParse(JSON.parse(fs.readFileSync(candidate, "utf8")));
      if (parsed.success) return parsed.data.version;
    } catch {
      // Continue to the next enclosing package candidate.
    }
  }
  throw new Error(`Cannot resolve the Resin release version for daemon entry ${entryFile}`);
}
