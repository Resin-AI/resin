import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function isExecutableFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the Deno executable Resin runs sandboxed code with, without spawning it. Order: the
 * explicit option, `RESIN_DENO_EXECUTABLE`, the Deno installed with Resin
 * (`<RESIN_HOME or ~/.resin>/current/deno/deno`), then PATH. Undefined when none exists.
 */
export function resolveDenoExecutable(options?: {
  denoExecutable?: string;
  resinHome?: string;
}): string | undefined {
  if (options?.denoExecutable && isExecutableFile(options.denoExecutable)) {
    return options.denoExecutable;
  }
  const envDeno = process.env.RESIN_DENO_EXECUTABLE;
  if (envDeno && isExecutableFile(envDeno)) {
    return envDeno;
  }
  const resinHome =
    options?.resinHome || process.env.RESIN_HOME || path.join(os.homedir(), ".resin");
  const resinDeno = path.join(
    resinHome,
    "current",
    "deno",
    process.platform === "win32" ? "deno.exe" : "deno",
  );
  if (isExecutableFile(resinDeno)) {
    return resinDeno;
  }
  if (process.platform === "win32") {
    const resinDenoFallback = path.join(resinHome, "current", "deno", "deno");
    if (isExecutableFile(resinDenoFallback)) {
      return resinDenoFallback;
    }
  }
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "deno.exe" : "deno");
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
