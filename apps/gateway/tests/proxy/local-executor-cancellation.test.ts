/**
 * A recorded workflow run by the real local executor stops when its invocation does: the caller's
 * cancel or the call deadline kills the running step's process tree, no later step runs, and the
 * result says the invocation was cancelled or timed out.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ToolManifest } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import {
  ArtifactCache,
  RESIN_PROCESS_RUNTIME,
  compileRecordedWorkflow,
  createProcessAdapter,
  encodeDeterministicTar,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAILURE_REASON_META_KEY } from "../../src/meta/invocation-failure.js";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { type WorkspaceContext, resolveWorkspaceContext } from "../../src/workspace-resolver.js";

/** A recorded bash step running `source` through its `command` argument. */
function shellStep(id: string, source: string, dependsOn: string[]) {
  return {
    id,
    callId: `call_${id}`,
    callable: {
      runtime: RESIN_PROCESS_RUNTIME,
      name: "bash",
      program: { kind: "shell", source, argument: "command", dialect: "bash" },
    },
    arguments: [{ name: "command", source: { kind: "literal", value: source } }],
    dependsOn,
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
  };
}

// The steps run real process trees: neither a file another process writes nor the exit of a
// process that is not this one's child emits an event to await, so both are polled briefly.

/** The pid the sleep step wrote, once it wrote it. */
async function sleepPid(workspaceDir: string): Promise<number> {
  const file = path.join(workspaceDir, "sleep.pid");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    if (/^\d+$/.test(text)) return Number(text);
    if (Date.now() > deadline) throw new Error("the sleep step never started");
    await delay(20);
  }
}

/** Whether `pid` still runs: a zombie waiting to be reaped has already been killed. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return process.platform !== "linux";
  }
}

describe.skipIf(process.platform === "win32")(
  "cancelling a recorded workflow in the gateway",
  () => {
    let tempDir: string;
    let workspaceDir: string;
    let cache: ArtifactCache;
    let context: WorkspaceContext;
    let installed: { manifest: ToolManifest; artifactDigest: string };

    beforeEach(async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-cancellation-gateway-"));
      workspaceDir = path.join(tempDir, "workspace");
      fs.mkdirSync(workspaceDir, { recursive: true });
      cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
      context = resolveWorkspaceContext({ cwd: workspaceDir });
      installed = await installPlan();
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    /**
     * A step that starts `sleep 30` in the background, records its pid and waits for it — so the
     * sleep is a descendant of the step's shell — then a step that leaves a file if it ever runs.
     */
    async function installPlan(): Promise<{ manifest: ToolManifest; artifactDigest: string }> {
      const raw = {
        id: "tool_sleep_then_touch",
        name: "sleep_then_touch",
        version: "1.0.0",
        description: "sleeps, then touches a file",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 60_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
        limits: {},
        scope: "workspace" as const,
        createdAt: "2026-10-01T00:00:00.000Z",
      };
      const manifest = {
        ...raw,
        digest: computeManifestDigest(raw as ToolManifest),
      } as ToolManifest;
      const plan = {
        schemaVersion: 1,
        workflowId: "wf_sleep_then_touch",
        inputs: [],
        steps: [
          shellStep("sleep", "sleep 30 & echo $! > sleep.pid; wait", []),
          shellStep("after", "touch ran", ["sleep"]),
        ],
      };
      const entrypoint = JSON.stringify(compileRecordedWorkflow(plan as never).plan);
      const { archive } = encodeDeterministicTar([
        { path: "manifest.json", content: JSON.stringify(manifest) },
        { path: "src/index.ts", content: entrypoint },
      ]);
      const artifactDigest = crypto.createHash("sha256").update(archive).digest("hex");
      const stagingDir = await cache.createStagingDirectory(artifactDigest);
      fs.mkdirSync(path.join(stagingDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest), "utf8");
      fs.writeFileSync(path.join(stagingDir, "src", "index.ts"), entrypoint, "utf8");
      await cache.commitStagingDirectory(stagingDir, artifactDigest, {
        digest: artifactDigest,
        extractedAt: new Date().toISOString(),
        fileCount: 2,
        totalSizeBytes: archive.length,
        entrypoint: "src/index.ts",
        verified: true,
      });
      return { manifest, artifactDigest };
    }

    it.each([
      {
        reason: "cancelled",
        abort: new Error("Request cancelled"),
        headline: "Tool invocation was cancelled (Request cancelled)",
      },
      {
        reason: "timeout",
        abort: new Error("Request timed out after 600000ms"),
        headline: "Tool invocation timed out (Request timed out after 600000ms)",
      },
    ])(
      "kills the running step and runs no later step when the invocation is $reason",
      async ({ reason, abort, headline }) => {
        const controller = new AbortController();
        const pending = new LocalArtifactExecutor({
          cache,
          workspaceRoot: workspaceDir,
          development: true,
          allowDevKeys: true,
          privateValueStore: new InMemoryPrivateValueStore(),
          recordedWorkflowAdapters: () => [createProcessAdapter({ cwd: workspaceDir })],
        }).execute({
          entry: {
            toolId: installed.manifest.id,
            name: installed.manifest.name,
            version: installed.manifest.version,
            artifactDigest: installed.artifactDigest,
          },
          manifest: installed.manifest,
          parameters: {},
          context,
          signal: controller.signal,
          timeoutMs: 600_000,
        });
        const pid = await sleepPid(workspaceDir);
        expect(running(pid)).toBe(true);
        const abortedAt = Date.now();
        controller.abort(abort);
        const result = await pending;
        expect(Date.now() - abortedAt).toBeLessThan(5_000);

        const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
        expect(result.isError).toBe(true);
        expect(result._meta?.[FAILURE_REASON_META_KEY]).toBe(reason);
        expect(text).toContain(
          `${headline}: the step in flight was stopped and no later step ran.\nStep 1 of 2 failed: recorded program replay was cancelled (${abort.message})`,
        );
        expect(text).toContain("Did not run: step 2/2.");

        const deadline = Date.now() + 5_000;
        while (running(pid) && Date.now() < deadline) await delay(20);
        expect(running(pid), `process ${pid} survived`).toBe(false);
        expect(fs.existsSync(path.join(workspaceDir, "ran"))).toBe(false);
      },
    );
  },
);
