import path from "node:path";
import { ClaudeHarnessAdapter } from "@resin/adapter-claude-code";
import { CodexHarnessAdapter } from "@resin/adapter-codex";
import { OmpHarnessAdapter } from "@resin/adapter-omp";
import type { RecordedWorkflow } from "@resin/contracts";
import type { HarnessAdapter } from "@resin/harness-contracts";
import type { PrivateValueRepresentation, PrivateValueStore } from "./private-value-store.js";
import { workflowPrivateReference } from "./workflow-private-reference.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_ADAPTERS = 16;
const MAX_DISCOVERY_WORKSPACES = 8_192;
// The adapters bound their own scans; this caps the index retained by one resolver refresh.
const MAX_DISCOVERY_SESSIONS = 50_000;
const PRIVATE_REPRESENTATIONS = [
  "literal",
  "redacted",
] as const satisfies readonly PrivateValueRepresentation[];
const BASELINE_RESULT_SLOTS = [
  "result",
  "native-result:v1:exact",
  "native-result:v1:text-trim",
] as const;

type SessionRoots = ReadonlyMap<string, readonly (string | undefined)[]>;
type ReferenceNamespace = "value" | "demonstration";

async function discoverSessionRoots(
  adapters: readonly HarnessAdapter[],
): Promise<SessionRoots | undefined> {
  if (adapters.length === 0 || adapters.length > MAX_ADAPTERS) return undefined;

  try {
    const rootsBySession = new Map<string, Set<string | undefined>>();
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
        // Adapters may retain sessions whose original cwd is unknown. Keep those identities
        // unbound without blocking unrelated projects, and never treat a fallback label as a path.
        const rootPath =
          typeof workspace.rootPath === "string" && path.isAbsolute(workspace.rootPath)
            ? path.resolve(workspace.rootPath)
            : undefined;
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
          let roots = rootsBySession.get(session.sessionId);
          if (roots === undefined) {
            roots = new Set<string | undefined>();
            rootsBySession.set(session.sessionId, roots);
          }
          roots.add(rootPath);
        }
      }
    }

    return new Map(
      [...rootsBySession.entries()].map(([sessionId, roots]) => [sessionId, [...roots]]),
    );
  } catch {
    return undefined;
  }
}

function privateArgumentReference(
  step: RecordedWorkflow["steps"][number],
  argumentName: string | undefined,
): { reference?: string; ambiguous: boolean } {
  if (argumentName === undefined) return { ambiguous: false };
  const argumentsForName = step.arguments.filter((argument) => argument.name === argumentName);
  if (argumentsForName.length > 1) return { ambiguous: true };
  const source = argumentsForName[0]?.source;
  if (source?.kind === "private") return { reference: source.reference, ambiguous: false };
  if (source?.kind !== "template") return { ambiguous: false };
  if (source.template.type === "private") {
    return { reference: source.template.reference, ambiguous: false };
  }
  // A structured program template keeps its private source at this same argument coordinate.
  if (source.template.type === "program" && source.template.source.type === "private") {
    return { reference: source.template.source.reference, ambiguous: false };
  }
  return { ambiguous: false };
}

function isOwnedLocalReference(
  store: PrivateValueStore,
  reference: string,
  representation: PrivateValueRepresentation,
  workspaceId: string,
): boolean {
  try {
    if (store.get(reference) === undefined || store.origin === undefined) return false;
    if (store.origin(reference)?.workspaceId !== workspaceId) return false;
    return store.representation === undefined || store.representation(reference) === representation;
  } catch {
    return false;
  }
}

function rootForReference(
  reference: string,
  namespace: ReferenceNamespace,
  workspaceId: string,
  store: PrivateValueStore,
  sessionRoots: SessionRoots,
  identityParts: (sessionId: string) => readonly (readonly unknown[])[],
): string | undefined {
  let identityMatches = 0;
  let rootPath: string | undefined;

  for (const [sessionId, roots] of sessionRoots) {
    for (const parts of identityParts(sessionId)) {
      for (const representation of PRIVATE_REPRESENTATIONS) {
        const expected = workflowPrivateReference(namespace, workspaceId, representation, parts);
        if (reference !== expected) continue;
        identityMatches += 1;
        if (
          identityMatches !== 1 ||
          roots.length !== 1 ||
          roots[0] === undefined ||
          !isOwnedLocalReference(store, reference, representation, workspaceId)
        ) {
          return undefined;
        }
        rootPath = roots[0];
      }
    }
  }

  return identityMatches === 1 ? rootPath : undefined;
}

