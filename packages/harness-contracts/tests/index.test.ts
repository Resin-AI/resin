import { describe, expect, it } from "vitest";
import * as HarnessContracts from "../src/index.js";
import {
  AmbiguousActiveSessionError,
  CatalogChangeSummarySchema,
  ConfigBackupSchema,
  ConfigMutationPlanSchema,
  HARNESS_CONTRACTS_VERSION,
  HarnessErrorCode,
  HarnessInstallationSchema,
  HarnessSessionSchema,
  HarnessWorkspaceSchema,
  InMemoryConfigFsBridge,
  MissingHarnessError,
  NodeConfigFsBridge,
  ObservationFidelitySchema,
  RawHarnessRecordSchema,
  RefreshCapabilitySchema,
  RefreshOutcomeSchema,
  RefreshResultSchema,
  SourceCursorSchema,
  TIER1_HIGH_FIDELITY,
  applyConfigMutation,
  computeConfigHash,
  createObservationFidelity,
  createRefreshResult,
  determineRefreshOutcome,
  isHarnessError,
  planConfigMutation,
  rollbackConfigMutation,
  verifyConfigIntegrity,
  verifyPreconditionHash,
} from "../src/index.js";

describe("harness-contracts root exports", () => {
  it("exports HARNESS_CONTRACTS_VERSION", () => {
    expect(HARNESS_CONTRACTS_VERSION).toBe("0.1.0");
  });

  it("exports all schemas and helpers", () => {
    expect(HarnessInstallationSchema).toBeDefined();
    expect(HarnessWorkspaceSchema).toBeDefined();
    expect(HarnessSessionSchema).toBeDefined();
    expect(RawHarnessRecordSchema).toBeDefined();
    expect(SourceCursorSchema).toBeDefined();
    expect(ConfigMutationPlanSchema).toBeDefined();
    expect(ConfigBackupSchema).toBeDefined();
    expect(RefreshCapabilitySchema).toBeDefined();
    expect(RefreshOutcomeSchema).toBeDefined();
    expect(RefreshResultSchema).toBeDefined();
    expect(ObservationFidelitySchema).toBeDefined();
    expect(CatalogChangeSummarySchema).toBeDefined();

    expect(computeConfigHash).toBeTypeOf("function");
    expect(verifyPreconditionHash).toBeTypeOf("function");
    expect(planConfigMutation).toBeTypeOf("function");
    expect(applyConfigMutation).toBeTypeOf("function");
    expect(rollbackConfigMutation).toBeTypeOf("function");
    expect(verifyConfigIntegrity).toBeTypeOf("function");
    expect(createRefreshResult).toBeTypeOf("function");
    expect(determineRefreshOutcome).toBeTypeOf("function");
    expect(createObservationFidelity).toBeTypeOf("function");
    expect(isHarnessError).toBeTypeOf("function");

    expect(NodeConfigFsBridge).toBeDefined();
    expect(InMemoryConfigFsBridge).toBeDefined();
    expect(TIER1_HIGH_FIDELITY).toBeDefined();
    expect(HarnessErrorCode.MISSING_HARNESS).toBe("MISSING_HARNESS");
    expect(MissingHarnessError).toBeDefined();
    expect(AmbiguousActiveSessionError).toBeDefined();
  });

  it("does not export test fakes from production root", () => {
    expect((HarnessContracts as Record<string, unknown>).FakeHarnessAdapter).toBeUndefined();
    expect((HarnessContracts as Record<string, unknown>).FakeSessionEventSource).toBeUndefined();
  });
});
