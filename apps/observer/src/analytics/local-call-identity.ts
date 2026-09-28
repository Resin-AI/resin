import {
  type ProgramLanguage,
  type WorkflowJsonValue,
  type WorkflowValuePath,
  analyzeProgramSourceProjection,
} from "@resin/contracts";
import type { HarnessAdapter } from "@resin/harness-contracts";
import { z } from "zod";
import { HARNESS_DEFINITIONS } from "../harness-registry.js";
import { RedactionEngine } from "../normalization/redaction.js";
import {
  type PrivateValueRepresentation,
  type PrivateValueStore,
  resolvePrivateReference,
} from "./private-value-store.js";
import {
  WORKFLOW_CALL_EXIT_CODE_SLOT,
  WORKFLOW_CALL_IDENTITY_SLOT,
  WORKFLOW_CALL_ORDER_SLOT,
  WORKFLOW_CALL_RESULT_SLOTS,
  workflowCallArgumentSlot,
  workflowPrivateReference,
} from "./workflow-private-reference.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_ADAPTERS = 16;
const MAX_DISCOVERY_WORKSPACES = 8_192;
// The adapters bound their own scans; this caps the index retained by one discovery refresh.
const MAX_DISCOVERY_SESSIONS = 50_000;
const PRIVATE_REPRESENTATIONS = [
  "literal",
  "redacted",
] as const satisfies readonly PrivateValueRepresentation[];

/** One call as this device recorded it, read back under references this device computed. */
export interface LocalRecordedCall {
  sessionId: string;
  callId: string;
  callable: {
    name: string;
    connection?: string;
    program?: { kind: string; argument: string };
  };
  arguments: Record<string, WorkflowJsonValue>;
  argumentReferences: Record<string, string>;
  /**
   * Argument positions whose recorded value was redacted from every upload: leaves (and program
   * tokens) that differ between the call as recorded and the view the cloud could have seen.
   */
  privatePositions: Array<{ argument: string; path: WorkflowValuePath }>;
  /** The exit status this device recorded for a shell call, when the harness established one. */
  exitCode?: number;
  /** Absent when the recording kept no successful result for the call. */
  result?: { value: WorkflowJsonValue; reference: string; comparison?: "text-trim" };
  /**
   * Where the recorder placed this call in the order it recorded calls: comparable only between
   * calls of the same `epoch`. Absent for a call recorded before the recorder kept an order.
   */
  sequence?: { epoch: string; index: number };
  /**
   * The root of the workspace the harness recorded this call's session in: what a relative working
   * directory the call named, or an omitted one, stood for.
   */
  workspaceRoot?: string;
}

/** This device cannot list its own sessions right now; the caller should try again later. */
export class LocalSessionDiscoveryUnavailableError extends Error {
  constructor() {
    super("local session discovery is unavailable");
    this.name = "LocalSessionDiscoveryUnavailableError";
  }
}

async function discoverSessionIds(
  adapters: readonly HarnessAdapter[],
): Promise<ReadonlyMap<string, string | undefined> | undefined> {
  if (adapters.length === 0 || adapters.length > MAX_ADAPTERS) return undefined;
  try {
    // Each session's workspace root; undefined when two workspaces claim the same session.
    const sessionIds = new Map<string, string | undefined>();
    let workspaceCount = 0;
    let sessionCount = 0;
    for (const adapter of adapters) {
      if (
        typeof adapter.listWorkspaces !== "function" ||
        typeof adapter.listSessions !== "function"
      ) {
        return undefined;
      }
      const workspaces = await adapter.listWorkspaces();
      if (!Array.isArray(workspaces)) return undefined;
      workspaceCount += workspaces.length;
      if (workspaceCount > MAX_DISCOVERY_WORKSPACES) return undefined;
      for (const workspace of workspaces) {
        if (typeof workspace?.workspaceId !== "string" || workspace.workspaceId.length === 0) {
          return undefined;
        }
        const sessions = await adapter.listSessions(workspace);
        if (!Array.isArray(sessions)) return undefined;
        sessionCount += sessions.length;
        if (sessionCount > MAX_DISCOVERY_SESSIONS) return undefined;
        for (const session of sessions) {
          if (
            typeof session?.sessionId !== "string" ||
            session.sessionId.length === 0 ||
            session.workspaceId !== workspace.workspaceId
          ) {
            return undefined;
          }
          const root = workspace.rootPath;
          sessionIds.set(
            session.sessionId,
            sessionIds.has(session.sessionId) && sessionIds.get(session.sessionId) !== root
              ? undefined
              : root,
          );
        }
      }
    }
    return sessionIds;
  } catch {
    return undefined;
  }
}

