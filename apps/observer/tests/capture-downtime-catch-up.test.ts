import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexHarnessAdapter } from "@resin/adapter-codex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudObservationClient,
  DaemonConfigSchema,
  type ModuleContext,
  resolvePaths,
} from "../src/index.js";
import {
  CaptureWatermarkSchema,
  MAX_DOWNTIME_CATCH_UP_MS,
  TrajectoryCaptureRuntimeModule,
  type TrajectoryCaptureRuntimeModuleOptions,
  resolveDowntimeCatchUpFrom,
} from "../src/trajectory-capture-module.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-09-23T12:00:00.000Z").getTime();

function observationClient(): CloudObservationClient {
  // SAFETY: Test double inherits the client prototype and replaces its network calls.
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  const accept = vi.fn(async (batch: { observations?: unknown[] }) => ({
    acceptedCount: batch?.observations?.length ?? 1,
    rejectedCount: 0,
    errors: [],
  }));
  return Object.assign(client, {
    sendTrajectoryObservationBatch: accept,
    sendObservationBatch: accept,
    submitTrajectoryObservation: vi.fn(async () => ({ accepted: true })),
  });
}

function moduleContext(): ModuleContext {
  return {
    config: DaemonConfigSchema.parse({}),
    paths: resolvePaths({ home: os.tmpdir() }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getModule: () => undefined,
  };
}

interface Fixture {
  root: string;
  sessionRoot: string;
  projectPath: string;
  configPath: string;
  stateDir: string;
}

let fixture: Fixture;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-downtime-test-"));
  fixture = {
    root,
    sessionRoot: path.join(root, "sessions"),
    projectPath: path.join(root, "project"),
    configPath: path.join(root, "config.toml"),
    stateDir: path.join(root, "state"),
  };
  fs.mkdirSync(fixture.sessionRoot, { recursive: true });
  fs.mkdirSync(fixture.projectPath, { recursive: true });
  fs.writeFileSync(fixture.configPath, 'model = "gpt-6-luna"\n', "utf8");
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

const watermarkPath = () => path.join(fixture.stateDir, "capture-watermark.json");

/** One daemon run: a module wired like the daemon's, with its sink's session ids. */
function createRun(
  options: Pick<
    TrajectoryCaptureRuntimeModuleOptions,
    "maxDowntimeCatchUpMs" | "telemetryEnabled" | "telemetryConsentUnknown"
  > = {},
) {
  const module = new TrajectoryCaptureRuntimeModule({
    adapters: [
      new CodexHarnessAdapter({
        customConfigPath: fixture.configPath,
        customSessionRoot: fixture.sessionRoot,
      }),
    ],
    observationClient: observationClient(),
    privacyCheckpointPath: path.join(fixture.stateDir, "telemetry-privacy-checkpoint.json"),
    captureWatermarkPath: watermarkPath(),
    ...options,
  });
  const captured = new Set<string>();
  module.getCaptureCoordinator().setSessionEventSink((session, events) => {
    if (events.length > 0) captured.add(session.sessionId);
  });
  return { module, captured, context: moduleContext() };
}

/** Writes a finished Codex rollout whose records and file activity are all at `atMs`. */
function writeFinishedSession(sessionId: string, atMs: number): void {
  const timestamp = new Date(atMs).toISOString();
  const records = [
    {
      type: "session_meta",
      payload: {
        session_id: `native-${sessionId}`,
        id: `thread-${sessionId}`,
        cwd: fixture.projectPath,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        id: `${sessionId}-prompt`,
        role: "user",
        content: [{ type: "input_text", text: `Prompt for ${sessionId}` }],
      },
    },
    { type: "event_msg", payload: { type: "task_started", id: "start", turn_id: "turn" } },
    {
      type: "event_msg",
      payload: { type: "task_complete", id: "complete", turn_id: "turn", success: true },
    },
  ];
  const transcriptPath = path.join(fixture.sessionRoot, `${sessionId}.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    records
      .map((record, ordinal) => `${JSON.stringify({ timestamp, ordinal, ...record })}\n`)
      .join(""),
    "utf8",
  );
  fs.utimesSync(transcriptPath, new Date(atMs), new Date(atMs));
}

/** Runs capture from `startMs` to `stopMs` with nothing to capture, leaving a watermark. */
async function runAndStop(startMs: number, stopMs: number): Promise<void> {
  vi.setSystemTime(startMs);
  const run = createRun();
  await run.module.start(run.context);
  await run.module.getObserverCoordinator().pollOnce();
  vi.setSystemTime(stopMs);
  await run.module.stop(run.context);
}

/** Starts a run at `atMs`, lets it deliver what it attached, and returns the captured ids. */
async function capturedOnStart(
  atMs: number,
  options: { maxDowntimeCatchUpMs?: number } = {},
): Promise<Set<string>> {
  vi.setSystemTime(atMs);
  const run = createRun(options);
  try {
    await run.module.start(run.context);
    await run.module.getObserverCoordinator().pollOnce();
    await run.module.getCaptureCoordinator().waitForIdle();
  } finally {
    await run.module.stop(run.context);
  }
  return run.captured;
}

describe("resolveDowntimeCatchUpFrom", () => {
  const nowMs = T0;
  const base = { nowMs, consentFloorMs: 0, maxWindowMs: 24 * HOUR };

  it("is undefined without a usable watermark", () => {
    expect(resolveDowntimeCatchUpFrom({ ...base, watermarkMs: undefined })).toBeUndefined();
    expect(resolveDowntimeCatchUpFrom({ ...base, watermarkMs: nowMs + MINUTE })).toBeUndefined();
    expect(resolveDowntimeCatchUpFrom({ ...base, watermarkMs: Number.NaN })).toBeUndefined();
    expect(resolveDowntimeCatchUpFrom({ ...base, watermarkMs: nowMs })).toBeUndefined();
  });

  it("starts at the watermark, clamped to the window and the consent floor", () => {
    expect(resolveDowntimeCatchUpFrom({ ...base, watermarkMs: nowMs - HOUR })).toBe(nowMs - HOUR);
    expect(resolveDowntimeCatchUpFrom({ ...base, watermarkMs: nowMs - 48 * HOUR })).toBe(
      nowMs - 24 * HOUR,
    );
    expect(
      resolveDowntimeCatchUpFrom({
        ...base,
        watermarkMs: nowMs - HOUR,
        consentFloorMs: nowMs - MINUTE,
      }),
    ).toBe(nowMs - MINUTE);
    expect(
      resolveDowntimeCatchUpFrom({ ...base, watermarkMs: nowMs - HOUR, consentFloorMs: nowMs }),
    ).toBeUndefined();
  });

  it("documents a 24 hour default window", () => {
    expect(MAX_DOWNTIME_CATCH_UP_MS).toBe(24 * HOUR);
  });
});

describe("TrajectoryCaptureRuntimeModule downtime catch-up", () => {
  it("captures a session that finished while the daemon was down, but not older history", async () => {
    await runAndStop(T0, T0 + MINUTE);
    expect(
      CaptureWatermarkSchema.parse(JSON.parse(fs.readFileSync(watermarkPath(), "utf8"))),
    ).toEqual({ version: 1, lastRunningAtMs: T0 + MINUTE, ownerWorkspaceId: null });

    writeFinishedSession("sess_before_watermark", T0 + 30_000);
    writeFinishedSession("sess_during_downtime", T0 + 10 * MINUTE);

    const captured = await capturedOnStart(T0 + 30 * MINUTE);
    expect([...captured]).toEqual(["sess_during_downtime"]);
  });

  it("does not reach further back than the maximum window", async () => {
    await runAndStop(T0, T0 + MINUTE);
    writeFinishedSession("sess_outside_window", T0 + 2 * HOUR);
    writeFinishedSession("sess_inside_window", T0 + 29 * HOUR);

    const captured = await capturedOnStart(T0 + 30 * HOUR, { maxDowntimeCatchUpMs: 24 * HOUR });
    expect([...captured]).toEqual(["sess_inside_window"]);
  });

  it("keeps observing from start only on a first run without a watermark", async () => {
    writeFinishedSession("sess_before_first_run", T0 - 10 * MINUTE);

    const captured = await capturedOnStart(T0);
    expect([...captured]).toEqual([]);
    // The clean stop leaves the watermark the next start catches up from.
    expect(fs.existsSync(watermarkPath())).toBe(true);
  });

  it("forgets the watermark when telemetry is turned off", async () => {
    await runAndStop(T0, T0 + MINUTE);
    vi.setSystemTime(T0 + 2 * MINUTE);
    const run = createRun();
    run.module.setTelemetryEnabled(false);
    expect(fs.existsSync(watermarkPath())).toBe(false);

    writeFinishedSession("sess_while_disabled", T0 + 3 * MINUTE);
    const captured = await capturedOnStart(T0 + 10 * MINUTE);
    expect([...captured]).toEqual([]);
  });

  it("catches up a signed-out window once consent is verifiable again", async () => {
    await runAndStop(T0, T0 + MINUTE);
    const checkpointPath = path.join(fixture.stateDir, "telemetry-privacy-checkpoint.json");
    const checkpoint = fs.readFileSync(checkpointPath, "utf8");
    const watermark = fs.readFileSync(watermarkPath(), "utf8");

    // A signed-out restart: consent is unknown, so capture is suspended, not withdrawn.
    vi.setSystemTime(T0 + 2 * MINUTE);
    const signedOut = createRun({ telemetryEnabled: false, telemetryConsentUnknown: true });
    signedOut.module.suspendUntilConsentVerified();
    await signedOut.module.start(signedOut.context);
    expect(signedOut.module.getState()).toBe("stopped");
    expect(fs.readFileSync(checkpointPath, "utf8")).toBe(checkpoint);
    expect(fs.readFileSync(watermarkPath(), "utf8")).toBe(watermark);

    writeFinishedSession("sess_while_signed_out", T0 + 5 * MINUTE);
    const captured = await capturedOnStart(T0 + 30 * MINUTE);
    expect([...captured]).toEqual(["sess_while_signed_out"]);
  });

  it("does not recreate a watermark removed underneath a running capture (resin logout)", async () => {
    vi.setSystemTime(T0);
    const run = createRun();
    await run.module.start(run.context);
    await run.module.getObserverCoordinator().pollOnce();
    await vi.waitFor(() => expect(fs.existsSync(watermarkPath())).toBe(true));
    fs.rmSync(watermarkPath());
    vi.setSystemTime(T0 + MINUTE);
    await run.module.stop(run.context);
    expect(fs.existsSync(watermarkPath())).toBe(false);

    writeFinishedSession("sess_after_logout", T0 + 2 * MINUTE);
    const captured = await capturedOnStart(T0 + 10 * MINUTE);
    expect([...captured]).toEqual([]);
  });
});
