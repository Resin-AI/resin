import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessId } from "@resin/contracts";
import type { HarnessInstallation } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uninstallCommand } from "../../src/commands/uninstall.js";
import {
  type HarnessProbeOptions,
  resolveHarnessConfigPath,
} from "../../src/installer/harness-config.js";
import {
  HARNESS_HEALTH_POLL_INTERVAL_MS,
  HarnessHealthCoordinator,
  type HarnessHealthRunner,
  loadHarnessHealthSettings,
  resolveHarnessHealthSettingsPath,
  saveHarnessHealthSettings,
  startHarnessHealthScheduler,
  updateHarnessHealthSettings,
} from "../../src/installer/harness-health.js";
import {
  type HarnessInstallationProbe,
  ReconciliationNodeFsBridge,
} from "../../src/installer/harness-reconciler.js";

let home: string;
let env: NodeJS.ProcessEnv;
let ompConfig: string;
let mtimeSeconds: number;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "resin-registration-repair-"));
  env = { HOME: home, USERPROFILE: home };
  ompConfig = resolveHarnessConfigPath("omp", home, env);
  mtimeSeconds = Math.floor(Date.now() / 1000);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

function probeRecorder(present: readonly HarnessId[]): {
  probe: HarnessInstallationProbe;
  probed: HarnessId[];
} {
  const probed: HarnessId[] = [];
  const probe = async ({
    harnessId,
    targetPath,
  }: HarnessProbeOptions): Promise<HarnessInstallation | null> => {
    probed.push(harnessId);
    return present.includes(harnessId)
      ? {
          harnessId,
          displayName: harnessId,
          version: "test",
          isInstalled: true,
          status: "ready",
          configPath: targetPath,
          detectedAt: "2026-10-08T12:00:00.000Z",
          metadata: {},
        }
      : null;
  };
  return { probe, probed };
}

function coordinator(probeHarness: HarnessInstallationProbe): HarnessHealthCoordinator {
  return new HarnessHealthCoordinator({
    home,
    env,
    workspacePath: home,
    resinCommand: "resin",
    fsBridge: new ReconciliationNodeFsBridge(),
    probeHarness,
    harnesses: ["omp"],
  });
}

/** Writes `content` as another tool would, with an mtime the fingerprint cannot miss. */
async function foreignWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  mtimeSeconds += 10;
  await utimes(filePath, mtimeSeconds, mtimeSeconds);
}

async function readServers(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(ompConfig, "utf8")).mcpServers;
}

async function backupsOf(filePath: string): Promise<string[]> {
  const prefix = `${path.basename(filePath)}.resin-backup.`;
  return (await readdir(path.dirname(filePath)))
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(path.dirname(filePath), name));
}

