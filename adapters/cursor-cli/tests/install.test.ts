import * as fs from "node:fs";
import path from "node:path";
import { applyConfigMutation, applyManagedBlock } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  CURSOR_CAPTURE_HOOK_EVENTS,
  cursorHarness,
  installCursorCaptureHooks,
  renderCursorHookCommand,
  resolveCursorHookScriptPath,
  resolveCursorHooksPath,
  resolveCursorMcpServer,
  resolveCursorSpoolDir,
  uninstallCursorCaptureHooks,
  verifyCursorCaptureHooks,
} from "../src/index.js";
import { fsBridge, installedHook, tempHome } from "./helpers.js";

const FOREIGN_HOOK = { command: "/bin/sh /opt/other/cursor-hook.sh", timeout: 10 };

describe("capture hooks install", () => {
  it("adds Resin once per event next to foreign hooks and removes only Resin's entries", async () => {
    const home = tempHome();
    const hooksPath = resolveCursorHooksPath(home);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    const original = {
      version: 1,
      hooks: { postToolUse: [FOREIGN_HOOK], preToolUse: [FOREIGN_HOOK] },
    };
    fs.writeFileSync(hooksPath, JSON.stringify(original));
    const context = { home, env: {}, fsBridge };

    const first = await installCursorCaptureHooks(context);
    expect(first.map((result) => result.action)).toEqual(["created", "updated"]);
    const second = await installCursorCaptureHooks(context);
    expect(second.map((result) => result.action)).toEqual(["unchanged", "unchanged"]);
    expect(await verifyCursorCaptureHooks(context)).toBe(true);

    const installed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    const command = renderCursorHookCommand(resolveCursorHookScriptPath(home));
    for (const event of CURSOR_CAPTURE_HOOK_EVENTS) {
      expect(
        installed.hooks[event].filter((entry: { command: string }) => entry.command === command),
      ).toHaveLength(1);
    }
    expect(installed.hooks.postToolUse[0]).toEqual(FOREIGN_HOOK);
    // Permission gates are never registered.
    expect(installed.hooks.preToolUse).toEqual([FOREIGN_HOOK]);
    expect(installed.hooks.beforeShellExecution).toBeUndefined();

    const removed = await uninstallCursorCaptureHooks(context);
    expect(removed.map((result) => result.action)).toEqual(["updated", "removed"]);
    expect(JSON.parse(fs.readFileSync(hooksPath, "utf8"))).toEqual(original);
    expect(fs.existsSync(resolveCursorHookScriptPath(home))).toBe(false);
    expect(await verifyCursorCaptureHooks(context)).toBe(false);
    expect((await uninstallCursorCaptureHooks(context)).map((result) => result.action)).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });

  it("deletes a hooks file that only held Resin's entries", async () => {
    const home = tempHome();
    const context = { home, env: {}, fsBridge };
    await installCursorCaptureHooks(context);
    await uninstallCursorCaptureHooks(context);
    expect(fs.existsSync(resolveCursorHooksPath(home))).toBe(false);
  });

  it("refuses to rewrite an unparseable hooks file", async () => {
    const home = tempHome();
    const hooksPath = resolveCursorHooksPath(home);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, "{ not json");
    await expect(installCursorCaptureHooks({ home, env: {}, fsBridge })).rejects.toThrow(
      /not valid JSON/,
    );
    expect(fs.readFileSync(hooksPath, "utf8")).toBe("{ not json");
  });

  it("dry run reports without writing", async () => {
    const home = tempHome();
    const results = await installCursorCaptureHooks({ home, env: {}, fsBridge, dryRun: true });
    expect(results.map((result) => result.action)).toEqual(["created", "created"]);
    expect(fs.existsSync(resolveCursorHooksPath(home))).toBe(false);
  });
});

