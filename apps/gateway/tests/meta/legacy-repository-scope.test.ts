/**
 * An older learned tool, declaring no repository and locating no step, is scoped on the device by
 * the directories its cached plan pins: when every one lies in a checkout of one repository, the
 * tool is offered only in that repository (any clone or worktree), so search, listing, the direct
 * listing count and the suggest index all follow. Real temporary git repositories throughout.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CapabilityManifestSchema,
  type RecordedWorkflow,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
  type WorkflowArgument,
} from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import {
  clearRepositoryIdentityCache,
  repositoryIdentity,
} from "@resin/observer/repository-identity";
import { ArtifactCache, RESIN_HARNESS_TOOL_RUNTIME, encodeDeterministicTar } from "@resin/runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DIRECT_LISTING_MAX_TOOLS, LocalMcpGateway } from "../../src/gateway.js";
import { type SearchToolsResponse, createSearchToolsHandler } from "../../src/meta/search-tools.js";
import {
  type CallToolResult,
  RESIN_LEARNED_TOOL_COUNT_META,
  RESIN_LEARNED_TOOL_LISTING_META,
  RESIN_LEARNED_TOOL_META,
  RESIN_SEARCH_LISTING_META,
} from "../../src/protocol/types.js";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { type GatewayRouter, createRegistryGatewayRouter } from "../../src/router.js";
import { suggestToolsFromCatalog } from "../../src/suggest/index-writer.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Synthetic",
  GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic",
  GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [name, value] of Object.entries(GIT_ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
}

/** A caller whose session started in `directory`, in workspace `workspaceId`. */
function callerIn(directory: string, workspaceId: string): WorkspaceContext {
  return {
    workspaceId,
    projectId: workspaceId,
    projectRoot: directory,
    canonicalRoot: directory,
    startupPath: directory,
    isReadOnly: false,
    name: workspaceId,
    source: "cwd_fallback",
    roots: [{ uri: `file://${directory}`, path: directory, name: workspaceId }],
    sessionId: "ses_legacy",
  } as WorkspaceContext;
}

function parseSearch(result: CallToolResult): SearchToolsResponse {
  const first = result.content[0];
  return JSON.parse(first && "text" in first ? String(first.text) : "{}") as SearchToolsResponse;
}

/** A legacy one-step plan: a harness bash call, with no repository location. */
function legacyPlan(name: string, args: WorkflowArgument[], privateReferences?: string[]) {
  const plan: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: `wf_${name}`,
    inputs: [],
    steps: [
      {
        id: "step0",
        callId: `call_${name}`,
        callable: {
          runtime: RESIN_HARNESS_TOOL_RUNTIME,
          name: "bash",
          program: { kind: "shell", source: "", argument: "command" },
        },
        arguments: args,
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "default" },
        observed: { outcome: "succeeded" },
      },
    ],
    ...(privateReferences === undefined ? {} : { privateReferences }),
  };
  return plan;
}

const command = (value: string): WorkflowArgument => ({
  name: "command",
  source: { kind: "literal", value },
});
const privateCwd = (reference: string): WorkflowArgument => ({
  name: "cwd",
  source: { kind: "private", reference },
});

