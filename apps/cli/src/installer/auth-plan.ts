import crypto from "node:crypto";
import readline from "node:readline";
import {
  type CapabilityEnvelope,
  CapabilityEnvelopeSchema,
  type CapabilityLimits,
  type CommandCapability,
  type FsCapability,
  type NetCapability,
  RedactionStrategySchema,
  type SecretCapability,
} from "@resin/contracts";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { defaultFsBridge } from "@resin/harness-contracts";
import { z } from "zod";

/**
 * Privacy and observability configuration for Resin installation.
 */
export const PrivacyConfigSchema = z.object({
  cloudSyncEnabled: z.boolean().default(false),
  telemetryEnabled: z.boolean().default(true),
  redactionStrategy: RedactionStrategySchema.default("mask"),
  localOnly: z.boolean().default(true),
  sensitivePatterns: z
    .array(z.string())
    .default(["token", "secret", "key", "password", "auth", "credential", "signature"]),
});

export type PrivacyConfig = z.infer<typeof PrivacyConfigSchema>;

/**
 * Harness authorization grant descriptor.
 */
export const HarnessGrantSchema = z.object({
  harnessId: z.string(),
  displayName: z.string(),
  scope: z.string(),
  permissions: z.array(z.string()),
});

export type HarnessGrant = z.infer<typeof HarnessGrantSchema>;

/**
 * Comprehensive authorization plan presented to user prior to mutating any configuration.
 */
export const AuthorizationPlanSchema = z.object({
  planId: z.string(),
  createdAt: z.string(),
  workspacePath: z.string(),
  capabilities: CapabilityEnvelopeSchema,
  privacy: PrivacyConfigSchema,
  harnesses: z.array(HarnessGrantSchema),
  granted: z.boolean().default(false),
  grantedAt: z.string().optional(),
  grantedBy: z.enum(["interactive_user", "non_interactive_flag", "capabilities_file"]).optional(),
});

export type AuthorizationPlan = z.infer<typeof AuthorizationPlanSchema>;

export interface AuthPlanOptions {
  workspacePath?: string;
  capabilitiesFile?: string;
  privacyConfigFile?: string;
  customCapabilities?: Partial<CapabilityEnvelope>;
  customPrivacy?: Partial<PrivacyConfig>;
  targetHarnesses?: Array<{ id: string; name: string }>;
  fsBridge?: ConfigFsBridge;
}

/**
 * Generates the default capability envelope for Resin runtime operations.
 */
