/**
 * The `resin mcp` supervisor: owns the harness's stdio for the whole session and runs the real
 * gateway as a child process of the active release, forwarding newline-delimited JSON-RPC both
 * ways. When the installer activates another release, it starts that release's gateway, replays
 * the session's `initialize` handshake to it, routes new requests there, lets the old gateway
 * finish what it already accepted, and tells the harness to re-list tools.
 *
 * Only node builtins are imported (see ./protocol.ts): the supervisor must keep running after the
 * release it was loaded from is replaced or pruned.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  type ChildLaunch,
  DEFAULT_POLL_INTERVAL_MS,
  type InstalledRelease,
  MCP_SUPERVISOR_PROTOCOL,
  childLaunch,
  isReleaseRunnable,
  readActiveRelease,
  removeSupervisorRegistration,
  writeSupervisorRegistration,
} from "./protocol.js";

type JsonRpcId = string | number | null;

type Classified =
  | { readonly kind: "request"; readonly id: JsonRpcId; readonly method: string }
  | { readonly kind: "notification"; readonly method: string }
  | { readonly kind: "response"; readonly id: JsonRpcId }
  | { readonly kind: "batch"; readonly items: readonly Classified[] }
  | { readonly kind: "other" };

type JsonObject = { readonly [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}

function classify(message: unknown): Classified {
  if (Array.isArray(message)) return { kind: "batch", items: message.map(classify) };
  if (!isObject(message)) return { kind: "other" };
  const method = message.method;
  if (typeof method === "string") {
    if ("id" in message && message.id !== undefined) {
      return isId(message.id) ? { kind: "request", id: message.id, method } : { kind: "other" };
    }
    return { kind: "notification", method };
  }
  if ("id" in message && isId(message.id) && ("result" in message || "error" in message)) {
    return { kind: "response", id: message.id };
  }
  return { kind: "other" };
}

function parseLine(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Map key that keeps `1` and `"1"` apart: JSON-RPC ids are compared by type and value. */
function idKey(id: JsonRpcId): string {
  return id === null ? "null" : `${typeof id}:${String(id)}`;
}

function withId(message: JsonObject, id: JsonRpcId): string {
  return JSON.stringify({ ...message, id });
}

/** Splits a byte stream into lines (without `\n` or a trailing `\r`), skipping blank ones. */
class LineSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private pending: string[] = [];

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    // Only the new text is scanned, so a long line arriving in many chunks stays linear.
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let start = 0;
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      this.pending.push(text.slice(start, newline));
      this.emit(this.pending.join(""));
      this.pending = [];
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    if (start < text.length) this.pending.push(text.slice(start));
  }

  end(): void {
    this.pending.push(this.decoder.end());
    const rest = this.pending.join("");
    this.pending = [];
    this.emit(rest);
  }

  private emit(line: string): void {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.trim() !== "") this.onLine(trimmed);
  }
}

type ChildState = "starting" | "active" | "draining" | "stopped";

interface ChildGateway {
  readonly release: InstalledRelease;
  readonly process: ChildProcess;
  state: ChildState;
  /** Client requests this child accepted and has not answered, by {@link idKey}. */
  readonly clientRequests: Map<string, JsonRpcId>;
  /** Supervisor ids of this child's requests the client has not answered. */
  readonly serverRequests: Set<string>;
  /** This child's own ids of those requests (by {@link idKey}) to the supervisor ids. */
  readonly serverIdsByChildId: Map<string, string>;
  /** Set while the replayed `initialize` is outstanding; its answer is not forwarded. */
  replayKey?: string;
  readonly replay: PromiseWithResolvers<JsonObject>;
  readonly exited: PromiseWithResolvers<{ code: number | null; signal: string | null }>;
  stopping: boolean;
  timers: Array<ReturnType<typeof setTimeout>>;
}

export type SpawnGateway = (launch: ChildLaunch) => ChildProcess;

