import {
  type DeploymentRecord,
  DeploymentRecordSchema,
  type ToolManifest,
  ToolManifestSchema,
  hashCanonicalContent,
} from "@resin/contracts";
import {
  type CatalogSnapshotRequest,
  type CatalogSnapshotResponse,
  PermissionDeniedError,
  ProtocolError,
  RateLimitedError,
  RetryableError,
  type StreamCatalogInvalidation,
  UpgradeRequiredError,
  ValidationError,
} from "@resin/protocol";
import type { CallToolResult } from "../../src/protocol/types.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

export interface FaultInjectionConfig {
  /**
   * Complete network disconnect / offline state.
   */
  offline?: boolean;
  /**
   * Artificial delay before responding in milliseconds.
   */
  latencyMs?: number;
  /**
   * Simulates mid-result connection termination.
   */
  disconnectMidResult?: boolean;
  /**
   * Injects 429 Rate Limit error with optional retry-after.
   */
  rateLimit?: {
    retryAfterMs?: number;
    limitCount?: number;
  };
  /**
   * Injects 401 / Unauthorized error.
   */
  unauthorized?: boolean;
  /**
   * Injects 426 / Upgrade Required error with min supported version.
   */
  upgradeRequired?: {
    minSupportedVersion: string;
  };
  /**
   * Explicit custom error to throw.
   */
  injectError?: Error | ProtocolError | null;
}

export interface CloudInvocationContext {
  workspaceContext: WorkspaceContext;
  idempotencyKey: string;
  deadline?: number;
  traceContext?: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
  };
  signal?: AbortSignal;
  onProgress?: (progress: number, total?: number) => void;
}

export interface MockCloudMcpServiceOptions {
  workspaceId?: string;
  faultConfig?: FaultInjectionConfig;
  initialTools?: ToolManifest[];
  initialDeployments?: DeploymentRecord[];
}

export class MockCloudMcpService {
  private readonly workspaceId: string;
  private faultConfig: FaultInjectionConfig;

  private readonly tools = new Map<string, ToolManifest>();
  private readonly deployments = new Map<string, DeploymentRecord>();
  private readonly toolHandlers = new Map<
    string,
    (params: Record<string, unknown>, context: CloudInvocationContext) => Promise<CallToolResult>
  >();

  private readonly invalidationListeners = new Set<(event: StreamCatalogInvalidation) => void>();
  private rateLimitCounter = 0;
  private snapshotVersionCounter = 1;

  constructor(options: MockCloudMcpServiceOptions = {}) {
    this.workspaceId = options.workspaceId || "default";
    this.faultConfig = options.faultConfig || {};

    if (options.initialTools) {
      for (const tool of options.initialTools) {
        this.addTool(tool);
      }
    }
    if (options.initialDeployments) {
      for (const dep of options.initialDeployments) {
        this.deployments.set(dep.toolId, dep);
      }
    }
  }

  // --- Fault Injection Controls ---

  setFaultConfig(config: Partial<FaultInjectionConfig>): void {
    this.faultConfig = { ...this.faultConfig, ...config };
  }

  clearFaults(): void {
    this.faultConfig = {};
    this.rateLimitCounter = 0;
  }

  simulateOffline(offline = true): void {
    this.faultConfig.offline = offline;
  }

  simulateOnline(): void {
    this.faultConfig.offline = false;
    this.faultConfig.unauthorized = false;
    this.faultConfig.injectError = null;
  }

  simulateUnauthorized(unauthorized = true): void {
    this.faultConfig.unauthorized = unauthorized;
  }

  simulateUpgradeRequired(minSupportedVersion = "2.0.0"): void {
    this.faultConfig.upgradeRequired = { minSupportedVersion };
  }

  simulateRateLimit(retryAfterMs = 1000): void {
    this.faultConfig.rateLimit = { retryAfterMs };
  }

  injectError(error: Error | ProtocolError | null): void {
    this.faultConfig.injectError = error;
  }

  // --- Tool & Catalog Management ---

  addTool(
    manifest: ToolManifest,
    deployment?: DeploymentRecord,
    handler?: (
      params: Record<string, unknown>,
      context: CloudInvocationContext,
    ) => Promise<CallToolResult>,
  ): void {
    const validated = ToolManifestSchema.parse(manifest);
    this.tools.set(validated.id, validated);

    if (deployment) {
      const validatedDep = DeploymentRecordSchema.parse(deployment);
      this.deployments.set(validated.id, validatedDep);
    } else {
      this.deployments.set(validated.id, {
        deploymentId: `dep_${validated.id}_${validated.version}`,
        workspaceId: this.workspaceId,
        toolId: validated.id,
        toolVersion: validated.version,
        state: "promoted",
        activeTrafficPercentage: 100,
        history: [],
        createdAt: new Date().toISOString(),
      });
    }

    if (handler) {
      this.toolHandlers.set(validated.id, handler);
      this.toolHandlers.set(validated.name, handler);
    }
    this.snapshotVersionCounter++;
  }

  removeTool(toolId: string): void {
    this.tools.delete(toolId);
    this.deployments.delete(toolId);
    this.toolHandlers.delete(toolId);
    this.snapshotVersionCounter++;
  }

