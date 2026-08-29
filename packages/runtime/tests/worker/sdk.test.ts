import { describe, expect, it, vi } from "vitest";
import {
  DefaultToolBrokerClient,
  type ToolContext,
  createToolContext,
  defineTool,
} from "../../src/worker/sdk.js";

describe("Tool SDK", () => {
  describe("defineTool", () => {
    it("returns the handler function without modification", async () => {
      const handler = defineTool(async (ctx: ToolContext<{ x: number }>) => {
        return ctx.input.x * 2;
      });

      expect(typeof handler).toBe("function");
    });
  });

  describe("createToolContext", () => {
    it("creates context with input, logging and progress callbacks", async () => {
      const progressLogs: Array<{ pct: number; msg?: string; stage?: string }> = [];
      const logs: Array<{ level: string; msg: string; data?: unknown }> = [];

      const ctx = createToolContext({
        input: { name: "test-input" },
        invocationId: "inv-test-1",
        workspaceRoot: "/test/root",
        scratchDir: "/tmp/scratch",
        metadata: { tag: "alpha" },
        onProgress: (pct, msg, stage) => {
          progressLogs.push({ pct, msg, stage });
        },
        onLog: (level, msg, data) => {
          logs.push({ level, msg, data });
        },
        brokerHandler: async () => ({}),
      });

      expect(ctx.input).toEqual({ name: "test-input" });
      expect(ctx.invocationId).toBe("inv-test-1");
      expect(ctx.workspaceRoot).toBe("/test/root");
      expect(ctx.scratchDir).toBe("/tmp/scratch");
      expect(ctx.metadata).toEqual({ tag: "alpha" });

      await ctx.progress(25, "Quarter done", "stage-1");
      expect(progressLogs).toHaveLength(1);
      expect(progressLogs[0]).toEqual({ pct: 25, msg: "Quarter done", stage: "stage-1" });

      await ctx.logger.info("Informational message", { key: "val" });
      await ctx.logger.debug("Debug msg");
      await ctx.logger.warn("Warning msg");
      await ctx.logger.error("Error msg");

      expect(logs).toHaveLength(4);
      expect(logs[0]?.level).toBe("info");
      expect(logs[0]?.msg).toBe("Informational message");
      expect(logs[0]?.data).toEqual({ key: "val" });
      expect(logs[1]?.level).toBe("debug");
      expect(logs[2]?.level).toBe("warn");
      expect(logs[3]?.level).toBe("error");
    });
  });

  describe("DefaultToolBrokerClient", () => {
    it("routes fs operations through broker handler", async () => {
      const fakeFiles = new Map<string, string>();
      fakeFiles.set("hello.txt", "world");

      const brokerHandler = vi.fn(
        async (service: string, action: string, payload: Record<string, unknown>) => {
          if (service === "fs") {
            if (action === "readFile") {
              const p = payload.path as string;
              if (!fakeFiles.has(p)) throw new Error("File not found");
              return { content: fakeFiles.get(p), encoding: "utf-8" };
            }
            if (action === "writeFile") {
              fakeFiles.set(payload.path as string, payload.content as string);
              return {};
            }
            if (action === "exists") {
              return { exists: fakeFiles.has(payload.path as string) };
            }
            if (action === "listDir") {
              return { entries: Array.from(fakeFiles.keys()) };
            }
            if (action === "stat") {
              return { size: 5, isFile: true, isDirectory: false, mtime: new Date().toISOString() };
            }
            if (action === "removeFile") {
              fakeFiles.delete(payload.path as string);
              return {};
            }
          }
          throw new Error(`Unhandled action: ${service}.${action}`);
        },
      );

      const client = new DefaultToolBrokerClient(brokerHandler);

      // Read
      const content = await client.fs.readFile("hello.txt");
      expect(content).toBe("world");

      // Exists
      expect(await client.fs.exists("hello.txt")).toBe(true);
      expect(await client.fs.exists("missing.txt")).toBe(false);

      // Write
      await client.fs.writeFile("new.txt", "created");
      expect(fakeFiles.get("new.txt")).toBe("created");

      // List
      const list = await client.fs.listDir();
      expect(list).toContain("hello.txt");
      expect(list).toContain("new.txt");

      // Stat
      const stat = await client.fs.stat("hello.txt");
      expect(stat.size).toBe(5);
      expect(stat.isFile).toBe(true);

      // Remove
      await client.fs.removeFile("new.txt");
      expect(fakeFiles.has("new.txt")).toBe(false);
    });

    it("routes net, cmd, and secret operations through broker handler", async () => {
      const brokerHandler = vi.fn(
        async (service: string, action: string, payload: Record<string, unknown>) => {
          if (service === "net" && action === "fetch") {
            return {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ message: "fetched successfully" }),
            };
          }
          if (service === "cmd" && action === "exec") {
            return {
              exitCode: 0,
              stdout: `executed: ${payload.command}`,
              stderr: "",
            };
          }
          throw new Error(`Unhandled ${service}.${action}`);
        },
      );

      const client = new DefaultToolBrokerClient(brokerHandler);

      // Net
      const resp = await client.net.fetch("https://api.example.com/data");
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("fetched successfully");
      expect(await resp.json<{ message: string }>()).toEqual({ message: "fetched successfully" });

      // Cmd
      const cmdRes = await client.cmd.exec("echo", ["hello"]);
      expect(cmdRes.exitCode).toBe(0);
      expect(cmdRes.stdout).toBe("executed: echo");

      // Secret - opaque references only
      const ref = client.secret.createReference("API_KEY");
      expect(ref.kind).toBe("secret_reference");
      expect(ref.name).toBe("API_KEY");
      expect("secret" in ref).toBe(false);
      expect("value" in ref).toBe(false);

      const bearer = client.secret.bearerToken("API_KEY");
      expect(bearer.permittedModes).toContain("bearer_token");

      const templateStr = client.secret.template("API_KEY");
      expect(templateStr).toBe("{{secret:API_KEY}}");

      expect("getSecret" in client.secret).toBe(false);
    });
  });
});
