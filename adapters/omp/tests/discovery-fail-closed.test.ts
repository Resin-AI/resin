import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeOmpInstallation } from "../src/discovery.js";

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
});
