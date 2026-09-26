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