/** What happened to the session's gateways, for diagnostics and tests. */
export type McpSupervisorEvent =
  | { readonly type: "switched"; readonly from: InstalledRelease; readonly to: InstalledRelease }
  | { readonly type: "switch_failed"; readonly release: InstalledRelease; readonly reason: string }
  | {
      readonly type: "child_exited";
      readonly release: InstalledRelease;
      readonly pid: number | undefined;
      readonly code: number | null;
    };

export interface McpSupervisorOptions {
  readonly resinHome: string;
  /** The release the session starts on. */
  readonly initialRelease: InstalledRelease;
  /** The release this supervisor was loaded from (recorded in its registration). */
  readonly supervisorRelease: InstalledRelease;
  /** The harness's `resin mcp` arguments, passed to every child unchanged. */
  readonly args: readonly string[];
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: { write: (chunk: string) => unknown };
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly nodePath?: string;
  /** How often to read the active-release pointer; 0 turns polling off. */
  readonly pollIntervalMs?: number;
  /** How long a new gateway may take to answer the replayed `initialize`. */
  readonly readyTimeoutMs?: number;
  /** How long an old gateway may take to finish its in-flight requests. */
  readonly drainTimeoutMs?: number;
  /** Grace after closing a gateway's stdin before it is terminated, then killed. */
  readonly stopGraceMs?: number;
  readonly spawnGateway?: SpawnGateway;
  readonly readActiveRelease?: (resinHome: string) => InstalledRelease | null;
  readonly isReleaseRunnable?: (resinHome: string, release: InstalledRelease) => boolean;
  /** Record this supervisor under `<home>/run/mcp-supervisors` as `pid`; omitted = no record. */
  readonly registrationPid?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: McpSupervisorEvent) => void;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
/** How long after a child exits its stdout may stay open before it is treated as gone. */
const EXIT_DRAIN_GRACE_MS = 2_000;
const INTERNAL_ERROR = -32603;
const SERVER_REQUEST_ID_PREFIX = "resin-mcp-supervisor-";

