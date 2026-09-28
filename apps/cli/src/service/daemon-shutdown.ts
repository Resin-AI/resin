import { IpcClient, resolvePaths } from "@resin/observer";

/**
 * Asks the running daemon to drain and exit cleanly over its IPC endpoint.
 * Resolves false when the daemon is unreachable or refuses.
 */
export async function requestDaemonGracefulShutdown(
  resinHome: string,
  reason = "Resin service stop",
): Promise<boolean> {
  const { socketPath } = resolvePaths({ resinHome });
  const client = new IpcClient({ socketPath, timeoutMs: 3_000 });
  try {
    await client.connect();
    const result = await client.gracefulShutdown({ reason });
    return result.accepted;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}
