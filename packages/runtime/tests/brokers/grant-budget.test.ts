import { describe, expect, it } from "vitest";
import {
  BrokerSecurityError,
  CapabilityBrokerManager,
  FilesystemBroker,
} from "../../src/brokers/index.js";
import { createInvocationGrant } from "../../src/policy/grant.js";

describe("Broker Grant Validation & Budget Enforcement", () => {
  const baseGrantParams = {
    grantId: "grant_test_001",
    invocationId: "inv_12345",
    toolId: "test_tool",
    toolVersion: "1.0.0",
    workspaceId: "ws_test",
    envelopeId: "env_test",
    capabilities: {
      fs: {
        readPaths: ["**"],
        writePaths: ["**"],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      limits: {
        maxOutputSizeBytes: 500, // Strict small limit for testing
        maxConcurrentExecutions: 2,
        maxExecutionTimeMs: 5000,
      },
    },
  };

  it("rejects operation when grant is required but missing", async () => {
    const fsBroker = new FilesystemBroker({ requireGrant: true });

    await expect(
      fsBroker.stat(
        { path: "test.txt" },
        {
          invocationId: "inv_12345",
          // grant omitted
        },
      ),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await fsBroker.stat({ path: "test.txt" }, { invocationId: "inv_12345" });
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("GRANT_REQUIRED");
    }
  });

  it("rejects expired invocation grant", async () => {
    const fsBroker = new FilesystemBroker();
    const expiredGrant = createInvocationGrant({
      ...baseGrantParams,
      issuedAt: new Date(Date.now() - 10000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    await expect(
      fsBroker.stat(
        { path: "test.txt" },
        {
          invocationId: "inv_12345",
          grant: expiredGrant,
        },
      ),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await fsBroker.stat({ path: "test.txt" }, { invocationId: "inv_12345", grant: expiredGrant });
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("GRANT_EXPIRED");
    }
  });

  it("rejects invocation ID mismatch between request and grant", async () => {
    const fsBroker = new FilesystemBroker();
    const validGrant = createInvocationGrant(baseGrantParams);

    await expect(
      fsBroker.stat(
        { path: "test.txt" },
        {
          invocationId: "inv_DIFFERENT_999",
          grant: validGrant,
        },
      ),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await fsBroker.stat(
        { path: "test.txt" },
        {
          invocationId: "inv_DIFFERENT_999",
          grant: validGrant,
        },
      );
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("INVOCATION_MISMATCH");
    }
  });

  it("rejects tampered grant digest", async () => {
    const fsBroker = new FilesystemBroker();
    const validGrant = createInvocationGrant(baseGrantParams);
    const tamperedGrant = {
      ...validGrant,
      workspaceId: "hacked_workspace_id",
    };

    await expect(
      fsBroker.stat(
        { path: "test.txt" },
        {
          invocationId: "inv_12345",
          grant: tamperedGrant,
        },
      ),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await fsBroker.stat(
        { path: "test.txt" },
        {
          invocationId: "inv_12345",
          grant: tamperedGrant,
        },
      );
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("GRANT_INVALID");
    }
  });

  it("enforces cumulative output size limit across operations", async () => {
    const manager = new CapabilityBrokerManager({
      allowUnverifiedBoundaries: true,
      development: true,
    });
    const strictGrant = createInvocationGrant({
      ...baseGrantParams,
      invocationId: "inv_budget_test",
      capabilities: {
        ...baseGrantParams.capabilities,
        limits: {
          maxOutputSizeBytes: 200, // 200 bytes max
        },
      },
    });

    const context = {
      invocationId: "inv_budget_test",
      grant: strictGrant,
      workspaceRoot: process.cwd(),
    };

    // First write within limit (150 bytes)
    await manager.handleRequest(
      "fs",
      "writeFile",
      {
        path: "test_budget.tmp",
        content: "A".repeat(150),
      },
      context,
    );

    // Read back 150 bytes (total cumulative output becomes 150 bytes tracked)
    await manager.handleRequest("fs", "readFile", { path: "test_budget.tmp" }, context);

    // Second read would consume another 150 bytes (total 300 > 200 limit) -> rejected
    await expect(
      manager.handleRequest("fs", "readFile", { path: "test_budget.tmp" }, context),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await manager.handleRequest("fs", "readFile", { path: "test_budget.tmp" }, context);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("BUDGET_EXCEEDED");
    }

    // Clean up file
    await manager.handleRequest("fs", "delete", { path: "test_budget.tmp" }, context);
  });
});
