import { describe, expect, it } from "vitest";
import {
  UnsupportedPlatformError,
  detectPlatform,
  isWslEnvironment,
  validatePlatform,
} from "../src/installer/platform.js";

describe("Platform Detection and Validation", () => {
  it("detects standard Linux", () => {
    const info = detectPlatform({
      platform: "linux",
      env: {},
      release: "6.5.0-generic",
      arch: "x64",
      nodeVersion: "v22.2.0",
    });

    expect(info.os).toBe("linux");
    expect(info.isWsl).toBe(false);
    expect(info.isSupported).toBe(true);
    expect(info.arch).toBe("x64");
    expect(info.nodeVersion).toBe("v22.2.0");
    expect(() => validatePlatform(info)).not.toThrow();
  });

  it("detects macOS (darwin)", () => {
    const info = detectPlatform({
      platform: "darwin",
      env: {},
      release: "24.0.0",
      arch: "arm64",
      nodeVersion: "v22.4.0",
    });

    expect(info.os).toBe("darwin");
    expect(info.isWsl).toBe(false);
    expect(info.isSupported).toBe(true);
    expect(info.arch).toBe("arm64");
    expect(() => validatePlatform(info)).not.toThrow();
  });

  it("detects WSL via WSL_DISTRO_NAME environment variable", () => {
    const info = detectPlatform({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu-22.04" },
      release: "5.15.133.1-microsoft-standard-WSL2",
      arch: "x64",
    });

    expect(info.os).toBe("wsl");
    expect(info.isWsl).toBe(true);
    expect(info.distro).toBe("Ubuntu-22.04");
    expect(info.isSupported).toBe(true);
    expect(() => validatePlatform(info)).not.toThrow();
  });

  it("detects WSL via IS_WSL environment flag", () => {
    const isWsl = isWslEnvironment({ IS_WSL: "1" });
    expect(isWsl).toBe(true);
  });

  it("detects WSL via microsoft kernel release string", () => {
    const isWsl = isWslEnvironment({}, "5.15.90.1-microsoft-standard-wsl2");
    expect(isWsl).toBe(true);
  });

  it("supports native Windows (win32 without WSL) on x64 and arm64", () => {
    const x64 = detectPlatform({ platform: "win32", env: {}, arch: "x64" });
    expect(x64).toMatchObject({
      os: "windows",
      platform: "win32",
      isSupported: true,
      isWsl: false,
      distro: "Windows",
      lane: "windows-x64",
    });
    expect(x64.rejectionReason).toBeUndefined();
    expect(validatePlatform(x64)).toBe(x64);

    const arm64 = detectPlatform({ platform: "win32", env: {}, arch: "arm64" });
    expect(arm64.lane).toBe("windows-arm64");
  });

  it("never treats native Windows as WSL, even with WSL interop variables set", () => {
    const info = detectPlatform({
      platform: "win32",
      arch: "x64",
      env: { WSLENV: "USERPROFILE/p", WSL_INTEROP: "/run/WSL/1_interop" },
      release: "10.0.26100",
    });
    expect(info.isWsl).toBe(false);
    expect(info.os).toBe("windows");
    expect(info.lane).toBe("windows-x64");
  });

  it("rejects other unsupported platforms (e.g. aix, freebsd)", () => {
    const info = detectPlatform({
      // SAFETY: Testing unsupported platform rejection with mock platform value.
      platform: "freebsd" as NodeJS.Platform,
      env: {},
    });

    expect(info.isSupported).toBe(false);
    expect(() => validatePlatform(info)).toThrow(UnsupportedPlatformError);
  });
});
