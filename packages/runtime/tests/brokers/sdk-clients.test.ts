import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapabilityBrokerManager, createBrokerClients } from "../../src/brokers/index.js";
import { type CreateInvocationGrantParams, createInvocationGrant } from "../../src/policy/grant.js";
import { ToolRuntime } from "../../src/worker/runner.js";
import { defineTool } from "../../src/worker/sdk.js";

describe("Broker SDK Clients & ToolRuntime Integration", () => {
  let tempWorkspace: string;
  let manager: CapabilityBrokerManager;

  beforeAll(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "broker_sdk_ws_"));
    manager = new CapabilityBrokerManager({
      workspaceRoot: tempWorkspace,
      allowUnverifiedBoundaries: true,
      development: true,
      secrets: {
        DATABASE_API_KEY: "secret_db_key_999",
      },
    });
  });

  afterAll(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {}
  });

  const createGrant = (overrides: Partial<CreateInvocationGrantParams> = {}) => {
    return createInvocationGrant({
      grantId: "grant_sdk_test",
      invocationId: "inv_sdk_001",
      toolId: "sdk_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_sdk",
      envelopeId: "env_sdk",
      ...overrides,
      capabilities: {
        fs: {
          readPaths: ["**"],
          writePaths: ["**"],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: true,
          allowedProtocols: ["http", "https"],
          allowLocalhost: true,
        },
        command: {
          allowShellExecution: false,
          allowedBinaries: ["node"],
        },
        secrets: {
          allowedSecretNames: ["DATABASE_API_KEY"],
          denyDirectRead: false,
        },
        limits: {
          maxOutputSizeBytes: 10485760,
          maxExecutionTimeMs: 30000,
        },
      },
    });
  };

  it("exercises FsClient operations via broker RPC", async () => {
    const grant = createGrant();
    const handler = manager.createRequestHandler({
      invocationId: "inv_sdk_001",
      grant,
      workspaceRoot: tempWorkspace,
    });

    const clients = createBrokerClients(handler);

    // 1. Write file
    await clients.fs.writeFile("test.txt", "Hello from FsClient");

    // 2. Exists
    const exists = await clients.fs.exists("test.txt");
    expect(exists).toBe(true);

    // 3. Stat
    const stat = await clients.fs.stat("test.txt");
    expect(stat.size).toBe(Buffer.byteLength("Hello from FsClient"));

    // 4. Read file (string & buffer)
    const textContent = await clients.fs.readFile("test.txt", "utf-8");
    expect(textContent).toBe("Hello from FsClient");

    const bufContent = await clients.fs.readFile("test.txt", "buffer");
    expect(bufContent).toBeInstanceOf(Uint8Array);

    // 5. Append file
    await clients.fs.appendFile("test.txt", " - Appended");
    const appendedText = await clients.fs.readFile("test.txt", "utf-8");
    expect(appendedText).toBe("Hello from FsClient - Appended");

    // 6. Mkdir & List directory
    await clients.fs.mkdir("subdir");
    await clients.fs.writeFile("subdir/nested.txt", "nested data");
    const list = await clients.fs.listDirectory(".", { recursive: true });
    expect(list).toContain("subdir");
    expect(list).toContain("subdir/nested.txt");

    // 7. Rename
    await clients.fs.rename("test.txt", "test_renamed.txt");
    expect(await clients.fs.exists("test.txt")).toBe(false);
    expect(await clients.fs.exists("test_renamed.txt")).toBe(true);

    // 8. Delete
    await clients.fs.delete("subdir", { recursive: true });
    expect(await clients.fs.exists("subdir")).toBe(false);
  });

  it("exercises CommandClient operations via broker RPC", async () => {
    const grant = createGrant();
    const handler = manager.createRequestHandler({
      invocationId: "inv_sdk_001",
      grant,
      workspaceRoot: tempWorkspace,
    });

    const clients = createBrokerClients(handler);
    const scriptPath = path.join(tempWorkspace, "sdk_test.js");
    fs.writeFileSync(scriptPath, "console.log('SDK Command Output');");

    const result = await clients.cmd.execute("node", [scriptPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("SDK Command Output");
  });

  it("exercises SecretClient operations via broker RPC", async () => {
    const grant = createGrant();
    const handler = manager.createRequestHandler({
      invocationId: "inv_sdk_001",
      grant,
      workspaceRoot: tempWorkspace,
    });

    const clients = createBrokerClients(handler);

    // Direct read from worker handler is strictly denied by non-disclosure policy
    await expect(clients.secret.getSecret("DATABASE_API_KEY")).rejects.toThrow();

    // Secret references and template building
    const ref = clients.secret.createReference("DATABASE_API_KEY");
    expect(ref.name).toBe("DATABASE_API_KEY");
    expect(ref.ref).toBeDefined();

    const bearer = clients.secret.bearerToken("DATABASE_API_KEY");
    expect(bearer.name).toBe("DATABASE_API_KEY");

    const tmpl = clients.secret.template("DATABASE_API_KEY");
    expect(tmpl).toBe("{{secret:DATABASE_API_KEY}}");
  });
  it("integrates capability brokers with ToolRuntime and DeterministicWorkerSandbox", async () => {
    const runtime = new ToolRuntime(
      {
        mode: "in-process",
        allowUnverifiedBoundaries: true,
        development: true,
        allowUnsafeVmFallback: true,
      },
      manager,
    );
    const grant = createGrant({ toolId: "broker_demo_tool" });

    const toolManifest = {
      name: "broker_demo_tool",
      version: "1.0.0",
      description: "Demo tool exercising brokers",
      entrypoint: "index.js",
    };
    const toolHandler = defineTool(async (ctx) => {
      // ctx.broker is wired to the capability brokers
      await ctx.broker.fs.writeFile(
        "runtime_demo.txt",
        `Processed for invocation: ${ctx.invocationId}`,
      );
      const content = await ctx.broker.fs.readFile("runtime_demo.txt");
      const stat = await ctx.broker.fs.stat("runtime_demo.txt");

      await ctx.broker.fs.writeFile("script.js", "console.log('Running inside tool');");
      const cmdRes = await ctx.broker.cmd.exec("node", ["script.js"]);

      return {
        savedContent: content,
        fileSize: stat.size,
        commandStdout: cmdRes.stdout.trim(),
      };
    });

    const result = await runtime.executeTool(
      toolManifest,
      toolHandler,
      {},
      {
        grant,
        workspaceRoot: tempWorkspace,
        allowUnverifiedBoundaries: true,
        development: true,
      },
    );

    expect(result.status).toBe("success");
    expect(result.output).toEqual(
      expect.objectContaining({
        savedContent: expect.stringContaining("Processed for invocation"),
        fileSize: expect.any(Number),
        commandStdout: "Running inside tool",
      }),
    );
  });
});