function ownedValue(
  store: PrivateValueStore,
  reference: string,
  representation: PrivateValueRepresentation,
  workspaceId: string,
): { value: WorkflowJsonValue } | undefined {
  try {
    if (store.get(reference) === undefined || store.origin === undefined) return undefined;
    if (store.origin(reference)?.workspaceId !== workspaceId) return undefined;
    if (store.representation !== undefined && store.representation(reference) !== representation) {
      return undefined;
    }
    return { value: resolvePrivateReference(store, reference) as WorkflowJsonValue };
  } catch {
    return undefined;
  }
}

/** Secret scanning only: the upload view's credential redaction, without path aliasing. */
const UPLOAD_VIEW = new RedactionEngine({
  homeDir: "",
  sensitiveEnvVars: [],
  localOnlyFields: [],
  maxStringLength: 0,
});

/**
 * Where `view` (what an upload could carry) differs from `original` (what the device recorded):
 * each differing leaf, and for a program text each token the redaction changed. A program whose
 * redacted view no longer aligns with its original is private as a whole.
 */
function privatePaths(
  original: WorkflowJsonValue,
  view: unknown,
  language: ProgramLanguage | undefined,
  path: WorkflowValuePath = [],
): WorkflowValuePath[] {
  if (typeof original === "string") {
    if (view === original) return [];
    if (language === undefined || typeof view !== "string") return [path];
    try {
      const { protectedTokens } = analyzeProgramSourceProjection(language, original, view);
      return protectedTokens.map((token) => [...path, "tokens", token]);
    } catch {
      return [path];
    }
  }
  if (Array.isArray(original)) {
    if (!Array.isArray(view) || view.length !== original.length) return [path];
    return original.flatMap((item, index) =>
      privatePaths(item, view[index], undefined, [...path, index]),
    );
  }
  if (original !== null && typeof original === "object") {
    if (view === null || typeof view !== "object" || Array.isArray(view)) return [path];
    const viewed = view as Record<string, unknown>;
    return Object.entries(original).flatMap(([key, entry]) =>
      privatePaths(entry, viewed[key], undefined, [...path, key]),
    );
  }
  return [];
}

/** The callable and argument names a recorded call kept under its identity slot. */
const RecordedCallIdentity = z.object({
  name: z.string(),
  connection: z.string().optional(),
  program: z.object({ kind: z.string(), argument: z.string() }).optional(),
  arguments: z.array(z.string()),
});

/** Where the recorder placed a call among the calls it recorded, kept under its order slot. */
const RecordedCallOrder = z.object({
  epoch: z.string().min(1),
  index: z.number().int().nonnegative(),
});

/** Reads a device's own recorded calls back by call id. */
export interface LocalCallIdentity {
  /**
   * The recorded call with this id, or undefined when this device has no single, owned, complete
   * record of it. Throws `LocalSessionDiscoveryUnavailableError` when sessions cannot be listed.
   */
  lookup(callId: string): Promise<LocalRecordedCall | undefined>;
}

/**
 * Reads recorded calls back from this device's own recording.
 *
 * A call is identified only by a call id and a session this device's harness adapters discovered;
 * every reference is recomputed here and must be owned by this workspace. A plan may name call ids,
 * but never the references or values the recording is read from, so a plan cannot make a validator
 * compare against anything the device did not record itself.
 */
