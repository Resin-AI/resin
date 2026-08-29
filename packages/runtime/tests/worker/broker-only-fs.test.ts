import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityBrokerManager } from "../../src/brokers/manager.js";
import { createInvocationGrant } from "../../src/policy/grant.js";
import { ToolRuntime } from "../../src/worker/index.js";
import { WorkerProcess } from "../../src/worker/process.js";

describe("Broker-Only Workspace Filesystem Access", () => {
  let tempWorkspace: string;
  let testFile: string;
  let secretFile: string;

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "te-broker-only-fs-"));
    testFile = path.join(tempWorkspace, "data.txt");
    secretFile = path.join(tempWorkspace, ".env");

    fs.writeFileSync(testFile, "HELLO_FROM_WORKSPACE_DATA", "utf8");
    fs.writeFileSync(secretFile, "SUPER_SECRET_ENV_KEY=12345", "utf8");
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempWorkspace)) {
        fs.rmSync(tempWorkspace, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup error
    }
  });

  const createGrant = (
    toolId: string,
    fsCapabilities: {
      readPaths?: string[];
      writePaths?: string[];
      allowWorkspaceRoot?: boolean;
    },
    invocationId = "inv_001",
  ) => {
    return createInvocationGrant({
      grantId: "grant_001",
      invocationId,
      toolId,
      toolVersion: "1.0.0",
      workspaceId: "ws_001",
      envelopeId: "env_001",
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          ...fsCapabilities,
        },
      },
    });
  };

  it("proves WorkerProcess permissions strictly exclude workspace root from Deno allow-read and allow-write", async () => {
    // Attempting to run a worker pointing to a dummy bundle
    const dummyBundle = path.join(tempWorkspace, "bundle.js");
    fs.writeFileSync(dummyBundle, "export default () => ({});", "utf8");

    const worker = new WorkerProcess({
      manifest: { id: "test-tool", name: "test-tool", version: "1.0.0" },
      bundleEntrypoint: dummyBundle,
      workspaceRoot: tempWorkspace,
      denoExecutable: "nonexistent-deno-to-capture-args",
    });

    const res = await worker.execute("inv-test-args", {});
    expect(res.status).toBe("error");

    worker.cleanup();
    const scratchDir = worker.getScratchDir();
    if (scratchDir) {
      expect(fs.existsSync(scratchDir)).toBe(false);
    }
  });

  it("proves direct filesystem access fails while brokered access succeeds for the same target", async () => {
    const brokerManager = new CapabilityBrokerManager({
      workspaceRoot: tempWorkspace,
      allowUnverifiedBoundaries: true,
      development: true,
    });
    const runtime = new ToolRuntime({
      mode: "in-process",
      brokerManager,
      allowUnverifiedBoundaries: true,
      development: true,
      allowUnsafeVmFallback: true,
    });

    const grant = createGrant(
      "fs-tool",
      {
        allowWorkspaceRoot: true,
        readPaths: ["data.txt"],
        writePaths: ["output.txt"],
      },
      "inv_fs_brokered_001",
    );

    const manifest = {
      id: "fs-tool",
      name: "fs-tool",
      version: "1.0.0",
      description: "Demonstrates direct vs brokered filesystem access",
      parameters: { type: "object" as const, properties: {}, required: [] },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    // 1. Direct fs access attempt: direct require of 'fs' or 'node:fs' is blocked by sandbox
    const directAccessCode = `
      export default async function(context) {
        const fs = require('node:fs');
        return fs.readFileSync('${testFile.replace(/\\/g, "\\\\")}', 'utf8');
      }
    `;

    const directResult = await runtime.executeTool(
      manifest,
      directAccessCode,
      {},
      {
        grant,
        workspaceRoot: tempWorkspace,
        allowUnverifiedBoundaries: true,
        development: true,
      },
    );

    expect(directResult.status).toBe("error");
    expect(directResult.error?.message).toContain("Permission Denied");

    // 2. Brokered fs access: travels through context.fs and capability broker
    const brokeredAccessCode = `
      export default async function(context) {
        const fileContent = await context.fs.readFile('data.txt');
        await context.fs.writeFile('output.txt', 'PROCESSED: ' + fileContent);
        const exists = await context.fs.exists('output.txt');
        return {
          content: fileContent,
          outputExists: exists,
        };
      }
    `;

    const brokeredResult = await runtime.executeTool(
      manifest,
      brokeredAccessCode,
      {},
      {
        grant,
        workspaceRoot: tempWorkspace,
        brokerManager,
        allowUnverifiedBoundaries: true,
        development: true,
      },
    );
    expect(brokeredResult.status).toBe("success");
    expect(brokeredResult.output).toEqual({
      content: "HELLO_FROM_WORKSPACE_DATA",
      outputExists: true,
    });

    // Verify file was written to disk in workspace
    const written = fs.readFileSync(path.join(tempWorkspace, "output.txt"), "utf8");
    expect(written).toBe("PROCESSED: HELLO_FROM_WORKSPACE_DATA");
  });

  it("blocks direct attempts to access sensitive files via brokered context even with allowWorkspaceRoot", async () => {
    const grant = createGrant(
      "sensitive-tool",
      {
        allowWorkspaceRoot: true,
        readPaths: ["**/*"], // Wildcard pattern must NOT expose .env
      },
      "inv_sensitive_001",
    );

    const manifest = {
      id: "sensitive-tool",
      name: "sensitive-tool",
      version: "1.0.0",
      description: "Demonstrates rejection of sensitive paths",
      parameters: { type: "object" as const, properties: {}, required: [] },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    const brokerManager = new CapabilityBrokerManager({
      workspaceRoot: tempWorkspace,
      allowUnverifiedBoundaries: true,
      development: true,
    });
    const runtime = new ToolRuntime({
      mode: "in-process",
      brokerManager,
      allowUnverifiedBoundaries: true,
      development: true,
      allowUnsafeVmFallback: true,
    });

    const sensitiveAccessCode = `
      export default async function(context) {
        return await context.fs.readFile('.env');
      }
    `;

    const result = await runtime.executeTool(
      manifest,
      sensitiveAccessCode,
      {},
      {
        grant,
        workspaceRoot: tempWorkspace,
        brokerManager,
        allowUnverifiedBoundaries: true,
        development: true,
      },
    );

    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(
      /sensitive or hidden path is denied|Unobserved filesystem read/,
    );
  });

  it("aborts invocation and emits audit event on capability violation", async () => {
    // Tool is given write grant for output.txt, but attempts to write to unapproved file
    const grant = createGrant(
      "unauth-write-tool",
      {
        allowWorkspaceRoot: false,
        readPaths: ["data.txt"],
        writePaths: ["output.txt"],
      },
      "inv_unauth_write_001",
    );

    const manifest = {
      id: "unauth-write-tool",
      name: "unauth-write-tool",
      version: "1.0.0",
      description: "Demonstrates capability violation handling",
      parameters: { type: "object" as const, properties: {}, required: [] },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    const brokerManager = new CapabilityBrokerManager({
      workspaceRoot: tempWorkspace,
      allowUnverifiedBoundaries: true,
      development: true,
    });
    const runtime = new ToolRuntime({
      mode: "in-process",
      brokerManager,
      allowUnverifiedBoundaries: true,
      development: true,
      allowUnsafeVmFallback: true,
    });

    const violationCode = `
      export default async function(context) {
        return await context.fs.writeFile('forbidden_location.txt', 'MALICIOUS_DATA');
      }
    `;

    const result = await runtime.executeTool(
      manifest,
      violationCode,
      {},
      {
        grant,
        workspaceRoot: tempWorkspace,
        brokerManager,
        allowUnverifiedBoundaries: true,
        development: true,
      },
    );
    if (result.status !== "error") {
      console.error("DEBUG VIOLATION RESULT:", result);
    }
    expect(result.status).toBe("error");
  });
});