describe("legacy learned tools scoped by their pinned directories", () => {
  let tempDir: string;
  let repoA: string;
  let worktreeA: string;
  let repoB: string;
  let plain: string;
  let cache: ArtifactCache;
  let privateValues: InMemoryPrivateValueStore;
  let registry: ToolRegistry;

  beforeEach(() => {
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "legacy-scope-")));
    repoA = path.join(tempDir, "alpha");
    repoB = path.join(tempDir, "beta");
    worktreeA = path.join(tempDir, "alpha-worktree");
    plain = path.join(tempDir, "plain");
    fs.mkdirSync(plain);
    for (const [root, marker] of [
      [repoA, "alpha"],
      [repoB, "beta"],
    ] as const) {
      fs.mkdirSync(path.join(root, "sub"), { recursive: true });
      fs.writeFileSync(path.join(root, "sub", "marker.txt"), `${marker}\n`);
      git(root, "init", "-q");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", marker);
    }
    git(repoA, "worktree", "add", "-q", worktreeA);
    cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
    privateValues = new InMemoryPrivateValueStore();
    registry = new ToolRegistry();
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: repoA,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
    });
    registry.setLocalToolProfile((tool, context) =>
      tool.artifactDigest === undefined
        ? undefined
        : executor.recordedWorkflowProfile(tool.artifactDigest, context),
    );
    registry.setLocalToolCommands((tool, context) =>
      tool.artifactDigest === undefined
        ? []
        : executor.recordedWorkflowCommands(tool.artifactDigest, context),
    );
  });

  afterEach(() => {
    clearRepositoryIdentityCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Caches `plan` as a recorded-workflow artifact and registers its tool in `workspaceId`. */
  async function learn(
    name: string,
    plan: RecordedWorkflow,
    workspaceId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const raw = {
      id: `tool_${name}`,
      name,
      version: "1.0.0",
      description: `Runs ${name}.`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      runtime: {
        runtime: "recorded-workflow",
        memoryLimitMb: 64,
        timeoutMs: 10_000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 65_536,
      },
      capabilities: { command: { allowShellExecution: true } },
      limits: {},
      scope: "workspace" as const,
      metadata,
      createdAt: "2026-10-08T00:00:00.000Z",
    };
    const manifest = {
      ...raw,
      digest: computeManifestDigest(raw as unknown as ToolManifest),
    } as unknown as ToolManifest;
    const entrypoint = JSON.stringify(plan);
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
    // The registry holds the catalog entry; the device reads the plan from the cached artifact.
    const entry = {
      id: raw.id,
      name,
      version: "1.0.0",
      description: raw.description,
      parameters: ToolParameterSchema.parse({ type: "object", properties: {} }),
      runtime: ToolRuntimeRequirementSchema.parse({ runtime: "builtin" }),
      capabilities: CapabilityManifestSchema.parse({}),
      limits: ToolLimitConfigSchema.parse({}),
      scope: "workspace" as const,
      metadata,
      createdAt: raw.createdAt,
    };
    await registry.registerTool({ ...entry, digest: computeManifestDigest(entry) }, undefined, {
      workspaceId,
      artifactDigest,
    });
  }

  /** The tools a caller in `directory` is offered by the listing; an empty search agrees. */
  async function offered(directory: string, workspaceId: string): Promise<string[]> {
    const context = callerIn(directory, workspaceId);
    const searched = parseSearch(await createSearchToolsHandler(registry)(context, {}))
      .tools.map((tool) => tool.name)
      .sort();
    const listed = (await createRegistryGatewayRouter(registry).listCatalogNoticeTools(context))
      .filter((tool) => tool._meta?.[RESIN_LEARNED_TOOL_META] === true)
      .map((tool) => tool.name)
      .sort();
    // Search groups near-identical tools under one lead, so it shows a subset of the listing.
    expect(listed).toEqual(expect.arrayContaining(searched));
    expect(searched.length > 0).toBe(listed.length > 0);
    return listed;
  }

  it("offers a tool whose leading cd pins repo A only in repo A and its worktrees", async () => {
    await learn("alpha_sub_tests", legacyPlan("a", [command(`cd ${repoA}/sub && npm test`)]), "ws");
    expect(await offered(repoA, "ws")).toEqual(["alpha_sub_tests"]);
    expect(await offered(path.join(worktreeA, "sub"), "ws")).toEqual(["alpha_sub_tests"]);
    expect(await offered(repoB, "ws")).toEqual([]);
    expect(await offered(plain, "ws")).toEqual([]);
  });

  it("offers a tool whose private cwd resolves into repo A only in repo A and its worktrees", async () => {
    const reference = "private:legacy:cwd";
    privateValues.set(reference, path.join(repoA, "sub"), { workspaceId: "ws-alpha" }, "literal");
    await learn(
      "alpha_private_tests",
      legacyPlan("p", [command("npm test"), privateCwd(reference)], [reference]),
      "ws",
    );
    // The value was recorded by another workspace than the callers', so no caller may run it, yet
    // each is scoped by the repository it names.
    expect(await offered(repoA, "ws")).toEqual(["alpha_private_tests"]);
    expect(await offered(worktreeA, "ws")).toEqual(["alpha_private_tests"]);
    expect(await offered(repoB, "ws")).toEqual([]);
    expect(await offered(plain, "ws")).toEqual([]);
  });

  it("keeps a tool that pins no directory offered everywhere", async () => {
    await learn("gh_pr_status", legacyPlan("g", [command("gh pr status")]), "ws");
    for (const directory of [repoA, worktreeA, repoB, plain]) {
      expect(await offered(directory, "ws")).toEqual(["gh_pr_status"]);
    }
  });

  it("leaves a plan pinning directories in two repositories to the runnable rules", async () => {
    const reference = "private:legacy:split";
    privateValues.set(reference, path.join(repoB, "sub"), { workspaceId: "ws-x" }, "literal");
    await learn(
      "split_tests",
      legacyPlan("s", [command(`cd ${repoA}/sub && npm test`), privateCwd(reference)], [reference]),
      "ws",
    );
    // Not scoped to either; the literal cd into repo A still makes it unrunnable elsewhere.
    expect(await offered(repoA, "ws")).toEqual(["split_tests"]);
    expect(await offered(repoB, "ws")).toEqual([]);
  });

  it("turns on direct listing where legacy scoping brings the catalog to the limit", async () => {
    const alpha = repositoryIdentity(repoA)?.id;
    if (alpha === undefined) throw new Error("repo A has no identity");
    // Six tools declared for repo A, three legacy ones pinned to repo A, one repo-agnostic: ten.
    for (let index = 0; index < 6; index++) {
      await learn(
        `declared_${index}`,
        legacyPlan(`d${index}`, [command(`make job${index}`)]),
        "ws",
        {
          repositories: [alpha],
        },
      );
    }
    for (let index = 0; index < 3; index++) {
      await learn(
        `alpha_legacy_${index}`,
        legacyPlan(`a${index}`, [command(`cd ${repoA}/sub && make check${index}`)]),
        "ws",
      );
    }
    await learn("gh_pr_status", legacyPlan("g", [command("gh pr status")]), "ws");
    // Three legacy tools whose private cwd lies in repo B, recorded by repo B's workspace: the
    // caller in repo A cannot resolve them to run, so only legacy scoping keeps them out.
    for (let index = 0; index < 3; index++) {
      const reference = `private:legacy:beta${index}`;
      privateValues.set(reference, path.join(repoB, "sub"), { workspaceId: "ws-beta" }, "literal");
      await learn(
        `beta_legacy_${index}`,
        legacyPlan(`b${index}`, [command(`make beta${index}`), privateCwd(reference)], [reference]),
        "ws",
      );
    }
    // And one that cannot run here at all: its recorded directory is gone.
    await learn(
      "gone_tests",
      legacyPlan("x", [command("cd /synthetic/deleted-scratch/wt && make gone")]),
      "ws",
    );

    const caller = callerIn(repoA, "ws");
    const registryRouter = createRegistryGatewayRouter(registry);
    const router: GatewayRouter = {
      listTools: () => registryRouter.listTools(caller),
      listCatalogNoticeTools: () => registryRouter.listCatalogNoticeTools(caller),
      callTool: async () => ({ content: [] }),
    };
    const gateway = new LocalMcpGateway({ router, enableRefreshCoordinator: false });
    const connection = gateway.createConnection({ cwd: "/synthetic/caller" });
    const initialized = await gateway.handleMessage(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omp-coding-agent", version: "1" },
        _meta: { [RESIN_SEARCH_LISTING_META]: true },
      },
    });
    const meta = z.object({ result: z.object({ _meta: z.record(z.unknown()) }) }).parse(initialized)
      .result._meta;
    expect(meta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(DIRECT_LISTING_MAX_TOOLS);
    const listing = z
      .array(z.object({ name: z.string() }))
      .parse(meta[RESIN_LEARNED_TOOL_LISTING_META]);
    expect(listing.map((tool) => tool.name).sort()).toEqual(
      [
        ...Array.from({ length: 6 }, (_, index) => `declared_${index}`),
        ...Array.from({ length: 3 }, (_, index) => `alpha_legacy_${index}`),
        "gh_pr_status",
      ].sort(),
    );
    // The suggest index is written from the same scoped catalog.
    const suggested = suggestToolsFromCatalog(await registryRouter.listCatalogNoticeTools(caller));
    expect(suggested.some((tool) => tool.name.startsWith("beta_legacy_"))).toBe(false);
    expect(suggested.some((tool) => tool.name === "gone_tests")).toBe(false);
    expect(suggested.some((tool) => tool.name === "alpha_legacy_0")).toBe(true);

    // In repo B the legacy tools pinned there are offered and repo A's are not.
    expect((await offered(repoB, "ws")).sort()).toEqual(
      ["beta_legacy_0", "beta_legacy_1", "beta_legacy_2", "gh_pr_status"].sort(),
    );
  });
});
