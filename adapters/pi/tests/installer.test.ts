import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyConfigMutation,
  applyManagedBlock,
  NodeConfigFsBridge,
} from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { piHarness } from "../src/harness.js";

const fsBridge = new NodeConfigFsBridge();
let home: string;

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-installer-home-"));
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

/** Mirrors the CLI: plan + apply the registration, then install the guidance block. */
async function install(env: NodeJS.ProcessEnv, command = "/opt/resin/bin/resin") {
  const targetPath = piHarness.mcpConfig.resolvePath(home, env);
  const plan = await piHarness.mcpConfig.planRegistration({
    targetPath,
    workspace: {
      workspaceId: "w",
      rootPath: home,
      name: "w",
      harnessId: "pi",
      configPath: targetPath,
      metadata: {},
    },
    gatewayUrl: "http://127.0.0.1:9400/mcp/sse",
    command,
    args: ["mcp"],
    fsBridge,
  });
  await applyConfigMutation(plan, fsBridge);
  const guidance = piHarness.guidance!;
  const block = await applyManagedBlock(
    fsBridge,
    guidance.resolvePath(home, env),
    guidance.markers,
    guidance.body,
  );
  return { targetPath, block };
}

async function uninstall(env: NodeJS.ProcessEnv) {
  const removed = await piHarness.mcpConfig.removeRegistration!({ home, env, fsBridge });
  const guidance = piHarness.guidance!;
  const block = await applyManagedBlock(
    fsBridge,
    guidance.resolvePath(home, env),
    guidance.markers,
    null,
  );
  return { removed, block };
}

describe("Pi installer surface", () => {
  it("installs the bridge extension and guidance idempotently and removes both", async () => {
    const env = { HOME: home };
    const agentDir = path.join(home, ".pi", "agent");
    await fsp.mkdir(agentDir, { recursive: true });
    await fsp.writeFile(path.join(agentDir, "AGENTS.md"), "# Mine\n\nKeep this.\n");

    const first = await install(env);
    expect(first.targetPath).toBe(path.join(agentDir, "extensions", "resin.ts"));
    const extension = await fsp.readFile(first.targetPath, "utf8");
    expect(extension).toContain('"command": "/opt/resin/bin/resin"');
    expect(first.block.action).toBe("updated");
    await expect(
      piHarness.mcpConfig.verifyRegistration!({ targetPath: first.targetPath, command: "/opt/resin/bin/resin", fsBridge }),
    ).resolves.toBe(true);
    await expect(
      piHarness.mcpConfig.verifyRegistration!({ targetPath: first.targetPath, command: "/other/resin", fsBridge }),
    ).resolves.toBe(false);

    const agentsAfterFirst = await fsp.readFile(path.join(agentDir, "AGENTS.md"), "utf8");
    const second = await install(env);
    expect(second.block.action).toBe("unchanged");
    expect(await fsp.readFile(second.targetPath, "utf8")).toBe(extension);
    expect(await fsp.readFile(path.join(agentDir, "AGENTS.md"), "utf8")).toBe(agentsAfterFirst);

    const removed = await uninstall(env);
    expect(removed).toEqual({ removed: true, block: expect.objectContaining({ action: "removed" }) });
    await expect(fsp.access(first.targetPath)).rejects.toThrow();
    expect(await fsp.readdir(path.join(agentDir, "extensions"))).toEqual([]);
    expect(await fsp.readFile(path.join(agentDir, "AGENTS.md"), "utf8")).toBe("# Mine\n\nKeep this.\n");

    expect(await uninstall(env)).toEqual({
      removed: false,
      block: expect.objectContaining({ action: "unchanged" }),
    });
  });

  it("honors PI_CODING_AGENT_DIR and the agent dir's winning context file", async () => {
    const agentDir = path.join(home, "custom-agent");
    const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir };
    await fsp.mkdir(agentDir, { recursive: true });
    // Pi reads only the first existing context file; AGENTS.override.md shadows AGENTS.md.
    await fsp.writeFile(path.join(agentDir, "AGENTS.override.md"), "override\n");
    await fsp.writeFile(path.join(agentDir, "AGENTS.md"), "ignored by Pi\n");

    const { targetPath } = await install(env);
    expect(targetPath).toBe(path.join(agentDir, "extensions", "resin.ts"));
    expect(await fsp.readFile(path.join(agentDir, "AGENTS.override.md"), "utf8")).toContain(
      piHarness.guidance!.markers.start,
    );
    expect(await fsp.readFile(path.join(agentDir, "AGENTS.md"), "utf8")).toBe("ignored by Pi\n");
    await expect(fsp.access(path.join(home, ".pi"))).rejects.toThrow();
  });

  it("never overwrites or deletes a user's own resin.ts extension", async () => {
    const env = { HOME: home };
    const targetPath = piHarness.mcpConfig.resolvePath(home, env);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, "export default function mine() {}\n");

    await expect(install(env)).rejects.toThrow(/not written by Resin/);
    expect(await piHarness.mcpConfig.removeRegistration!({ home, env, fsBridge })).toBe(false);
    expect(await fsp.readFile(targetPath, "utf8")).toBe("export default function mine() {}\n");
  });
});
