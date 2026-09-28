import net from "node:net";
import type { Duplex } from "node:stream";
import { connectVerifiedPipe, isLocalPipeName, verifyPipeServer } from "@resin/windows-security";
import { IPC_ERROR_CODES } from "./protocol.js";

/**
 * Windows: the daemon is only ever reachable through a local named pipe. Anything else (a
 * filesystem path, a remote `\\host\pipe\` name that would authenticate to another machine) is
 * refused before dialling. Returns the refusal error, or undefined (always off Windows).
 */
export function undialableDaemonTarget(socketPath: string): Error | undefined {
  if (process.platform !== "win32" || isLocalPipeName(socketPath)) return undefined;
  return Object.assign(
    new Error(
      `Refusing to dial '${socketPath}': on Windows the Resin daemon is only reachable through a local named pipe (\\\\.\\pipe\\...).`,
    ),
    { code: IPC_ERROR_CODES.UNTRUSTED_SERVER },
  );
}

function connectNet(socketPath: string): Promise<Duplex> {
  const { promise, resolve, reject } = Promise.withResolvers<Duplex>();
  const socket = net.createConnection(socketPath);
  const onError = (error: Error): void => reject(error);
  socket.once("error", onError);
  socket.once("connect", () => {
    socket.off("error", onError);
    resolve(socket);
  });
  return promise;
}

/**
 * Opens a byte stream to the daemon. POSIX: the Unix socket (its directory and 0600 mode keep
 * other users out). Windows: a local pipe connection whose owner and server process were verified
 * to be the current user on that very connection, before anything is sent; a pipe held by anyone
 * else is refused with code UNTRUSTED_SERVER, and a missing daemon rejects with ENOENT.
 */
export async function openDaemonConnection(
  socketPath: string,
  options: { timeoutMs?: number } = {},
): Promise<Duplex> {
  if (process.platform !== "win32") return connectNet(socketPath);
  const undialable = undialableDaemonTarget(socketPath);
  if (undialable) throw undialable;
  try {
    return await connectVerifiedPipe(socketPath, { timeoutMs: options.timeoutMs });
  } catch (error) {
    const reason = error instanceof Error && "reason" in error ? error.reason : undefined;
    if (reason === "access-denied" || reason === "foreign-owner" || reason === "foreign-server") {
      throw Object.assign(
        new Error(
          `Refusing to talk to daemon pipe ${socketPath}: it is not served by the current user (${reason}). Another process may be squatting the name.`,
        ),
        { code: IPC_ERROR_CODES.UNTRUSTED_SERVER, reason, cause: error },
      );
    }
    throw error;
  }
}

/**
 * Windows: whether anything currently serves the local daemon pipe, or undefined when
 * `socketPath` is not a Windows pipe (callers then check the socket file). `fs.existsSync` reports
 * pipes as missing and `fs.access` opens a connection to them, so neither is a presence check.
 * Presence only: talk to the daemon through {@link openDaemonConnection}.
 */
export function daemonPipePresent(socketPath: string): boolean | undefined {
  if (process.platform !== "win32" || !isLocalPipeName(socketPath)) return undefined;
  return verifyPipeServer(socketPath).reason !== "not-running";
}
