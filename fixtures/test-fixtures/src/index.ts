/**
 * @resin/test-fixtures
 *
 * Contract validation, compatibility fixtures, schema conformance tooling,
 * sanitization engine, deterministic fake environments, and consumer test suites.
 */

// Legacy compatibility exports
import type { ToolSpec } from "@resin/contracts";

export const sampleToolSpec: ToolSpec = {
  id: "fixture-tool-01",
  name: "fixtureTool",
  version: "1.0.0",
  description: "Standard mock fixture tool",
};

export const FIXTURES_VERSION = "0.1.0";

// Golden Fixtures
export * from "./golden/index.js";

// Conformance & Contract Validation Engine
export * from "./conformance-runner.js";

// Semantic Schema Diff Tool
export * from "./schema-diff.js";

// Fixture Sanitization Engine
export * from "./sanitization.js";

// Release Compatibility Manifest
export * from "./compatibility-manifest.js";

// Deterministic Fake Environment
export * from "./fake-environment.js";

// Documentation & JSON Schema Generator
export * from "./doc-generator.js";

// Consumer Test Suites
export * from "./consumer-suites.js";
