import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { V1_SCHEMA_KINDS, V1_SCHEMA_VERSION } from "@resin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESIN_DIR_GITIGNORE,
  bootstrapProject,
  lockRecordsProjectDecision,
} from "../../src/project/project-bootstrap.js";
import { ProjectLockManager } from "../../src/project/project-lock.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function lockedEntry(name: string, status: "active" | "pinned" | "disabled" = "active") {
  return {
    toolId: crypto.randomUUID(),
    name,
    version: "1.0.0",
    manifestDigest: crypto.createHash("sha256").update(name).digest("hex"),
    artifactDigest: crypto.createHash("sha256").update(`artifact:${name}`).digest("hex"),
    status,
  };
}

describe(".resin/ git visibility", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resin-dir-gitignore-")));
    git(repo, "init", "-q");
    fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "init");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const gitignorePath = () => path.join(repo, ".resin", ".gitignore");

  it("leaves git status clean after a fresh bootstrap", () => {
    const result = bootstrapProject(repo);

    expect(fs.existsSync(result.projectJsonPath)).toBe(true);
    expect(fs.existsSync(result.lockPath)).toBe(true);
    expect(fs.readFileSync(gitignorePath(), "utf8")).toBe(RESIN_DIR_GITIGNORE);
    expect(git(repo, "status", "--porcelain")).toBe("");
    // A second start in the same checkout keeps it that way.
    bootstrapProject(repo);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("keeps catalog-adopted active tools ignored and reveals the lock once a tool is pinned", () => {
    const result = bootstrapProject(repo);
    const manager = new ProjectLockManager({
      lockPath: result.lockPath,
      projectId: result.projectId,
    });

    manager.reconcileQualified(lockedEntry("adopted_tool"));
    expect(fs.existsSync(gitignorePath())).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe("");

    manager.setStatus("adopted_tool", "pinned");
    expect(fs.existsSync(gitignorePath())).toBe(false);
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe(
      "?? .resin/project.json\n?? .resin/resin.lock\n",
    );

    // Unpinning later never hides a lock the project may already have committed.
    manager.setStatus("adopted_tool", "active");
    bootstrapProject(repo);
    expect(fs.existsSync(gitignorePath())).toBe(false);
  });

  it("reveals the lock when a tool is disabled for the project", () => {
    const result = bootstrapProject(repo);
    const manager = new ProjectLockManager({
      lockPath: result.lockPath,
      projectId: result.projectId,
    });
    manager.reconcileQualified(lockedEntry("unwanted_tool"));
    manager.revokeTool("unwanted_tool");
    expect(fs.existsSync(gitignorePath())).toBe(false);
  });

  it("never adds a .gitignore to a .resin/ that already existed", () => {
    fs.mkdirSync(path.join(repo, ".resin"));
    bootstrapProject(repo);
    expect(fs.existsSync(gitignorePath())).toBe(false);
  });

  it("never adds a .gitignore to a git-tracked .resin/ being recreated", () => {
    bootstrapProject(repo);
    fs.rmSync(gitignorePath());
    git(repo, "add", ".resin");
    git(repo, "commit", "-q", "-m", "track resin");
    fs.rmSync(path.join(repo, ".resin"), { recursive: true });

    bootstrapProject(repo);
    expect(fs.existsSync(gitignorePath())).toBe(false);
  });

  it("never removes a user-authored .resin/.gitignore", () => {
    const result = bootstrapProject(repo);
    fs.writeFileSync(gitignorePath(), "*\n");
    const manager = new ProjectLockManager({
      lockPath: result.lockPath,
      projectId: result.projectId,
    });
    manager.reconcileQualified(lockedEntry("frozen_tool", "pinned"));
    expect(fs.readFileSync(gitignorePath(), "utf8")).toBe("*\n");
  });

  it("treats only pinned or disabled entries as project decisions", () => {
    const lock = (status: "active" | "pinned" | "disabled") => ({
      schemaKind: V1_SCHEMA_KINDS.TOOL_LOCK,
      schemaVersion: V1_SCHEMA_VERSION,
      projectId: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
      tools: { tool: lockedEntry("tool", status) },
    });
    expect(lockRecordsProjectDecision({ ...lock("active"), tools: {} })).toBe(false);
    expect(lockRecordsProjectDecision(lock("active"))).toBe(false);
    expect(lockRecordsProjectDecision(lock("pinned"))).toBe(true);
    expect(lockRecordsProjectDecision(lock("disabled"))).toBe(true);
  });
});
