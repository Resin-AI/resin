import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

/**
 * Harness-owned `resin mcp` processes are not part of the resident service, so an
 * update cannot restart them. Each gateway records the version it runs so status
 * can tell the user which harnesses still need a restart.
 */
const GatewayRegistrationSchema = z
  .object({
    schemaVersion: z.literal(1),
    pid: z.number().int().positive(),
    version: z.string().min(1).max(64),
    startedAt: z.string().min(1).max(64),
  })
  .strict();

export type GatewayRegistration = z.infer<typeof GatewayRegistrationSchema>;

const MAX_REGISTRATIONS = 256;

export function resolveGatewayRegistryDir(resinHome: string): string {
  return path.join(resinHome, "run", "mcp-gateways");
}

/** Records this gateway process; returns an idempotent synchronous unregister. */
export function registerRunningGateway(options: {
  readonly resinHome: string;
  readonly version: string;
  readonly pid?: number;
  readonly now?: () => number;
}): () => void {
  const pid = options.pid ?? process.pid;
  const directory = resolveGatewayRegistryDir(options.resinHome);
  const filePath = path.join(directory, `${pid}.json`);
  fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const registration: GatewayRegistration = GatewayRegistrationSchema.parse({
    schemaVersion: 1,
    pid,
    version: options.version.replace(/^v/u, ""),
    startedAt: new Date((options.now ?? Date.now)()).toISOString(),
  });
  fsSync.writeFileSync(filePath, `${JSON.stringify(registration)}\n`, { mode: 0o600 });
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    try {
      fsSync.rmSync(filePath, { force: true });
    } catch {
      // A stale registration is pruned by the next reader.
    }
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Lists live gateways, pruning registrations whose process has exited. */
export async function listRunningGateways(options: {
  readonly resinHome: string;
  readonly isAlive?: (pid: number) => boolean;
}): Promise<GatewayRegistration[]> {
  const directory = resolveGatewayRegistryDir(options.resinHome);
  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => /^\d+\.json$/u.test(name));
  } catch {
    return [];
  }
  const isAlive = options.isAlive ?? isProcessAlive;
  const live: GatewayRegistration[] = [];
  for (const name of names.slice(0, MAX_REGISTRATIONS)) {
    const filePath = path.join(directory, name);
    try {
      const parsed = GatewayRegistrationSchema.safeParse(
        JSON.parse(await fs.readFile(filePath, "utf8")),
      );
      if (parsed.success && isAlive(parsed.data.pid)) {
        live.push(parsed.data);
        continue;
      }
    } catch {
      // Unreadable registrations are treated as stale.
    }
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
  return live;
}

const RESIN_ENTRY_BASENAME = /^resin(?:\.m?js)?$/u;

function realpathOrSelf(filePath: string): string {
  try {
    return fsSync.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Finds live `resin mcp` processes of this Resin home that never registered (gateways started
 * by releases older than the registry). Scans `/proc/<pid>/cmdline` for a Resin entry point
 * inside `resinHome` followed by `mcp`; returns nothing where `/proc` is unavailable.
 */
export async function listUnregisteredGatewayPids(options: {
  readonly resinHome: string;
  readonly registeredPids: Iterable<number>;
  readonly procRoot?: string;
  readonly selfPid?: number;
}): Promise<number[]> {
  const procRoot = options.procRoot ?? "/proc";
  let entries: string[];
  try {
    entries = (await fs.readdir(procRoot)).filter((name) => /^\d+$/u.test(name));
  } catch {
    return [];
  }
  const resolvedHome = path.resolve(options.resinHome);
  const homePrefixes = [resolvedHome, realpathOrSelf(resolvedHome)].map(
    (home) => `${home}${path.sep}`,
  );
  const skip = new Set(options.registeredPids);
  skip.add(options.selfPid ?? process.pid);
  const pids: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (skip.has(pid)) continue;
    let args: string[];
    try {
      args = (await fs.readFile(path.join(procRoot, entry, "cmdline"), "utf8")).split("\0");
    } catch {
      continue;
    }
    const isGateway = args.some((arg, index) => {
      if (args[index + 1] !== "mcp" || !path.isAbsolute(arg)) return false;
      if (!RESIN_ENTRY_BASENAME.test(path.basename(arg))) return false;
      return [path.resolve(arg), realpathOrSelf(arg)].some((candidate) =>
        homePrefixes.some((prefix) => candidate.startsWith(prefix)),
      );
    });
    if (isGateway) pids.push(pid);
  }
  return pids.sort((left, right) => left - right);
}
