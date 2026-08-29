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

  it("rejects native Windows (win32 without WSL)", () => {
    const info = detectPlatform({
      platform: "win32",
      env: {},
      arch: "x64",
    });

    expect(info.isSupported).toBe(false);
    expect(info.platform).toBe("win32");
    expect(info.rejectionReason).toContain("Native Windows is not supported");

    expect(() => validatePlatform(info)).toThrow(UnsupportedPlatformError);
    expect(() => validatePlatform(info)).toThrow(/Native Windows is not supported/i);
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
