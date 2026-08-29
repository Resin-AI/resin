import { describe, expect, it } from "vitest";
import {
  CONTRACT_SCHEMA_REGISTRY,
  FIXTURES_VERSION,
  FakeClock,
  InMemoryArtifactStore,
  InMemoryFileSystem,
  allValidDomainEvents,
  assertCompatible,
  assertSanitized,
  generateCompatibilityManifest,
  generateFullContractCatalogDoc,
  runConformanceSuite,
  sampleToolSpec,
  sanitizeFixture,
  validateContractPayload,
} from "../src/index.js";

describe("@resin/test-fixtures package index", () => {
  it("exports package version and legacy fixtures", () => {
    expect(FIXTURES_VERSION).toBe("0.1.0");
    expect(sampleToolSpec.id).toBe("fixture-tool-01");
  });

  it("exports conformance runner and master schema registry", () => {
    expect(CONTRACT_SCHEMA_REGISTRY).toBeDefined();
    expect(typeof validateContractPayload).toBe("function");
    expect(typeof runConformanceSuite).toBe("function");
  });

  it("exports schema diffing and compatibility tools", () => {
    expect(typeof assertCompatible).toBe("function");
    expect(typeof generateCompatibilityManifest).toBe("function");
  });

  it("exports sanitization engine", () => {
    expect(typeof sanitizeFixture).toBe("function");
    expect(typeof assertSanitized).toBe("function");
  });

  it("exports fake environment components", () => {
    expect(FakeClock).toBeDefined();
    expect(InMemoryFileSystem).toBeDefined();
    expect(InMemoryArtifactStore).toBeDefined();
  });

  it("exports doc generator and golden fixtures", () => {
    expect(typeof generateFullContractCatalogDoc).toBe("function");
    expect(Array.isArray(allValidDomainEvents)).toBe(true);
  });
});
