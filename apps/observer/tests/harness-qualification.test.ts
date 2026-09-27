/**
 * Registry-wide harness qualification.
 *
 * Every harness the observer decodes (HARNESS_DEFINITIONS) must carry recorded fixtures for each
 * version it claims as tested, and those fixtures must survive the live capture path unchanged:
 * `createAdapter()` discovery and event sources, `createDecoder()`, the real NormalizationPipeline
 * and the WorkflowCallRecorder. A decoder that drifts from the event schema, or a harness whose
 * record format drifts from its decoder, would otherwise lose events silently in production.
 *
 * Fixture convention: `adapters/<dir>/tests/qualification-fixtures.ts` exports
 * `materializeRecordedHomes(version, createHome)`, which places the recorded fixtures of
 * `tests/fixtures/recorded/<version>/` into one or more fresh homes where the adapter's default
 * discovery looks. Each home is captured with HOME pointing at it and no other environment.
 * A harness without tested versions (Cursor) is qualified once, with `version` undefined, from
 * whatever synthetic capture its module produces; that does not make any version tested.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type NormalizedSessionEvent, parseAssistantStopReason } from "@resin/contracts";
import type { HarnessDefinition, RawHarnessRecord } from "@resin/harness-contracts";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryPrivateValueStore } from "../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "../src/analytics/workflow-call-recorder.js";
import { HARNESS_DEFINITIONS } from "../src/harness-registry.js";
import { isLocalWorkflowResultSuppressed } from "../src/normalization/local-workflow-payload.js";
import {
  NormalizationPipeline,
  type PipelineProcessContext,
} from "../src/normalization/pipeline.js";

const ADAPTERS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../adapters",
);

/**
 * Raw record types each adapter deliberately passes through as `unknown_passthrough`. Anything
 * else surfacing as passthrough is a record the decoder no longer understands.
 */
const EXPECTED_PASSTHROUGH: Record<string, readonly string[]> = {
  // Transcript bookkeeping: hook/file attachments, prompt-queue and resume markers, mode
  // switches and hook summaries. None is a prompt, answer or tool step.
  "claude-code": ["attachment", "queue-operation", "atis-latch", "last-prompt", "mode", "system"],
  // Per-model-call usage the next assistant message did not claim.
  "muse-code": ["muse.model_completed"],
  // Session configuration changes and harness-injected reminders that are not user prompts.
  omp: [
    "title",
    "model_change",
    "thinking_level_change",
    "service_tier_change",
    "credential_pin",
    "custom_message",
  ],
  pi: ["model_change", "thinking_level_change", "context_edit", "session_info", "usage"],
};

/**
 * Recorded sessions whose final turn never completes, so no settlement boundary is expected
 * after their last prompt. Keyed `<harness>/<version>`; values match discovered session ids.
 */
const UNSETTLED_SESSIONS: Record<string, readonly RegExp[]> = {
  // A scrubbed excerpt of one code-mode cell; the recording stops before the turn completes.
  "codex-cli/0.157.1": [/01a0e011-bd72-7ea1-87cb-61d2c1474ec0/],
};

interface SessionCapture {
  readonly sessionId: string;
  readonly events: NormalizedSessionEvent[];
  readonly deadLetters: string[];
  /** Results the pipeline marked as an unknown outcome (no replay baseline by design). */
  readonly unknownOutcomeResults: Set<NormalizedSessionEvent>;
}

function adapterDirFor(definition: HarnessDefinition): string {
  for (const dir of fs.readdirSync(ADAPTERS_DIR)) {
    const manifest = path.join(ADAPTERS_DIR, dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const { name } = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string };
    if (name === definition.adapterPackage) return path.join(ADAPTERS_DIR, dir);
  }
  throw new Error(`no adapter directory for ${definition.adapterPackage}`);
}

