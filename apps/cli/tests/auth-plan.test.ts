import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  createAuthorizationPlan,
  formatAuthPlanForDisplay,
  generateDefaultCapabilities,
  validateAuthorization,
} from "../src/installer/auth-plan.js";

describe("Authorization Plan & Privacy Boundary", () => {
  it("generates default capability envelope with strict security constraints", () => {
    const caps = generateDefaultCapabilities("/workspace/project");

    expect(caps.version).toBe("0.1.0");
    expect(caps.fs.readPaths).toContain("/workspace/project");
    expect(caps.fs.denyPaths).toContain("**/.git/**");
    expect(caps.fs.denyPaths).toContain("**/.env*");
    expect(caps.net.allowOutbound).toBe(false);
    expect(caps.net.allowedHosts).toContain("127.0.0.1");
    expect(caps.command.allowedCommands).toEqual(["git", "node", "pnpm", "deno"]);
    expect(caps.secrets.denyDirectRead).toBe(true);
    expect(caps.limits.maxCpuUsagePercent).toBe(100);
  });

  it("formats authorization plan for human-readable terminal display", async () => {
    const plan = await createAuthorizationPlan({
      workspacePath: "/workspace/my-app",
      targetHarnesses: [
        { id: "claude-code", name: "Claude Code CLI" },
        { id: "omp", name: "Oh My Pi (OMP)" },
      ],
    });

    const display = formatAuthPlanForDisplay(plan);

    expect(display).toContain("RESIN AUTHORIZATION PLAN");
    expect(display).toContain("Target Workspace: /workspace/my-app");
    expect(display).toContain("CAPABILITY ENVELOPE");
    expect(display).toContain("PRIVACY & OBSERVABILITY BOUNDARY");
    expect(display).toContain("[Claude Code CLI]");
    expect(display).toContain("[Oh My Pi (OMP)]");
  });

  it("rejects non-interactive authorization when no approval flags or files are provided", async () => {
    const plan = await createAuthorizationPlan({ workspacePath: "/workspace/app" });

    await expect(validateAuthorization(plan, { nonInteractive: true })).rejects.toThrow(
      /Authorization required: Non-interactive execution/i,
    );
  });

  it("grants authorization in non-interactive mode with autoApprove flag", async () => {
    const plan = await createAuthorizationPlan({ workspacePath: "/workspace/app" });

    const grantedPlan = await validateAuthorization(plan, {
      nonInteractive: true,
      autoApprove: true,
    });

    expect(grantedPlan.granted).toBe(true);
    expect(grantedPlan.grantedBy).toBe("non_interactive_flag");
  });

  it("grants authorization when explicit capabilities file is supplied", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customCaps = generateDefaultCapabilities("/custom/path");
    await bridge.writeFile("/custom/caps.json", JSON.stringify(customCaps));

    const plan = await createAuthorizationPlan({
      workspacePath: "/custom/path",
      capabilitiesFile: "/custom/caps.json",
      fsBridge: bridge,
    });

    const validated = await validateAuthorization(plan, {
      nonInteractive: true,
      capabilitiesFile: "/custom/caps.json",
    });

    expect(validated.granted).toBe(true);
    expect(validated.grantedBy).toBe("capabilities_file");
  });

  it("supports interactive prompt function for user consent", async () => {
    const plan = await createAuthorizationPlan({ workspacePath: "/workspace/app" });

    // User approves
    const approved = await validateAuthorization(plan, {
      promptFn: async () => true,
    });
    expect(approved.granted).toBe(true);
    expect(approved.grantedBy).toBe("interactive_user");

    // User declines
    const plan2 = await createAuthorizationPlan({ workspacePath: "/workspace/app" });
    await expect(
      validateAuthorization(plan2, {
        promptFn: async () => false,
      }),
    ).rejects.toThrow(/Authorization declined by user/i);
  });
});
