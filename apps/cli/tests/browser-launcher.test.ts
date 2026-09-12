import type * as childProcess from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultOpenBrowser } from "../src/commands/login.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

const URL_TO_OPEN = "http://127.0.0.1:3100/device?user_code=TEST-CODE&approval_nonce=fixture-only";
const WINDOWS_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

class LauncherProcess extends EventEmitter {
  kill = vi.fn(() => true);
}

const children: LauncherProcess[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function launcher(index = 0): LauncherProcess {
  const child = children[index];
  if (!child) throw new Error(`Launcher ${index} has not started`);
  return child;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(spawn).mockReset();
  children.length = 0;
  Object.defineProperty(process, "platform", { configurable: true, get: () => "linux" });
  vi.spyOn(os, "release").mockReturnValue("6.8.0-generic");
  for (const name of ["WSL_DISTRO_NAME", "WSL_INTEROP", "WSLENV", "IS_WSL"]) {
    vi.stubEnv(name, undefined);
  }
  vi.mocked(spawn).mockImplementation(() => {
    const child = new LauncherProcess();
    children.push(child);
    // Only the event/kill subprocess boundary is exercised; no OS process is launched.
    return child as unknown as childProcess.ChildProcess;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  vi.useRealTimers();
});

describe("defaultOpenBrowser", () => {
  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ] as const)(
    "waits for successful %s desktop dispatch, not merely spawn",
    async (platform, command) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const result = defaultOpenBrowser(URL_TO_OPEN);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      launcher().emit("spawn");
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(spawn).toHaveBeenCalledWith(command, [URL_TO_OPEN], {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      });
      launcher().emit("close", 0, null);
      await expect(result).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("detects WSL from the kernel with isolated environment and falls back to the Windows system path", async () => {
    vi.spyOn(os, "release").mockReturnValue("6.18.0-microsoft-standard-WSL2");
    const result = defaultOpenBrowser(URL_TO_OPEN);
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe("powershell.exe");
    launcher().emit("error", new Error("ENOENT"));
    await Promise.resolve();
    expect(vi.mocked(spawn).mock.calls[1]?.[0]).toBe(WINDOWS_POWERSHELL);
    launcher(1).emit("close", 0, null);
    await expect(result).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("falls back to the Linux desktop when Windows dispatch fails in WSL", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    const result = defaultOpenBrowser(URL_TO_OPEN);
    launcher().emit("close", 1, null);
    await Promise.resolve();
    launcher(1).emit("close", null, "SIGTERM");
    await Promise.resolve();
    expect(vi.mocked(spawn).mock.calls[2]?.[0]).toBe("xdg-open");
    launcher(2).emit("close", 0, null);
    await expect(result).resolves.toBe(true);
  });

  it("returns manual fallback when every WSL launcher fails", async () => {
    vi.stubEnv("WSL_INTEROP", "/run/WSL/fixture_interop");
    const result = defaultOpenBrowser(URL_TO_OPEN);
    for (let index = 0; index < 3; index++) {
      launcher(index).emit("error", new Error("launcher unavailable"));
      await Promise.resolve();
    }
    await expect(result).resolves.toBe(false);
  });

  it("tries the next WSL launcher after killing a hung Windows dispatch", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    const result = defaultOpenBrowser(URL_TO_OPEN);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(launcher().kill).toHaveBeenCalledWith("SIGKILL");
    expect(vi.mocked(spawn).mock.calls[1]?.[0]).toBe(WINDOWS_POWERSHELL);
    launcher(1).emit("close", 0, null);
    await expect(result).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the native Windows system directory when PowerShell is absent from PATH", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const result = defaultOpenBrowser(URL_TO_OPEN);
    launcher().emit("error", new Error("ENOENT"));
    await Promise.resolve();
    expect(vi.mocked(spawn).mock.calls[1]?.[0]).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    launcher(1).emit("close", 0, null);
    await expect(result).resolves.toBe(true);
  });

  it("passes URL metacharacters as encoded data, never Windows shell source", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const url = `${URL_TO_OPEN}&payload='\";$(calc.exe)|&%PATH%\n#é`;
    const result = defaultOpenBrowser(url);
    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    if (!Array.isArray(args)) throw new Error("Missing launcher arguments");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(String(args[3]), "base64").toString("utf16le");
    const encodedUrl = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
    expect(encodedUrl).toBeDefined();
    expect(Buffer.from(encodedUrl ?? "", "base64").toString("utf8")).toBe(url);
    expect(script).not.toContain(url);
    expect(script).toContain("Start-Process -FilePath $url -ErrorAction Stop");
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe("powershell.exe");
    launcher().emit("close", 0, null);
    await expect(result).resolves.toBe(true);
  });

  it("returns manual fallback on a desktop launcher's nonzero exit", async () => {
    const result = defaultOpenBrowser(URL_TO_OPEN);
    launcher().emit("spawn");
    launcher().emit("close", 3, null);
    await expect(result).resolves.toBe(false);
  });

  it("bounds a hung launcher and returns manual fallback", async () => {
    const result = defaultOpenBrowser(URL_TO_OPEN);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe(false);
    expect(launcher().kill).toHaveBeenCalledWith("SIGKILL");
    launcher().emit("close", 0, null);
    await expect(result).resolves.toBe(false);
  });

  it("handles synchronous subprocess errors", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error("spawn unavailable");
    });
    await expect(defaultOpenBrowser(URL_TO_OPEN)).resolves.toBe(false);
  });

  it.each(["file:///tmp/anything", "javascript:alert(1)", "--help", "not a URL"])(
    "does not dispatch non-web target %s",
    async (url) => {
      await expect(defaultOpenBrowser(url)).resolves.toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});