/**
 * Locates the trusted local project root that recorded each program in a workflow.
 *
 * Local session IDs come only from host adapter discovery. References in the plan are accepted only
 * when their canonical local identity and private-store owner match this workspace; paths carried by
 * the plan are never consulted.
 */
export function createRecordedWorkflowWorkspaceResolver(options: {
  workspaceId: string;
  privateValues: PrivateValueStore;
  adapters?: readonly HarnessAdapter[];
  cacheTtlMs?: number;
}): (plan: RecordedWorkflow) => Promise<string | undefined> {
  const adapters = options.adapters ?? [
    new ClaudeHarnessAdapter(),
    new CodexHarnessAdapter(),
    new OmpHarnessAdapter({ activeOnly: false }),
  ];
  const requestedTtl = options.cacheTtlMs;
  const cacheTtlMs =
    requestedTtl !== undefined && Number.isFinite(requestedTtl) && requestedTtl >= 0
      ? requestedTtl
      : DEFAULT_CACHE_TTL_MS;

  let cached: { expiresAt: number; roots: SessionRoots | undefined } | undefined;
  let inFlight: Promise<SessionRoots | undefined> | undefined;
  const getSessionRoots = async (): Promise<SessionRoots | undefined> => {
    if (cached !== undefined && Date.now() < cached.expiresAt) return cached.roots;
    if (inFlight !== undefined) return await inFlight;

    const pending = discoverSessionRoots(adapters).then((roots) => {
      cached = { expiresAt: Date.now() + cacheTtlMs, roots };
      if (inFlight === pending) inFlight = undefined;
      return roots;
    });
    inFlight = pending;
    return await pending;
  };

  return async (plan: RecordedWorkflow): Promise<string | undefined> => {
    if (
      options.workspaceId.trim().length === 0 ||
      options.workspaceId === "unknown" ||
      !Array.isArray(plan?.steps)
    ) {
      return undefined;
    }
    const programSteps = plan.steps.filter((step) => step.callable?.program !== undefined);
    if (programSteps.length === 0) return undefined;

    const sessionRoots = await getSessionRoots();
    if (sessionRoots === undefined || sessionRoots.size === 0) return undefined;

    let recordedRoot: string | undefined;
    const includeRoot = (rootPath: string | undefined): boolean => {
      if (rootPath === undefined) return false;
      if (recordedRoot !== undefined && recordedRoot !== rootPath) return false;
      recordedRoot = rootPath;
      return true;
    };

    for (const step of programSteps) {
      const program = step.callable.program!;
      const argumentName = program.argument;
      const argument = privateArgumentReference(step, argumentName);
      if (argument.ambiguous) return undefined;

      let stepRoot: string | undefined;
      if (argument.reference?.startsWith("private:v2:")) {
        // A V2 reference that cannot be bound to its local source must not be rescued by a result ref.
        if (!argument.reference.startsWith("private:v2:value:") || argumentName === undefined) {
          return undefined;
        }
        stepRoot = rootForReference(
          argument.reference,
          "value",
          options.workspaceId,
          options.privateValues,
          sessionRoots,
          (sessionId) => [[sessionId, step.callId, [argumentName]]],
        );
      } else {
        const baseline = plan.baseline?.observed.filter((entry) => entry.stepId === step.id) ?? [];
        if (baseline.length !== 1) return undefined;
        stepRoot = rootForReference(
          baseline[0]!.reference,
          "demonstration",
          options.workspaceId,
          options.privateValues,
          sessionRoots,
          (sessionId) => BASELINE_RESULT_SLOTS.map((slot) => [sessionId, step.callId, slot]),
        );
      }
      if (!includeRoot(stepRoot)) return undefined;

      const setup = program.pythonState?.setup;
      if (setup !== undefined) {
        if (!Array.isArray(setup) || (setup.length > 0 && argumentName === undefined))
          return undefined;
        for (const cell of setup) {
          if (typeof cell?.callId !== "string" || typeof cell.reference !== "string")
            return undefined;
          const setupRoot = rootForReference(
            cell.reference,
            "value",
            options.workspaceId,
            options.privateValues,
            sessionRoots,
            (sessionId) => [[sessionId, cell.callId, [argumentName!]]],
          );
          if (!includeRoot(setupRoot)) return undefined;
        }
      }
    }

    return recordedRoot;
  };
}
