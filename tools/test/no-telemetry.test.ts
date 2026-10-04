import childProcess, { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const printOptOut = ["-p", "process.env.DO_NOT_TRACK ?? 'unset'"];
const bareEnv = { PATH: process.env.PATH ?? "" };

describe("tests never send error reports or usage events", () => {
  it("opts the test worker out", () => {
    expect(process.env.DO_NOT_TRACK).toBe("1");
  });

  it("opts out children started with a constructed environment", async () => {
    const spawned = spawnSync(process.execPath, printOptOut, { env: bareEnv, encoding: "utf8" });
    expect(spawned.stdout.trim()).toBe("1");
    expect(
      execFileSync(process.execPath, printOptOut, { env: bareEnv, encoding: "utf8" }).trim(),
    ).toBe("1");
    const viaDefault = childProcess.spawnSync(process.execPath, printOptOut, {
      env: bareEnv,
      encoding: "utf8",
    });
    expect(viaDefault.stdout.trim()).toBe("1");
    const { stdout } = await promisify(execFile)(process.execPath, printOptOut, { env: bareEnv });
    expect(stdout.trim()).toBe("1");
  });

  it("leaves an explicit reporting choice alone", () => {
    const forced = spawnSync(process.execPath, printOptOut, {
      env: { ...bareEnv, RESIN_ERROR_REPORTING: "1" },
      encoding: "utf8",
    });
    expect(forced.stdout.trim()).toBe("unset");
  });

  it("opts out every workflow that runs tests, qualification or releases", () => {
    for (const name of ["ci", "release-candidate", "release"]) {
      const workflow: unknown = parse(
        fs.readFileSync(path.join(repoRoot, ".github/workflows", `${name}.yml`), "utf8"),
      );
      expect(workflow, name).toMatchObject({ env: { DO_NOT_TRACK: "1" } });
    }
  });

  it("opts out qualification and smoke scripts run outside vitest", () => {
    for (const script of ["scripts/platform-qualification.mjs", "scripts/verify-binaries.mjs"]) {
      expect(fs.readFileSync(path.join(repoRoot, script), "utf8"), script).toContain(
        'process.env.DO_NOT_TRACK = "1";',
      );
    }
  });
});