  seedTools(tools: ToolManifest[]): void {
    for (const tool of tools) {
      this.addTool(tool);
    }
  }

  createFetchHandler(): typeof fetch {
    return (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
      const urlStr =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(urlStr);

      if (url.pathname.includes("/catalog/snapshot")) {
        const workspaceId = url.searchParams.get("workspaceId") || this.workspaceId;
        const deviceId = url.searchParams.get("deviceId") || "default";
        const currentVersion = url.searchParams.get("currentVersion") || undefined;
        const filterScopes = url.searchParams.get("filterScopes")?.split(",");

        try {
          const snapshot = await this.handleCatalogSnapshot(
            {
              workspaceId,
              deviceId,
              currentVersion,
              filterScopes,
            },
            init?.signal ?? undefined,
          );
          return new Response(JSON.stringify(snapshot), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err: unknown) {
          if (err instanceof ProtocolError) {
            return new Response(
              JSON.stringify({
                error: err.code,
                message: err.message,
                details: err.details,
              }),
              {
                status: err.status || 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          throw err;
        }
      }

      return new Response(JSON.stringify({ error: "not_found", message: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  // --- Invalidation Events ---

  onInvalidation(listener: (event: StreamCatalogInvalidation) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  emitInvalidation(
    toolIds: string[],
    reason:
      | "version_published"
      | "tool_deprecated"
      | "emergency_revocation"
      | "config_changed" = "version_published",
    workspaceId = this.workspaceId,
  ): void {
    const event: StreamCatalogInvalidation = {
      type: "server.catalog_invalidation",
      workspaceId,
      toolIds,
      reason,
      timestamp: new Date().toISOString(),
    };

    for (const listener of this.invalidationListeners) {
      try {
        listener(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  // --- Service Handlers ---

  async handleCatalogSnapshot(
    request: CatalogSnapshotRequest,
    signal?: AbortSignal,
  ): Promise<CatalogSnapshotResponse> {
    await this.applyFaultInjections(signal);

    const toolsList = Array.from(this.tools.values()).map((t) => ToolManifestSchema.parse(t));
    const deploymentsList = Array.from(this.deployments.values()).map((d) =>
      DeploymentRecordSchema.parse(d),
    );

    const checksum = hashCanonicalContent({
      tools: toolsList,
      activeDeployments: deploymentsList,
    });

    return {
      snapshotVersion: `v${this.snapshotVersionCounter}`,
      generatedAt: new Date().toISOString(),
      checksum,
      tools: toolsList,
      activeDeployments: deploymentsList,
    };
  }

  async handleToolInvocation(
    toolIdOrName: string,
    params: Record<string, unknown>,
    context: CloudInvocationContext,
  ): Promise<CallToolResult> {
    await this.applyFaultInjections(context.signal);

    const tool =
      this.tools.get(toolIdOrName) ||
      Array.from(this.tools.values()).find((t) => t.name === toolIdOrName);
    if (!tool) {
      throw new ProtocolError("not_found", `Tool '${toolIdOrName}' not found in cloud catalog`, {
        status: 404,
      });
    }

    if (this.faultConfig.disconnectMidResult) {
      if (context.onProgress) {
        context.onProgress(50, 100);
      }
      throw new ProtocolError("terminal", "Connection abruptly closed mid-stream by cloud peer", {
        status: 502,
      });
    }

    const handler = this.toolHandlers.get(tool.id) || this.toolHandlers.get(tool.name);
    if (handler) {
      return await handler(params, context);
    }

    // Default mock execution
    if (context.onProgress) {
      context.onProgress(100, 100);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "executed",
            source: "cloud",
            tool: tool.name,
            version: tool.version,
            params,
            idempotencyKey: context.idempotencyKey,
          }),
        },
      ],
    };
  }

  private async applyFaultInjections(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Request aborted by client");
    }

    if (this.faultConfig.offline) {
      throw new RetryableError("Network unreachable: Cloud service is offline (ECONNREFUSED)");
    }

    if (this.faultConfig.unauthorized) {
      throw new ProtocolError(
        "unauthorized",
        "Unauthorized: Cloud device credentials invalid or expired",
        { status: 401 },
      );
    }

    if (this.faultConfig.upgradeRequired) {
      throw new UpgradeRequiredError(
        "Protocol upgrade required",
        this.faultConfig.upgradeRequired.minSupportedVersion,
      );
    }

    if (this.faultConfig.injectError) {
      throw this.faultConfig.injectError;
    }

    if (this.faultConfig.rateLimit) {
      this.rateLimitCounter++;
      const limit = this.faultConfig.rateLimit.limitCount ?? 1;
      if (this.rateLimitCounter <= limit) {
        throw new RateLimitedError("Rate limit exceeded: please retry after cooldown", {
          retryAfterMs: this.faultConfig.rateLimit.retryAfterMs ?? 1000,
        });
      }
    }

    if (this.faultConfig.latencyMs && this.faultConfig.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.faultConfig.latencyMs);
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Request aborted by client"));
          });
        }
      });
    }
  }
}