export function createLocalCallIdentity(options: {
  workspaceId: string;
  privateValues: PrivateValueStore;
  adapters?: readonly HarnessAdapter[];
  cacheTtlMs?: number;
}): LocalCallIdentity {
  const adapters =
    options.adapters ?? HARNESS_DEFINITIONS.map((definition) => definition.createAdapter());
  const requestedTtl = options.cacheTtlMs;
  const cacheTtlMs =
    requestedTtl !== undefined && Number.isFinite(requestedTtl) && requestedTtl >= 0
      ? requestedTtl
      : DEFAULT_CACHE_TTL_MS;
  const workspaceId = options.workspaceId;
  const store = options.privateValues;

  let cached:
    | { expiresAt: number; sessions: ReadonlyMap<string, string | undefined> | undefined }
    | undefined;
  let inFlight: Promise<ReadonlyMap<string, string | undefined> | undefined> | undefined;
  const sessions = async (): Promise<ReadonlyMap<string, string | undefined> | undefined> => {
    if (cached !== undefined && Date.now() < cached.expiresAt) return cached.sessions;
    if (inFlight !== undefined) return await inFlight;
    const pending = discoverSessionIds(adapters).then((found) => {
      cached = { expiresAt: Date.now() + cacheTtlMs, sessions: found };
      if (inFlight === pending) inFlight = undefined;
      return found;
    });
    inFlight = pending;
    return await pending;
  };

  return {
    async lookup(callId) {
      if (workspaceId.trim().length === 0 || workspaceId === "unknown") return undefined;
      if (callId.length === 0) return undefined;
      const discovered = await sessions();
      if (discovered === undefined) throw new LocalSessionDiscoveryUnavailableError();

      let match:
        | {
            sessionId: string;
            representation: PrivateValueRepresentation;
            identity: unknown;
          }
        | undefined;
      for (const sessionId of discovered.keys()) {
        for (const representation of PRIVATE_REPRESENTATIONS) {
          const reference = workflowPrivateReference("demonstration", workspaceId, representation, [
            sessionId,
            callId,
            WORKFLOW_CALL_IDENTITY_SLOT,
          ]);
          const owned = ownedValue(store, reference, representation, workspaceId);
          if (owned === undefined) continue;
          // A call id recorded in two sessions is not one call; refuse rather than pick one.
          if (match !== undefined) return undefined;
          match = { sessionId, representation, identity: owned.value };
        }
      }
      if (match === undefined) return undefined;

      const parsed = RecordedCallIdentity.safeParse(match.identity);
      if (!parsed.success) return undefined;
      const { arguments: argumentNames, ...callable } = parsed.data;
      const referenceFor = (slot: string): string =>
        workflowPrivateReference("demonstration", workspaceId, match.representation, [
          match.sessionId,
          callId,
          slot,
        ]);
      const args: Record<string, WorkflowJsonValue> = {};
      const argumentReferences: Record<string, string> = {};
      const privatePositions: LocalRecordedCall["privatePositions"] = [];
      for (const name of argumentNames) {
        const reference = referenceFor(workflowCallArgumentSlot(name));
        const owned = ownedValue(store, reference, match.representation, workspaceId);
        if (owned === undefined) return undefined;
        args[name] = owned.value;
        argumentReferences[name] = reference;
        // A redacted record keeps the placeholders the upload carried; a literal one is scanned
        // the way its upload was.
        const view =
          match.representation === "redacted"
            ? store.get(reference)
            : UPLOAD_VIEW.redact(owned.value).data;
        const language =
          callable.program?.argument === name
            ? (callable.program.kind as ProgramLanguage)
            : undefined;
        for (const path of privatePaths(owned.value, view, language)) {
          privatePositions.push({ argument: name, path });
        }
      }
      // A result is kept under the representation of the result event, which can differ from the
      // call's: an invoke_tool call is always recorded redacted, its result as the event arrived.
      let result: LocalRecordedCall["result"];
      for (const { slot, comparison } of WORKFLOW_CALL_RESULT_SLOTS) {
        for (const representation of PRIVATE_REPRESENTATIONS) {
          const reference = workflowPrivateReference("demonstration", workspaceId, representation, [
            match.sessionId,
            callId,
            slot,
          ]);
          const owned = ownedValue(store, reference, representation, workspaceId);
          if (owned === undefined) continue;
          // The native command output is the call's own result when both were kept.
          result = {
            value: owned.value,
            reference,
            ...(comparison === undefined ? {} : { comparison }),
          };
        }
      }
      const order = ownedValue(
        store,
        referenceFor(WORKFLOW_CALL_ORDER_SLOT),
        match.representation,
        workspaceId,
      );
      const sequence = order === undefined ? undefined : RecordedCallOrder.safeParse(order.value);
      const exit = ownedValue(
        store,
        referenceFor(WORKFLOW_CALL_EXIT_CODE_SLOT),
        match.representation,
        workspaceId,
      );
      const workspaceRoot = discovered.get(match.sessionId);
      return {
        sessionId: match.sessionId,
        callId,
        callable,
        arguments: args,
        argumentReferences,
        privatePositions,
        ...(typeof exit?.value === "number" && Number.isSafeInteger(exit.value)
          ? { exitCode: exit.value }
          : {}),
        ...(result === undefined ? {} : { result }),
        ...(sequence?.success === true ? { sequence: sequence.data } : {}),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      };
    },
  };
}
