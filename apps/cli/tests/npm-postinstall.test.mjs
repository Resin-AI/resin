import { describe, expect, it, vi } from "vitest";
import {
  isGlobalLifecycleInstall,
  postinstallSuppressionReason,
  runPostinstall,
} from "../bin/postinstall.mjs";

function memoryStream() {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += String(chunk);
      },
    },
    read() {
      return output;
    },
  };
}

describe("global npm and pnpm postinstall onboarding", () => {
  it.each([
    ["npm global install", { npm_config_global: "true" }],
    ["pnpm global install", { npm_config_location: "global" }],
  ])("runs the same complete onboarding transaction for %s", async (_label, lifecycleEnv) => {
    const initCommand = vi.fn().mockResolvedValue(0);
    const output = memoryStream();

    const result = await runPostinstall({
      env: { ...lifecycleEnv, RESIN_ALLOW_ROOT: "1" },
      stdout: output.stream,
      getuid: () => 1000,
      loadCli: async () => ({ initCommand }),
    });

    expect(result).toEqual({ attempted: true, skipped: false, success: true });
    expect(initCommand).toHaveBeenCalledOnce();
    expect(initCommand).toHaveBeenCalledWith(["--auto-approve"]);
    expect(output.read()).toContain(
      "browser authorization, editor configuration, and daemon setup",
    );
    expect(output.read()).toContain("daemon is ready");
  });

  it("does not run for dependency installs or CI lifecycle scripts", async () => {
    const initCommand = vi.fn().mockResolvedValue(0);

    expect(isGlobalLifecycleInstall({ npm_config_global: "false" })).toBe(false);
    expect(
      await runPostinstall({
        env: {},
        getuid: () => 1000,
        loadCli: async () => ({ initCommand }),
      }),
    ).toMatchObject({ attempted: false, reason: "dependency install" });

    expect(
      postinstallSuppressionReason({ npm_config_global: "true", CI: "true" }, () => 1000),
    ).toBe("CI environment detected");
    expect(
      await runPostinstall({
        env: { npm_config_global: "true", CI: "true" },
        getuid: () => 1000,
        loadCli: async () => ({ initCommand }),
      }),
    ).toMatchObject({ attempted: false, reason: "CI environment detected" });
    expect(initCommand).not.toHaveBeenCalled();
  });

  it("reruns idempotently and fails the lifecycle when onboarding is incomplete", async () => {
    const successfulInit = vi.fn().mockResolvedValue(0);
    const options = {
      env: { npm_config_global: "true" },
      stdout: memoryStream().stream,
      getuid: () => 1000,
      loadCli: async () => ({ initCommand: successfulInit }),
    };

    await runPostinstall(options);
    await runPostinstall(options);
    expect(successfulInit).toHaveBeenCalledTimes(2);

    await expect(
      runPostinstall({
        ...options,
        loadCli: async () => ({ initCommand: vi.fn().mockResolvedValue(1) }),
      }),
    ).rejects.toThrow("onboarding transaction exited with code 1");
  });
});
