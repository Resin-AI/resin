import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityBrokerManager } from "../../src/brokers/manager.js";
import { createInvocationGrant } from "../../src/policy/grant.js";
import { ToolRuntime } from "../../src/worker/runner.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-read-only-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(root, "file.txt"), "one\n");
  git("add", "file.txt");
  git("commit", "-qm", "fixture");
  return { root, git };
}
const statusArgs = [
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--ignore-submodules=all",
];
async function execute(root: string, body: string, command = `git ${statusArgs.join(" ")}`) {
  const grant = createInvocationGrant({
    grantId: "read-only-grant",
    invocationId: "read-only-inv",
    toolId: "read-only-test",
    toolVersion: "1.0.0",
    workspaceId: "fixture",
    envelopeId: "fixture",
    capabilities: {
      fs: {
        allowWorkspaceRoot: false,
        allowTemp: false,
        readPaths: ["<WORKSPACE_ROOT>", "<WORKSPACE_ROOT>/**"],
      },
      command: { allowedCommands: [command], allowShellExecution: false },
      limits: { maxOutputSizeBytes: 100000 },
    },
  });
  const manager = new CapabilityBrokerManager({
    workspaceRoot: root,
    allowUnverifiedBoundaries: true,
    development: true,
  });
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-read-only-bundle-"));
  roots.push(bundleRoot);
  const entrypoint = path.join(bundleRoot, "tool.js");
  fs.writeFileSync(
    entrypoint,
    `import { defineTool } from "@resin/runtime"; export default defineTool(async context => { ${body} });`,
  );
  return new ToolRuntime({ mode: "deno" }).executeTool(
    {
      id: "read-only-test",
      name: "read_only_test",
      version: "1.0.0",
      description: "Fixture",
      parameters: { type: "object", properties: {} },
    },
    entrypoint,
    {},
    {
      workspaceRoot: root,
      brokerManager: manager,
      grant,
      allowUnverifiedBoundaries: true,
      development: true,
    },
  );
}
describe("real Deno read-only broker path", () => {
  it("suppresses repository fsmonitor hooks without changing the index", async () => {
    const { root, git } = fixture();
    git("config", "core.fsmonitor", "sh -c 'touch sentinel'");
    fs.writeFileSync(path.join(root, "file.txt"), "changed\n");
    const before = fs.readFileSync(path.join(root, ".git/index"));
    const result = await execute(
      root,
      `return context.broker.cmd.exec("git", ${JSON.stringify(statusArgs)}, { readOnlyGit: true });`,
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({ exitCode: 0, stdout: " M file.txt\u0000" });
    expect(fs.existsSync(path.join(root, "sentinel"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".git/index"))).toEqual(before);
  });
  it.each(["include", "filter", "alternates", "symlink"])(
    "rejects unsafe repository configuration: %s",
    async (kind) => {
      const { root, git } = fixture();
      if (kind === "include") git("config", "include.path", "/outside/config");
      if (kind === "filter") git("config", "filter.untrusted.clean", "touch sentinel");
      if (kind === "alternates")
        fs.writeFileSync(path.join(root, ".git/objects/info/alternates"), "/outside/objects");
      if (kind === "symlink") fs.symlinkSync("/outside", path.join(root, ".git/escape"));
      const result = await execute(
        root,
        `return context.broker.cmd.exec("git", ${JSON.stringify(statusArgs)}, { readOnlyGit: true });`,
      );
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("confined read-only Git execution");
    },
  );
  it("returns a bounded prefix only when truncation is explicitly requested", async () => {
    const { root } = fixture();
    for (let n = 0; n < 100; n++)
      fs.writeFileSync(path.join(root, `untracked-${String(n).padStart(3, "0")}.txt`), "");
    const prefix = await execute(
      root,
      `return context.broker.cmd.exec("git", ${JSON.stringify(statusArgs)}, { readOnlyGit: true, truncateOutput: true, maxOutputSizeBytes: 64 });`,
    );
    expect(prefix.status).toBe("success");
    expect(prefix.output).toMatchObject({ truncated: true });
    expect(
      Buffer.byteLength(String((prefix.output as { stdout: string }).stdout)),
    ).toBeLessThanOrEqual(64);
    const bounded = await execute(
      root,
      `return context.broker.cmd.exec("git", ${JSON.stringify(statusArgs)}, { readOnlyGit: true, maxOutputSizeBytes: 64 });`,
    );
    expect(bounded.status).toBe("error");
  });
  it("does not make an authorized mutation eligible for the read-only profile", async () => {
    const { root } = fixture();
    const result = await execute(
      root,
      'return context.broker.cmd.exec("git", ["reset", "--hard"], { readOnlyGit: true });',
      "git reset --hard",
    );
    expect(result.status).toBe("error");
  });
  it("propagates stat metadata, fatal UTF8 decoding, and directory bounds through the loader", async () => {
    const { root } = fixture();
    fs.writeFileSync(path.join(root, "invalid.bin"), Buffer.from([0xff]));
    const metadata = await execute(root, 'return context.broker.fs.stat("file.txt");');
    expect(metadata.error).toBeUndefined();
    expect(metadata.status).toBe("success");
    expect(metadata.output).toMatchObject({ isSymbolicLink: false, isFile: true });
    const invalid = await execute(
      root,
      'return context.broker.fs.readFile("invalid.bin", "utf-8-strict");',
    );
    expect(invalid.status).toBe("error");
    const listing = await execute(
      root,
      'return context.broker.fs.listDir(".", { maxEntries: 1 });',
    );
    expect(listing.status).toBe("error");
  });
});
