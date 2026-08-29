import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOmpCatalogInstructions,
  buildOmpCatalogInstructionsBlock,
  parseCatalogInstructionToolNames,
  renderOmpInvocationSnippet,
  syncOmpCatalogInstructions,
} from "../src/instructions.js";

describe("renderOmpInvocationSnippet", () => {
  it("renders xd:// invocation and docs paths with underscored server name", () => {
    const snippet = renderOmpInvocationSnippet("git_operation_helper", "resin");
    expect(snippet).toContain("xd://mcp__resin_git_operation_helper");
    expect(snippet).toContain("write");
    expect(snippet).toContain("read");
  });
});

describe("buildOmpCatalogInstructionsBlock", () => {
  it("wraps markdown in managed markers and appends per-tool invocation snippets", () => {
    const block = buildOmpCatalogInstructionsBlock({
      markdown: "## Evolved Tools\n\n### `git_operation_helper`\n- **Description**: x",
      toolNames: ["git_operation_helper"],
    });
    expect(block).toContain("<!-- resin:catalog:start -->");
    expect(block).toContain("<!-- resin:catalog:end -->");
    expect(block).toContain("## Evolved Tools");
    expect(block).toContain("xd://mcp__resin_git_operation_helper");
  });
});

describe("parseCatalogInstructionToolNames", () => {
  it("extracts tool names from ### headings", () => {
    const md = "## Evolved Tools\n\n### `alpha_tool`\n- d\n\n### `beta_tool`\n- d\n";
    expect(parseCatalogInstructionToolNames(md)).toEqual(["alpha_tool", "beta_tool"]);
  });

  it("returns empty for the no-tools comment", () => {
    expect(
      parseCatalogInstructionToolNames(
        "<!-- No evolved tools currently active in this workspace catalog. -->",
      ),
    ).toEqual([]);
  });
});

describe("applyOmpCatalogInstructions", () => {
  it("creates the append-system file with the managed block", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-instr-test-"));
    try {
      const target = path.join(tmpDir, "agent", "APPEND_SYSTEM.md");
      const result = await applyOmpCatalogInstructions({
        markdown: "## Evolved Tools\n\n### `alpha_tool`\n- **Description**: d",
        toolNames: ["alpha_tool"],
        appendSystemPath: target,
      });
      expect(result.action).toBe("created");
      const content = await fsp.readFile(target, "utf8");
      expect(content).toContain("<!-- resin:catalog:start -->");
      expect(content).toContain("xd://mcp__resin_alpha_tool");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves user content outside the managed block on update", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-instr-test-"));
    try {
      const target = path.join(tmpDir, "APPEND_SYSTEM.md");
      await fsp.writeFile(target, "# My Rules\n\nBe brief.\n", "utf8");
      await applyOmpCatalogInstructions({
        markdown: "## Evolved Tools\n\n### `alpha_tool`\n- d",
        appendSystemPath: target,
      });
      const result = await applyOmpCatalogInstructions({
        markdown: "## Evolved Tools\n\n### `beta_tool`\n- d",
        appendSystemPath: target,
      });
      expect(result.action).toBe("updated");
      const content = await fsp.readFile(target, "utf8");
      expect(content).toContain("# My Rules");
      expect(content).toContain("Be brief.");
      expect(content).toContain("### `beta_tool`");
      expect(content).not.toContain("### `alpha_tool`");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("removes the managed block when markdown is empty", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-instr-test-"));
    try {
      const target = path.join(tmpDir, "APPEND_SYSTEM.md");
      await applyOmpCatalogInstructions({
        markdown: "## Evolved Tools\n\n### `alpha_tool`\n- d",
        appendSystemPath: target,
      });
      const result = await applyOmpCatalogInstructions({
        markdown: "",
        appendSystemPath: target,
      });
      expect(result.action).toBe("removed");
      const content = await fsp.readFile(target, "utf8");
      expect(content).not.toContain("resin:catalog");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("syncOmpCatalogInstructions", () => {
  it("fetches markdown from the cloud route and writes invocation snippets", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-instr-sync-"));
    try {
      const target = path.join(tmpDir, "APPEND_SYSTEM.md");
      const markdown = "## Evolved Tools\n\n### `git_operation_helper`\n- **Description**: d";
      const calls: Array<{ url: string; headers: Record<string, string> }> = [];
      const fetchFn = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
        calls.push({ url: String(url), headers: init?.headers ?? {} });
        return new Response(JSON.stringify({ markdown }), { status: 200 });
      }) as typeof fetch;

      const result = await syncOmpCatalogInstructions({
        cloudUrl: "http://127.0.0.1:8080",
        workspaceId: "ws-1",
        accountId: "acc-1",
        appendSystemPath: target,
        fetchFn,
      });

      expect(result.action).toBe("created");
      expect(calls[0]!.url).toBe("http://127.0.0.1:8080/v1/evolution/catalog/instructions");
      expect(calls[0]!.headers["x-workspace-id"]).toBe("ws-1");
      expect(calls[0]!.headers["x-account-id"]).toBe("acc-1");
      const content = await fsp.readFile(target, "utf8");
      expect(content).toContain("xd://mcp__resin_git_operation_helper");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws on non-200 responses", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(
      syncOmpCatalogInstructions({
        cloudUrl: "http://127.0.0.1:8080",
        workspaceId: "ws-1",
        appendSystemPath: path.join(os.tmpdir(), "never-written.md"),
        fetchFn,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