function recordedVersions(definition: HarnessDefinition): string[] {
  const recorded = path.join(adapterDirFor(definition), "tests", "fixtures", "recorded");
  if (!fs.existsSync(recorded)) return [];
  return fs
    .readdirSync(recorded, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
    .map((entry) => entry.name);
}

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

/** Runs `body` with a process environment that only knows the fixture home. */
async function withIsolatedEnv(home: string, body: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key !== "PATH" && key !== "TMPDIR") delete process.env[key];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await body();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

async function capture(
  definition: HarnessDefinition,
  version: string | undefined,
): Promise<SessionCapture[]> {
  const loader = path.join(adapterDirFor(definition), "tests", "qualification-fixtures.ts");
  if (!fs.existsSync(loader)) {
    throw new Error(`${definition.id} has no ${path.relative(ADAPTERS_DIR, loader)}`);
  }
  // The loader is selected per registry entry at runtime, so it cannot be a static import.
  const module = (await import(pathToFileURL(loader).href)) as {
    materializeRecordedHomes(version: string | undefined, createHome: () => string): Promise<void>;
  };
  const created: string[] = [];
  await module.materializeRecordedHomes(version, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `resin-qualify-${definition.id}-`));
    created.push(home);
    return home;
  });
  homes.push(...created);

  const captures: SessionCapture[] = [];
  for (const home of created) {
    await withIsolatedEnv(home, async () => {
      const adapter = definition.createAdapter();
      const store = new InMemoryPrivateValueStore();
      const pipeline = new NormalizationPipeline({ privateValueStore: store });
      pipeline.registerDecoder(definition.createDecoder());
      const recorder = new WorkflowCallRecorder({ privateValues: store });
      for (const workspace of (await adapter.listWorkspaces?.()) ?? []) {
        for (const session of (await adapter.listSessions?.(workspace)) ?? []) {
          const source = await adapter.openEventSource!(session);
          const records: RawHarnessRecord[] = [];
          for (let batch = await source.readNext(100); batch.length > 0; ) {
            records.push(...batch);
            batch = await source.readNext(100);
          }
          await source.close?.();
          const context: PipelineProcessContext = {
            sessionId: session.sessionId,
            harnessId: session.harnessId,
            workspaceId: session.workspaceId,
            customMetadata: JSON.parse(JSON.stringify(session.metadata ?? {})),
          };
          const result: SessionCapture = {
            sessionId: session.sessionId,
            events: [],
            deadLetters: [],
            unknownOutcomeResults: new Set(),
          };
          for (const outcome of await pipeline.processBatch(records, context)) {
            if (outcome.status === "dead_letter") {
              result.deadLetters.push(
                `${outcome.deadLetterRecord.originalEventType}: ${outcome.errorReason}`,
              );
              continue;
            }
            if (outcome.isDuplicate) continue;
            const unknownOutcome = isLocalWorkflowResultSuppressed(outcome.event);
            const observed = recorder.observe(outcome.event, { workspaceId: session.workspaceId });
            if (unknownOutcome) result.unknownOutcomeResults.add(observed);
            result.events.push(observed);
          }
          captures.push(result);
        }
      }
    });
  }
  return captures;
}

function isSettlementBoundary(event: NormalizedSessionEvent): boolean {
  if (event.type === "session_lifecycle") {
    return event.lifecycleType === "end" || event.lifecycleType === "crash";
  }
  return (
    event.type === "message" &&
    event.role === "assistant" &&
    parseAssistantStopReason(event.metadata?.stopReason) !== undefined
  );
}

/** Problems that would make Cloud detection miss or reject this session's work. */
function qualificationProblems(key: string, sessions: SessionCapture[]): string[] {
  const problems: string[] = [];
  const passthroughAllowed = new Set(EXPECTED_PASSTHROUGH[key.split("/")[0]!] ?? []);
  for (const session of sessions) {
    const at = `${session.sessionId}`;
    for (const reason of session.deadLetters) problems.push(`${at} dead letter ${reason}`);
    for (const event of session.events) {
      if (event.type === "tool_call") {
        if (!readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])) {
          problems.push(`${at} tool_call ${event.toolName} (${event.callId}) has no workflowCall`);
        }
      } else if (event.type === "tool_result") {
        if (
          !session.unknownOutcomeResults.has(event) &&
          !readWorkflowResultCarrier(event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY])
        ) {
          problems.push(`${at} tool_result ${event.callId} has no workflowResult`);
        }
      } else if (event.type === "unknown_passthrough") {
        if (!passthroughAllowed.has(event.rawEventType)) {
          problems.push(`unknown_passthrough ${event.rawEventType}`);
        }
      }
    }
    // Each prompt's turn is settled by the next prompt; the last one needs its own boundary.
    const lastPrompt = session.events.findLastIndex(
      (event) => event.type === "message" && event.role === "user",
    );
    const tail = session.events.slice(lastPrompt + 1);
    const answered = tail.some((event) => event.type === "message" && event.role === "assistant");
    const exempt = (UNSETTLED_SESSIONS[key] ?? []).some((pattern) =>
      pattern.test(session.sessionId),
    );
    if (answered && !exempt && !tail.some(isSettlementBoundary)) {
      problems.push(`${at} final turn has no settlement boundary`);
    }
  }
  // One line per distinct problem keeps a drifted fixture's report readable.
  const counts = new Map<string, number>();
  for (const problem of problems) counts.set(problem, (counts.get(problem) ?? 0) + 1);
  return [...counts].map(([problem, count]) => (count > 1 ? `${problem} (x${count})` : problem));
}

const cases = HARNESS_DEFINITIONS.flatMap((definition) =>
  definition.testedVersions.length > 0
    ? definition.testedVersions.map((version) => ({ definition, version }))
    : [{ definition, version: undefined as string | undefined }],
);

describe("harness registry qualification", () => {
  it.each(HARNESS_DEFINITIONS.map((definition) => [definition.id, definition] as const))(
    "%s has recorded fixtures for every tested version",
    (_id, definition) => {
      const recorded = recordedVersions(definition);
      expect(definition.testedVersions.filter((version) => !recorded.includes(version))).toEqual(
        [],
      );
    },
  );

  it.each(
    cases.map(
      ({ definition, version }) =>
        [`${definition.id}/${version ?? "synthetic"}`, definition, version] as const,
    ),
  )(
    "%s captures without loss",
    async (key, definition, version) => {
      const sessions = await capture(definition, version);
      expect(sessions.length, "discovered sessions").toBeGreaterThan(0);
      expect(qualificationProblems(key, sessions).join("\n")).toBe("");
      const events = sessions.flatMap((session) => session.events);
      expect(
        events.some((event) => event.type === "tool_call"),
        "decoded tool calls",
      ).toBe(true);
    },
    60_000,
  );
});