export function generateDefaultCapabilities(workspacePath = process.cwd()): CapabilityEnvelope {
  const fsCap: FsCapability = {
    readPaths: [workspacePath],
    writePaths: [workspacePath],
    allowWorkspaceRoot: true,
    allowTemp: true,
    denyPaths: ["**/.git/**", "**/.ssh/**", "**/.aws/**", "**/.gnupg/**", "**/.env*"],
    maxFileSizeBytes: 10 * 1024 * 1024, // 10MB
  };

  const netCap: NetCapability = {
    allowOutbound: false,
    allowedDomains: [],
    allowedHosts: ["127.0.0.1", "localhost"],
    allowedPorts: [9400, 9401],
    allowedProtocols: ["http", "https"],
    allowLocalhost: true,
    denyPrivateRanges: true,
  };

  const cmdCap: CommandCapability = {
    allowShellExecution: false,
    allowedCommands: ["git", "node", "pnpm", "deno"],
    allowedBinaries: ["git", "node", "pnpm", "deno"],
    forbiddenPatterns: ["sudo", "rm -rf /", "dd", "mkfs", "shutdown", "reboot"],
    allowEnvPassthrough: ["PATH", "NODE_ENV", "USER", "HOME"],
  };

  const secCap: SecretCapability = {
    allowedSecretNames: [],
    allowedPrefixes: [],
    denyDirectRead: true,
    injectAsEnv: true,
  };

  const limits: CapabilityLimits = {
    maxConcurrentExecutions: 4,
    maxCpuUsagePercent: 100,
    maxMemoryMb: 512,
    maxExecutionTimeMs: 30000,
    maxOutputSizeBytes: 2 * 1024 * 1024,
  };

  return {
    version: "0.1.0",
    envelopeId: `env_${crypto.randomUUID().slice(0, 8)}`,
    workspaceId: `ws_${crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 12)}`,
    fs: fsCap,
    net: netCap,
    command: cmdCap,
    secrets: secCap,
    limits,
    isFrozen: false,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generates an authorization plan consolidating capabilities, privacy settings, and harness grants.
 */
export async function createAuthorizationPlan(
  options: AuthPlanOptions = {},
): Promise<AuthorizationPlan> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const workspacePath = options.workspacePath ?? process.cwd();

  // Load or construct capabilities
  let capabilities: CapabilityEnvelope;
  if (options.capabilitiesFile) {
    const content = await fsBridge.readFile(options.capabilitiesFile);
    if (!content) {
      throw new Error(`Capabilities file not found at ${options.capabilitiesFile}`);
    }
    capabilities = CapabilityEnvelopeSchema.parse(JSON.parse(content));
  } else {
    capabilities = {
      ...generateDefaultCapabilities(workspacePath),
      ...(options.customCapabilities ?? {}),
    };
  }

  // Load or construct privacy settings
  let privacy: PrivacyConfig;
  if (options.privacyConfigFile) {
    const content = await fsBridge.readFile(options.privacyConfigFile);
    if (!content) {
      throw new Error(`Privacy config file not found at ${options.privacyConfigFile}`);
    }
    privacy = PrivacyConfigSchema.parse(JSON.parse(content));
  } else {
    privacy = PrivacyConfigSchema.parse(options.customPrivacy ?? {});
  }

  // Build target harness list
  const defaultHarnesses = [
    { id: "claude-code", name: "Claude Code CLI" },
    { id: "codex-cli", name: "Codex CLI" },
    { id: "omp", name: "Oh My Pi (OMP)" },
  ];
  const targetHarnesses = options.targetHarnesses ?? defaultHarnesses;

  const harnesses: HarnessGrant[] = targetHarnesses.map((h) => ({
    harnessId: h.id,
    displayName: h.name,
    scope: workspacePath,
    permissions: [
      "mcp.server.register",
      "mcp.tools.list",
      "mcp.tools.call",
      "local.gateway.connect",
    ],
  }));

  return {
    planId: `auth_${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    workspacePath,
    capabilities,
    privacy,
    harnesses,
    granted: false,
  };
}

/**
 * Formats an authorization plan into a human-readable terminal display.
 */
export function formatAuthPlanForDisplay(plan: AuthorizationPlan): string {
  const lines: string[] = [];

  lines.push("================================================================================");
  lines.push("                    RESIN AUTHORIZATION PLAN                             ");
  lines.push("================================================================================");
  lines.push(`Plan ID:         ${plan.planId}`);
  lines.push(`Target Workspace: ${plan.workspacePath}`);
  lines.push(
    `Status:          ${plan.granted ? `GRANTED (${plan.grantedBy})` : "PENDING AUTHORIZATION"}`,
  );
  lines.push("");

  lines.push("1. CAPABILITY ENVELOPE (SANDBOX CONSTRAINTS):");
  lines.push(
    `   - Filesystem Read/Write:  ${plan.capabilities.fs.allowWorkspaceRoot ? "Workspace root allowed" : "Strict path list only"}`,
  );
  lines.push(`   - Filesystem Deny Paths:  ${plan.capabilities.fs.denyPaths.join(", ")}`);
  lines.push(
    `   - Network Outbound:       ${plan.capabilities.net.allowOutbound ? "ALLOWED" : `DENIED (Local loopback only: ${plan.capabilities.net.allowedHosts.join(", ")})`}`,
  );
  lines.push(
    `   - Allowed Commands:       ${plan.capabilities.command.allowedCommands.join(", ")}`,
  );
  lines.push(
    `   - Secret Access:          ${plan.capabilities.secrets.allowedSecretNames.length > 0 ? plan.capabilities.secrets.allowedSecretNames.join(", ") : "NONE (Zero secrets exposed)"}`,
  );
  lines.push(
    `   - Resource Limits:        CPU: ${plan.capabilities.limits.maxCpuUsagePercent}%, Mem: ${plan.capabilities.limits.maxMemoryMb}MB, Timeout: ${plan.capabilities.limits.maxExecutionTimeMs}ms`,
  );
  lines.push("");

  lines.push("2. PRIVACY & OBSERVABILITY BOUNDARY:");
  lines.push(
    `   - Redaction Strategy:     ${plan.privacy.redactionStrategy.toUpperCase()} (Sensitive patterns masked)`,
  );
  lines.push(
    `   - Local-Only Mode:        ${plan.privacy.localOnly ? "ENABLED (Zero cloud data leakage)" : "DISABLED"}`,
  );
  lines.push(
    `   - Cloud Sync:             ${plan.privacy.cloudSyncEnabled ? "ENABLED" : "DISABLED (Default opt-out)"}`,
  );
  lines.push(
    `   - Telemetry:              ${plan.privacy.telemetryEnabled ? "ENABLED (Default)" : "DISABLED"}`,
  );
  lines.push("");

  lines.push("3. TARGET HARNESS REGISTRATIONS:");
  for (const h of plan.harnesses) {
    lines.push(`   - [${h.displayName}] (ID: ${h.harnessId})`);
    lines.push(`     Scope:       ${h.scope}`);
    lines.push(`     Permissions: ${h.permissions.join(", ")}`);
  }
  lines.push("================================================================================");

  return lines.join("\n");
}

/**
 * Formats an authorization plan into a compact summary for default terminal display.
 */
export function formatCompactAuthPlan(plan: AuthorizationPlan): string {
  const harnesses = plan.harnesses.map((h) => h.displayName).join(", ");
  const lines: string[] = [
    `Resin Authorization (${plan.planId}):`,
    `  Workspace: ${plan.workspacePath}`,
    `  Harnesses: ${harnesses || "None"}`,
  ];
  return lines.join("\n");
}
export type AuthorizationPromptFn = (question: string) => Promise<boolean>;

/**
 * Default prompt implementation for interactive terminal authorization.
 * Reads explicit y/N answer, defaulting to deny (fail-closed) on EOF or anything other than yes.
 */
export async function defaultPromptFn(question: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const safeResolve = (val: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(val);
      }
    };
    try {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(question, (answer) => {
        const normalized = answer.trim().toLowerCase();
        safeResolve(normalized === "y" || normalized === "yes");
        rl.close();
      });
      rl.on("close", () => {
        safeResolve(false);
      });
      rl.on("error", () => {
        safeResolve(false);
      });
    } catch {
      safeResolve(false);
    }
  });
}

export interface ValidateAuthorizationOptions {
  nonInteractive?: boolean;
  autoApprove?: boolean;
  capabilitiesFile?: string;
  promptFn?: AuthorizationPromptFn;
}

/**
 * Validates and grants authorization based on CLI parameters or interactive prompts.
 */
export async function validateAuthorization(
  plan: AuthorizationPlan,
  options: ValidateAuthorizationOptions = {},
): Promise<AuthorizationPlan> {
  // If loaded from explicit capabilities file
  if (options.capabilitiesFile) {
    plan.granted = true;
    plan.grantedAt = new Date().toISOString();
    plan.grantedBy = "capabilities_file";
    return plan;
  }

  if (options.autoApprove) {
    plan.granted = true;
    plan.grantedAt = new Date().toISOString();
    plan.grantedBy = "non_interactive_flag";
    return plan;
  }

  if (options.nonInteractive) {
    throw new Error(
      "Authorization required: Non-interactive execution must provide either --capabilities-file or explicit confirmation flag.",
    );
  }

  // Interactive prompt (injected or default readline)
  const prompt = options.promptFn ?? defaultPromptFn;
  const promptQuestion =
    "Do you authorize Resin with the capability envelope and privacy plan displayed above? (y/N): ";
  const approved = await prompt(promptQuestion);

  if (!approved) {
    throw new Error("Authorization declined by user. Installation aborted.");
  }

  plan.granted = true;
  plan.grantedAt = new Date().toISOString();
  plan.grantedBy = "interactive_user";
  return plan;
}
