import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverOmpSessions,
  discoverOmpWorkspaces,
  probeOmpInstallation,
} from "../src/discovery.js";

const cleanup: string[] = [];

afterEach(async () => {
  for (const target of cleanup.splice(0)) {
    await fsp.rm(target, { recursive: true, force: true });
  }
});

describe("OMP discovery fail-closed qualification", () => {
  it("does not synthesize a version when an executable cannot report semver", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fail-closed-"));
    cleanup.push(home);
    const executable = path.join(home, "omp");
    await fsp.writeFile(executable, "#!/bin/sh\necho development-build\n", { mode: 0o755 });

    const installation = await probeOmpInstallation({
      customHome: home,
      customExecutablePath: executable,
      customConfigPath: path.join(home, "config.json"),
    });

    expect(installation).not.toBeNull();
    expect(installation?.isInstalled).toBe(false);
    expect(installation?.status).toBe("corrupt");
    expect(installation?.version).toBe("0.0.0");
  });

  it("reports an explicitly missing executable without a fabricated version", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-missing-"));
    cleanup.push(home);

    const installation = await probeOmpInstallation({
      customHome: home,
      customExecutablePath: path.join(home, "does-not-exist"),
    });

    expect(installation).not.toBeNull();
    expect(installation?.isInstalled).toBe(false);
    expect(installation?.status).toBe("missing_executable");
    expect(installation?.version).toBe("0.0.0");
  });

  it("ignores zero-byte JSONL transcript files safely without fabricating invalid sessions", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-empty-transcript-"));
    cleanup.push(home);
    const wsPath = path.join(home, "ws-empty");
    await fsp.mkdir(wsPath, { recursive: true });
    const sessionsDir = path.join(home, "agent", "sessions", "-ws-empty");
    await fsp.mkdir(sessionsDir, { recursive: true });

    const emptyFile = path.join(sessionsDir, "empty.jsonl");
    await fsp.writeFile(emptyFile, "");

    const workspace = {
      workspaceId: "ws-empty",
      rootPath: wsPath,
      name: "ws-empty",
      harnessId: "omp",
    };

    const sessions = await discoverOmpSessions(workspace, { ompHome: home });
    expect(sessions.length).toBe(0);
  });

  it("fails closed on corrupt non-JSON transcript files without crashing", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-corrupt-transcript-"));
    cleanup.push(home);
    const wsPath = path.join(home, "ws-corrupt");
    await fsp.mkdir(wsPath, { recursive: true });
    const sessionsDir = path.join(home, "agent", "sessions", "-ws-corrupt");
    await fsp.mkdir(sessionsDir, { recursive: true });

    const corruptFile = path.join(sessionsDir, "corrupt.jsonl");
    await fsp.writeFile(corruptFile, "<<<NOT_JSON_BINARY_GARBAGE>>>\n{invalid json\n");

    const workspace = {
      workspaceId: "ws-corrupt",
      rootPath: wsPath,
      name: "ws-corrupt",
      harnessId: "omp",
    };

    const sessions = await discoverOmpSessions(workspace, { ompHome: home });
    expect(sessions.length).toBe(0);
  });

  it("safely handles unreadable or missing directories during workspace discovery", async () => {
    const workspaces = await discoverOmpWorkspaces({
      customHome: "/nonexistent/omp/dir/for/sure",
      searchPaths: ["/another/nonexistent/path/12345"],
    });
    expect(Array.isArray(workspaces)).toBe(true);
  });
});
