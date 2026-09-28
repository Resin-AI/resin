import { describe, expect, it, vi } from "vitest";
import { parseServiceFlags, serviceCommand } from "../../src/commands/service.js";
import type { ServiceStatusInfo, UserServiceManager } from "../../src/service/manager.js";

function fakeManager(status: ServiceStatusInfo, installed = true): UserServiceManager {
  return {
    name: "windows-task",
    platform: "windows-task",
    install: vi.fn(),
    uninstall: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue(status),
    isInstalled: vi.fn().mockResolvedValue(installed),
    getUnitDefinition: () => "",
    getUnitPath: () => "C:\\Users\\dev\\.resin\\services\\windows-task.xml",
  };
}

function capture(): { write(chunk: string): boolean; text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(""),
  };
}

const running: ServiceStatusInfo = {
  installed: true,
  active: true,
  enabled: true,
  serviceName: "\\Resin\\ResinDaemon",
  unitPath: "C:\\Users\\dev\\.resin\\services\\windows-task.xml",
  state: "running",
  pid: 4242,
};

describe("resin service", () => {
  it("parses the action and options", () => {
    expect(parseServiceFlags(["restart", "--json", "--home", "C:\\Users\\dev"])).toEqual({
      action: "restart",
      json: true,
      home: "C:\\Users\\dev",
    });
    expect(parseServiceFlags(["bogus"]).error).toBe("Unknown argument: bogus");
  });

  it("reports the service state as JSON", async () => {
    const stdout = capture();
    const exitCode = await serviceCommand(["status", "--json"], {
      serviceManager: fakeManager(running),
      stdout,
      stderr: capture(),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      success: true,
      action: "status",
      platform: "windows-task",
      serviceName: "\\Resin\\ResinDaemon",
      installed: true,
      active: true,
      enabled: true,
      state: "running",
      pid: 4242,
    });
  });

  it("stops through the platform service manager", async () => {
    const manager = fakeManager({ ...running, active: false, state: "ready", pid: undefined });
    const stdout = capture();
    expect(
      await serviceCommand(["stop"], { serviceManager: manager, stdout, stderr: capture() }),
    ).toBe(0);
    expect(manager.stop).toHaveBeenCalledOnce();
    expect(stdout.text()).toContain("stopped [ready]");
  });

  it("refuses to start a service that is not installed", async () => {
    const manager = fakeManager({ ...running, installed: false, active: false }, false);
    const stderr = capture();
    expect(
      await serviceCommand(["start"], { serviceManager: manager, stdout: capture(), stderr }),
    ).toBe(1);
    expect(manager.start).not.toHaveBeenCalled();
    expect(stderr.text()).toContain("resin init");
  });

  it("requires an action", async () => {
    const stderr = capture();
    expect(await serviceCommand([], { stdout: capture(), stderr })).toBe(2);
    expect(stderr.text()).toContain("Missing service action");
  });
});