describe("capture hook script", () => {
  it("appends each payload to its conversation spool, stamped and without user_email, printing nothing", async () => {
    const home = tempHome();
    const run = await installedHook(home);
    const payload = {
      conversation_id: "conv-1",
      hook_event_name: "afterAgentResponse",
      text: "hi",
      user_email: "someone@example.com",
      workspace_roots: ["/w"],
    };
    expect(run(payload)).toBe("");
    expect(run(payload)).toBe("");
    expect(run("not json")).toBe("");
    const lines = fs
      .readFileSync(path.join(resolveCursorSpoolDir(home), "conv-1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].user_email).toBeUndefined();
    expect(lines[0].text).toBe("hi");
    expect(Number.isNaN(Date.parse(lines[0].resin_received_at))).toBe(false);
    expect(fs.readdirSync(resolveCursorSpoolDir(home))).toEqual(["conv-1.jsonl"]);
  });

  it("cannot escape the spool directory through the conversation id", async () => {
    const home = tempHome();
    const run = await installedHook(home);
    run({ conversation_id: "../../escape", hook_event_name: "stop", status: "completed" });
    expect(fs.readdirSync(resolveCursorSpoolDir(home))).toEqual(["______escape.jsonl"]);
  });
});

describe("MCP registration and guidance", () => {
  it("registers Resin in ~/.cursor/mcp.json idempotently, keeping other servers", async () => {
    const home = tempHome();
    const targetPath = cursorHarness.mcpConfig.resolvePath(home, {});
    expect(targetPath).toBe(path.join(home, ".cursor", "mcp.json"));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ mcpServers: { blender: { command: "uvx", args: ["blender-mcp"] } } }),
    );
    const context = {
      targetPath,
      workspace: {
        workspaceId: "w",
        rootPath: home,
        name: "w",
        harnessId: "cursor-cli",
        configPath: targetPath,
        metadata: {},
      },
      gatewayUrl: "http://127.0.0.1:9400/mcp/sse",
      command: "/opt/resin/bin/resin",
      args: ["mcp"],
      fsBridge,
    };
    await applyConfigMutation(await cursorHarness.mcpConfig.planRegistration(context), fsBridge);
    const once = fs.readFileSync(targetPath, "utf8");
    await applyConfigMutation(await cursorHarness.mcpConfig.planRegistration(context), fsBridge);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(once);
    expect(JSON.parse(once).mcpServers).toEqual({
      blender: { command: "uvx", args: ["blender-mcp"] },
      resin: { command: "/opt/resin/bin/resin", args: ["mcp"] },
    });
  });

  it("writes an always-applied user rule and removes it cleanly", async () => {
    const home = tempHome();
    const guidance = cursorHarness.guidance;
    if (!guidance) throw new Error("cursor guidance missing");
    const rulePath = guidance.resolvePath(home, {});
    expect(rulePath).toBe(path.join(home, ".cursor", "rules", "resin.mdc"));
    expect(
      (await applyManagedBlock(fsBridge, rulePath, guidance.markers, guidance.body)).action,
    ).toBe("created");
    expect(
      (await applyManagedBlock(fsBridge, rulePath, guidance.markers, guidance.body)).action,
    ).toBe("unchanged");
    expect(fs.readFileSync(rulePath, "utf8")).toMatch(
      /^---\ndescription: .+\nalwaysApply: true\n---\n/,
    );
    expect((await applyManagedBlock(fsBridge, rulePath, guidance.markers, null)).action).toBe(
      "removed",
    );
    expect(fs.existsSync(rulePath)).toBe(false);
  });
});

describe("declared MCP servers", () => {
  it("prefers the project's .cursor/mcp.json over the user-level file", () => {
    const home = tempHome();
    const project = tempHome();
    for (const [dir, command] of [
      [path.join(home, ".cursor"), "user-echo"],
      [path.join(project, ".cursor"), "project-echo"],
    ] as const) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: { demo: { command, args: ["--x"] }, remote: { url: "http://h/mcp" } },
        }),
      );
    }
    expect(resolveCursorMcpServer("demo", project, home)).toEqual({
      name: "demo",
      transport: { kind: "stdio", command: "project-echo", args: ["--x"] },
    });
    expect(resolveCursorMcpServer("remote", tempHome(), home)).toEqual({
      name: "remote",
      transport: { kind: "http", url: "http://h/mcp" },
    });
    expect(resolveCursorMcpServer("missing", project, home)).toBeUndefined();
  });
});