function silenceStdout(): void {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

const BLENDER_ONLY = `${JSON.stringify(
  { mcpServers: { blender: { command: "uvx", args: ["blender-mcp"] } } },
  null,
  2,
)}\n`;

describe("resident harness registration repair", () => {
  it("re-adds Resin that another installer dropped, keeping its servers and backing up its file", async () => {
    const { probe } = probeRecorder(["omp"]);
    const health = coordinator(probe);
    await foreignWrite(ompConfig, `${JSON.stringify({ mcpServers: {} })}\n`);
    expect((await health.run({ trigger: "startup" })).status).toBe("checked");
    expect(await readServers()).toHaveProperty("resin");

    // Another installer rewrites mcp.json with only its own server.
    await foreignWrite(ompConfig, BLENDER_ONLY);
    const repaired = await health.run({ trigger: "scheduled" });

    expect(repaired.status).toBe("checked");
    expect(repaired.snapshot?.harnesses).toEqual([
      expect.objectContaining({
        harnessId: "omp",
        configured: true,
        changed: true,
        recentAction: expect.objectContaining({ kind: "reconciled" }),
      }),
    ]);
    const servers = await readServers();
    expect(servers.blender).toEqual({ command: "uvx", args: ["blender-mcp"] });
    expect(servers.resin).toMatchObject({ command: "resin", args: ["mcp"] });
    const backups = await Promise.all(
      (await backupsOf(ompConfig)).map((backup) => readFile(backup, "utf8")),
    );
    expect(backups).toContain(BLENDER_ONLY);

    // Nothing changed since: the next poll costs only fingerprints.
    expect((await health.run({ trigger: "scheduled" })).status).toBe("debounced");
  });

  it("checks only the changed harness between full checks, without probing its installation", async () => {
    const { probe, probed } = probeRecorder(["omp"]);
    const health = new HarnessHealthCoordinator({
      home,
      env,
      workspacePath: home,
      resinCommand: "resin",
      fsBridge: new ReconciliationNodeFsBridge(),
      probeHarness: probe,
    });
    await foreignWrite(ompConfig, `${JSON.stringify({ mcpServers: {} })}\n`);
    const first = await health.run({ trigger: "startup" });
    expect(first.status).toBe("checked");
    const fullCheckProbes = probed.length;
    expect(fullCheckProbes).toBeGreaterThan(1);

    await foreignWrite(ompConfig, BLENDER_ONLY);
    const partial = await health.run({ trigger: "scheduled" });

    expect(partial.status).toBe("checked");
    expect(probed.length).toBe(fullCheckProbes);
    // The full check's time is kept so the hourly full check keeps its cadence.
    expect(partial.snapshot?.checkedAt).toBe(first.snapshot?.checkedAt);
    expect(partial.snapshot?.harnesses.map((harness) => harness.harnessId)).toEqual(
      first.snapshot?.harnesses.map((harness) => harness.harnessId),
    );
    expect(await readServers()).toHaveProperty("resin");
  });

  it("restores Resin's guidance block when another tool rewrites the guidance file", async () => {
    const { probe } = probeRecorder(["omp"]);
    const health = coordinator(probe);
    await foreignWrite(ompConfig, `${JSON.stringify({ mcpServers: {} })}\n`);
    await health.run({ trigger: "startup" });
    const guidancePath = path.join(home, ".omp", "agent", "AGENTS.md");
    expect(await readFile(guidancePath, "utf8")).toContain("resin");

    await foreignWrite(guidancePath, "# My agent notes\n");
    const repaired = await health.run({ trigger: "scheduled" });

    expect(repaired.status).toBe("checked");
    const guidance = await readFile(guidancePath, "utf8");
    expect(guidance).toContain("# My agent notes");
    expect(guidance).toContain("resin");
  });

  it("does not re-add Resin to a harness the user removed it from", async () => {
    silenceStdout();
    const { probe } = probeRecorder(["omp"]);
    const health = coordinator(probe);
    await foreignWrite(
      ompConfig,
      `${JSON.stringify({ mcpServers: { blender: { command: "uvx", args: ["blender-mcp"] } } })}\n`,
    );
    await health.run({ trigger: "startup" });
    expect(await readServers()).toHaveProperty("resin");

    expect(await uninstallCommand(["--harness", "omp", "--home", home], { env })).toBe(0);
    expect(await readServers()).toEqual({ blender: { command: "uvx", args: ["blender-mcp"] } });
    expect((await loadHarnessHealthSettings({ home })).disabledHarnesses).toEqual(["omp"]);

    const scheduled = await health.run({ trigger: "scheduled" });
    const repair = await health.run({ trigger: "repair", force: true, autoRepair: true });

    expect(scheduled.status).toBe("checked");
    expect(scheduled.snapshot?.disabledHarnesses).toEqual(["omp"]);
    expect(repair.snapshot?.harnesses).toEqual([]);
    expect(await readServers()).toEqual({ blender: { command: "uvx", args: ["blender-mcp"] } });

    // `resin init --harness omp` clears the opt-out; repair then applies again.
    await updateHarnessHealthSettings({ enableHarnesses: ["omp"] }, { home });
    const reEnabled = await health.run({ trigger: "scheduled" });
    expect(reEnabled.status).toBe("checked");
    expect(await readServers()).toHaveProperty("resin");
  });

  it("keeps a Resin entry the user disabled in the harness config as it is", async () => {
    const { probe } = probeRecorder(["omp"]);
    const health = coordinator(probe);
    await foreignWrite(ompConfig, `${JSON.stringify({ mcpServers: {} })}\n`);
    await health.run({ trigger: "startup" });
    const config = JSON.parse(await readFile(ompConfig, "utf8"));
    config.mcpServers.resin.disabled = true;
    const disabledByUser = `${JSON.stringify(config, null, 2)}\n`;
    await foreignWrite(ompConfig, disabledByUser);

    const check = await health.run({ trigger: "repair", force: true, autoRepair: true });

    expect(check.snapshot?.harnesses[0]).toMatchObject({ configured: true, changed: false });
    expect(await readFile(ompConfig, "utf8")).toBe(disabledByUser);
  });

  it("leaves a dropped registration alone when automatic repair is off", async () => {
    const { probe } = probeRecorder(["omp"]);
    const health = coordinator(probe);
    await foreignWrite(ompConfig, `${JSON.stringify({ mcpServers: {} })}\n`);
    await health.run({ trigger: "startup" });
    await saveHarnessHealthSettings(false, { home });

    await foreignWrite(ompConfig, BLENDER_ONLY);
    const check = await health.run({ trigger: "scheduled" });

    expect(check.snapshot).toMatchObject({ autoRepair: false, hasDrift: true });
    expect(await readFile(ompConfig, "utf8")).toBe(BLENDER_ONLY);
  });
});

describe("harness health settings", () => {
  it("keeps opt-outs and the repair setting independent", async () => {
    await updateHarnessHealthSettings({ disableHarnesses: ["omp", "claude-code"] }, { home });
    await saveHarnessHealthSettings(false, { home });
    expect(await loadHarnessHealthSettings({ home })).toEqual({
      format: "resin-harness-health-settings/v1",
      autoRepair: false,
      disabledHarnesses: ["claude-code", "omp"],
    });

    await updateHarnessHealthSettings({ enableHarnesses: ["claude-code", "omp"] }, { home });
    // Without opt-outs the file keeps the shape builds that predate them can read.
    expect(JSON.parse(await readFile(resolveHarnessHealthSettingsPath(home), "utf8"))).toEqual({
      format: "resin-harness-health-settings/v1",
      autoRepair: false,
    });
  });

  it("rejects an unknown harness id in uninstall --harness without changing anything", async () => {
    silenceStdout();
    expect(await uninstallCommand(["--harness", "not-a-harness", "--home", home], { env })).toBe(1);
    expect((await loadHarnessHealthSettings({ home })).disabledHarnesses).toEqual([]);
  });
});

describe("resident scheduler", () => {
  it("polls for changes every few seconds, not hourly", async () => {
    vi.useFakeTimers();
    try {
      const runs: string[] = [];
      const runner: HarnessHealthRunner = {
        run: async (options = {}) => {
          runs.push(options.trigger ?? "scheduled");
          return { status: "debounced", snapshot: null };
        },
      };
      const scheduler = startHarnessHealthScheduler({ runner });
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toEqual(["startup"]);
      await vi.advanceTimersByTimeAsync(HARNESS_HEALTH_POLL_INTERVAL_MS);
      expect(runs).toEqual(["startup", "scheduled"]);
      expect(HARNESS_HEALTH_POLL_INTERVAL_MS).toBeLessThanOrEqual(60_000);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
