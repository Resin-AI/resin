/**
 * Recorded patch steps applied in-process to real files: exact and shifted hunks, whole-file adds
 * and deletes, refusal of anything that does not match, and confinement to the working directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKFLOW_PATCH_STEP_RESULT,
  type WorkflowJsonValue,
  type WorkflowStep,
  applyProgramTokenValues,
  tokenizeProgram,
} from "@resin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRecordedCall } from "../../src/workflow/program-runner.js";

const SERVICES = [
  "# Services routed by the edge proxy.",
  "services:",
  "  - name: orders",
  "    port: 8072",
  "    path: /orders",
  "",
  "# Proxy defaults; these are not services.",
  "timeout: 30",
  "",
].join("\n");

const ADD_MEDIA = [
  "--- /app/services.yaml",
  "+++ /app/services.yaml",
  "@@ -5,2 +5,5 @@",
  "     path: /orders",
  "+  - name: media",
  "+    port: 8083",
  "+    path: /media",
  " ",
  "",
].join("\n");

const STEP: WorkflowStep = {
  id: "edit",
  callId: "exec-1",
  callable: {
    runtime: "resin-process",
    name: "apply_patch",
    program: { kind: "patch", source: "", argument: "patch" },
  },
  arguments: [],
  dependsOn: [],
  failurePolicy: { onError: "abort", policy: "default" },
} as unknown as WorkflowStep;

describe("recorded patch steps", () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-patch-"));
    workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "services.yaml"), SERVICES, { mode: 0o640 });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Replays a patch written against `/app` with the temp workspace as its recorded workdir. */
  const replay = (patch: string): Promise<WorkflowJsonValue> =>
    runRecordedCall(
      { step: STEP, arguments: { patch: patch.replaceAll("/app", workspace), workdir: workspace } },
      { cwd: workspace },
    );
  const services = () => fs.readFileSync(path.join(workspace, "services.yaml"), "utf8");

  it("applies a hunk at its stated line, keeping the file's mode, and acknowledges it", async () => {
    await expect(replay(ADD_MEDIA)).resolves.toBe(WORKFLOW_PATCH_STEP_RESULT);
    expect(services()).toBe(
      SERVICES.replace(
        "path: /orders\n",
        "path: /orders\n  - name: media\n    port: 8083\n    path: /media\n",
      ),
    );
    // NTFS exposes only the read-only bit, so Windows reports the writable file as 0o666.
    expect(fs.statSync(path.join(workspace, "services.yaml")).mode & 0o777).toBe(
      process.platform === "win32" ? 0o666 : 0o640,
    );
    expect(fs.readdirSync(workspace)).toEqual(["services.yaml"]);
  });

  it("never applies a patch program on a model-written derivation step", async () => {
    const derived = { ...STEP, origin: "derivation" } as WorkflowStep;
    await expect(
      runRecordedCall(
        {
          step: derived,
          arguments: { patch: ADD_MEDIA.replaceAll("/app", workspace), workdir: workspace },
        },
        { cwd: workspace },
      ),
    ).rejects.toThrow(/derivation/);
    expect(services()).toBe(SERVICES);
  });

  it("applies a hunk whose lines moved, when they appear exactly once", async () => {
    fs.writeFileSync(path.join(workspace, "services.yaml"), `# header\n# more\n${SERVICES}`);
    await replay(ADD_MEDIA);
    expect(services()).toContain(
      "    path: /orders\n  - name: media\n    port: 8083\n    path: /media\n\n#",
    );
  });

  it("refuses context that is missing or ambiguous, leaving the file unchanged", async () => {
    fs.writeFileSync(path.join(workspace, "services.yaml"), SERVICES.replace("/orders", "/other"));
    await expect(replay(ADD_MEDIA)).rejects.toThrow(/context does not match/);
    const twice = `${SERVICES.replace("path: /orders\n\n", "path: /x\n")}    path: /orders\n\n    path: /orders\n\n`;
    fs.writeFileSync(path.join(workspace, "services.yaml"), twice);
    await expect(replay(ADD_MEDIA)).rejects.toThrow(/more than one place/);
    expect(services()).toBe(twice);
  });

  it("creates a new file with its parents, and refuses to create one that exists", async () => {
    const create = "--- /dev/null\n+++ /app/conf/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n";
    await replay(create);
    expect(fs.readFileSync(path.join(workspace, "conf", "new.txt"), "utf8")).toBe("one\ntwo\n");
    await expect(replay(create)).rejects.toThrow(/creates a file that exists/);
  });

  it("deletes a file only when it holds exactly what the patch removes", async () => {
    fs.writeFileSync(path.join(workspace, "old.txt"), "gone\nextra\n");
    const remove = "--- /app/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n";
    await expect(replay(remove)).rejects.toThrow(/differs/);
    fs.writeFileSync(path.join(workspace, "old.txt"), "gone\n");
    await replay(remove);
    expect(fs.existsSync(path.join(workspace, "old.txt"))).toBe(false);
  });

  it("refuses a target outside the working directory through `..` or a symlink", async () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "services.yaml"), SERVICES);
    const viaParent = ADD_MEDIA.replaceAll("/app/services.yaml", "/app/../outside/services.yaml");
    await expect(replay(viaParent)).rejects.toThrow(/outside the step's working directory/);
    // A junction on Windows, where unprivileged users cannot create symlinks (ignored on POSIX).
    fs.symlinkSync(outside, path.join(workspace, "linked"), "junction");
    const viaLink = ADD_MEDIA.replaceAll("/app/services.yaml", "/app/linked/services.yaml");
    await expect(replay(viaLink)).rejects.toThrow(/outside the step's working directory/);
    // File symlinks need admin or Developer Mode on Windows, and junctions cannot target files.
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(outside, "services.yaml"), path.join(workspace, "alias.yaml"));
      const viaFileLink = ADD_MEDIA.replaceAll("/app/services.yaml", "/app/alias.yaml");
      await expect(replay(viaFileLink)).rejects.toThrow(/outside the step's working directory/);
    }
    expect(fs.readFileSync(path.join(outside, "services.yaml"), "utf8")).toBe(SERVICES);
  });

  it("writes the values bound to added-line tokens, and refuses a value spanning lines", async () => {
    const tokens = tokenizeProgram("patch", ADD_MEDIA);
    // Only added lines carry tokens: context and headers never do.
    expect(tokens.map((token) => token.value)).toEqual([
      "-",
      "name",
      "media",
      "port",
      "8083",
      "path",
      "/media",
    ]);
    const bound = applyProgramTokenValues(
      ADD_MEDIA,
      tokens,
      new Map([
        [2, "search"],
        [4, "8084"],
        [6, "/search"],
      ]),
      "patch",
    );
    await replay(bound);
    expect(services()).toContain("  - name: search\n    port: 8084\n    path: /search\n");
    expect(() =>
      applyProgramTokenValues(ADD_MEDIA, tokens, new Map([[2, "x\n+evil"]]), "patch"),
    ).toThrow(/cannot span lines/);
  });
});