function defaultSpawn(launch: ChildLaunch): ChildProcess {
  return spawn(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
}

export class McpSupervisor {
  private readonly options: McpSupervisorOptions;
  private readonly children = new Set<ChildGateway>();
  private active: ChildGateway | undefined;
  /** Supervisor id (by {@link idKey}) of every child request the client has not answered. */
  private readonly serverRequests = new Map<string, { child: ChildGateway; id: JsonRpcId }>();
  private nextServerRequestId = 1;
  private initializeLine: string | undefined;
  private initializeKey: string | undefined;
  private initializedLine: string | undefined;
  private switching: Promise<void> | undefined;
  /** The last release a switch was tried for; a failed one is not retried until the pointer moves. */
  private lastAttempted: string | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private closing = false;
  private exitCode = 0;
  private readonly closedSignal = Promise.withResolvers<number>();
  private readonly startedAt: string;
  private readonly clientLines: LineSplitter;
  private readonly onStdinData = (chunk: Buffer | string): void => this.clientLines.push(chunk);
  private readonly onStdinEnd = (): void => {
    this.clientLines.end();
    this.close(this.exitCode);
  };
  private readonly onStdoutError = (): void => this.close(this.exitCode);

  constructor(options: McpSupervisorOptions) {
    this.options = options;
    this.startedAt = new Date((options.now ?? Date.now)()).toISOString();
    this.clientLines = new LineSplitter((line) => this.onClientLine(line));
  }

  /** Settles with the process exit code once the session is over and every child has exited. */
  closed(): Promise<number> {
    return this.closedSignal.promise;
  }

  /** The release new client requests go to. */
  activeRelease(): InstalledRelease | undefined {
    return this.active?.release;
  }

  /** Process ids of the gateways currently running, active first. */
  childPids(): number[] {
    const pids: number[] = [];
    if (this.active?.process.pid !== undefined) pids.push(this.active.process.pid);
    for (const child of this.children) {
      if (child !== this.active && child.state !== "stopped" && child.process.pid !== undefined) {
        pids.push(child.process.pid);
      }
    }
    return pids;
  }

  start(): void {
    const first = this.spawnChild(this.options.initialRelease);
    first.state = "active";
    this.active = first;
    this.lastAttempted = first.release.directory;
    this.updateRegistration();
    const { stdin, stdout } = this.options;
    stdin.on("data", this.onStdinData);
    stdin.once("end", this.onStdinEnd);
    stdin.once("close", this.onStdinEnd);
    stdin.on("error", this.onStdinEnd);
    stdout.on("error", this.onStdoutError);
    stdin.resume();
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (interval > 0) {
      this.pollTimer = setInterval(() => {
        if (this.polling) return;
        this.polling = true;
        void this.checkForUpgrade().finally(() => {
          this.polling = false;
        });
      }, interval);
      this.pollTimer.unref?.();
    }
  }

  /**
   * Reads the active-release pointer and switches when it names another runnable release. The
   * switch waits until the session finished its `initialize` handshake, so it can be replayed.
   * Settles once a started switch succeeded or failed; never rejects.
   */
  checkForUpgrade(): Promise<void> {
    if (this.switching) return this.switching;
    if (this.closing || this.active === undefined) return Promise.resolve();
    let release: InstalledRelease | null;
    try {
      release = (this.options.readActiveRelease ?? readActiveRelease)(this.options.resinHome);
    } catch {
      release = null;
    }
    if (release === null || release.directory === this.lastAttempted) return Promise.resolve();
    if (release.directory === this.active.release.directory) {
      this.lastAttempted = release.directory;
      return Promise.resolve();
    }
    if (this.initializeLine === undefined || this.initializedLine === undefined) {
      return Promise.resolve();
    }
    const runnable = this.options.isReleaseRunnable ?? isReleaseRunnable;
    if (!runnable(this.options.resinHome, release)) return Promise.resolve();
    this.lastAttempted = release.directory;
    const target = release;
    this.switching = this.switchTo(target)
      .catch((error: unknown) => {
        this.log(
          `could not switch this session to v${target.version} (${error instanceof Error ? error.message : String(error)}).`,
        );
      })
      .finally(() => {
        this.switching = undefined;
      });
    return this.switching;
  }

  /** Ends the session: closes every gateway's stdin, then terminates any that linger. */
  stop(): void {
    this.close(this.exitCode);
  }

  private log(message: string): void {
    try {
      this.options.stderr.write(`resin mcp: ${message}\n`);
    } catch {
      // Logging must never take the session down.
    }
  }

  private writeClient(line: string): void {
    try {
      this.options.stdout.write(`${line}\n`);
    } catch {
      this.close(this.exitCode);
    }
  }

  private writeChild(child: ChildGateway, line: string): void {
    const stdin = child.process.stdin;
    if (stdin === null || child.state === "stopped" || stdin.destroyed) return;
    try {
      stdin.write(`${line}\n`);
    } catch {
      // The child is going away; its exit answers whatever it still owed.
    }
  }

  private spawnChild(release: InstalledRelease): ChildGateway {
    const launch = childLaunch({
      resinHome: this.options.resinHome,
      release,
      nodePath: this.options.nodePath ?? process.execPath,
      args: this.options.args,
      env: this.options.env ?? process.env,
      cwd: this.options.cwd ?? process.cwd(),
    });
    const spawned = (this.options.spawnGateway ?? defaultSpawn)(launch);
    const child: ChildGateway = {
      release,
      process: spawned,
      state: "starting",
      clientRequests: new Map(),
      serverRequests: new Set(),
      serverIdsByChildId: new Map(),
      replay: Promise.withResolvers<JsonObject>(),
      exited: Promise.withResolvers(),
      stopping: false,
      timers: [],
    };
    this.children.add(child);
    const lines = new LineSplitter((line) => this.onChildLine(child, line));
    spawned.stdout?.on("data", (chunk: Buffer | string) => lines.push(chunk));
    spawned.stdout?.on("end", () => lines.end());
    spawned.stdin?.on("error", () => {
      // EPIPE once the child exited; its close event handles the rest.
    });
    let exited = false;
    const onExit = (code: number | null, signal: string | null): void => {
      if (exited) return;
      exited = true;
      this.onChildExit(child, code, signal);
    };
    // `close` fires after the child's stdout is drained, so every answer it wrote is forwarded
    // before its unanswered requests are failed.
    spawned.on("close", onExit);
    // A grandchild that inherited the child's stdout could hold `close` back indefinitely.
    spawned.on("exit", (code, signal) => {
      const fallback = setTimeout(() => {
        spawned.stdout?.destroy();
        onExit(code, signal);
      }, EXIT_DRAIN_GRACE_MS);
      fallback.unref?.();
    });
    spawned.on("error", () => {
      if (spawned.pid === undefined || spawned.exitCode !== null) onExit(null, null);
    });
    return child;
  }

  private onClientLine(raw: string): void {
    const active = this.active;
    if (active === undefined) return;
    const message = parseLine(raw);
    const classified = classify(message);
    if (classified.kind === "request" && isObject(message)) {
      if (classified.method === "initialize" && this.initializeLine === undefined) {
        this.initializeLine = raw;
        this.initializeKey = idKey(classified.id);
      }
      active.clientRequests.set(idKey(classified.id), classified.id);
      this.writeChild(active, raw);
      return;
    }
    if (classified.kind === "notification" && isObject(message)) {
      if (classified.method === "notifications/initialized" && this.initializedLine === undefined) {
        this.initializedLine = raw;
      }
      if (classified.method === "notifications/cancelled") {
        this.routeClientCancellation(message, raw);
        return;
      }
      this.writeChild(active, raw);
      return;
    }
    if (classified.kind === "response" && isObject(message)) {
      const pending = this.serverRequests.get(idKey(classified.id));
      // An answer to a request of a gateway that already stopped has nowhere to go.
      if (pending === undefined) return;
      this.serverRequests.delete(idKey(classified.id));
      pending.child.serverRequests.delete(idKey(classified.id));
      pending.child.serverIdsByChildId.delete(idKey(pending.id));
      this.writeChild(pending.child, withId(message, pending.id));
      return;
    }
    if (classified.kind === "batch") {
      for (const item of classified.items) {
        if (item.kind === "request") active.clientRequests.set(idKey(item.id), item.id);
      }
    }
    this.writeChild(active, raw);
  }

  private routeClientCancellation(message: JsonObject, raw: string): void {
    const params = isObject(message.params) ? message.params : undefined;
    const requestId = params?.requestId;
    if (isId(requestId)) {
      const key = idKey(requestId);
      for (const child of this.children) {
        if (child.clientRequests.has(key)) {
          this.writeChild(child, raw);
          return;
        }
      }
      const pending = this.serverRequests.get(key);
      if (pending !== undefined) {
        this.writeChild(
          pending.child,
          JSON.stringify({ ...message, params: { ...params, requestId: pending.id } }),
        );
        return;
      }
    }
    if (this.active !== undefined) this.writeChild(this.active, raw);
  }

  private onChildLine(child: ChildGateway, raw: string): void {
    const message = parseLine(raw);
    const classified = classify(message);
    if (classified.kind === "response" && isObject(message)) {
      const key = idKey(classified.id);
      if (child.replayKey !== undefined && key === child.replayKey) {
        child.replayKey = undefined;
        child.replay.resolve(message);
        return;
      }
      if (child.clientRequests.has(key)) {
        child.clientRequests.delete(key);
        this.writeClient(raw);
        this.stopIfDrained(child);
        return;
      }
      // Answers nobody is waiting for are dropped, so no request is ever answered twice; error
      // replies without an id (unparseable input) belong to the active gateway's client.
      if (classified.id === null && child === this.active) this.writeClient(raw);
      return;
    }
    if (classified.kind === "request" && isObject(message)) {
      const supervisorId = `${SERVER_REQUEST_ID_PREFIX}${this.nextServerRequestId++}`;
      const key = idKey(supervisorId);
      this.serverRequests.set(key, { child, id: classified.id });
      child.serverRequests.add(key);
      child.serverIdsByChildId.set(idKey(classified.id), supervisorId);
      this.writeClient(withId(message, supervisorId));
      return;
    }
    if (classified.kind === "notification" && isObject(message)) {
      if (classified.method === "notifications/tools/list_changed" && child.state === "starting") {
        // The supervisor announces the new tool list itself once this gateway takes over.
        return;
      }
      if (classified.method === "notifications/cancelled") {
        const params = isObject(message.params) ? message.params : undefined;
        const requestId = params?.requestId;
        const supervisorId = isId(requestId)
          ? child.serverIdsByChildId.get(idKey(requestId))
          : undefined;
        if (supervisorId !== undefined) {
          this.forgetServerRequest(child, supervisorId);
          this.writeClient(
            JSON.stringify({ ...message, params: { ...params, requestId: supervisorId } }),
          );
          return;
        }
      }
      this.writeClient(raw);
      return;
    }
    if (child === this.active) this.writeClient(raw);
  }

  private forgetServerRequest(child: ChildGateway, supervisorId: string): void {
    const key = idKey(supervisorId);
    const pending = this.serverRequests.get(key);
    this.serverRequests.delete(key);
    child.serverRequests.delete(key);
    if (pending !== undefined) child.serverIdsByChildId.delete(idKey(pending.id));
  }

  private async switchTo(release: InstalledRelease): Promise<void> {
    const initializeLine = this.initializeLine;
    const initializeKey = this.initializeKey;
    const initializedLine = this.initializedLine;
    if (initializeLine === undefined || initializeKey === undefined) return;
    if (initializedLine === undefined) return;
    const previous = this.active;
    if (previous === undefined) return;

    let child: ChildGateway;
    try {
      child = this.spawnChild(release);
    } catch (error) {
      this.failSwitch(undefined, release, previous, error);
      return;
    }
    child.replayKey = initializeKey;
    // The exact bytes the client sent: same id, protocol version, capabilities and client info.
    this.writeChild(child, initializeLine);

    const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const timedOut = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => timedOut.resolve("timeout"), timeoutMs);
    timer.unref?.();
    const outcome = await Promise.race([
      child.replay.promise,
      child.exited.promise.then(() => "exited" as const),
      timedOut.promise,
    ]);
    clearTimeout(timer);

    if (outcome === "timeout") {
      this.failSwitch(child, release, previous, `no initialize answer within ${timeoutMs} ms`);
      return;
    }
    if (outcome === "exited") {
      this.failSwitch(child, release, previous, "the gateway exited during startup");
      return;
    }
    if ("error" in outcome) {
      this.failSwitch(child, release, previous, "the gateway refused the session's initialize");
      return;
    }
    if (this.closing || this.active !== previous || previous.state !== "active") {
      // The session ended (or the old gateway died) while the new one started.
      this.stopChild(child);
      return;
    }

    this.writeChild(child, initializedLine);
    child.state = "active";
    this.active = child;
    previous.state = "draining";
    this.writeClient(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
    );
    this.log(`switched this session from v${previous.release.version} to v${release.version}.`);
    this.options.onEvent?.({ type: "switched", from: previous.release, to: release });
    this.updateRegistration();
    if (previous.clientRequests.size === 0) {
      this.stopChild(previous);
    } else {
      const drain = setTimeout(
        () => this.stopChild(previous),
        this.options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      );
      drain.unref?.();
      previous.timers.push(drain);
    }
  }

  private failSwitch(
    child: ChildGateway | undefined,
    release: InstalledRelease,
    kept: ChildGateway,
    reason: unknown,
  ): void {
    if (child !== undefined) this.stopChild(child);
    const detail = reason instanceof Error ? reason.message : String(reason);
    this.log(
      `could not switch this session to v${release.version} (${detail}); it keeps running v${kept.release.version}.`,
    );
    this.options.onEvent?.({ type: "switch_failed", release, reason: detail });
  }

  private stopIfDrained(child: ChildGateway): void {
    if (child.state === "draining" && child.clientRequests.size === 0) this.stopChild(child);
  }

  /** Closes the child's stdin (a gateway exits on it), then terminates and kills it if needed. */
  private stopChild(child: ChildGateway): void {
    if (child.stopping || child.state === "stopped") return;
    child.stopping = true;
    if (child.state !== "starting") child.state = "draining";
    try {
      child.process.stdin?.end();
    } catch {
      // Already closed.
    }
    const grace = this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    const terminate = setTimeout(() => {
      child.process.kill("SIGTERM");
      const kill = setTimeout(() => child.process.kill("SIGKILL"), grace);
      kill.unref?.();
      child.timers.push(kill);
    }, grace);
    terminate.unref?.();
    child.timers.push(terminate);
  }

  private onChildExit(child: ChildGateway, code: number | null, signal: string | null): void {
    const wasActive = child === this.active;
    child.state = "stopped";
    for (const timer of child.timers) clearTimeout(timer);
    child.timers = [];
    this.children.delete(child);
    for (const id of child.clientRequests.values()) {
      this.writeClient(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: INTERNAL_ERROR,
            message: "The Resin gateway stopped before answering this request.",
          },
        }),
      );
    }
    child.clientRequests.clear();
    for (const key of child.serverRequests) {
      const pending = this.serverRequests.get(key);
      this.serverRequests.delete(key);
      if (pending === undefined) continue;
      const supervisorId = key.slice("string:".length);
      this.writeClient(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: supervisorId, reason: "The Resin gateway that asked stopped." },
        }),
      );
    }
    child.serverRequests.clear();
    child.serverIdsByChildId.clear();
    child.exited.resolve({ code, signal });
    this.options.onEvent?.({
      type: "child_exited",
      release: child.release,
      pid: child.process.pid,
      code,
    });
    if (wasActive) {
      // The session's gateway is gone: end the session as the gateway itself would have.
      this.active = undefined;
      this.close(this.closing ? this.exitCode : (code ?? 1));
    }
    this.updateRegistration();
    this.finishIfDone();
  }

  private close(exitCode: number): void {
    if (!this.closing) {
      this.closing = true;
      this.exitCode = exitCode;
      if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
      const { stdin, stdout } = this.options;
      stdin.off("data", this.onStdinData);
      stdin.off("end", this.onStdinEnd);
      stdin.off("close", this.onStdinEnd);
      stdin.off("error", this.onStdinEnd);
      stdout.off("error", this.onStdoutError);
      stdin.pause();
      if ("destroy" in stdin && typeof stdin.destroy === "function") stdin.destroy();
      for (const child of this.children) this.stopChild(child);
    }
    this.finishIfDone();
  }

  private finishIfDone(): void {
    if (!this.closing || this.children.size > 0) return;
    if (this.options.registrationPid !== undefined) {
      removeSupervisorRegistration(this.options.resinHome, this.options.registrationPid);
    }
    this.closedSignal.resolve(this.exitCode);
  }

  private updateRegistration(): void {
    const pid = this.options.registrationPid;
    if (pid === undefined || this.closing) return;
    writeSupervisorRegistration(this.options.resinHome, {
      schemaVersion: 1,
      pid,
      protocol: MCP_SUPERVISOR_PROTOCOL,
      version: this.options.supervisorRelease.version,
      activeVersion: (this.active?.release ?? this.options.initialRelease).version,
      childPids: this.childPids(),
      startedAt: this.startedAt,
    });
  }
}
